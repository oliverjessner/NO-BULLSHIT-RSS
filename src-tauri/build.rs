#[cfg(target_os = "macos")]
fn lock_desktop_resources() -> std::fs::File {
    let directory = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("missing repository directory")
        .join(".desktop-cache");
    std::fs::create_dir_all(&directory).expect("failed to create desktop cache");
    let lock = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(directory.join("desktop-resources.lock"))
        .expect("failed to open desktop resource lock");
    lock.lock().expect("failed to lock desktop resources");
    lock
}

fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        cc::Build::new()
            .file("src/watchdog_permissions.m")
            .flag("-fobjc-arc")
            .flag("-fblocks")
            .compile("watchdog_permissions");
        println!("cargo:rustc-link-lib=framework=UserNotifications");
        println!("cargo:rerun-if-changed=src/watchdog_permissions.m");
    }
    // Preparation must finish before tauri-build walks/copies the runtime tree.
    #[cfg(target_os = "macos")]
    let _resources_lock = lock_desktop_resources();
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "open_external",
            "sync_article_viewer",
            "toggle_devtools",
            "selection_menu",
            "save_export",
            "watchdog_notification_permission",
            "watchdog_take_target",
        ]),
    ))
    .expect("failed to build desktop resources");
}
