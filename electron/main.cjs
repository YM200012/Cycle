const { app, BrowserWindow, session, shell, dialog } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

app.setName('Cycle');

let backend;
let window;
let quitReady = false;

function isExternalLink(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}

async function createWindow() {
  if (!backend) {
    const { startServer } = await import(pathToFileURL(path.join(__dirname, '..', 'src', 'server.mjs')).href);
    backend = await startServer({ dataDir: path.join(app.getPath('userData'), 'data'), port: 0 });
  }
  window = new BrowserWindow({
    width: 1500,
    height: 980,
    minWidth: 960,
    minHeight: 640,
    title: 'Cycle · 本地训练日志',
    backgroundColor: '#f6f7f9',
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false
    }
  });
  window.setMenuBarVisibility(false);
  const localOrigin = new URL(backend.url).origin;
  const allowLocal = (value) => {
    try { return new URL(value).origin === localOrigin; } catch { return false; }
  };
  window.webContents.on('will-navigate', (event, url) => {
    if (!allowLocal(url)) event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalLink(url)) shell.openExternal(url).catch(console.error);
    return { action: 'deny' };
  });
  window.webContents.on('page-title-updated', event => event.preventDefault());
  window.once('ready-to-show', () => window?.show());
  window.on('closed', () => { window = null; });
  await window.loadURL(backend.url);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (window) {
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    } else if (app.isReady()) {
      createWindow().catch(handleStartupError);
    }
  });
  app.whenReady().then(async () => {
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    await createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow().catch(handleStartupError);
    });
  }).catch(handleStartupError);
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('before-quit', event => {
    if (quitReady || !backend) return;
    event.preventDefault();
    quitReady = true;
    Promise.resolve(backend.close()).catch(console.error).finally(() => app.quit());
  });
}

function handleStartupError(error) {
  console.error(error);
  dialog.showErrorBox('Cycle 启动失败', error?.stack || String(error));
  app.quit();
}
