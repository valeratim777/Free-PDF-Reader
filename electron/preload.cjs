// Minimal bridge for the desktop shell: PDFs handed over by the operating system
// and what the update check needs to know about this installation.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  pendingFiles: () => ipcRenderer.invoke('pending-files'),
  onOpenFile: (cb) => ipcRenderer.on('open-file', (_e, file) => cb(file)),
  appInfo: () => ipcRenderer.invoke('app-info'),
});
