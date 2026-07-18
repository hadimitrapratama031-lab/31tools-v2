// ══════════════════════════════════════════════════════════════════════════
// NOVA LAUNCHER — ELECTRON MAIN PROCESS
// Beda dari project sebelumnya: pakai contextIsolation + preload (lebih aman),
// bukan nodeIntegration langsung di renderer. Window juga frameless custom.
// ══════════════════════════════════════════════════════════════════════════
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { execSync, exec } = require('child_process');
const http = require('http');
const https = require('https');
const extractZip = require('extract-zip');

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

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ── IPC: kontrol window custom title bar ──
ipcMain.on('window-minimize', () => mainWindow?.minimize());
ipcMain.on('window-close', () => mainWindow?.close());
ipcMain.on('window-maximize', () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});

// ── IPC: buka link di browser default (dipakai buat login Discord) ──
// Login Discord SENGAJA dibuka di browser luar, bukan di dalam app — Discord
// sering nge-block OAuth yang jalan di dalam embedded webview/browser custom.
ipcMain.on('open-external', (event, url) => {
  shell.openExternal(url);
});
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ── IPC: kontrol window ──
ipcMain.on('window-minimize', () => mainWindow?.minimize());
ipcMain.on('window-close',    () => mainWindow?.close());
ipcMain.on('window-maximize', () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.on('open-external', (event, url) => shell.openExternal(url));

// ── Detect Steam path dari registry ──
ipcMain.handle('get-steam-path', () => {
  try {
    const reg = execSync('reg query "HKCU\\Software\\Valve\\Steam" /v SteamPath').toString();
    const match = reg.match(/SteamPath\s+REG_SZ\s+(.+)/);
    if (match) return match[1].trim();
  } catch (e) {}
  return null;
});

// ── Parse semua Steam library folders ──
function getSteamLibraryFolders(steamPath) {
  const libraries = [steamPath];
  try {
    const vdfPath = path.join(steamPath, 'steamapps', 'libraryfolders.vdf');
    if (!fs.existsSync(vdfPath)) return libraries;
    const content = fs.readFileSync(vdfPath, 'utf8');
    const matches = content.matchAll(/"path"\s+"([^"]+)"/g);
    for (const m of matches) {
      const libPath = m[1].replace(/\\\\/g, '\\');
      if (!libraries.includes(libPath)) libraries.push(libPath);
    }
  } catch (e) {}
  return libraries;
}

// ── Cari folder game berdasarkan Steam App ID ──
ipcMain.handle('find-game-folder-by-appid', (event, { steamPath, appId }) => {
  try {
    if (!steamPath || !appId) return { found: false, error: 'Steam path atau App ID tidak valid' };
    const libraries = getSteamLibraryFolders(steamPath);
    for (const lib of libraries) {
      const manifestPath = path.join(lib, 'steamapps', `appmanifest_${appId}.acf`);
      if (fs.existsSync(manifestPath)) {
        const manifest = fs.readFileSync(manifestPath, 'utf8');
        const match = manifest.match(/"installdir"\s+"([^"]+)"/);
        if (match) {
          const gameFolder = path.join(lib, 'steamapps', 'common', match[1]);
          if (fs.existsSync(gameFolder)) return { found: true, folderPath: gameFolder };
        }
      }
    }
    return { found: false, error: `Game belum terinstall di Steam (App ID ${appId} tidak ditemukan)` };
  } catch (e) {
    return { found: false, error: e.message };
  }
});

// ── Download file dengan progress ──
let activeDownloadRequest = null;
let activeDownloadFile = null;

