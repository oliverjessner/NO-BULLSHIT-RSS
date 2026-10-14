#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod backend;
use std::sync::Mutex;
use tauri::{
    menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu},
    webview::{NewWindowResponse, WebviewBuilder},
    window::WindowBuilder,
    LogicalPosition, LogicalSize, Manager, WebviewUrl,
};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

#[derive(Default)]
struct ArticleState {
    url: Mutex<Option<String>>,
}

#[derive(Default)]
struct SelectionState(Mutex<String>);

fn http_url(value: &str) -> Result<tauri::Url, String> {
    let url = tauri::Url::parse(value).map_err(|_| "Invalid URL")?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("Only HTTP(S) URLs without credentials are allowed".into());
    }
    Ok(url)
}

fn open_browser(app: &tauri::AppHandle, url: &tauri::Url) {
    if http_url(url.as_str()).is_ok() {
        let _ = app.opener().open_url(url.as_str(), None::<&str>);
    }
}

#[tauri::command]
fn open_external(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let url = http_url(&url)?;
    app.opener()
        .open_url(url.as_str(), None::<&str>)
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn save_export(
    app: tauri::AppHandle,
    filename: String,
    content: String,
) -> Result<bool, String> {
    if filename.contains(['/', '\\']) || filename.len() > 200 || content.len() > 100 * 1024 * 1024 {
        return Err("Invalid export".into());
    }
    let extension = filename
        .rsplit('.')
        .next()
        .ok_or("Missing export extension")?;
    if !["md", "json", "csv", "txt"].contains(&extension) {
        return Err("Invalid export format".into());
    }
    let chosen = app
        .dialog()
        .file()
        .set_file_name(&filename)
        .add_filter("Export", &[extension])
        .blocking_save_file();
    let Some(chosen) = chosen else {
        return Ok(false);
    };
    let path = chosen.into_path().map_err(|e| e.to_string())?;
    std::fs::write(path, content).map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
fn toggle_devtools(app: tauri::AppHandle) {
    if let Some(main) = app.get_webview("main") {
        if main.is_devtools_open() {
            main.close_devtools();
        } else {
            main.open_devtools();
        }
    }
}

#[derive(serde::Deserialize)]
struct ViewerBounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

impl ViewerBounds {
    fn valid(&self) -> bool {
        [self.x, self.y, self.width, self.height]
            .iter()
            .all(|value| value.is_finite())
            && self.x >= 0.0
            && self.y >= 0.0
            && self.width > 0.0
            && self.height > 0.0
            && self.width <= 10000.0
            && self.height <= 10000.0
    }
}

#[tauri::command]
async fn sync_article_viewer(
    app: tauri::AppHandle,
    url: Option<String>,
    bounds: Option<ViewerBounds>,
) -> Result<(), String> {
    let state = app.state::<ArticleState>();
    let Some((url, bounds)) = url.zip(bounds) else {
        if let Some(view) = app.get_webview("article") {
            view.hide().map_err(|e| e.to_string())?;
        }
        return Ok(());
    };
    let parsed = http_url(&url)?;
    if !bounds.valid() {
        return Err("Invalid article viewer bounds".into());
    }
    let window = app.get_window("main").ok_or("Main window is closed")?;
    let position = LogicalPosition::new(bounds.x, bounds.y);
    let size = LogicalSize::new(bounds.width, bounds.height);
    let existing = app.get_webview("article");
    let view = if let Some(view) = existing {
        view
    } else {
        let popup_app = app.clone();
        let builder = WebviewBuilder::new("article", WebviewUrl::External(parsed.clone()))
            .on_navigation(|url| matches!(url.scheme(), "http" | "https" | "about"))
            .on_new_window(move |url, _| {
                open_browser(&popup_app, &url);
                NewWindowResponse::Deny
            });
        window
            .add_child(builder, position, size)
            .map_err(|e| e.to_string())?
    };
    let mut loaded = state.url.lock().map_err(|e| e.to_string())?;
    if loaded.as_deref() != Some(&url) {
        view.navigate(parsed).map_err(|e| e.to_string())?;
        *loaded = Some(url);
    }
    view.set_bounds(tauri::Rect {
        position: position.into(),
        size: size.into(),
    })
    .map_err(|e| e.to_string())?;
    view.show().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn selection_menu(app: tauri::AppHandle, text: String) -> Result<(), String> {
    let normalized = text
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(300)
        .collect::<String>();
    if normalized.is_empty() {
        return Ok(());
    }
    *app.state::<SelectionState>()
        .0
        .lock()
        .map_err(|e| e.to_string())? = normalized;
    let search = MenuItem::with_id(
        &app,
        "search-selection",
        "search for selected text",
        true,
        None::<&str>,
    )
    .map_err(|e| e.to_string())?;
    let copy = PredefinedMenuItem::copy(&app, None).map_err(|e| e.to_string())?;
    let menu = Menu::with_items(&app, &[&search, &copy]).map_err(|e| e.to_string())?;
    let main = app.get_window("main").ok_or("Main window is closed")?;
    main.popup_menu(&menu).map_err(|e| e.to_string())
}

fn create_main(app: &tauri::AppHandle) -> tauri::Result<()> {
    if let Some(main) = app.get_window("main") {
        main.unminimize()?;
        main.show()?;
        main.set_focus()?;
        return Ok(());
    }
    *app.state::<ArticleState>()
        .url
        .lock()
        .expect("article state") = None;
    let navigation_app = app.clone();
    let popup_app = app.clone();
    let origin = app.state::<backend::Origin>().0.clone();
    let allowed_origin = origin.clone();
    // Both views are children of the same native window. A single-webview window
    // installs a different macOS content view and is unsuitable for later siblings.
    let window = WindowBuilder::new(app, "main")
        .title("NO BULLSHIT RSS")
        .inner_size(1680.0, 1050.0)
        .min_inner_size(800.0, 600.0)
        .build()?;
    let size = window.inner_size()?;
    let builder = WebviewBuilder::new(
        "main",
        WebviewUrl::External(origin.parse().expect("local origin")),
    )
    .auto_resize()
    .on_navigation(move |url| {
        if url.origin().ascii_serialization() == allowed_origin {
            true
        } else {
            open_browser(&navigation_app, url);
            false
        }
    })
    .on_new_window(move |url, _| {
        open_browser(&popup_app, &url);
        NewWindowResponse::Deny
    });
    window.add_child(builder, LogicalPosition::new(0.0, 0.0), size)?;
    Ok(())
}

fn install_menu(app: &tauri::AppHandle) -> tauri::Result<()> {
    let about = PredefinedMenuItem::about(
        app,
        None,
        Some(AboutMetadata {
            name: Some("NO BULLSHIT RSS".into()),
            version: Some(app.package_info().version.to_string()),
            copyright: Some("© Oliver Jessner".into()),
            website: Some("https://oliverjessner.com".into()),
            ..Default::default()
        }),
    )?;
    let application = Submenu::with_items(
        app,
        "NO BULLSHIT RSS",
        true,
        &[
            &about,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    let file = Submenu::with_items(
        app,
        "File",
        true,
        &[&PredefinedMenuItem::close_window(app, None)?],
    )?;
    let devtools = MenuItem::with_id(
        app,
        "devtools",
        "Toggle Developer Tools",
        true,
        Some("Alt+CmdOrCtrl+I"),
    )?;
    let view = Submenu::with_items(app, "View", true, &[&devtools])?;
    let support = MenuItem::with_id(app, "support", "Support development", true, None::<&str>)?;
    let help = Submenu::with_items(app, "Help", true, &[&support])?;
    app.set_menu(Menu::with_items(
        app,
        &[&application, &file, &edit, &view, &help],
    )?)?;
    app.on_menu_event(|app, event| match event.id().as_ref() {
        "search-selection" => {
            if let (Some(main), Ok(text)) = (
                app.get_webview("main"),
                app.state::<SelectionState>().0.lock(),
            ) {
                if let Ok(serialized) = serde_json::to_string(&*text) {
                    let _ = main.eval(format!("window.__nbsSearchSelection?.({serialized})"));
                }
            }
        }
        "devtools" => toggle_devtools(app.clone()),
        "support" => {
            let _ = open_external(
                app.clone(),
                "https://www.buymeacoffee.com/oliverjessner".into(),
            );
        }
        _ => {}
    });
    Ok(())
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            let _ = create_main(app);
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(ArticleState::default())
        .manage(SelectionState::default())
        .invoke_handler(tauri::generate_handler![
            open_external,
            sync_article_viewer,
            toggle_devtools,
            selection_menu,
            save_export
        ])
        .setup(|app| {
            install_menu(app.handle())?;
            match backend::start(app.handle()) {
                Ok(backend) => {
                    app.manage(backend::Origin(backend.origin.clone()));
                    app.manage(Mutex::new(Some(backend)));
                    create_main(app.handle())?;
                }
                Err(error) => {
                    app.dialog()
                        .message(error.to_string())
                        .title("Startup error")
                        .blocking_show();
                    return Err(error);
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to start NO BULLSHIT RSS");
    app.run(|app, event| match event {
        tauri::RunEvent::Exit => {
            if let Some(backend) = app.try_state::<Mutex<Option<backend::Backend>>>() {
                let _ = backend.lock().map(|mut backend| backend.take());
            }
        }
        tauri::RunEvent::ExitRequested {
            code: None, api, ..
        } if cfg!(target_os = "macos") => api.prevent_exit(),
        tauri::RunEvent::Reopen { .. } => {
            let _ = create_main(app);
        }
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn external_urls_require_http_without_credentials() {
        for url in ["https://example.com/news", "http://example.com"] {
            assert!(http_url(url).is_ok());
        }
        for url in [
            "javascript:alert(1)",
            "file:///tmp/foo",
            "mailto:a@b.com",
            "https://user:pass@example.com",
            "invalid",
        ] {
            assert!(http_url(url).is_err());
        }
    }
    #[test]
    fn viewer_rejects_invalid_geometry() {
        assert!(ViewerBounds {
            x: 2.0,
            y: 4.0,
            width: 500.0,
            height: 300.0
        }
        .valid());
        for width in [f64::NAN, f64::INFINITY, -1.0, 0.0, 10001.0] {
            assert!(!ViewerBounds {
                x: 0.0,
                y: 0.0,
                width,
                height: 300.0
            }
            .valid());
        }
    }
}
