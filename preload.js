const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Window controls
  minimize:     () => ipcRenderer.send('window-minimize'),
  close:        () => ipcRenderer.send('window-close'),
  maximize:     () => ipcRenderer.send('window-maximize'),
  openExternal: (url) => ipcRenderer.send('open-external', url),
  // Alias/tambahan untuk titlebar kustom APP DEMO (dipakai oleh app/app.js
  // hasil migrasi) — reuse channel IPC yang sama persis di atas, cuma nama
  // method di sisi renderer disesuaikan biar cocok dipanggil dari UI baru.
  toggleMaximize: () => ipcRenderer.send('window-maximize'),
  isMaximized:    () => ipcRenderer.invoke('window:is-maximized'),
  onMaximizedChange: (callback) => ipcRenderer.on('window:maximized', (_e, isMaximized) => callback(isMaximized)),

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

  // Automatic Watermark Detection — scan folder Game/Bypass lokal utk file watermark
  scanWatermarks: (args) => ipcRenderer.invoke('scan-watermarks', args),

  // Steam & Discord Detection (halaman Settings)
  getSystemDetection: () => ipcRenderer.invoke('get-system-detection'),
  openFolder: (folderPath) => ipcRenderer.invoke('open-folder', folderPath),
  onSystemDetectionStatus: (cb) => ipcRenderer.on('system-detection-status', (_, data) => cb(data)),

  // Auto Update / Force Update (GitHub Releases)
  getAppVersion:            () => ipcRenderer.invoke('get-app-version'),
  checkPendingUpdateResult: () => ipcRenderer.invoke('check-pending-update-result'),
  downloadAppUpdate:        (args) => ipcRenderer.invoke('download-app-update', args),
  cancelAppUpdateDownload:  () => ipcRenderer.invoke('cancel-app-update-download'),
  installAppUpdate:         (args) => ipcRenderer.invoke('install-app-update', args),
  onAppUpdateProgress:      (cb) => ipcRenderer.on('app-update-progress', (_, data) => cb(data)),
  removeAppUpdateProgressListeners: () => ipcRenderer.removeAllListeners('app-update-progress'),

  // Active Tools (halaman Settings)
  activeToolsInstall:     (args) => ipcRenderer.invoke('active-tools-install', args),
  activeToolsCheckStatus: (args) => ipcRenderer.invoke('active-tools-check-status', args),
  // Active Tools — metode BARU "PowerShell Command" (lihat main.js). Sistem
  // Link di atas (activeToolsInstall/activeToolsCheckStatus) tidak diubah.
  activeToolsRunPowerShell:    (args) => ipcRenderer.invoke('active-tools-run-powershell', args),
  onActiveToolsPsProgress:     (cb) => ipcRenderer.on('active-tools-ps-progress', (_, data) => cb(data)),
  removeActiveToolsPsListeners: () => ipcRenderer.removeAllListeners('active-tools-ps-progress'),
  cloudFixInstall:        (args) => ipcRenderer.invoke('cloud-fix-install', args),
  cloudFixCheckStatus:    (args) => ipcRenderer.invoke('cloud-fix-check-status', args),
  launchSteam:            (steamPath) => ipcRenderer.invoke('launch-steam', steamPath),

  // Steam Account Marketplace — tombol "LOGIN AKUN"
  steamAccountLogin: (args) => ipcRenderer.invoke('steam-account-login', args),
  onSteamAccountLoginProgress: (cb) => ipcRenderer.on('steam-account-login-progress', (_, data) => cb(data)),
  removeSteamAccountLoginProgressListeners: () => ipcRenderer.removeAllListeners('steam-account-login-progress'),
});