function downloadFileWithProgress(url, destPath, onProgress, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 10) return reject(new Error('Terlalu banyak redirect'));
    const client = url.startsWith('https') ? https : http;
    const request = client.get(url, { headers: { 'User-Agent': 'NovaLauncher' } }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        let location = response.headers.location;
        if (location.startsWith('/')) location = new URL(url).origin + location;
        return resolve(downloadFileWithProgress(location, destPath, onProgress, redirectCount + 1));
      }
      if (response.statusCode !== 200) {
        response.resume();
        return reject(new Error('Download gagal, status ' + response.statusCode));
      }
      const total = parseInt(response.headers['content-length'] || '0', 10);
      let downloaded = 0;
      const file = fs.createWriteStream(destPath);
      activeDownloadFile = file;
      response.on('data', (chunk) => {
        downloaded += chunk.length;
        if (onProgress) onProgress(downloaded, total);
        mainWindow?.webContents.send('download-progress', { downloaded, total });
      });
      response.pipe(file);
      file.on('finish', () => { activeDownloadRequest = null; activeDownloadFile = null; file.close(resolve); });
      file.on('error', (err) => { activeDownloadRequest = null; activeDownloadFile = null; file.close(); fs.unlink(destPath, () => {}); reject(err); });
    });
    activeDownloadRequest = request;
    request.on('error', (err) => {
      activeDownloadRequest = null; activeDownloadFile = null;
      fs.unlink(destPath, () => {});
      reject(err.message === 'CANCELLED' ? new Error('CANCELLED') : err);
    });
  });
}

ipcMain.handle('cancel-download', () => {
  try {
    if (activeDownloadRequest) { activeDownloadRequest.destroy(new Error('CANCELLED')); activeDownloadRequest = null; }
    if (activeDownloadFile) { activeDownloadFile.close(); activeDownloadFile = null; }
    return { success: true };
  } catch (e) { return { success: false, error: e.message }; }
});

// ── INJECT GAME: extract ZIP → .lua ke stplug-in, .manifest ke depotcache ──
ipcMain.handle('inject-game', async (event, { steamPath, zipUrl }) => {
  const tempZip = path.join(app.getPath('temp'), 'inject_' + Date.now() + '.zip');
  const tempDir = path.join(app.getPath('temp'), 'inject_extract_' + Date.now());
  try {
    // Download
    await downloadFileWithProgress(zipUrl, tempZip);

    // Validasi ZIP signature
    const head = fs.readFileSync(tempZip, { encoding: null }).slice(0, 4);
    if (head[0] !== 0x50 || head[1] !== 0x4B) throw new Error('File bukan ZIP valid');

    // Siapkan folder tujuan
    const stplugDir    = path.join(steamPath, 'config', 'stplug-in');
    const depotcacheDir = path.join(steamPath, 'config', 'depotcache');
    fs.mkdirSync(stplugDir,     { recursive: true });
    fs.mkdirSync(depotcacheDir, { recursive: true });

    // Extract ke temp
    fs.mkdirSync(tempDir, { recursive: true });
    await extractZip(tempZip, { dir: tempDir });

    // Walk dan copy berdasarkan ekstensi
    const extractedFiles = [];
    function walkDir(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) { walkDir(fullPath); continue; }
        const ext = path.extname(entry.name).toLowerCase();
        let destDir = null;
        if (ext === '.lua')      destDir = stplugDir;
        if (ext === '.manifest') destDir = depotcacheDir;
        if (destDir) {
          fs.copyFileSync(fullPath, path.join(destDir, entry.name));
          extractedFiles.push((ext === '.lua' ? 'stplug-in/' : 'depotcache/') + entry.name);
        }
      }
    }
    walkDir(tempDir);

    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch(e2) {}
    try { fs.unlinkSync(tempZip); } catch(e2) {}
    return { success: true, extractedFiles };
  } catch (e) {
    try { fs.unlinkSync(tempZip); } catch(e2) {}
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch(e2) {}
    if (e.message === 'CANCELLED') return { success: false, cancelled: true };
    return { success: false, error: e.message };
  }
});

// ── INSTALL BYPASS: auto-detect folder game via appId, extract ZIP ke sana ──
function copyDirOverwrite(srcDir, destDir) {
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const src = path.join(srcDir, entry.name);
    const dst = path.join(destDir, entry.name);
    if (entry.isDirectory()) copyDirOverwrite(src, dst);
    else fs.copyFileSync(src, dst);
  }
}

