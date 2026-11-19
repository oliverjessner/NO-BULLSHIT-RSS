use std::ffi::{c_char, CString};

unsafe extern "C" {
    fn nbs_show_about(name: *const c_char, version: *const c_char, icon: *const u8, icon_len: usize);
}

pub fn show(app: &tauri::AppHandle) {
    let name = app
        .config()
        .product_name
        .clone()
        .unwrap_or_else(|| app.package_info().name.clone());
    let Ok(name) = CString::new(name) else {
        return;
    };
    // package_info resolves the version from tauri.conf.json (../package.json).
    let version = CString::new(app.package_info().version.to_string()).expect("valid app version");
    let icon = include_bytes!("../icons/icon.png");
    if let Err(error) = app.run_on_main_thread(move || {
        // AppKit copies the strings and image bytes during this synchronous call.
        unsafe { nbs_show_about(name.as_ptr(), version.as_ptr(), icon.as_ptr(), icon.len()) };
    }) {
        eprintln!("Failed to open About window: {error}");
    }
}
