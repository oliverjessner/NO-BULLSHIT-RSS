use serde::Deserialize;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};
use tauri_plugin_notification::NotificationExt;

#[derive(Default)]
pub struct State {
    pending_target: Mutex<Option<i64>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Notice {
    #[serde(rename = "type")]
    kind: String,
    id: i64,
    match_id: i64,
    watchdog_id: i64,
    name: String,
    title: String,
    count: usize,
}
impl Notice {
    pub fn parse(line: &str) -> Option<Self> {
        let json = line.strip_prefix("NBS_DESKTOP_EVENT ")?;
        if json.len() > 8192 {
            return None;
        }
        let notice: Self = serde_json::from_str(json).ok()?;
        (notice.kind == "watchdog.notification"
            && notice.id > 0
            && notice.match_id > 0
            && notice.watchdog_id > 0
            && !notice.name.trim().is_empty()
            && notice.name.len() <= 800
            && notice.title.len() <= 4000
            && notice.count > 0)
            .then_some(notice)
    }
    fn body(&self) -> String {
        if self.count == 1 {
            self.title.clone()
        } else {
            format!("{} (+{} more matches)", self.title, self.count - 1)
        }
    }
}

#[cfg(target_os = "macos")]
unsafe extern "C" {
    fn nbs_notification_permission(request: bool) -> i32;
}

fn permission(request: bool) -> String {
    #[cfg(target_os = "macos")]
    let state = unsafe { nbs_notification_permission(request) };
    #[cfg(not(target_os = "macos"))]
    let state = if request { 2 } else { 0 };
    match state {
        2 => "granted",
        1 => "denied",
        0 => "prompt",
        _ => "unavailable",
    }
    .into()
}

#[tauri::command]
pub async fn watchdog_notification_permission(request: bool) -> Result<String, String> {
    // The plugin's desktop permission method always returns Granted. On macOS,
    // query/request the real OS authorization only after the user's explicit action.
    tauri::async_runtime::spawn_blocking(move || permission(request))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn watchdog_take_target(app: AppHandle) -> Option<i64> {
    app.state::<State>().pending_target.lock().ok()?.take()
}

pub fn open_target(app: &AppHandle, id: i64) {
    if id <= 0 {
        return;
    }
    if let Ok(mut target) = app.state::<State>().pending_target.lock() {
        *target = Some(id);
    }
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Err(error) = super::create_main(&handle) {
            eprintln!("Could not open Watchdog: {error}");
            return;
        }
        if let Some(main) = handle.get_webview("main") {
            let _ = main.eval("window.dispatchEvent(new CustomEvent('nbs:watchdog-open'))");
        }
    });
}

fn action_target(action: &tauri_plugin_notification::ActionPerformed) -> Option<i64> {
    if action.action_id() != "tap" {
        return None;
    }
    action
        .notification()?
        .extra()
        .get("watchdogMatchId")?
        .as_i64()
        .filter(|id| *id > 0)
}

pub fn setup(app: &AppHandle) -> tauri_plugin_notification::Result<()> {
    let handle = app.clone();
    app.notification().on_action(move |action| {
        if let Some(id) = action_target(action) {
            open_target(&handle, id);
        }
    })
}

pub fn dispatch(app: &AppHandle, line: &str) {
    let Some(notice) = Notice::parse(line) else {
        return;
    };
    if permission(false) != "granted" {
        return;
    }
    if let Err(error) = app
        .notification()
        .builder()
        .title(format!("Watchdog: {}", notice.name))
        .body(notice.body())
        .extra("watchdogMatchId", notice.match_id)
        .show()
    {
        eprintln!("Watchdog notification failed: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn permission_ipc_allows_the_local_dev_reader_and_remote_loopback_reader_only() {
        let app = tauri::test::mock_builder()
            .invoke_handler(tauri::generate_handler![watchdog_notification_permission])
            .build(tauri::generate_context!())
            .unwrap();
        for (label, url, allowed) in [
            ("main", "tauri://localhost", true),
            ("main", "http://127.0.0.1:1377", true),
            ("main", "http://127.0.0.1:49152", true),
            ("main", "https://example.com", false),
            ("article", "tauri://localhost", false),
            ("article-remote", "http://127.0.0.1:49152", false),
            ("untrusted", "https://example.com", false),
        ] {
            // The main reader uses this label in both development and production.
            let existing = app.get_webview_window(label);
            let webview = existing.unwrap_or_else(|| {
                tauri::WebviewWindowBuilder::new(&app, label, Default::default())
                    .build()
                    .unwrap()
            });
            let response = tauri::test::get_ipc_response(
                &webview,
                tauri::webview::InvokeRequest {
                    cmd: "watchdog_notification_permission".into(),
                    callback: tauri::ipc::CallbackFn(0),
                    error: tauri::ipc::CallbackFn(1),
                    url: url.parse().unwrap(),
                    body: tauri::ipc::InvokeBody::Json(serde_json::json!({"request": false})),
                    headers: Default::default(),
                    invoke_key: tauri::test::INVOKE_KEY.to_string(),
                },
            );
            assert_eq!(response.is_ok(), allowed, "{label} at {url}: {response:?}");
        }
    }
    fn line(id: i64, count: usize) -> String {
        format!("NBS_DESKTOP_EVENT {{\"type\":\"watchdog.notification\",\"id\":{id},\"matchId\":1,\"watchdogId\":2,\"name\":\"News\",\"title\":\"Article\",\"count\":{count}}}")
    }
    #[test]
    fn validates_sidecar_frames_and_batches() {
        assert_eq!(Notice::parse(&line(1, 1)).unwrap().body(), "Article");
        assert_eq!(
            Notice::parse(&line(1, 4)).unwrap().body(),
            "Article (+3 more matches)"
        );
        for invalid in [
            line(0, 1),
            line(1, 0),
            "NBS_DESKTOP_READY".into(),
            "NBS_DESKTOP_EVENT {}".into(),
            line(1, 1).replace("watchdog.notification", "other"),
        ] {
            assert!(Notice::parse(&invalid).is_none());
        }
    }
    #[test]
    fn native_tap_payload_opens_only_a_positive_watchdog_match() {
        for (action, target, expected) in [
            ("tap", 42, Some(42)),
            ("dismiss", 42, None),
            ("tap", 0, None),
        ] {
            let payload = serde_json::json!({ "actionId": action, "notification": {"id": 1, "extra": {"watchdogMatchId": target}} });
            let performed = serde_json::from_value(payload).unwrap();
            assert_eq!(action_target(&performed), expected);
        }
        let missing = serde_json::from_value(serde_json::json!({"actionId": "tap"})).unwrap();
        assert_eq!(action_target(&missing), None);
    }
    #[test]
    fn pending_target_survives_until_consumed_once() {
        let state = State::default();
        *state.pending_target.lock().unwrap() = Some(42);
        assert_eq!(state.pending_target.lock().unwrap().take(), Some(42));
        assert_eq!(state.pending_target.lock().unwrap().take(), None);
    }
}
