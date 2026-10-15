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
        ]),
    ))
    .expect("failed to build desktop resources");
}
