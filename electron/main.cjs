const { app, BrowserWindow, dialog, shell, nativeImage } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const PORT = process.env.PORT || '1377';
let serverProcess = null;
let serverLogPath = null;
let mainWindow = null;

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}

function waitForServer(port, attempts = 40, delayMs = 250) {
  return new Promise((resolve, reject) => {
    let tries = 0;

    const attempt = () => {
      tries += 1;
      const req = http.get({ hostname: '127.0.0.1', port, path: '/api/health', timeout: 1000 }, (res) => {
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
  const serverPath = path.join(__dirname, '..', 'src', 'server.js');
  const dbPath = path.join(app.getPath('userData'), 'data.db');
  serverLogPath = path.join(app.getPath('userData'), 'server.log');
  const appPath = app.getAppPath();

  const logMain = (message) => {
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
      SERVER_LOG_PATH: serverLogPath
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  serverProcess.stdout.on('data', (chunk) => {
    logMain(String(chunk));
  });
  serverProcess.stderr.on('data', (chunk) => {
    logMain(String(chunk));
  });

  serverProcess.on('error', (err) => {
    logMain(`[main] spawn error: ${err?.stack || err?.message || String(err)}`);
    dialog.showErrorBox('Server error', `Failed to start server process. Log: ${serverLogPath}`);
  });

  serverProcess.on('exit', (code) => {
    if (code && code !== 0) {
      const message = serverLogPath
        ? `Server exited with code ${code}. Log: ${serverLogPath}`
        : `Server exited with code ${code}`;
      dialog.showErrorBox('Server error', message);
    }
  });
}

async function createWindow() {
  const iconPath = path.join(__dirname, '..', 'public', 'images', 'logo_raw.png');
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
      contextIsolation: true
    }
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

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.focus();
  }
});

app.whenReady().then(async () => {
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
