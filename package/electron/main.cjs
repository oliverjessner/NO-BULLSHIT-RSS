const { app, BrowserWindow, dialog, shell, nativeImage } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const http = require('node:http');

const PORT = process.env.PORT || '1377';
let serverProcess = null;

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

  serverProcess = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_PATH: dbPath
    },
    stdio: 'inherit'
  });

  serverProcess.on('exit', (code) => {
    if (code && code !== 0) {
      dialog.showErrorBox('Server error', `Server exited with code ${code}`);
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
