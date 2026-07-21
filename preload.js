const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Window controls
  minimize:     () => ipcRenderer.send('window-minimize'),
  close:        () => ipcRenderer.send('window-close'),
  maximize:     () => ipcRenderer.send('window-maximize'),
  openExternal: (url) => ipcRenderer.send('open-external', url),

  // Steam
  getSteamPath:          ()       => ipcRenderer.invoke('get-steam-path'),
  findGameFolderByAppId: (args)   => ipcRenderer.invoke('find-game-folder-by-appid', args),

  // Install
  injectGame:    (args) => ipcRenderer.invoke('inject-game', args),
  installBypass: (args) => ipcRenderer.invoke('install-bypass', args),
  removeGame:    (args) => ipcRenderer.invoke('remove-game', args),
  removeBypass:  (args) => ipcRenderer.invoke('remove-bypass', args),
  cancelDownload:()     => ipcRenderer.invoke('cancel-download'),
  restartSteam:  (steamPath) => ipcRenderer.invoke('restart-steam', steamPath),

  // Download progress events
  onDownloadProgress: (cb) => ipcRenderer.on('download-progress', (_, data) => cb(data)),

  // Device Lock — kumpulkan info hardware buat fingerprint perangkat
  getDeviceInfo: () => ipcRenderer.invoke('get-device-info'),

  // ── Auto Update Launcher ──
  getAppVersion:    ()      => ipcRenderer.invoke('get-app-version'),
  startUpdate:      (args)  => ipcRenderer.invoke('update:start', args),
  cancelUpdateDownload: ()  => ipcRenderer.invoke('cancel-download'),
  onUpdateProgress: (cb) => ipcRenderer.on('update:progress', (_, data) => cb(data)),
  onUpdateStatus:   (cb) => ipcRenderer.on('update:status',   (_, data) => cb(data)),
});