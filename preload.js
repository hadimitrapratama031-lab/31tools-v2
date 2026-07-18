const { contextBridge, ipcRenderer } = require('electron');

// Cuma expose fungsi yang benar-benar dibutuhkan renderer — bukan seluruh Node.js API.
contextBridge.exposeInMainWorld('electronAPI', {
  minimize: () => ipcRenderer.send('window-minimize'),
  close: () => ipcRenderer.send('window-close'),
  openExternal: (url) => ipcRenderer.send('open-external', url)
});
