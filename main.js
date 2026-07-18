// ══════════════════════════════════════════════════════════════════════════
// NOVA LAUNCHER — ELECTRON MAIN PROCESS
// Beda dari project sebelumnya: pakai contextIsolation + preload (lebih aman),
// bukan nodeIntegration langsung di renderer. Window juga frameless custom.
// ══════════════════════════════════════════════════════════════════════════
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 960,
    minHeight: 600,
    frame: false, // custom title bar dibikin sendiri di app.html/app.js
    backgroundColor: '#0a0713',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'app', 'index.html'));
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ── IPC: kontrol window custom title bar ──
ipcMain.on('window-minimize', () => mainWindow?.minimize());
ipcMain.on('window-close', () => mainWindow?.close());

// ── IPC: buka link di browser default (dipakai buat login Discord) ──
// Login Discord SENGAJA dibuka di browser luar, bukan di dalam app — Discord
// sering nge-block OAuth yang jalan di dalam embedded webview/browser custom.
ipcMain.on('open-external', (event, url) => {
  shell.openExternal(url);
});
