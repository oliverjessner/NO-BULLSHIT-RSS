const { app, BrowserWindow, dialog, shell, nativeImage, Menu } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const PORT = process.env.PORT || '1377';
const gotSingleInstanceLock = app.requestSingleInstanceLock();

let serverProcess = null;
let serverLogPath = null;
let mainWindow = null;
let aboutWindow = null;

if (!gotSingleInstanceLock) {
    app.quit();
}

function waitForServer(port, attempts = 40, delayMs = 250) {
    return new Promise((resolve, reject) => {
        let tries = 0;

        const attempt = () => {
            tries += 1;

            const req = http.get({ hostname: '127.0.0.1', port, path: '/api/health', timeout: 1000 }, res => {
                res.resume();
                if (res.statusCode === 200) {
                    resolve();
                } else if (tries < attempts) {
                    setTimeout(attempt, delayMs);
                } else {
                    reject(new Error('Server not responding'));
                }
            });

            req.on('error', () => {
                if (tries < attempts) {
                    setTimeout(attempt, delayMs);
                } else {
                    reject(new Error('Server not responding'));
                }
            });

            req.on('timeout', () => {
                req.destroy();
            });
        };

        attempt();
    });
}

function startServer() {
    const serverPath = path.join(__dirname, '..', 'backend', 'server.js');
    const dbPath = path.join(app.getPath('userData'), 'data.db');
    const appPath = app.getAppPath();
    serverLogPath = path.join(app.getPath('userData'), 'server.log');

    const logMain = message => {
        try {
            fs.appendFileSync(serverLogPath, `${message}\n`);
        } catch {
            // Ignore logging failures to avoid crashing on startup.
        }
    };

    logMain(`[main] starting server`);
    logMain(`[main] execPath=${process.execPath}`);
    logMain(`[main] appPath=${appPath}`);
    logMain(`[main] serverPath=${serverPath}`);
    logMain(`[main] serverPathExists=${fs.existsSync(serverPath)}`);

    serverProcess = spawn(process.execPath, [serverPath], {
        env: {
            ...process.env,
            PORT: String(PORT),
            DB_PATH: dbPath,
            ELECTRON_RUN_AS_NODE: '1',
            SERVER_LOG_PATH: serverLogPath,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    serverProcess.stdout.on('data', chunk => {
        logMain(String(chunk));
    });
    serverProcess.stderr.on('data', chunk => {
        logMain(String(chunk));
    });

    serverProcess.on('error', err => {
        logMain(`[main] spawn error: ${err?.stack || err?.message || String(err)}`);
        dialog.showErrorBox('Server error', `Failed to start server process. Log: ${serverLogPath}`);
    });

    serverProcess.on('exit', code => {
        if (code && code !== 0) {
            const message = serverLogPath
                ? `Server exited with code ${code}. Log: ${serverLogPath}`
                : `Server exited with code ${code}`;
            dialog.showErrorBox('Server error', message);
        }
    });
}

async function createWindow() {
    const iconPath = path.join(__dirname, '..', 'public', 'images', 'logo', 'logo_raw.png');
    const appIcon = nativeImage.createFromPath(iconPath);

    const win = new BrowserWindow({
        width: 1280,
        height: 800,
        minWidth: 720,
        minHeight: 500,
        backgroundColor: '#f7f8fa',
        icon: appIcon,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
        },
    });
    mainWindow = win;

    if (process.platform === 'darwin' && app.dock && appIcon) {
        app.dock.setIcon(appIcon);
    }

    win.webContents.setWindowOpenHandler(({ url }) => {
        if (url.startsWith('http')) {
            shell.openExternal(url);
            return { action: 'deny' };
        }
        return { action: 'allow' };
    });

    win.webContents.on('will-navigate', (event, url) => {
        if (url.startsWith('http') && !url.includes(`127.0.0.1:${PORT}`)) {
            event.preventDefault();
            shell.openExternal(url);
        }
    });

    await waitForServer(PORT);
    await win.loadURL(`http://127.0.0.1:${PORT}`);
}

function createAboutWindow() {
    if (aboutWindow) {
        aboutWindow.focus();
        return;
    }

    const version = app.getVersion();
    const name = app.getName();
    const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>About</title>
    <style>
      body { margin: 0; font: 14px/1.4 -apple-system, BlinkMacSystemFont, Segoe UI, Helvetica, Arial, sans-serif; color: #111; background: #f7f8fa; }
      .wrap { padding: 24px; }
      h1 { margin: 0 0 8px; font-size: 18px; }
      .meta { color: #444; margin-bottom: 12px; }
      .fine { color: #666; font-size: 12px; margin-bottom: 16px; }
      .actions { display: flex; justify-content: flex-end; }
      button { border: 0; background: #1d1d1f; color: #fff; padding: 8px 14px; border-radius: 6px; cursor: pointer; }
      button:focus { outline: 2px solid #7aa2ff; outline-offset: 2px; }
    </style>
  </head>
  <body>
    <div class="wrap">
      <h1>${name}</h1>
      <div class="meta">Version ${version}</div>
      <div class="fine">Copyright Oliver Jessner</div>
      <div class="actions">
        <button id="close">Close</button>
      </div>
    </div>
    <script>
      document.getElementById('close').addEventListener('click', () => window.close());
    </script>
  </body>
</html>`;

    aboutWindow = new BrowserWindow({
        width: 420,
        height: 220,
        resizable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        parent: mainWindow || undefined,
        modal: !!mainWindow,
        show: true,
        backgroundColor: '#f7f8fa',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
        },
    });

    aboutWindow.on('closed', () => {
        aboutWindow = null;
    });

    aboutWindow.setMenu(null);
    aboutWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
}

function buildAppMenu() {
    const isMac = process.platform === 'darwin';
    const aboutItem = {
        label: `About ${app.getName()}`,
        click: () => createAboutWindow(),
    };

    const template = [
        ...(isMac
            ? [
                  {
                      label: app.getName(),
                      submenu: [aboutItem, { type: 'separator' }, { role: 'quit' }],
                  },
              ]
            : []),
        {
            label: 'File',
            submenu: [isMac ? { role: 'close' } : { role: 'quit' }],
        },
        {
            label: 'Help',
            submenu: isMac ? [] : [aboutItem],
        },
    ];

    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.on('second-instance', () => {
    if (mainWindow) {
        if (mainWindow.isMinimized()) {
            mainWindow.restore();
        }
        mainWindow.focus();
    }
});

app.whenReady().then(async () => {
    buildAppMenu();
    startServer();
    try {
        await createWindow();
    } catch (err) {
        dialog.showErrorBox('Startup error', err.message);
        app.quit();
    }
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('before-quit', () => {
    if (serverProcess) {
        serverProcess.kill();
        serverProcess = null;
    }
});
