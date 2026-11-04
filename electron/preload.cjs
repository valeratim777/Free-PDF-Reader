// Minimal bridge for the desktop shell: PDFs handed over by the operating system,
// what the update check needs to know about this installation, installing an
// update, and requests to the online translation service.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  pendingFiles: () => ipcRenderer.invoke('pending-files'),
  onOpenFile: (cb) => ipcRenderer.on('open-file', (_e, file) => cb(file)),
  appInfo: () => ipcRenderer.invoke('app-info'),
  httpGet: (url) => ipcRenderer.invoke('http-get', url),
  installUpdate: (url, sha256) => ipcRenderer.invoke('install-update', url, sha256),
  onUpdateProgress: (cb) => ipcRenderer.on('update-progress', (_e, fraction) => cb(fraction)),
});
