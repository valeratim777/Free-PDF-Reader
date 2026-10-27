// Desktop shell (Windows / Linux / macOS): shows the built web app in a native
// window, opens PDFs passed by the system ("Open with", double-click) and asks
// before closing with unsaved changes.
const { app, BrowserWindow, Menu, dialog, ipcMain, net, protocol, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const DIST = path.join(__dirname, '..', 'dist');
const ORIGIN = 'app://pdf-reader';

// A privileged scheme behaves like https: fetch, workers and storage all work
// and the origin stays the same between launches (saved signatures, sessions).
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

let win = null;
let pending = [];

const pdfArgs = (argv) => argv.slice(1).filter((a) => /\.pdf$/i.test(a) && fs.existsSync(a));
const readPdf = (p) => ({ name: path.basename(p), data: fs.readFileSync(p) });

function openInWindow(p) {
  if (win && !win.webContents.isLoading()) win.webContents.send('open-file', readPdf(p));
  else pending.push(p);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 360,
    minHeight: 480,
    backgroundColor: '#f3f4f6',
    title: 'PDF Reader',
    icon: path.join(DIST, 'icons', 'icon-512.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      spellcheck: false,
    },
  });
  win.loadURL(`${ORIGIN}/index.html`);

  // Links leave the app and open in the default browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(ORIGIN)) {
      e.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });

  // The page asks to stay open when there are unsaved edits; confirm natively.
  win.webContents.on('will-prevent-unload', (e) => {
    const ru = app.getLocale().toLowerCase().startsWith('ru');
    const choice = dialog.showMessageBoxSync(win, {
      type: 'question',
      buttons: ru ? ['Закрыть без сохранения', 'Отмена'] : ['Close without saving', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'PDF Reader',
      message: ru ? 'Есть несохранённые изменения. Закрыть без сохранения?' : 'You have unsaved changes. Close without saving?',
    });
    if (choice === 0) e.preventDefault();
  });

  // "Download" and exports: ask where to save, starting in Documents.
  win.webContents.session.on('will-download', (_e, item) => {
    const name = item.getFilename();
    const ext = path.extname(name).slice(1).toLowerCase();
    const target = dialog.showSaveDialogSync(win, {
      defaultPath: path.join(app.getPath('documents'), name),
      filters: ext ? [{ name: ext.toUpperCase(), extensions: [ext] }] : [],
    });
    if (target) item.setSavePath(target);
    else item.cancel();
  });

  win.on('closed', () => {
    win = null;
  });
}

// The portable .exe sets PORTABLE_EXECUTABLE_FILE; updates then point to the portable download.
ipcMain.handle('app-info', () => ({ version: app.getVersion(), portable: !!process.env.PORTABLE_EXECUTABLE_FILE, platform: process.platform }));

ipcMain.handle('pending-files', () => {
  const files = pending.filter((p) => fs.existsSync(p)).map(readPdf);
  pending = [];
  return files;
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  pending = pdfArgs(process.argv);

  app.on('second-instance', (_e, argv) => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
    pdfArgs(argv).forEach(openInWindow);
  });

  // macOS delivers files this way.
  app.on('open-file', (e, p) => {
    e.preventDefault();
    openInWindow(p);
  });

  app.whenReady().then(() => {
    protocol.handle('app', (req) => {
      let p = decodeURIComponent(new URL(req.url).pathname);
      if (p === '/' || p === '') p = '/index.html';
      const file = path.normalize(path.join(DIST, p));
      if (!file.startsWith(DIST)) return new Response('Not found', { status: 404 });
      return net.fetch(pathToFileURL(file).toString());
    });
    Menu.setApplicationMenu(null);
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