ipcMain.handle('install-bypass', async (event, { steamPath, appId, zipUrl }) => {
  const tempZip = path.join(app.getPath('temp'), 'bypass_' + Date.now() + '.zip');
  const tempDir = path.join(app.getPath('temp'), 'bypass_extract_' + Date.now());
  try {
    // 1. Cari folder game via appId
    if (!steamPath) throw new Error('Steam tidak terdeteksi di PC ini');
    const libraries = getSteamLibraryFolders(steamPath);
    let folderPath = null;
    for (const lib of libraries) {
      const manifestPath = path.join(lib, 'steamapps', `appmanifest_${appId}.acf`);
      if (fs.existsSync(manifestPath)) {
        const manifest = fs.readFileSync(manifestPath, 'utf8');
        const match = manifest.match(/"installdir"\s+"([^"]+)"/);
        if (match) {
          const gf = path.join(lib, 'steamapps', 'common', match[1]);
          if (fs.existsSync(gf)) { folderPath = gf; break; }
        }
      }
    }
    if (!folderPath) throw new Error(`Game dengan App ID ${appId} belum terinstall di Steam. Install gamenya dulu ya.`);

    // Validasi: harus di dalam steamapps/common
    const normalizedFolder = path.resolve(folderPath).toLowerCase().replace(/\\/g, '/');
    if (!normalizedFolder.includes('steamapps/common')) throw new Error('Folder tujuan tidak valid');

    // 2. Download
    await downloadFileWithProgress(zipUrl, tempZip);

    // Validasi ZIP
    const head = fs.readFileSync(tempZip, { encoding: null }).slice(0, 4);
    if (head[0] !== 0x50 || head[1] !== 0x4B) throw new Error('File bukan ZIP valid');

    // 3. Extract ke temp
    fs.mkdirSync(tempDir, { recursive: true });
    await extractZip(tempZip, { dir: tempDir });

    // 4. Catat semua file yang akan dicopy
    const extractedFiles = [];
    function walkBypass(dir, baseDir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) { walkBypass(fullPath, baseDir); continue; }
        extractedFiles.push(path.relative(baseDir, fullPath).replace(/\\/g, '/'));
      }
    }
    walkBypass(tempDir, tempDir);

    // 5. Copy ke folder game (overwrite)
    copyDirOverwrite(tempDir, folderPath);

    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch(e2) {}
    try { fs.unlinkSync(tempZip); } catch(e2) {}
    return { success: true, extractedFiles, folderPath };
  } catch (e) {
    try { fs.unlinkSync(tempZip); } catch(e2) {}
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch(e2) {}
    if (e.message === 'CANCELLED') return { success: false, cancelled: true };
    return { success: false, error: e.message };
  }
});

// ── Remove game (hapus .lua & .manifest) ──
ipcMain.handle('remove-game', (event, { steamPath, extractedFiles }) => {
  try {
    const configDir = path.join(steamPath, 'config');
    let deleted = 0;
    for (const relPath of (extractedFiles || [])) {
      if (typeof relPath !== 'string' || relPath.includes('..') || relPath.includes('\\')) continue;
      const parts = relPath.split('/');
      if (parts.length !== 2) continue;
      const [folder, filename] = parts;
      if (!['stplug-in', 'depotcache'].includes(folder) || !filename) continue;
      const filePath = path.join(configDir, folder, filename);
      if (!filePath.startsWith(configDir + path.sep)) continue;
      try { if (fs.existsSync(filePath)) { fs.unlinkSync(filePath); deleted++; } } catch(e2) {}
    }
    return { success: true, deleted };
  } catch (e) { return { success: false, error: e.message }; }
});

// ── Remove bypass ──
ipcMain.handle('remove-bypass', (event, { folderPath, extractedFiles }) => {
  try {
    if (!folderPath || !fs.existsSync(folderPath)) return { success: true, deleted: 0 };
    const base = path.resolve(folderPath);
    let deleted = 0;
    for (const relPath of (extractedFiles || [])) {
      if (typeof relPath !== 'string' || relPath.includes('..') || relPath.startsWith('/')) continue;
      const filePath = path.join(base, relPath);
      if (!path.resolve(filePath).startsWith(base)) continue;
      try { if (fs.existsSync(filePath)) { fs.unlinkSync(filePath); deleted++; } } catch(e2) {}
    }
    return { success: true, deleted };
  } catch (e) { return { success: false, error: e.message }; }
});

// ── Restart Steam ──
ipcMain.handle('restart-steam', (event, steamPath) => {
  try {
    if (!steamPath || !fs.existsSync(steamPath)) return { success: false, error: 'Steam path tidak ditemukan' };
    const steamExe = path.join(path.resolve(steamPath), 'steam.exe');
    execSync('taskkill /F /IM steam.exe');
    setTimeout(() => exec('"' + steamExe + '"'), 2000);
    return { success: true };
  } catch (e) { return { success: false, error: e.message }; }
});