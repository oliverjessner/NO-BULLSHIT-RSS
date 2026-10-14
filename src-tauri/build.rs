fn main() {
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
