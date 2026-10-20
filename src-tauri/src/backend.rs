use std::{
    fs::{self, OpenOptions},
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc,
    },
    time::Duration,
};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

pub struct Origin(pub String);

pub struct Backend {
    child: Child,
    stopping: Arc<AtomicBool>,
    pub origin: String,
}

impl Drop for Backend {
    fn drop(&mut self) {
        self.stopping.store(true, Ordering::SeqCst);
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

pub fn data_directory(app: &AppHandle) -> tauri::Result<PathBuf> {
    // Preserve the Electron data directory, including WAL, custom rules and CLI discovery.
    Ok(app.path().config_dir()?.join("NO-BULLSHIT-RSS"))
}

pub fn start(app: &AppHandle) -> Result<Backend, Box<dyn std::error::Error>> {
    let port = std::env::var("RSS_PORT")
        .unwrap_or_else(|_| "1377".into())
        .parse::<u16>()?;
    if port == 0 {
        return Err("RSS_PORT must be between 1 and 65535".into());
    }
    let data = std::env::var_os("RSS_DATA_DIR")
        .map(PathBuf::from)
        .map(Ok)
        .unwrap_or_else(|| data_directory(app))?;
    fs::create_dir_all(&data)?;
    let (runtime, node) = if cfg!(debug_assertions) {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        (
            root.parent()
                .ok_or("missing repository directory")?
                .to_path_buf(),
            root.join("binaries/rss-node-aarch64-apple-darwin"),
        )
    } else {
        (
            app.path().resource_dir()?.join("runtime"),
            std::env::current_exe()?.with_file_name("rss-node"),
        )
    };
    let log_path = data.join("server.log");
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)?;
    let mut child = Command::new(node)
        .arg(runtime.join("backend/server.js"))
        .current_dir(runtime)
        .env("HOST", "127.0.0.1")
        .env("PORT", port.to_string())
        .env("DB_PATH", data.join("data-v2.db"))
        .env("TOPIC_RULES_FILE_PATH", data.join("topics.rules.json"))
        .env("SERVER_LOG_PATH", &log_path)
        .env("DESKTOP_PARENT_WATCHDOG", "1")
        .env_remove("NODE_OPTIONS")
        .env_remove("NODE_PATH")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::from(log.try_clone()?))
        .spawn()?;
    let stdout = child.stdout.take().ok_or("missing server stdout")?;
    let (tx, rx) = mpsc::channel();
    let stopping = Arc::new(AtomicBool::new(false));
    let monitor_stopping = stopping.clone();
    let monitor_app = app.clone();
    let monitor_log_path = log_path.clone();
    std::thread::spawn(move || {
        let mut log = log;
        let mut ready = false;
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if line.starts_with("NBS_DESKTOP_EVENT ") {
                super::watchdog::dispatch(&monitor_app, &line);
                continue;
            }
            let _ = writeln!(log, "{line}");
            if line == "NBS_DESKTOP_READY" {
                ready = true;
                let _ = tx.send(());
            }
        }
        if ready && !monitor_stopping.load(Ordering::SeqCst) {
            let exit_app = monitor_app.clone();
            monitor_app
                .dialog()
                .message(format!(
                    "The local backend stopped unexpectedly. See {}",
                    monitor_log_path.display()
                ))
                .title("Server error")
                .show(move |_| exit_app.exit(1));
        }
    });
    let backend = Backend {
        child,
        stopping,
        origin: format!("http://127.0.0.1:{port}"),
    };
    // Only our own child can announce readiness. Never attach to an unrelated server.
    rx.recv_timeout(Duration::from_secs(120)).map_err(|_| {
        format!(
            "The local server could not start. Port {port} may be in use. See {}",
            log_path.display()
        )
    })?;
    Ok(backend)
}
