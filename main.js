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
// extractZip — implementasi native tanpa dependency external
// Menggunakan PowerShell Expand-Archive (tersedia di Windows 10+) sebagai fallback utama
// dan manual ZIP extraction via Node zlib sebagai alternatif
const { execSync: _execSync } = require('child_process');
async function extractZip(zipPath, { dir }) {
  const fs2 = require('fs');
  const path2 = require('path');
  if (!fs2.existsSync(dir)) fs2.mkdirSync(dir, { recursive: true });
  
  try {
    // Windows: pakai PowerShell Expand-Archive (zero dependency, tersedia Windows 10+)
    const safeSrc  = zipPath.replace(/'/g, "''");
    const safeDest = dir.replace(/'/g, "''");
    _execSync(
      `powershell -NoProfile -NonInteractive -Command "Expand-Archive -LiteralPath '${safeSrc}' -DestinationPath '${safeDest}' -Force"`,
      { windowsHide: true, timeout: 120000 }
    );
    return;
  } catch(e1) {
    // Fallback: manual unzip pakai yauzl-style reading lewat Buffer + zlib
    // Baca ZIP file manual
    const buf = fs2.readFileSync(zipPath);
    const entries = parseZip(buf);
    for (const entry of entries) {
      if (entry.name.endsWith('/')) {
        fs2.mkdirSync(path2.join(dir, entry.name), { recursive: true });
        continue;
      }
      const outPath = path2.join(dir, entry.name);
      fs2.mkdirSync(path2.dirname(outPath), { recursive: true });
      fs2.writeFileSync(outPath, entry.data);
    }
  }
}

function parseZip(buf) {
  const zlib2 = require('zlib');
  const entries = [];
  let i = 0;
  while (i < buf.length - 4) {
    // Local file header signature = 0x04034b50
    if (buf[i]===0x50 && buf[i+1]===0x4B && buf[i+2]===0x03 && buf[i+3]===0x04) {
      const compression  = buf.readUInt16LE(i + 8);
      const compSize     = buf.readUInt32LE(i + 18);
      const fnLen        = buf.readUInt16LE(i + 26);
      const extraLen     = buf.readUInt16LE(i + 28);
      const name         = buf.slice(i + 30, i + 30 + fnLen).toString('utf8');
      const dataStart    = i + 30 + fnLen + extraLen;
      const compData     = buf.slice(dataStart, dataStart + compSize);
      let data;
      if (compression === 0) {
        data = compData; // stored
      } else if (compression === 8) {
        data = zlib2.inflateRawSync(compData); // deflate
      } else {
        i++; continue; // skip unknown
      }
      entries.push({ name, data });
      i = dataStart + compSize;
    } else {
      i++;
    }
  }
  return entries;
}

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
      nodeIntegration: false,
      // Video tutorial (YouTube/TikTok) di-embed pakai <webview>, bukan <iframe>.
      // App di-load lewat file:// (loadFile di bawah), dan YouTube menolak embed
      // <iframe> dari origin file:// (persis Error 153 "Video player configuration
      // error"). <webview> membuka halaman embed sebagai konteks navigasi sendiri
      // (origin youtube.com/tiktok.com yang sebenarnya), jadi lolos pengecekan itu.
      webviewTag: true
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

function downloadFileWithProgress(url, destPath, onProgress, redirectCount = 0, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 10) return reject(new Error('Terlalu banyak redirect'));

    // SECURITY: hanya izinkan download dari domain-domain terpercaya. Semua file game/bypass
    // di app ini SUDAH lewat proxy server sendiri (/api/games/:id/stream, /api/bypasses/:id/stream),
    // jadi url yang sampai ke sini seharusnya selalu server sendiri. Allowlist ini jaga-jaga
    // supaya kalau suatu saat ada bug/kebocoran URL mentah, app tetap menolak download-nya
    // alih-alih diam-diam download dari host sembarangan.
    const OWN_SERVER_HOST = '31tools-v2-production.up.railway.app'; // domain server sendiri — WAJIB, semua stream lewat sini
    const ALLOWED_DOWNLOAD_HOSTS = [
      OWN_SERVER_HOST,
      'hubcapmanifest.com',                   // HubCap manifest API — untuk game inject
      'github.com',
      'raw.githubusercontent.com',
      'objects.githubusercontent.com',
      'release-assets.githubusercontent.com',
      'cdn.discordapp.com',
      'media.discordapp.net',
      'drive.google.com',
      'docs.google.com',
      'storage.googleapis.com',
      'generator.ryuu.lol',                   // Ryuu — link bypass langsung dari admin
      'ryuu.lol',
    ];
    try {
      const parsedUrl = new URL(url);
      const host = parsedUrl.hostname.toLowerCase();
      const allowed = ALLOWED_DOWNLOAD_HOSTS.some(h => host === h || host.endsWith('.' + h));
      if (!allowed) {
        return reject(new Error(`Download ditolak: host "${host}" tidak ada dalam daftar terpercaya.`));
      }
    } catch (urlErr) {
      return reject(new Error('URL download tidak valid: ' + url));
    }

    const client = url.startsWith('https') ? https : http;
    // User-Agent browser supaya host seperti ryuu.lol tidak blokir (403 host_not_allowed)
    // Referer juga WAJIB ditambahkan untuk host pihak ketiga: banyak file-hosting seperti
    // ryuu.lol menerapkan proteksi hotlink (nolak request tanpa Referer dari domain mereka
    // sendiri) dan akan balas 401/403 walau User-Agent sudah disamarkan jadi browser biasa.
    // Referer HANYA ditambahkan kalau caller belum menyertakan sendiri di extraHeaders,
    // dan HANYA untuk host selain server kita sendiri (server kita tidak butuh Referer).
    const ownServerHost = OWN_SERVER_HOST;
    const hasCustomReferer = Object.keys(extraHeaders).some(k => k.toLowerCase() === 'referer');
    const currentHost = new URL(url).hostname.toLowerCase();
    const autoReferer = (!hasCustomReferer && currentHost !== ownServerHost)
      ? { Referer: new URL(url).origin + '/' }
      : {};
    const reqHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': '*/*',
      ...autoReferer,
      ...extraHeaders
    };
    const request = client.get(url, { headers: reqHeaders }, (response) => {
      // Handle redirect
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        let location = response.headers.location;
        if (location.startsWith('/')) location = new URL(url).origin + location;
        // Saat redirect ke domain lain, JANGAN teruskan Authorization header
        // (Bearer token server kita tidak berlaku di GitHub/GDrive/dll dan akan kena 401)
        let redirectHeaders = { ...extraHeaders };
        try {
          const origHost = new URL(url).hostname;
          const locFull  = location.startsWith('/') ? (new URL(url).origin + location) : location;
          const newHost  = new URL(locFull).hostname;
          if (origHost !== newHost) {
            // Domain berbeda — hapus Authorization agar tidak dikirim ke host lain
            delete redirectHeaders['Authorization'];
            delete redirectHeaders['authorization'];
          }
        } catch(e2) {}
        return resolve(downloadFileWithProgress(location, destPath, onProgress, redirectCount + 1, redirectHeaders));
      }
      if (response.statusCode === 401 || response.statusCode === 403 || (response.statusCode >= 400 && response.statusCode < 600)) {
        let rawBody = '';
        response.on('data', (chunk) => { rawBody += chunk; });
        response.on('end', () => {
          let serverMsg = null;
          try {
            const parsed = JSON.parse(rawBody);
            if (parsed && typeof parsed.error === 'string' && parsed.error.trim()) serverMsg = parsed.error;
          } catch(e3) {
            // Bukan JSON — coba pakai teks mentahnya kalau pendek & bermakna
            const trimmed = rawBody.trim();
            if (trimmed && trimmed.length < 300 && !trimmed.startsWith('<')) {
              serverMsg = `Link bypass bermasalah: "${trimmed}". Minta admin ganti dengan link GitHub Release yang valid.`;
            }
          }

          if (serverMsg) return reject(new Error(serverMsg));

          const host = (() => { try { return new URL(url).hostname.toLowerCase(); } catch(e4) { return ''; } })();
          if (response.statusCode === 401) {
            let errMsg401 = 'Sesi login kamu expired. Silakan logout dan login ulang.';
            if (host.includes('hubcap')) errMsg401 = 'API Key HubCap tidak valid atau expired. Hubungi admin.';
            else if (host.includes('ryuu')) errMsg401 = 'Link bypass Ryuu memerlukan auth — gunakan link GitHub Release sebagai gantinya. Minta admin update link bypass.';
            else if (host !== ownServerHost) errMsg401 = `Link file ditolak oleh server (401): ${host}. Kemungkinan link sudah kedaluwarsa atau diproteksi. Hubungi admin untuk ganti link.`;
            return reject(new Error(errMsg401));
          }
          if (response.statusCode === 403) {
            return reject(new Error('Tidak punya izin download file ini (403). Pastikan paket kamu sesuai.'));
          }
          return reject(new Error(`Download gagal, server mengembalikan status ${response.statusCode}`));
        });
        return;
      }
      const total = parseInt(response.headers['content-length'] || '0', 10);
      let downloaded = 0;
      const file = fs.createWriteStream(destPath);
      activeDownloadFile = file;
      response.on('data', (chunk) => {
        downloaded += chunk.length;
        if (onProgress) onProgress(downloaded, total);
        // Kirim ke renderer — pakai KEDUA nama event agar kompatibel
        mainWindow?.webContents.send('download-progress', { downloaded, total });
        mainWindow?.webContents.send('inject-download-progress', { downloaded, total });
      });
      response.pipe(file);
      file.on('finish', () => {
        activeDownloadRequest = null;
        activeDownloadFile = null;
        file.close(resolve);
      });
      file.on('error', (err) => {
        activeDownloadRequest = null;
        activeDownloadFile = null;
        file.close();
        fs.unlink(destPath, () => {});
        reject(err);
      });
    });
    activeDownloadRequest = request;
    request.on('error', (err) => {
      activeDownloadRequest = null;
      activeDownloadFile = null;
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
ipcMain.handle('inject-game', async (event, { steamPath, zipUrl, extraHeaders }) => {
  const tempZip = path.join(app.getPath('temp'), 'inject_' + Date.now() + '.zip');
  const tempDir = path.join(app.getPath('temp'), 'inject_extract_' + Date.now());
  try {
    // Download — teruskan extraHeaders (termasuk Authorization untuk hubcap)
    await downloadFileWithProgress(zipUrl, tempZip, null, 0, extraHeaders || {});

    // Validasi ZIP signature
    const head = fs.readFileSync(tempZip, { encoding: null }).slice(0, 4);
    if (head[0] !== 0x50 || head[1] !== 0x4B) throw new Error('File bukan ZIP valid — URL mungkin salah atau akses ditolak server.');

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

ipcMain.handle('install-bypass', async (event, { folderPath, driveUrl, userId, deviceId, gameId, gameName, steamAppId, extraHeaders }) => {
  const tempZipPath = path.join(app.getPath('temp'), 'bypass_' + Date.now() + '.zip');
  const tempExtractDir = path.join(app.getPath('temp'), 'bypass_extract_' + Date.now());
  try {
    if (!folderPath || !fs.existsSync(folderPath)) {
      throw new Error('Folder game tujuan tidak ditemukan: ' + folderPath);
    }

    const resolvedFolder = path.resolve(folderPath);
    const normalizedFolder = resolvedFolder.toLowerCase().replace(/\\/g, '/');

    if (!normalizedFolder.includes('steamapps/common')) {
      throw new Error('Folder tujuan harus berada di dalam steamapps/common');
    }

    const forbiddenPaths = [
      process.env.SystemRoot || 'C:\\Windows',
      process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'AppData', 'Roaming') : '',
      process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'AppData', 'Local', 'Microsoft') : '',
    ].filter(Boolean).map(p => path.resolve(p));
    for (const forbidden of forbiddenPaths) {
      if (resolvedFolder.toLowerCase().startsWith(forbidden.toLowerCase())) {
        throw new Error('Folder tujuan tidak diizinkan (sistem/AppData): ' + resolvedFolder);
      }
    }

    // Download dari URL yang admin set, ATAU dari streamPath proxy server sendiri (butuh
    // extraHeaders/Authorization kalau link-nya perlu auth, mis. Ryuu Generator).
    await downloadFileWithProgress(driveUrl, tempZipPath, null, 0, extraHeaders || {});

    // Validasi: file harus diawali signature ZIP (PK\x03\x04)
    const headBuf = fs.readFileSync(tempZipPath, { encoding: null, flag: 'r' }).slice(0, 4);
    const isZip = headBuf[0] === 0x50 && headBuf[1] === 0x4B;
    if (!isZip) {
      throw new Error('File yang didownload bukan ZIP valid (kemungkinan link bermasalah atau sudah kedaluwarsa)');
    }

    // Extract ke folder temp dulu — struktur ZIP dipertahankan apa adanya (tidak di-flatten)
    fs.mkdirSync(tempExtractDir, { recursive: true });
    await extractZip(tempZipPath, { dir: tempExtractDir });

    // Walk semua file di temp untuk catat extractedFiles
    const extractedFiles = [];
    function walkBypassDir(dir, baseDir) {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walkBypassDir(fullPath, baseDir);
        } else {
          const relPath = path.relative(baseDir, fullPath).replace(/\\/g, '/');
          extractedFiles.push(relPath);
        }
      }
    }
    walkBypassDir(tempExtractDir, tempExtractDir);

    // Salin semua isi ke folder game, menimpa file yang sudah ada
    copyDirOverwrite(tempExtractDir, folderPath);

    fs.unlinkSync(tempZipPath);
    try { fs.rmSync(tempExtractDir, { recursive: true, force: true }); } catch(e2) {}

    return { success: true, extractedFiles, folderPath };
  } catch (e) {
    try { fs.unlinkSync(tempZipPath); } catch(e2) {}
    try { fs.rmSync(tempExtractDir, { recursive: true, force: true }); } catch(e2) {}
    if (e.message === 'CANCELLED') return { success: false, cancelled: true };
    return { success: false, error: e.message };
  }
});

// ── Remove bypass (hapus file-file spesifik hasil extract dari folder game) ──
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

// ══════════════════════════════════════════════════════════════════════════
// DEVICE LOCK — kumpulkan info hardware buat dijadikan fingerprint perangkat.
// ══════════════════════════════════════════════════════════════════════════
// Dipanggil sekali tiap sesi login (bukan tiap request API) lewat electronAPI.getDeviceInfo().
// Semua query lewat PowerShell (Get-CimInstance) — tidak butuh dependency npm baru.
// Kombinasi 4 komponen dipakai sebagai fingerprint (bukan cuma 1 macam data):
//   1. MachineGuid Windows (registry, HKLM\SOFTWARE\Microsoft\Cryptography)
//   2. CPU (nama, jumlah core/thread)
//   3. Motherboard (vendor + serial/model)
//   4. Disk utama (model + serial)
// Server yang menghitung hash & fingerprint akhir (lihat deviceLock.js) — di sini
// cuma mengumpulkan raw value-nya, TERMASUK yang buat ditampilkan admin (CPU/RAM/GPU/OS).
function runPS(cmd, timeout = 12000) {
  try {
    return execSync(`powershell -NoProfile -NonInteractive -Command "${cmd.replace(/"/g, '\\"')}"`, {
      windowsHide: true, timeout, encoding: 'utf8'
    }).trim();
  } catch (e) {
    return '';
  }
}

ipcMain.handle('get-device-info', async () => {
  try {
    const os = require('os');

    // Satu panggilan PowerShell buat semua CIM query sekaligus (lebih cepat daripada
    // spawn proses terpisah tiap komponen).
    const psScript = `
      $ErrorActionPreference = 'SilentlyContinue'
      $cpu   = Get-CimInstance Win32_Processor | Select-Object -First 1 Name, NumberOfCores, NumberOfLogicalProcessors
      $cs    = Get-CimInstance Win32_ComputerSystem | Select-Object -First 1 Manufacturer, Model, Name, TotalPhysicalMemory
      $gpu   = Get-CimInstance Win32_VideoController | Select-Object -First 1 Name
      $bb    = Get-CimInstance Win32_BaseBoard | Select-Object -First 1 Manufacturer, Product, SerialNumber
      $disk  = Get-CimInstance Win32_DiskDrive | Sort-Object Index | Select-Object -First 1 Model, Size, SerialNumber
      $osi   = Get-CimInstance Win32_OperatingSystem | Select-Object -First 1 Caption, Version, BuildNumber, OSArchitecture
      $guid  = (Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Cryptography' -Name MachineGuid -ErrorAction SilentlyContinue).MachineGuid
      [PSCustomObject]@{ cpu=$cpu; cs=$cs; gpu=$gpu; bb=$bb; disk=$disk; osi=$osi; machineGuid=$guid } | ConvertTo-Json -Depth 4 -Compress
    `;
    const raw = runPS(psScript, 15000);
    let wmi = {};
    try { wmi = JSON.parse(raw || '{}'); } catch (e) { wmi = {}; }

    return {
      pcName:           wmi.cs?.Name || os.hostname() || '',
      windowsUsername:  os.userInfo()?.username || '',
      osName:            wmi.osi?.Caption || `${os.platform()} ${os.release()}`,
      osVersion:        wmi.osi?.Version || os.release() || '',
      osBuild:          wmi.osi?.BuildNumber ? String(wmi.osi.BuildNumber) : '',
      arch:             wmi.osi?.OSArchitecture || os.arch() || '',
      cpuName:          wmi.cpu?.Name || (os.cpus()[0]?.model || ''),
      cpuCores:         wmi.cpu?.NumberOfCores || null,
      cpuThreads:       wmi.cpu?.NumberOfLogicalProcessors || (os.cpus()?.length || null),
      ramTotalBytes:    wmi.cs?.TotalPhysicalMemory ? Number(wmi.cs.TotalPhysicalMemory) : (os.totalmem() || null),
      gpuName:          wmi.gpu?.Name || '',
      boardVendor:      wmi.bb?.Manufacturer || '',
      boardModel:       wmi.bb?.Product || '',
      boardSerial:      wmi.bb?.SerialNumber || '',
      diskModel:        wmi.disk?.Model || '',
      diskSizeBytes:    wmi.disk?.Size ? Number(wmi.disk.Size) : null,
      diskSerial:       wmi.disk?.SerialNumber || '',
      machineGuid:      wmi.machineGuid || '',
      appVersion:       app.getVersion() || '',
    };
  } catch (e) {
    return { error: e.message };
  }
});