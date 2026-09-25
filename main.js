// ══════════════════════════════════════════════════════════════════════════
// 31 TOOLS — ELECTRON MAIN PROCESS
// Beda dari project sebelumnya: pakai contextIsolation + preload (lebih aman),
// bukan nodeIntegration langsung di renderer. Window juga frameless custom.
// ══════════════════════════════════════════════════════════════════════════
const { app, BrowserWindow, ipcMain, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { execSync, exec, spawn, execFile } = require('child_process');
const http = require('http');
const https = require('https');
// extractZip — implementasi native tanpa dependency external
// Menggunakan PowerShell Expand-Archive (tersedia di Windows 10+) sebagai fallback utama
// dan manual ZIP extraction via Node zlib sebagai alternatif
const { promisify } = require('util');
const _execAsync = promisify(require('child_process').exec);
// PERF FIX (Not Responding saat install game): sebelumnya extractZip() pakai
// execSync() buat panggil PowerShell Expand-Archive — execSync itu BLOCKING,
// artinya SELURUH Main Process (bukan cuma renderer) berhenti total sampai
// proses PowerShell selesai (bisa puluhan detik untuk file besar), jadi semua
// IPC lain (minimize/close/maximize, IPC handler lain yang lagi jalan
// bersamaan) ikut macet dalam rentang waktu itu -> inilah salah satu sumber
// utama "Not Responding". Diganti ke exec() versi promise (non-blocking),
// Main Process tetap bisa memproses event/IPC lain selama extract berjalan.
async function extractZip(zipPath, { dir }) {
  const fs2 = require('fs');
  const path2 = require('path');
  if (!fs2.existsSync(dir)) fs2.mkdirSync(dir, { recursive: true });

  try {
    // Windows: pakai PowerShell Expand-Archive (zero dependency, tersedia Windows 10+)
    const safeSrc  = zipPath.replace(/'/g, "''");
    const safeDest = dir.replace(/'/g, "''");
    await _execAsync(
      `powershell -NoProfile -NonInteractive -Command "Expand-Archive -LiteralPath '${safeSrc}' -DestinationPath '${safeDest}' -Force"`,
      { windowsHide: true, timeout: 120000, maxBuffer: 1024 * 1024 * 10 }
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

// PERF FIX (RAM tinggi saat install game): dulu buat cek "apakah file ini ZIP
// valid" kode-nya fs.readFileSync(seluruh_file) lalu .slice(0,4) — artinya
// SELURUH file (bisa berukuran ratusan MB - beberapa GB untuk game) dibaca
// penuh ke memory cuma buat lihat 4 byte pertamanya, lalu langsung dibuang.
// Ini boros RAM besar-besaran dan juga blocking (readFileSync sync) selama
// file itu selesai dibaca dari disk. Diganti baca 4 byte saja lewat file
// descriptor, sisanya tidak pernah masuk memory.
function readFileHeadSync(filePath, n = 4) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, 0);
    return buf;
  } finally {
    fs.closeSync(fd);
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

// ══════════════════════════════════════════════════════════════════════════
// ZOOM APP (CTRL + +/-/0) — arsitektur yang benar pakai mekanisme zoom NATIF
// Electron (webContents.setZoomFactor), bukan hack CSS transform manual.
//
// Kenapa sebelumnya bisa error/nyangkut:
// - Tidak ada Menu aplikasi eksplisit yang di-set (Menu.setApplicationMenu
//   tidak pernah dipanggil) sehingga Electron memakai default Menu tiap OS,
//   yang accelerator zoom bawaannya TIDAK konsisten pada window frameless
//   (frame:false) — kadang aktif, kadang tidak, tanpa batas min/max, dan
//   tanpa persist, jadi mudah "nyangkut" di skala aneh setelah dipakai
//   berkali-kali.
// - Solusinya: matikan Menu default (Menu.setApplicationMenu(null)) supaya
//   TIDAK ada accelerator zoom ganda/liar, lalu tangani CTRL + +/-/0 SENDIRI
//   lewat 'before-input-event' di webContents window utama, dengan step,
//   batas min/max, dan persist yang jelas — satu sumber kebenaran.
// ══════════════════════════════════════════════════════════════════════════
const ZOOM_MIN = 0.5;      // 50%
const ZOOM_MAX = 2.0;      // 200%
const ZOOM_DEFAULT = 1.0;  // 100%
const ZOOM_STEP = 0.1;     // tiap CTRL + +/- naik/turun 10%

function getZoomSettingsPath() {
  return path.join(app.getPath('userData'), 'zoom-settings.json');
}

function loadSavedZoomFactor() {
  try {
    const raw = fs.readFileSync(getZoomSettingsPath(), 'utf8');
    const data = JSON.parse(raw);
    const z = Number(data.zoomFactor);
    if (!isFinite(z)) return ZOOM_DEFAULT;
    return clampZoom(z);
  } catch (e) {
    return ZOOM_DEFAULT; // belum pernah di-set / file tidak ada / corrupt -> default aman
  }
}

function saveZoomFactor(z) {
  try {
    fs.writeFileSync(getZoomSettingsPath(), JSON.stringify({ zoomFactor: z }));
  } catch (e) {
    // Gagal simpan bukan hal fatal — App tetap jalan, cuma preferensi zoom
    // tidak persist ke sesi berikutnya.
  }
}

function clampZoom(z) {
  const snapped = Math.round(z * 100) / 100; // hindari floating point drift (0.1 + 0.2 dst)
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, snapped));
}

// Terapkan zoom via mekanisme NATIF webContents (bukan CSS manual), clamp ke
// batas wajar, lalu persist supaya konsisten kalau App ditutup & dibuka lagi.
function applyZoom(webContents, targetFactor) {
  if (!webContents || webContents.isDestroyed()) return;
  const clamped = clampZoom(targetFactor);
  webContents.setZoomFactor(clamped);
  saveZoomFactor(clamped);
  return clamped;
}

// Pasang handler CTRL + +/-/0 di SATU window/webContents. Dipanggil per
// window (bukan global) supaya scoped ke window yang sedang fokus saja —
// tidak menyentuh <webview> tutorial video (webContents terpisah, tidak
// ikut ke-zoom, sesuai spec "jangan merusak fitur existing").
function setupZoomHandlers(win) {
  const wc = win.webContents;

  // Matikan pinch/visual zoom bawaan Chromium (beda mekanisme dari layout
  // zoom) supaya tidak ada 2 sistem zoom yang saling tabrakan/konflik state.
  wc.setVisualZoomLevelLimits(1, 1).catch(() => {});

  wc.on('did-finish-load', () => {
    // Restore preferensi zoom terakhir tiap kali halaman selesai dimuat
    // (termasuk reload) — behavior konsisten sesuai setting existing.
    applyZoom(wc, loadSavedZoomFactor());
  });

  wc.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;

    // FIX (debug App Customization): Menu.setApplicationMenu(null) di
    // createWindow() menghapus SEMUA accelerator default Electron, termasuk
    // "Toggle Developer Tools" (F12 / Ctrl+Shift+I) — makanya sebelumnya
    // tidak bisa dibuka sama sekali di App ini. Ditangani manual di sini,
    // TIDAK menyalakan Menu lagi (supaya tidak mengulang bug zoom liar yang
    // sudah diperbaiki di atas). Sengaja tidak dibatasi dev/production —
    // ini tools debug internal, bukan dirilis ke publik.
    const isF12 = input.key === 'F12';
    const isCtrlShiftI = (input.control || input.meta) && input.shift && (input.key === 'I' || input.key === 'i');
    if (isF12 || isCtrlShiftI) {
      event.preventDefault();
      if (wc.isDevToolsOpened()) wc.closeDevTools();
      else wc.openDevTools({ mode: 'detach' }); // detach: window terpisah, tidak gepeng nge-squeeze App yang frame:false/fixed size
      return;
    }

    if (!(input.control || input.meta)) return; // CTRL (Windows/Linux) atau CMD (mac)
    if (input.alt) return; // jangan tabrakan sama shortcut lain (mis. CTRL+ALT+...)
    // CATATAN: SHIFT sengaja TIDAK diblok di sini — di keyboard US, tombol
    // "+" cuma bisa diketik lewat SHIFT+"=" (tidak ada tombol "+" tersendiri
    // selain numpad), jadi CTRL+"+" secara fisik = CTRL+SHIFT+"=". Kalau
    // SHIFT diblok, CTRL + + versi keyboard biasa jadi tidak pernah kena.

    const key = input.key;
    const code = input.code;
    const isZoomIn  = key === '+' || key === '=' || code === 'NumpadAdd';
    const isZoomOut = key === '-' || key === '_' || code === 'NumpadSubtract';
    const isZoomReset = key === '0' || code === 'Numpad0';

    if (!isZoomIn && !isZoomOut && !isZoomReset) return;

    event.preventDefault(); // cegah default browser zoom Chromium jalan barengan (sumber "error"/nyangkut sebelumnya)

    const current = wc.getZoomFactor();
    if (isZoomIn) applyZoom(wc, current + ZOOM_STEP);
    else if (isZoomOut) applyZoom(wc, current - ZOOM_STEP);
    else if (isZoomReset) applyZoom(wc, ZOOM_DEFAULT);
  });
}

// CATATAN HISTORI DEBUG (biar gak keulang lagi kalau ada yang coba fix ini lagi):
// 1) file:// origin gak punya Referer sama sekali -> YouTube tolak (Error 153).
// 2) Sempat coba paksa Referer="https://www.youtube.com/" -> malah Error 152,
//    soalnya "asal video dari YouTube sendiri" itu kontradiktif buat YouTube.
// 3) Sempat coba load app lewat local HTTP server (127.0.0.1) supaya dapat
//    origin HTTP asli -> video YouTube JADI JALAN, TAPI ini malah bikin semua
//    fetch app ke backend sendiri (SERVER_URL) gagal dengan
//    ERR_NETWORK_ACCESS_DENIED (Windows ngeblok network access dari process
//    yang baru buka local listening server kayak gini). Jadi di-revert.
// FINAL: tetap file:// untuk app utama (biar API ke backend tetap normal),
// dan Referer/origin video di-set ke domain PRODUKSI KITA SENDIRI
// (OWN_SERVER_HOST / SERVER_URL di app.js) — bukan file://, bukan juga
// youtube.com — supaya YouTube lihat origin yang valid & make sense (situs
// pihak ketiga yang nge-embed videonya), tanpa kontradiksi dan tanpa ganti
// cara app di-load sama sekali.

// YouTube embed player menolak User-Agent bawaan Electron (mengandung string
// "Electron/x.x.x") dan langsung balas Error 153 "Video player configuration
// error" — ini kejadian di SEMUA embed YouTube di app Electron manapun yang
// belum di-override UA-nya, terlepas dari pakai <iframe> atau <webview>, dan
// terlepas dari video itu sendiri bebas restriction atau tidak.
// Fix: samarkan UA jadi Chrome biasa supaya YouTube menganggapnya browser normal.
const SPOOFED_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
app.userAgentFallback = SPOOFED_USER_AGENT;

function createWindow() {
  mainWindow = new BrowserWindow({
    // Default launch size. Width dinaikkan +5% lagi dari baseline
    // sebelumnya (1180 -> 1239 -> 1301); height diturunkan -2% dari
    // baseline sebelumnya (760 ->745). Ini murni ukuran window saat APP
    // pertama kali dibuka — resize manual oleh user selama APP berjalan
    // TIDAK ditulis balik ke sini (tidak ada sistem save-bounds/electron-store
    // di app ini), jadi close lalu launch ulang selalu kembali ke 1301x745,
    // bukan ke ukuran manual terakhir.
    width: 1301,
    height: 745,
    // LOCK UKURAN MINIMUM — minWidth/minHeight disamakan dengan ukuran
    // launch (1301x745), jadi window TIDAK BISA diperkecil di bawah
    // ukuran sekarang lagi (dulu minWidth:960/minHeight:600 masih
    // mengizinkan diperkecil jauh dari ukuran launch). maxWidth/maxHeight
    // sengaja TIDAK diset (tetap unbounded, default Electron) supaya user
    // masih BISA memperbesar window sebebas-bebasnya — cuma batas bawah
    // (mengecilkan) yang dikunci, bukan resizable-nya dimatikan total.
    minWidth: 1301,
    minHeight: 745,
    frame: false, // custom title bar dibikin sendiri di app.html/app.js
    backgroundColor: '#0a0713',
    // PERF FIX (restart setelah App Update terasa lama): window sebelumnya
    // langsung `show` begitu di-construct, jadi ada jeda window kosong/putih
    // kelihatan dulu sebelum index.html+CSS selesai render — ini yang bikin
    // "buka ulang app" terasa lama padahal proses Electron-nya sendiri sudah
    // jalan. `show:false` + reveal di event 'ready-to-show' (di bawah)
    // membuat window baru muncul PERSIS saat konten pertama sudah siap
    // digambar, jadi tidak ada frame kosong yang kelihatan. Ukuran, posisi,
    // frame, dan seluruh webPreferences TIDAK berubah sama sekali.
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Video tutorial (YouTube/TikTok) di-embed pakai <webview>, bukan <iframe>.
      webviewTag: true
    }
  });

  // Tampilkan window begitu konten pertama siap di-render (lihat catatan
  // show:false di atas). Fallback: kalau event ini karena alasan apapun
  // tidak pernah terpanggil (mis. edge-case rendering tertentu), window
  // tetap dipaksa muncul setelah 3 detik supaya app TIDAK PERNAH kelihatan
  // "tidak terbuka sama sekali".
  let _shownFallback = false;
  mainWindow.once('ready-to-show', () => {
    if (_shownFallback) return;
    _shownFallback = true;
    mainWindow.show();
  });
  setTimeout(() => {
    if (_shownFallback || !mainWindow || mainWindow.isDestroyed()) return;
    _shownFallback = true;
    mainWindow.show();
  }, 3000);

  // Matikan Menu default Electron — sumber accelerator zoom liar/tidak
  // konsisten sebelumnya (lihat catatan di setupZoomHandlers di atas). Zoom
  // sekarang 100% ditangani sendiri lewat before-input-event.
  Menu.setApplicationMenu(null);

  setupZoomHandlers(mainWindow);

  mainWindow.loadFile(path.join(__dirname, 'app', 'index.html'));

  // Pastikan webview (video tutorial) juga pakai UA yang sudah disamarkan,
  // bukan cuma window utama — guest page webview kadang punya webContents
  // sendiri yang gak otomatis kebawa app.userAgentFallback di semua versi Electron.
  // Catatan: UA utama sekarang di-set langsung lewat atribut `useragent` pada
  // tag <webview> di app/index.html supaya berlaku SEBELUM navigasi pertama ke
  // YouTube/TikTok (menghindari race condition — did-attach-webview kadang
  // baru jalan setelah request pertama sudah terlanjur terkirim pakai UA lama).
  // Baris setUserAgent tetap dipertahankan sebagai jaring pengaman untuk
  // navigasi berikutnya di dalam webview yang sama (misal ganti video).
  mainWindow.webContents.on('did-attach-webview', (event, webContents) => {
    webContents.setUserAgent(SPOOFED_USER_AGENT);
  });

  // Sinkronkan ikon Maximize/Restore di titlebar kustom APP DEMO dengan state
  // window ASLI (mis. saat user double-click titlebar atau drag ke tepi layar
  // / Aero Snap) — ditambahkan saat migrasi ke UI APP DEMO. Tidak mengubah
  // ipcMain.on('window-maximize', ...) yang sudah ada di bawah; ini murni
  // event tambahan supaya ikon di titlebar baru selalu akurat.
  mainWindow.on('maximize', () => mainWindow.webContents.send('window:maximized', true));
  mainWindow.on('unmaximize', () => mainWindow.webContents.send('window:maximized', false));
}


// Bersihkan SESI ROLLBACK yang tertinggal dari proses inject-game/install-bypass
// sebelumnya (mis. app di-force-close user, komputer mati mendadak, atau crash
// di tengah proses install) — dipanggil sekali tiap app.whenReady(). Aman
// dihapus semua karena folder ini CUMA berisi backup temporary buat rollback
// SATU sesi install yang sudah pasti tidak lagi berjalan (app baru saja start
// ulang) — bukan file game/bypass asli milik user.
// PERF FIX: sama seperti cleanupStaleUpdateTempFiles() di atas — diganti ke
// async (fs.promises.rm) supaya tidak memblokir Main Process kalau folder
// rollback kebetulan berisi banyak file backup sisa (mis. dari inject game
// yang terputus). Logika penghapusan (hapus total folder root) tidak berubah.
async function cleanupStaleRollbackSessions() {
  try {
    const root = get31ToolsRollbackRoot();
    if (!fs.existsSync(root)) return;
    await fs.promises.rm(root, { recursive: true, force: true });
  } catch (e) { /* best-effort */ }
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
  // Steam & Discord Detection — watcher status realtime (lihat definisi di bawah).
  startSystemDetectionWatcher();
  // PERF FIX (restart setelah App Update terasa lama): dua cleanup di bawah
  // ini TIDAK PERNAH dibutuhkan sebelum window kelihatan — keduanya cuma
  // beres-beres file sisa proses SEBELUMNYA, tidak ada satupun state yang
  // dibutuhkan createWindow()/index.html untuk render pertama. Sebelumnya
  // dipanggil di sini secara sinkron (blocking) tepat saat startup paling
  // kritis; sekarang digeser jalan di background 2 detik SETELAH proses
  // whenReady() ini selesai (window sudah tampil & interaktif), pakai versi
  // async-nya (lihat definisi masing-masing fungsi) supaya sama sekali tidak
  // menahan window muncul. Tidak ada logika hapus/kondisi yang berubah.
  setTimeout(() => {
    // Auto Update — bersihkan file installer/script sementara yang mungkin
    // tertinggal dari proses update sebelumnya (crash, force-close user, dst).
    cleanupStaleUpdateTempFiles();
    // Rollback Bypass/Game — bersihkan sesi backup temporary yang tertinggal
    // dari proses install sebelumnya yang tidak sempat selesai (lihat catatan
    // di atas cleanupStaleRollbackSessions).
    cleanupStaleRollbackSessions();
  }, 2000);
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

// Query state maximize saat ini — ditambahkan saat migrasi ke titlebar kustom
// APP DEMO (buat set ikon awal yang benar begitu window pertama kali tampil).
ipcMain.handle('window:is-maximized', () => mainWindow?.isMaximized() || false);

// ── Detect Steam path dari registry ──
function detectSteamPathFromRegistry() {
  try {
    const reg = execSync('reg query "HKCU\\Software\\Valve\\Steam" /v SteamPath').toString();
    const match = reg.match(/SteamPath\s+REG_SZ\s+(.+)/);
    if (match) return match[1].trim();
  } catch (e) {}
  return null;
}
ipcMain.handle('get-steam-path', () => detectSteamPathFromRegistry());

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
    const OWN_SERVER_HOST = '31store-production-299d.up.railway.app'; // domain server sendiri — WAJIB, semua stream lewat sini
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
            if (host.includes('hubcap')) errMsg401 = 'Server penyedia game sedang bermasalah (401 - kredensial tidak valid/expired). Hubungi admin.';
            else if (host.includes('ryuu')) errMsg401 = 'Link bypass ini memerlukan autentikasi tambahan yang belum didukung langsung. Minta admin ganti dengan link GitHub Release.';
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

// ══════════════════════════════════════════════════════════════════════════
// AUTO UPDATE / FORCE UPDATE — download installer dari GitHub Release,
// verifikasi, tutup app SEPENUHNYA, baru jalankan installer, lalu installer
// (NSIS, runAfterFinish) otomatis membuka lagi app versi baru.
//
// BUG LAMA yang diperbaiki di sini ("update selesai tapi masih kedetect versi
// lama, minta update lagi terus"): sebelumnya installer di-spawn lalu app ini
// cuma nunggu setTimeout 500ms sebelum app.quit(). app.quit() di Electron itu
// ASYNC (nutup semua window, lepas listener, dst) dan bisa makan waktu lebih
// dari 500ms — sementara NSIS (dijalankan silent /S) langsung mencoba menimpa
// app.exe yang masih di-lock oleh proses lama yang belum benar-benar exit.
// Di Windows, executable yang sedang berjalan TIDAK BISA ditimpa — jadi NSIS
// diam-diam gagal replace app.exe (tapi tetap "runAfterFinish" membuka apa
// yang ada di situ, yaitu EXE LAMA yang tidak berubah). Makanya app kebuka
// lagi tapi versinya tetap lama → app deteksi versi lama lagi → user diminta
// update lagi → loop.
//
// FIX: proses install dipindah ke SCRIPT TERPISAH yang DETACHED dari app ini
// (tetap hidup walau app ini sudah quit), dan script itu MENUNGGU proses app
// lama (PID kita sendiri) BENAR-BENAR hilang dari process list (bukan sekadar
// nunggu timer) SEBELUM menjalankan installer. Ini menghilangkan race
// condition file-lock di atas sepenuhnya.
//
// Tambahan: "pending update marker" (file kecil di userData) dicatat SEBELUM
// quit, isinya versi target yang seharusnya aktif setelah restart. Begitu app
// kebuka lagi, marker ini dicek:
//   - Kalau app.getVersion() sudah = versi target → update SUKSES, marker
//     dihapus, popup update tidak muncul lagi (dicek IPC 'check-pending-update-result').
//   - Kalau versi masih beda DAN marker sudah cukup lama (>90 detik, artinya
//     proses install & restart harusnya sudah selesai) → dianggap GAGAL,
//     marker dihapus (supaya tidak numpuk), dan App menampilkan pesan error
//     yang jelas (bukan diam-diam mengulang alur silent yang sama terus, yang
//     itulah definisi "update loop" yang diminta untuk dihindari).
// ══════════════════════════════════════════════════════════════════════════
ipcMain.handle('get-app-version', () => app.getVersion());

// Guard re-entrancy: mencegah 2 runner update ke-spawn sekaligus kalau IPC
// 'install-app-update' sempat terpanggil dobel (mis. user klik cepat 2x
// sebelum tombolnya sempat ke-disable di renderer).
let _installUpdateInProgress = false;

function pendingUpdateMarkerPath() {
  return path.join(app.getPath('userData'), 'pending-update.json');
}
function writePendingUpdateMarker(targetVersion) {
  try {
    fs.writeFileSync(pendingUpdateMarkerPath(), JSON.stringify({
      targetVersion, fromVersion: app.getVersion(), startedAt: Date.now()
    }));
  } catch (e) { /* best-effort, jangan sampai gagalkan alur update cuma karena ini */ }
}
function readPendingUpdateMarker() {
  try {
    const p = pendingUpdateMarkerPath();
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) { return null; }
}
function clearPendingUpdateMarker() {
  try { fs.unlinkSync(pendingUpdateMarkerPath()); } catch (e) { /* noop */ }
}

// Dipanggil App (renderer) sekali di awal, SEBELUM cek versi normal — supaya
// kalau update terakhir gagal diterapkan, App kasih pesan yang jelas alih-alih
// diam-diam nyoba alur silent yang sama lagi (itu yang bikin "loop").
ipcMain.handle('check-pending-update-result', () => {
  const marker = readPendingUpdateMarker();
  if (!marker) return { status: 'none' };

  const currentVersion = app.getVersion();
  const succeeded = compareSemverSimple(currentVersion, marker.targetVersion) >= 0;
  if (succeeded) {
    clearPendingUpdateMarker();
    return { status: 'success', version: currentVersion };
  }

  const ageMs = Date.now() - (marker.startedAt || 0);
  if (ageMs > 90 * 1000) {
    // Sudah cukup lama sejak install dimulai (installer+restart harusnya jauh
    // lebih cepat dari ini) tapi versi tetap tidak berubah → install gagal.
    clearPendingUpdateMarker();
    return { status: 'failed', targetVersion: marker.targetVersion, currentVersion };
  }
  // Masih dalam rentang wajar (mis. app sempat kebuka duluan sebelum installer
  // benar-benar kelar tulis file) — jangan langsung divonis gagal.
  return { status: 'pending', targetVersion: marker.targetVersion };
});

function compareSemverSimple(a, b) {
  const norm = (v) => String(v || '0').trim().replace(/^v/i, '').split(/[.\-+]/).map(s => {
    const n = parseInt(s, 10);
    return Number.isFinite(n) ? n : 0;
  });
  const pa = norm(a), pb = norm(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

// Bersihkan installer/script sementara yang tertinggal dari proses update
// sebelumnya (misal user paksa-tutup app saat proses berjalan, atau installer
// gagal di tengah jalan) — dipanggil sekali tiap app.whenReady(). Cuma
// menghapus file yang lebih tua dari 10 menit, supaya tidak bentrok dengan
// proses update yang MUNGKIN sedang berjalan (jarang, tapi aman dijaga).
// PERF FIX (restart setelah App Update terasa lama): fungsi ini SEBELUMNYA
// dipanggil sinkron di dalam app.whenReady().then() (lihat pemanggilnya di
// bawah) memakai fs.readdirSync/statSync/unlinkSync — semuanya BLOCKING,
// artinya seluruh Main Process (termasuk proses createWindow() yang baru
// saja jalan) ikut berhenti sejenak sampai OS temp folder selesai di-scan.
// Ini persis skenario yang paling terasa PAS SETELAH UPDATE: folder temp
// OS sedang berisi sisa installer/script (.bat/.vbs/.exe) dari proses
// restart yang baru saja terjadi, jadi scan-nya kebetulan tidak kosong.
// Diganti total ke versi ASYNC (fs.promises) TANPA mengubah logika apapun
// (pola nama file yang dicari, ambang umur 10 menit, cara hapus — semua
// sama persis) — cuma cara bacanya yang tidak lagi memblokir proses lain.
async function cleanupStaleUpdateTempFiles() {
  try {
    const tempDir = app.getPath('temp');
    const files = await fs.promises.readdir(tempDir);
    const now = Date.now();
    for (const f of files) {
      if (!/^31tools_update_/.test(f)) continue;
      const full = path.join(tempDir, f);
      try {
        const stat = await fs.promises.stat(full);
        if (now - stat.mtimeMs > 10 * 60 * 1000) await fs.promises.unlink(full);
      } catch (e) { /* file mungkin lagi dipakai proses lain, skip */ }
    }
  } catch (e) { /* best-effort */ }
}

ipcMain.handle('download-app-update', async (event, { url, fileSize } = {}) => {
  if (!url) return { success: false, error: 'Link download update tidak tersedia.' };
  const destPath = path.join(app.getPath('temp'), '31tools_update_' + Date.now() + '.exe');

  let lastTime = Date.now();
  let lastDownloaded = 0;

  try {
    await downloadFileWithProgress(url, destPath, (downloaded, total) => {
      const now = Date.now();
      const elapsedSec = Math.max((now - lastTime) / 1000, 0.001);
      const bytesSinceLast = downloaded - lastDownloaded;
      const speedBps = bytesSinceLast / elapsedSec;
      const totalBytes = total || fileSize || 0;
      const remaining = totalBytes > downloaded ? totalBytes - downloaded : 0;
      const etaSec = speedBps > 0 ? Math.round(remaining / speedBps) : null;
      const percent = totalBytes > 0 ? Math.min(100, Math.round((downloaded / totalBytes) * 100)) : null;

      mainWindow?.webContents.send('app-update-progress', {
        downloaded, total: totalBytes, percent, speedBps: Math.max(0, Math.round(speedBps)), etaSec
      });

      if (now - lastTime > 250) { lastTime = now; lastDownloaded = downloaded; }
    }, 0, {});

    // Verifikasi dasar: file ada, ukurannya masuk akal (bukan 0 byte / bukan halaman
    // error HTML yang ketutup jadi .exe), dan kalau server kasih tahu fileSize yang
    // diharapkan, ukurannya harus mendekati (toleransi kecil untuk perbedaan header/CDN).
    const stat = fs.statSync(destPath);
    if (!stat.isFile() || stat.size < 1024) {
      try { fs.unlinkSync(destPath); } catch (e) {}
      return { success: false, error: 'File hasil download tidak valid atau rusak (ukuran terlalu kecil).' };
    }
    if (fileSize && fileSize > 0) {
      const diffRatio = Math.abs(stat.size - fileSize) / fileSize;
      if (diffRatio > 0.15) {
        try { fs.unlinkSync(destPath); } catch (e) {}
        return { success: false, error: 'Ukuran file hasil download tidak sesuai — kemungkinan file rusak atau link sudah berubah. Coba download ulang.' };
      }
    }
    // Cek signature PE (.exe) dasar — 2 byte pertama harus "MZ"
    const headBuf = Buffer.alloc(2);
    const fd = fs.openSync(destPath, 'r');
    fs.readSync(fd, headBuf, 0, 2, 0);
    fs.closeSync(fd);
    if (headBuf.toString('ascii') !== 'MZ') {
      try { fs.unlinkSync(destPath); } catch (e) {}
      return { success: false, error: 'File installer tidak valid (bukan file .exe yang sah). Coba download ulang.' };
    }

    return { success: true, installerPath: destPath, size: stat.size };
  } catch (e) {
    try { fs.unlinkSync(destPath); } catch (e2) {}
    if (e.message === 'CANCELLED') return { success: false, cancelled: true };
    return { success: false, error: e.message || 'Download update gagal.' };
  }
});

ipcMain.handle('cancel-app-update-download', () => {
  try {
    if (activeDownloadRequest) { activeDownloadRequest.destroy(new Error('CANCELLED')); activeDownloadRequest = null; }
    if (activeDownloadFile) { activeDownloadFile.close(); activeDownloadFile = null; }
    return { success: true };
  } catch (e) { return { success: false, error: e.message }; }
});

// Jalankan installer via script DETACHED yang menunggu app ini benar-benar
// tertutup dulu (lihat penjelasan panjang di atas) — bukan langsung exec +
// setTimeout seperti sebelumnya. `targetVersion` dicatat ke marker supaya
// bisa diverifikasi setelah app kebuka lagi (lihat 'check-pending-update-result').
//
// FIX (bug "CMD kebuka terus & update loop / tidak selesai normal"):
// Root cause-nya BUKAN di logic waitloop/marker (itu sudah benar) — root
// cause-nya ada di 2 hal teknis yang lebih dalam:
//
//   1) NSIS yang di-generate electron-builder TIDAK PERNAH menjalankan app
//      lagi setelah instalasi kalau dijalankan silent (/S) — opsi
//      "runAfterFinish" cuma dieksekusi lewat checkbox di halaman "Finish",
//      dan halaman itu SAMA SEKALI TIDAK PERNAH TAMPIL di mode silent,
//      terlepas dari runAfterFinish di-set true atau tidak (ini konfirmasi
//      dari maintainer electron-builder sendiri, lihat issue #1545 & PR
//      Arduino IDE #942: "When in silent mode: app does not start after
//      installation"). Makanya sebelumnya: installer selesai jalan diam-diam,
//      TAPI TIDAK ADA YANG MEMBUKA APP BARU. User mengira macet/loop, lalu
//      klik "Update Sekarang" lagi → script & CMD baru di-spawn lagi → begitu
//      terus. FIX: script sekarang MENJALANKAN EXE BARU SECARA EKSPLISIT
//      setelah instalasi silent selesai (bukan mengandalkan runAfterFinish).
//      Path exe diambil dari app.getPath('exe') SAAT INI (sebelum quit) —
//      NSIS update selalu install ulang ke folder yang sama persis dengan
//      instalasi sebelumnya, jadi path ini pasti valid setelah update juga.
//
//   2) Command `timeout` di Windows GAGAL/exit langsung kalau dijalankan
//      tanpa console interaktif (persis kondisi kita: stdio 'ignore') —
//      pesannya "Input redirection is not supported". Efeknya waitloop
//      sebelumnya jalan tanpa delay sama sekali (busy-loop, bukan nunggu
//      1 detik/putaran seperti niatnya). Diganti pakai `ping` ke localhost
//      yang TIDAK butuh console/stdin sama sekali — trik standar Windows
//      untuk delay di script non-interaktif.
//
// Tambahan: guard re-entrancy `_installUpdateInProgress` supaya kalau
// tombol "Update Sekarang" ke-klik dobel (race condition UI) sebelum
// app sempat quit, TIDAK ada 2 runner/CMD yang ke-spawn sekaligus.
ipcMain.handle('install-app-update', async (event, { installerPath, targetVersion } = {}) => {
  if (_installUpdateInProgress) {
    return { success: false, error: 'Proses update sudah berjalan, tunggu sebentar.' };
  }
  try {
    if (!installerPath || !fs.existsSync(installerPath)) {
      return { success: false, error: 'File installer tidak ditemukan. Silakan download ulang.' };
    }
    if (process.platform !== 'win32') {
      return { success: false, error: 'Auto update otomatis saat ini hanya didukung di Windows. Silakan update manual lewat link download.' };
    }

    _installUpdateInProgress = true;
    if (targetVersion) writePendingUpdateMarker(targetVersion);

    const myPid = process.pid;
    const exePath = app.getPath('exe'); // exe App yang sedang berjalan SEKARANG — lokasi ini yang akan ditimpa installer
    const tempDir = app.getPath('temp');
    const batchPath = path.join(tempDir, `31tools_update_runner_${Date.now()}.bat`);
    const vbsPath = path.join(tempDir, `31tools_update_launcher_${Date.now()}.vbs`);

    // Batch script (isi proses sebenarnya):
    //  1) Nunggu PID app ini BENAR-BENAR hilang dari process list (bukan timer
    //     tebak-tebakan) — max ~60 detik, fallback tetap lanjut kalau kelamaan.
    //  2) Jalankan installer /S (silent, synchronous — baris ini block sampai
    //     instalasi BENAR-BENAR selesai).
    //  3) Buka EXE versi baru secara eksplisit (lihat penjelasan di atas —
    //     TIDAK mengandalkan runAfterFinish NSIS, karena itu tidak jalan di
    //     mode silent). Pakai `start "" "path"` supaya proses baru lepas dari
    //     batch script ini (tidak ikut ditunggu/di-block olehnya).
    //  4) Hapus file installer .exe & script vbs pembungkus (sudah tidak dipakai).
    //  5) Hapus dirinya sendiri (baris terakhir, aman karena cmd.exe sudah
    //     baca seluruh isi file .bat ke memori duluan sebelum eksekusi).
    const batchScript = [
      '@echo off',
      'setlocal',
      `set "PID=${myPid}"`,
      `set "INSTALLER=${installerPath}"`,
      `set "APPEXE=${exePath}"`,
      `set "VBS=${vbsPath}"`,
      'set "TRIES=0"',
      ':waitloop',
      'tasklist /FI "PID eq %PID%" 2>NUL | find "%PID%" >NUL',
      'if errorlevel 1 goto proceed',
      'set /a TRIES+=1',
      'if %TRIES% GEQ 60 goto proceed',
      'ping -n 2 127.0.0.1 >nul',
      'goto waitloop',
      ':proceed',
      '"%INSTALLER%" /S',
      // PERF FIX: tambah /ABOVENORMAL — cuma menaikkan priority proses baru
      // ini sedikit di atas default saat pertama kali start (murni hint ke
      // Windows scheduler agar startup Electron-nya kebagian jatah CPU lebih
      // dulu di sistem yang sedang banyak proses lain jalan), TIDAK mengubah
      // apa yang dijalankan atau urutannya sama sekali.
      'start "" /ABOVENORMAL "%APPEXE%"',
      'del /f /q "%INSTALLER%" >nul 2>&1',
      'del /f /q "%VBS%" >nul 2>&1',
      'del /f /q "%~f0" >nul 2>&1'
    ].join('\r\n');
    fs.writeFileSync(batchPath, batchScript);

    // Pembungkus VBScript — dijalankan lewat wscript.exe (BUKAN cmd.exe langsung).
    // wscript.exe secara desain memang tidak pernah membuka jendela console sama
    // sekali (beda dengan cmd.exe yang menyembunyikan jendelanya lewat flag
    // windowsHide — biasanya cukup, tapi WScript.Shell.Run dengan window style 0
    // ini cara paling pasti untuk memastikan TIDAK ADA CMD yang sempat kelihatan,
    // termasuk di kondisi/AV tertentu yang kadang bikin flag windowsHide gagal).
    // Argumen ke-2 (0) = jendela hidden, argumen ke-3 (False) = tidak menunggu
    // (batch-nya sendiri yang jalan async & detached lewat spawn di bawah).
    const escapedBatchForVbs = batchPath.replace(/"/g, '""');
    const vbsScript = [
      'Set shell = CreateObject("WScript.Shell")',
      `shell.Run """" & "${escapedBatchForVbs}" & """", 0, False`
    ].join('\r\n');
    fs.writeFileSync(vbsPath, vbsScript);

    const child = spawn('wscript.exe', ['//B', '//Nologo', vbsPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });
    child.unref();

    // Quit app SEKARANG (tidak perlu delay tebak-tebakan lagi) — script di atas
    // yang akan menunggu proses kita benar-benar hilang sebelum lanjut install.
    setImmediate(() => app.quit());
    return { success: true };
  } catch (e) {
    _installUpdateInProgress = false;
    clearPendingUpdateMarker();
    return { success: false, error: e.message || 'Gagal menjalankan installer.' };
  }
});


// ══════════════════════════════════════════════════════════════════════════
// ROLLBACK/BACKUP HELPERS — sistem backup-sebelum-overwrite untuk INJECT GAME
// & INSTALL BYPASS. Diperbaiki total dari versi sebelumnya:
//   MASALAH LAMA: file backup (".rollback_bak_<ts>_<rand>") ditulis LANGSUNG
//   di sebelah file aslinya (di DALAM folder game/Steam) via `dest + '.rollback_bak_...'`,
//   dan TIDAK PERNAH dihapus kalau proses berakhir SUKSES (cuma dibersihkan
//   kalau proses gagal & di-rollback) — akibatnya file backup lama-lama
//   menumpuk permanen di folder game user, bikin storage penuh & folder
//   berantakan.
//   PERBAIKAN: backup sekarang ditulis ke folder TEMPORARY KHUSUS 31 Tools
//   (bukan di folder game), satu folder baru per proses inject/install (jadi
//   tidak bentrok antar proses). Folder ini SELALU dihapus total begitu
//   proses selesai — baik SUKSES (langsung dibersihkan, lihat inject-game &
//   install-bypass) MAUPUN GAGAL (dibersihkan otomatis di dalam
//   rollbackTrackedCopies setelah restore selesai). Backup TIDAK PERNAH
//   tersisa permanen di manapun.
// ══════════════════════════════════════════════════════════════════════════

// Folder root tempat SEMUA backup temporary 31 Tools disimpan (di dalam temp
// OS, bukan di folder game) — dibuat on-demand, aman dihapus kapan saja kalau
// tidak ada proses install yang sedang berjalan.
function get31ToolsRollbackRoot() {
  return path.join(app.getPath('temp'), '31tools_rollback');
}

// Buat folder backup BARU & UNIK untuk satu proses inject/install — supaya
// beberapa proses (mis. dua install bersamaan, atau retry) tidak saling
// bentrok/menimpa backup satu sama lain.
function createRollbackSession() {
  const dir = path.join(get31ToolsRollbackRoot(), `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`);
  return dir; // baru dibuat fisik (mkdirSync) saat backup PERTAMA kali dibutuhkan — lihat copyFileTracked
}

// Bersihkan file backup peninggalan versi LAMA (".rollback_bak_*" yang dulu
// ditulis langsung di folder game) yang mungkin masih tersisa dari instalasi
// sebelum perbaikan ini — best-effort, cuma hapus file yang jelas-jelas
// polanya buatan 31 Tools (".rollback_bak_<angka>_<random>"), TIDAK PERNAH
// menyentuh file lain milik user. Dipanggil sekali di awal tiap inject/install
// supaya folder game bersih dari sisa-sisa lama tanpa perlu migrasi manual.
const LEGACY_ROLLBACK_FILE_PATTERN = /\.rollback_bak_\d+_[a-z0-9]+$/i;
function cleanupLegacyRollbackFiles(dir, depth = 0) {
  if (depth > 6) return; // guard biar tidak nyasar ke folder yang salah/terlalu dalam
  try {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      try {
        if (entry.isDirectory()) {
          cleanupLegacyRollbackFiles(full, depth + 1);
        } else if (LEGACY_ROLLBACK_FILE_PATTERN.test(entry.name)) {
          fs.unlinkSync(full);
        }
      } catch (e2) { /* satu file gagal dihapus tidak boleh menghentikan pembersihan yang lain */ }
    }
  } catch (e) { /* best-effort, tidak pernah melempar error ke pemanggil */ }
}

// Helper rollback: copy file dengan backup, supaya kalau proses gagal di
// tengah jalan kita bisa PERSIS mengembalikan keadaan semula — file yang
// memang baru (belum ada sebelumnya) dihapus, file yang SUDAH ADA sebelumnya
// (ke-overwrite) dikembalikan ke isi semula, bukan asal dihapus. Backup
// SEKARANG disimpan di `rollbackDir` (folder temporary 31 Tools), BUKAN lagi
// di sebelah file aslinya.
function copyFileTracked(src, dest, backupList, rollbackDir) {
  const existedBefore = fs.existsSync(dest);
  let backupPath = null;
  if (existedBefore) {
    fs.mkdirSync(rollbackDir, { recursive: true });
    // Nama backup di-namespace pakai index + basename — cukup unik dalam satu
    // sesi rollback (folder rollbackDir-nya sendiri sudah unik per proses).
    backupPath = path.join(rollbackDir, `${backupList.length}_${path.basename(dest)}`);
    fs.copyFileSync(dest, backupPath);
  }
  fs.copyFileSync(src, dest);
  backupList.push({ dest, backupPath, existedBefore });
}

// Balikin semua perubahan yang tercatat di backupList (urutan terbalik) —
// dipanggil kalau proses download/extract/copy gagal ATAU dibatalkan di
// tengah jalan supaya TIDAK ADA file Game/Bypass yang tersisa setengah-setengah
// di komputer user. Folder backup temporary (`rollbackDir`) SELALU dihapus
// total di akhir — sukses restore maupun sebagian gagal — supaya tidak ada
// jejak backup tersisa di manapun.
function rollbackTrackedCopies(backupList, rollbackDir) {
  let removed = 0, restored = 0;
  const errors = [];
  for (let i = backupList.length - 1; i >= 0; i--) {
    const entry = backupList[i];
    try {
      if (entry.existedBefore && entry.backupPath && fs.existsSync(entry.backupPath)) {
        fs.copyFileSync(entry.backupPath, entry.dest); // kembalikan isi semula
        restored++;
      } else {
        if (fs.existsSync(entry.dest)) { fs.unlinkSync(entry.dest); removed++; }
      }
    } catch (e) {
      errors.push(`${entry.dest}: ${e.message}`);
    }
  }
  // Hapus TOTAL folder backup temporary (bukan cuma per-file) — memastikan
  // tidak ada satupun file backup tersisa, baik restore di atas berhasil
  // semua maupun sebagian gagal.
  try { if (rollbackDir && fs.existsSync(rollbackDir)) fs.rmSync(rollbackDir, { recursive: true, force: true }); } catch (e2) {}
  return { attempted: backupList.length > 0, success: errors.length === 0, removed, restored, errors };
}

// ── INJECT GAME: extract ZIP → .lua ke stplug-in, .manifest ke depotcache ──
ipcMain.handle('inject-game', async (event, { steamPath, zipUrl, extraHeaders, watermark }) => {
  const tempZip = path.join(app.getPath('temp'), 'inject_' + Date.now() + '.zip');
  const tempDir = path.join(app.getPath('temp'), 'inject_extract_' + Date.now());
  const rollbackDir = createRollbackSession(); // folder backup temporary 31 Tools (BUKAN di folder game)
  const backupList = []; // file yang sudah ditulis ke stplug-in/depotcache (tujuan akhir)
  let stage = 'download'; // 'download' | 'install' — dipakai server buat log Download Failed vs Install Failed
  try {
    // Download — teruskan extraHeaders (termasuk Authorization untuk hubcap)
    await downloadFileWithProgress(zipUrl, tempZip, null, 0, extraHeaders || {});

    stage = 'install';

    // Validasi ZIP signature
    const head = readFileHeadSync(tempZip, 4);
    if (head[0] !== 0x50 || head[1] !== 0x4B) throw new Error('File bukan ZIP valid — URL mungkin salah atau akses ditolak server.');

    // Siapkan folder tujuan
    const stplugDir    = path.join(steamPath, 'config', 'stplug-in');
    const depotcacheDir = path.join(steamPath, 'config', 'depotcache');
    // Lokasi KEDUA untuk file .manifest — Steam\depotcache (BUKAN di dalam
    // config\, sejajar dengan folder config\ itu sendiri). LUA & lokasi
    // depotcache PERTAMA (config\depotcache) TIDAK disentuh sama sekali —
    // ini murni tambahan copy, dibuat otomatis kalau belum ada (sama seperti
    // stplugDir/depotcacheDir di atas).
    const depotcacheRootDir = path.join(steamPath, 'depotcache');
    fs.mkdirSync(stplugDir,     { recursive: true });
    fs.mkdirSync(depotcacheDir, { recursive: true });
    fs.mkdirSync(depotcacheRootDir, { recursive: true });

    // Bersihkan sisa file backup versi LAMA (kalau ada, dari sebelum perbaikan
    // rollback ini) yang mungkin masih menumpuk di folder Steam config —
    // best-effort, tidak pernah gagal-kan proses inject.
    cleanupLegacyRollbackFiles(stplugDir);
    cleanupLegacyRollbackFiles(depotcacheDir);

    // Extract ke temp
    fs.mkdirSync(tempDir, { recursive: true });
    await extractZip(tempZip, { dir: tempDir });

    // Walk dan copy berdasarkan ekstensi — SETIAP copy dicatat di backupList supaya
    // kalau salah satu copy gagal di tengah jalan (disk penuh, permission, dll),
    // semua yang SUDAH sempat ter-copy bisa langsung di-rollback (lihat catch di bawah).
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
          const destPath = path.join(destDir, entry.name);
          copyFileTracked(fullPath, destPath, backupList, rollbackDir);
          extractedFiles.push((ext === '.lua' ? 'stplug-in/' : 'depotcache/') + entry.name);

          // ── FIX "Manifest juga harus masuk ke Steam\depotcache" ──
          // Copy KEDUA ini pakai file sumber yang SAMA persis (`fullPath`, dari
          // hasil extract ZIP yang SAMA di atas) — TIDAK ada download ulang.
          // copyFileTracked() dipakai lagi (fungsi rollback/overwrite existing,
          // sama seperti copy pertama) supaya perilaku overwrite-jika-sudah-ada
          // & rollback-kalau-gagal konsisten dengan proses install yang sudah
          // ada. Karena ini masih di dalam try block yang sama SEBELUM
          // `return { success:true, ... }` di bawah, kalau copy ini melempar
          // error (disk penuh/permission/dll), seluruh proses inject ikut
          // dianggap GAGAL & di-rollback oleh catch block existing di bawah —
          // TIDAK PERNAH diam-diam dianggap sukses walau copy pertama (config\
          // depotcache) sudah berhasil.
          if (ext === '.manifest') {
            const destPath2 = path.join(depotcacheRootDir, entry.name);
            copyFileTracked(fullPath, destPath2, backupList, rollbackDir);
            // Token folder terpisah ('depotcache-root') dari 'depotcache' biasa
            // supaya remove-game tahu ini file di lokasi KEDUA (Steam\depotcache,
            // bukan di dalam config\) saat uninstall — lihat ipcMain 'remove-game'.
            extractedFiles.push('depotcache-root/' + entry.name);
          }
        }
      }
    }
    walkDir(tempDir);

    // ── AUTOMATIC WATERMARK DETECTION — server sudah membuat & menandatangani
    // watermark ini (lihat POST /api/watermark/issue di app.js SEBELUM
    // memanggil inject-game). File-nya CUMA dituliskan mentah di sini (bukan
    // dibuat/diproses main process), disimpan di folder depotcache (satu
    // folder dgn file .manifest yang sudah ada) supaya ikut ke-scan launcher
    // lain kali dijalankan. Ekstensi ".wmk" SENGAJA bukan .lua/.manifest
    // supaya tidak ikut dianggap plugin/manifest oleh SteamTools. ──
    if (watermark?.downloadId && watermark?.blob) {
      try {
        const wmFileName = `${watermark.downloadId}.wmk`;
        fs.writeFileSync(path.join(depotcacheDir, wmFileName), watermark.blob, 'utf8');
        extractedFiles.push('depotcache/' + wmFileName);
      } catch (e3) { /* watermark gagal ditulis TIDAK boleh menggagalkan inject game itu sendiri */ }
    }

    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch(e2) {}
    try { fs.unlinkSync(tempZip); } catch(e2) {}
    // SUKSES — hapus TOTAL folder backup temporary (tidak dibutuhkan lagi,
    // tidak boleh ada satupun file backup tersisa di manapun).
    try { if (fs.existsSync(rollbackDir)) fs.rmSync(rollbackDir, { recursive: true, force: true }); } catch (e2) {}
    return { success: true, extractedFiles };
  } catch (e) {
    // Rollback TOTAL: hapus/kembalikan semua file yang sempat ter-copy ke tujuan akhir,
    // lalu bersihkan temp zip & temp extract dir — memastikan TIDAK ADA file game
    // yang tersisa setengah-setengah di komputer user kalau prosesnya gagal/dibatalkan.
    // Folder backup temporary ikut terhapus otomatis di dalam rollbackTrackedCopies.
    const rollback = rollbackTrackedCopies(backupList, rollbackDir);
    try { fs.unlinkSync(tempZip); } catch(e2) {}
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch(e2) {}
    if (e.message === 'CANCELLED') return { success: false, cancelled: true, stage, rollback };
    return { success: false, error: e.message, stage, rollback };
  }
});

// ── INSTALL BYPASS: auto-detect folder game via appId, extract ZIP ke sana ──
function copyDirOverwriteTracked(srcDir, destDir, backupList, rollbackDir) {
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const src = path.join(srcDir, entry.name);
    const dst = path.join(destDir, entry.name);
    if (entry.isDirectory()) copyDirOverwriteTracked(src, dst, backupList, rollbackDir);
    else copyFileTracked(src, dst, backupList, rollbackDir);
  }
}

ipcMain.handle('install-bypass', async (event, { folderPath, driveUrl, userId, deviceId, gameId, gameName, steamAppId, extraHeaders, watermark }) => {
  const tempZipPath = path.join(app.getPath('temp'), 'bypass_' + Date.now() + '.zip');
  const tempExtractDir = path.join(app.getPath('temp'), 'bypass_extract_' + Date.now());
  const rollbackDir = createRollbackSession(); // folder backup temporary 31 Tools (BUKAN di folder game)
  const backupList = []; // file yang sudah ditulis ke folderPath (tujuan akhir/folder game)
  let stage = 'download'; // 'download' | 'install' — dipakai server buat log Download Failed vs Install Failed
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

    // Bersihkan sisa file backup versi LAMA (kalau ada, dari sebelum perbaikan
    // rollback ini) yang mungkin masih menumpuk di folder game — best-effort,
    // tidak pernah gagal-kan proses install.
    cleanupLegacyRollbackFiles(folderPath);

    // Download dari URL yang admin set, ATAU dari streamPath proxy server sendiri (butuh
    // extraHeaders/Authorization kalau link-nya perlu auth, mis. Ryuu Generator).
    await downloadFileWithProgress(driveUrl, tempZipPath, null, 0, extraHeaders || {});

    stage = 'install';

    // Validasi: file harus diawali signature ZIP (PK\x03\x04)
    const headBuf = readFileHeadSync(tempZipPath, 4);
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

    // Salin semua isi ke folder game, menimpa file yang sudah ada — SETIAP copy dicatat
    // di backupList (file yang sudah ADA sebelumnya di-backup dulu, bukan langsung ditimpa
    // tanpa jejak) supaya kalau copy gagal di tengah jalan, semuanya bisa di-rollback PERSIS
    // ke kondisi semula tanpa merusak file game yang sudah ada sebelumnya. Backup ditulis
    // ke rollbackDir (folder temporary 31 Tools), BUKAN di folder game.
    copyDirOverwriteTracked(tempExtractDir, folderPath, backupList, rollbackDir);

    // ── AUTOMATIC WATERMARK DETECTION — sama seperti inject-game, file
    // watermark cuma dituliskan mentah (server yang membuat & menandatangani
    // lewat POST /api/watermark/issue). Diletakkan di ROOT folder Bypass
    // (folder utama), diberi prefix "." (hidden-style) + ekstensi ".wmk"
    // supaya tidak bentrok dgn file bypass manapun. ──
    if (watermark?.downloadId && watermark?.blob) {
      try {
        const wmFileName = `.wm_${watermark.downloadId}.wmk`;
        fs.writeFileSync(path.join(folderPath, wmFileName), watermark.blob, 'utf8');
        extractedFiles.push(wmFileName);
      } catch (e3) { /* watermark gagal ditulis TIDAK boleh menggagalkan install bypass itu sendiri */ }
    }

    fs.unlinkSync(tempZipPath);
    try { fs.rmSync(tempExtractDir, { recursive: true, force: true }); } catch(e2) {}
    // SUKSES — hapus TOTAL folder backup temporary (tidak dibutuhkan lagi,
    // tidak boleh ada satupun file backup tersisa di folder game/manapun).
    try { if (fs.existsSync(rollbackDir)) fs.rmSync(rollbackDir, { recursive: true, force: true }); } catch (e2) {}

    return { success: true, extractedFiles, folderPath };
  } catch (e) {
    // Rollback TOTAL: kembalikan/hapus semua file yang sempat ter-copy ke folder game,
    // lalu bersihkan temp zip & temp extract dir — memastikan TIDAK ADA file bypass yang
    // tersisa setengah-setengah, dan file game asli yang sempat ke-overwrite dikembalikan.
    // Folder backup temporary ikut terhapus otomatis di dalam rollbackTrackedCopies.
    const rollback = rollbackTrackedCopies(backupList, rollbackDir);
    try { fs.unlinkSync(tempZipPath); } catch(e2) {}
    try { fs.rmSync(tempExtractDir, { recursive: true, force: true }); } catch(e2) {}
    if (e.message === 'CANCELLED') return { success: false, cancelled: true, stage, rollback };
    return { success: false, error: e.message, stage, rollback };
  }
});

// ── Remove bypass (hapus file-file spesifik hasil extract dari folder game) ──
ipcMain.handle('remove-game', (event, { steamPath, extractedFiles }) => {
  try {
    const configDir = path.join(steamPath, 'config');
    // Lokasi KEDUA manifest (lihat inject-game / token 'depotcache-root') —
    // dihapus juga saat uninstall supaya tidak ada salinan manifest yang
    // tersisa/orphan di Steam\depotcache. TIDAK mengubah resolusi path untuk
    // 'stplug-in'/'depotcache' (config\) yang sudah ada di bawah.
    const depotcacheRootDir = path.join(steamPath, 'depotcache');
    let deleted = 0;
    for (const relPath of (extractedFiles || [])) {
      if (typeof relPath !== 'string' || relPath.includes('..') || relPath.includes('\\')) continue;
      const parts = relPath.split('/');
      if (parts.length !== 2) continue;
      const [folder, filename] = parts;
      if (!filename) continue;
      let filePath;
      if (folder === 'stplug-in' || folder === 'depotcache') {
        filePath = path.join(configDir, folder, filename);
        if (!filePath.startsWith(configDir + path.sep)) continue;
      } else if (folder === 'depotcache-root') {
        filePath = path.join(depotcacheRootDir, filename);
        if (!filePath.startsWith(depotcacheRootDir + path.sep)) continue;
      } else {
        continue;
      }
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

// ── AUTOMATIC WATERMARK DETECTION — dipanggil app/app.js di background saat
// launcher dibuka (TIDAK memblokir startup). Scan folder yang SUDAH DIKETAHUI
// (bukan crawl seluruh disk — supaya cepat & tidak mengganggu performa):
//   • Game  -> config/depotcache & config/stplug-in di Steam yang terdeteksi
//     (satu folder dipakai bersama SEMUA game, jadi cukup di-scan sekali).
//   • Bypass -> root tiap folder game yang pernah dipasangi bypass (dikirim
//     renderer dari localStorage installMeta-nya sendiri).
// Membaca isi FILE APA ADANYA (blob terenkripsi) — verifikasi/keputusan
// "perangkat sama/beda" sepenuhnya di server (lihat watermarkManager.js),
// main process di sini TIDAK pernah menilai/menyimpulkan apapun.
ipcMain.handle('scan-watermarks', async (event, { steamPath, bypassFolders } = {}) => {
  const items = [];
  try {
    function readWmkFiles(dir) {
      if (!dir || !fs.existsSync(dir)) return;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (!entry.name.toLowerCase().endsWith('.wmk')) continue;
        try {
          const content = fs.readFileSync(path.join(dir, entry.name), 'utf8');
          if (content) items.push(content.trim());
        } catch (e) { /* file mungkin sedang dipakai proses lain — lewati, coba lagi lain kali */ }
      }
    }

    const resolvedSteamPath = steamPath || detectSteamPathFromRegistry();
    if (resolvedSteamPath) {
      readWmkFiles(path.join(resolvedSteamPath, 'config', 'depotcache'));
      readWmkFiles(path.join(resolvedSteamPath, 'config', 'stplug-in'));
    }

    for (const folder of (Array.isArray(bypassFolders) ? bypassFolders : [])) {
      if (typeof folder === 'string') readWmkFiles(folder);
    }

    return { success: true, items };
  } catch (e) {
    return { success: false, items, error: e.message };
  }
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
// ACTIVE TOOLS — download ZIP tools dari link GitHub (diatur Admin Web),
// tutup Steam, extract ke folder Steam yang sudah terdeteksi, lalu catat
// semua file yang di-extract supaya statusnya bisa divalidasi ulang kapan
// saja (termasuk kalau user menghapus filenya manual).
// Progress download dikirim lewat channel 'download-progress' YANG SAMA
// dengan inject-game/install-bypass, supaya renderer bisa reuse modal
// download yang sudah ada (dlModal) tanpa perlu listener/channel baru.
// ══════════════════════════════════════════════════════════════════════════
ipcMain.handle('active-tools-install', async (event, { steamPath, zipUrl } = {}) => {
  const tempZip = path.join(app.getPath('temp'), 'active_tools_' + Date.now() + '.zip');
  const tempDir = path.join(app.getPath('temp'), 'active_tools_extract_' + Date.now());
  try {
    if (!steamPath || !fs.existsSync(steamPath)) {
      throw new Error('Folder Steam belum terdeteksi. Pastikan Steam sudah terinstall di PC ini.');
    }
    if (!zipUrl) throw new Error('Link download Active Tools belum diatur admin.');

    await downloadFileWithProgress(zipUrl, tempZip, null, 0, {});

    const headBuf = Buffer.alloc(4);
    const fdCheck = fs.openSync(tempZip, 'r');
    fs.readSync(fdCheck, headBuf, 0, 4, 0);
    fs.closeSync(fdCheck);
    if (headBuf[0] !== 0x50 || headBuf[1] !== 0x4B) {
      throw new Error('File yang didownload bukan ZIP valid - kemungkinan link rusak atau sudah kedaluwarsa.');
    }

    try { execSync('taskkill /F /IM steam.exe'); } catch (e) { /* Steam memang belum jalan - aman */ }
    await new Promise(r => setTimeout(r, 1500));

    fs.mkdirSync(tempDir, { recursive: true });
    await extractZip(tempZip, { dir: tempDir });

    const extractedFiles = [];
    function walkAndCopy(srcDir, relBase) {
      for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
        const srcPath = path.join(srcDir, entry.name);
        const relPath = relBase ? path.join(relBase, entry.name) : entry.name;
        const destPath = path.join(steamPath, relPath);
        if (entry.isDirectory()) {
          fs.mkdirSync(destPath, { recursive: true });
          walkAndCopy(srcPath, relPath);
        } else {
          fs.mkdirSync(path.dirname(destPath), { recursive: true });
          fs.copyFileSync(srcPath, destPath);
          extractedFiles.push(relPath.split(path.sep).join('/'));
        }
      }
    }
    walkAndCopy(tempDir, '');

    try { fs.unlinkSync(tempZip); } catch (e) {}
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e) {}

    if (!extractedFiles.length) throw new Error('File ZIP kosong - tidak ada file yang bisa diextract.');

    return { success: true, extractedFiles };
  } catch (e) {
    try { fs.unlinkSync(tempZip); } catch (e2) {}
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e2) {}
    if (e.message === 'CANCELLED') return { success: false, cancelled: true };
    return { success: false, error: e.message || 'Gagal mengaktifkan Active Tools.' };
  }
});

ipcMain.handle('active-tools-check-status', (event, { steamPath, extractedFiles } = {}) => {
  try {
    if (!steamPath || !fs.existsSync(steamPath)) return { active: false, reason: 'steam-not-found' };
    if (!Array.isArray(extractedFiles) || !extractedFiles.length) return { active: false, reason: 'not-installed' };
    const base = path.resolve(steamPath);
    let missing = 0;
    for (const relPath of extractedFiles) {
      if (typeof relPath !== 'string' || relPath.includes('..')) { missing++; continue; }
      const fullPath = path.resolve(path.join(steamPath, relPath));
      if (!fullPath.startsWith(base)) { missing++; continue; }
      if (!fs.existsSync(fullPath)) { missing++; continue; }
      // ROOT CAUSE FIX ("file rusak/tidak valid -> TIDAK AKTIF"): SEBELUMNYA
      // hanya existsSync yang dicek — file 0 byte (hasil copy yang gagal/
      // keputus di tengah jalan, disk penuh, dst — sisa file tetap "ada" tapi
      // isinya kosong/rusak) lolos dianggap valid padahal jelas tidak
      // fungsional. `extractedFiles` di sini SELALU berisi path FILE (bukan
      // folder — lihat walkAndCopy() di 'active-tools-install' di atas, cuma
      // push ke array ini untuk entry yang bukan direktori), jadi aman
      // langsung statSync tanpa perlu cek isDirectory. TIDAK menambah sistem
      // verifikasi baru — tetap IPC & daftar file yang SAMA persis, cuma
      // pengecekan existsSync-nya diperketat.
      try {
        if (fs.statSync(fullPath).size === 0) { missing++; continue; }
      } catch (e) { missing++; continue; }
    }
    return { active: missing === 0, missing, total: extractedFiles.length };
  } catch (e) {
    return { active: false, error: e.message };
  }
});

// ══════════════════════════════════════════════════════════════════════════
// ACTIVE TOOLS — METODE BARU: "PowerShell Command". Sistem Link di atas
// (active-tools-install) TIDAK diubah/dihapus sama sekali — ini handler
// BARU yang terpisah, dipakai HANYA kalau admin memilih Activation Method =
// PowerShell di Admin Web (lihat activeToolsManager.js).
//
// PENTING (sesuai permintaan): TIDAK ADA taskkill/restart Steam di sini sama
// sekali — command yang diisi admin diasumsikan SUDAH mengurus Exit Steam-nya
// sendiri kalau memang perlu. App menjalankan command PERSIS apa adanya,
// tanpa menambahkan command lain apapun sebelum/sesudahnya.
//
// ── CATATAN PERBAIKAN BUG "spawn EPERM" ──
// Implementasi lama memanggil spawn('powershell.exe', [...], {windowsHide:true})
// LANGSUNG dari Node (Electron main process). Di banyak kondisi Windows —
// Antivirus/EDR yang memang mencurigai PowerShell di-spawn tersembunyi +
// -ExecutionPolicy Bypass oleh proses non-shell (pola umum "LOLBin" yang
// sering diblokir Controlled Folder Access / Defender), App Execution Alias,
// atau kebijakan grup tertentu — panggilan CreateProcess ini ditolak Windows
// dan Node melempar `spawn EPERM` (persis error yang dilaporkan).
//
// Fix: TIDAK spawn powershell.exe langsung. Sebaliknya pakai ULANG pola yang
// SUDAH terbukti jalan & aman di fitur lain pada file ini (lihat handler
// 'active-tools-install-update' di atas) — jalankan lewat WScript.Shell.Run
// (window style 0 = hidden). WScript.Shell.Run TIDAK lewat Node punya
// CreateProcess API sama sekali, jadi tidak kena pemblokiran yang sama, dan
// dari sisi Windows ini adalah cara resmi/umum untuk menjalankan proses
// tersembunyi — jauh lebih reliable daripada flag windowsHide (lihat catatan
// yang sama soal ini di handler update di atas).
//
// Command PowerShell dari admin ditulis apa adanya ke file .ps1 sementara
// (bukan inline -Command string) — sekalian menghindari batas panjang &
// masalah escaping command-line untuk command yang kompleks/multi-baris.
// Output (stdout+stderr) dan exit code dialihkan ke file sementara supaya
// tetap bisa di-stream realtime ke renderer & dideteksi selesainya, walau
// eksekusi sebenarnya "dititipkan" ke WScript. Node hanya men-spawn
// wscript.exe (proses ringan, TIDAK pernah kena EPERM di kasus manapun yang
// pernah dilaporkan) dan menunggu event 'close'-nya — bukan detached, supaya
// kita tetap tahu kapan seluruh proses (termasuk PowerShell di dalamnya)
// benar-benar selesai.
// ══════════════════════════════════════════════════════════════════════════
ipcMain.handle('active-tools-run-powershell', (event, { command } = {}) => {
  return new Promise((resolve) => {
    if (!command || !String(command).trim()) {
      resolve({ success: false, error: 'PowerShell Command belum diatur admin.' });
      return;
    }

    const sender = event.sender;
    const logLines = [];
    const pushLog = (line) => {
      const clean = String(line || '').replace(/\r/g, '').trimEnd();
      if (!clean) return;
      logLines.push(clean);
      try { sender.send('active-tools-ps-progress', { line: clean }); } catch (e) { /* renderer sudah tertutup - abaikan */ }
    };

    const stamp = Date.now();
    const tempDir = app.getPath('temp');
    const ps1Path = path.join(tempDir, `31tools_activetools_${stamp}.ps1`);
    const outPath = path.join(tempDir, `31tools_activetools_${stamp}.out.log`);
    const exitPath = path.join(tempDir, `31tools_activetools_${stamp}.exitcode`);
    const vbsPath = path.join(tempDir, `31tools_activetools_${stamp}.vbs`);
    const cmdBatchPath = path.join(tempDir, `31tools_activetools_${stamp}.bat`);

    const cleanupTempFiles = () => {
      for (const p of [ps1Path, outPath, exitPath, vbsPath, cmdBatchPath]) {
        try { fs.unlinkSync(p); } catch (e) { /* sudah terhapus/tidak fatal */ }
      }
    };

    let watchTimer = null;
    let lastReadPos = 0;
    const tailOutputFile = () => {
      try {
        if (!fs.existsSync(outPath)) return;
        const stat = fs.statSync(outPath);
        if (stat.size <= lastReadPos) return;
        const fd = fs.openSync(outPath, 'r');
        const len = stat.size - lastReadPos;
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, lastReadPos);
        fs.closeSync(fd);
        lastReadPos = stat.size;
        buf.toString('utf8').split('\n').forEach(pushLog);
      } catch (e) { /* file mungkin lagi ditulis proses lain - coba lagi di tick berikutnya */ }
    };

    try {
      // Command PERSIS apa adanya ke file .ps1 (tanpa modifikasi apapun),
      // sama seperti perilaku -Command sebelumnya — cuma medianya beda.
      fs.writeFileSync(ps1Path, command, { encoding: 'utf8' });

      // cmd.exe di sini HANYA dipakai sebagai perantara redirection (>, 2>&1,
      // %errorlevel%) — dia sendiri tidak pernah tampil karena seluruhnya
      // dijalankan lewat WScript.Shell.Run dengan window style 0 (hidden).
      const inner = `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${ps1Path}" > "${outPath}" 2>&1` +
        `\r\necho %errorlevel% > "${exitPath}"`;
      fs.writeFileSync(cmdBatchPath, `@echo off\r\n${inner}\r\n`);

      const escapedBatch = cmdBatchPath.replace(/"/g, '""');
      const vbsScript = [
        'Set shell = CreateObject("WScript.Shell")',
        // 0 = window hidden, True = tunggu sampai selesai (biar event 'close'
        // punya wscript.exe di Node benar-benar menandakan proses sudah beres).
        `shell.Run """" & "${escapedBatch}" & """", 0, True`
      ].join('\r\n');
      fs.writeFileSync(vbsPath, vbsScript);
    } catch (e) {
      resolve({ success: false, error: `Gagal menyiapkan PowerShell: ${e.message}` });
      return;
    }

    let child;
    try {
      child = spawn('wscript.exe', ['//B', '//Nologo', vbsPath], {
        windowsHide: true,
        stdio: 'ignore'
      });
    } catch (e) {
      cleanupTempFiles();
      resolve({ success: false, error: `Gagal menjalankan PowerShell: ${e.message}` });
      return;
    }

    pushLog('▶ Menjalankan PowerShell command...');
    watchTimer = setInterval(tailOutputFile, 300);

    child.on('error', (e) => {
      clearInterval(watchTimer);
      pushLog(`✖ ${e.message}`);
      const finalLog = logLines.join('\n');
      cleanupTempFiles();
      resolve({ success: false, error: e.message || 'Gagal menjalankan PowerShell.', log: finalLog });
    });

    child.on('close', () => {
      clearInterval(watchTimer);
      tailOutputFile(); // baca sisa output yang belum sempat ke-tail terakhir kali

      let code = null;
      try { code = parseInt(String(fs.readFileSync(exitPath, 'utf8')).trim(), 10); } catch (e) { /* file exit code tidak ada = anggap gagal di bawah */ }

      // Log proses disimpan ke disk (userData/logs) supaya bisa ditelusuri belakangan
      // kalau ada masalah — TIDAK dikirim ke server (murni lokal PC), sesuai fitur ini
      // yang memang berjalan sepenuhnya di sisi App/PC user.
      try {
        const logDir = path.join(app.getPath('userData'), 'logs');
        fs.mkdirSync(logDir, { recursive: true });
        const logPath = path.join(logDir, `active-tools-powershell-${stamp}.log`);
        fs.writeFileSync(logPath, `Command:\n${command}\n\nExit Code: ${code}\n\nOutput:\n${logLines.join('\n')}\n`);
      } catch (e) { /* gagal simpan log lokal - tidak fatal */ }

      cleanupTempFiles();

      // CATATAN FIX (popup "i (exit code 0)."): baris yang di-push ke renderer
      // di sini SEBELUMNYA menyertakan teks teknis "(exit code N)" — ini yang
      // muncul apa adanya di UI karena app.js dulu menampilkan baris log
      // TERAKHIR sebagai status text tanpa filter (lihat fix di app.js,
      // fungsi onActiveToolsPsProgress). Exit code TETAP dicatat lengkap di
      // `code` (dipakai di file log internal userData/logs di atas) — cuma
      // teks yang dikirim ke renderer/​UI sekarang bahasa manusia biasa,
      // tanpa detail proses/teknis.
      if (Number.isInteger(code) && code === 0) {
        pushLog('✅ Selesai.');
        resolve({ success: true, code, log: logLines.join('\n') });
      } else {
        pushLog('✖ Command berhenti dengan kesalahan.');
        resolve({ success: false, error: 'Active Tools gagal dijalankan. Cek log internal untuk detail teknis.', code, log: logLines.join('\n') });
      }
    });
  });
});

// ── CLOUD FIX — SEKARANG SAMA PERSIS mekanismenya dengan Active Tools di atas:
// download ZIP yang diatur admin, tutup Steam, lalu extract langsung ke folder
// Steam (bukan cuma buka link eksternal seperti versi sebelumnya). Sengaja
// dibuat handler terpisah (bukan numpang ke 'active-tools-install') supaya
// log/pesan errornya tetap jelas ini proses Cloud FIX, bukan Active Tools. ──
ipcMain.handle('cloud-fix-install', async (event, { steamPath, zipUrl } = {}) => {
  const tempZip = path.join(app.getPath('temp'), 'cloud_fix_' + Date.now() + '.zip');
  const tempDir = path.join(app.getPath('temp'), 'cloud_fix_extract_' + Date.now());
  try {
    if (!steamPath || !fs.existsSync(steamPath)) {
      throw new Error('Folder Steam belum terdeteksi. Pastikan Steam sudah terinstall di PC ini.');
    }
    if (!zipUrl) throw new Error('Link download Cloud FIX belum diatur admin.');

    await downloadFileWithProgress(zipUrl, tempZip, null, 0, {});

    const headBuf = Buffer.alloc(4);
    const fdCheck = fs.openSync(tempZip, 'r');
    fs.readSync(fdCheck, headBuf, 0, 4, 0);
    fs.closeSync(fdCheck);
    if (headBuf[0] !== 0x50 || headBuf[1] !== 0x4B) {
      throw new Error('File yang didownload bukan ZIP valid - kemungkinan link rusak atau sudah kedaluwarsa.');
    }

    try { execSync('taskkill /F /IM steam.exe'); } catch (e) { /* Steam memang belum jalan - aman */ }
    await new Promise(r => setTimeout(r, 1500));

    fs.mkdirSync(tempDir, { recursive: true });
    await extractZip(tempZip, { dir: tempDir });

    const extractedFiles = [];
    function walkAndCopy(srcDir, relBase) {
      for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
        const srcPath = path.join(srcDir, entry.name);
        const relPath = relBase ? path.join(relBase, entry.name) : entry.name;
        const destPath = path.join(steamPath, relPath);
        if (entry.isDirectory()) {
          fs.mkdirSync(destPath, { recursive: true });
          walkAndCopy(srcPath, relPath);
        } else {
          fs.mkdirSync(path.dirname(destPath), { recursive: true });
          fs.copyFileSync(srcPath, destPath);
          extractedFiles.push(relPath.split(path.sep).join('/'));
        }
      }
    }
    walkAndCopy(tempDir, '');

    try { fs.unlinkSync(tempZip); } catch (e) {}
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e) {}

    if (!extractedFiles.length) throw new Error('File ZIP kosong - tidak ada file yang bisa diextract.');

    return { success: true, extractedFiles };
  } catch (e) {
    try { fs.unlinkSync(tempZip); } catch (e2) {}
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e2) {}
    if (e.message === 'CANCELLED') return { success: false, cancelled: true };
    return { success: false, error: e.message || 'Gagal menjalankan Cloud FIX.' };
  }
});

ipcMain.handle('cloud-fix-check-status', (event, { steamPath, extractedFiles } = {}) => {
  try {
    if (!steamPath || !fs.existsSync(steamPath)) return { active: false, reason: 'steam-not-found' };
    if (!Array.isArray(extractedFiles) || !extractedFiles.length) return { active: false, reason: 'not-installed' };
    const base = path.resolve(steamPath);
    let missing = 0;
    for (const relPath of extractedFiles) {
      if (typeof relPath !== 'string' || relPath.includes('..')) { missing++; continue; }
      const fullPath = path.resolve(path.join(steamPath, relPath));
      if (!fullPath.startsWith(base)) { missing++; continue; }
      if (!fs.existsSync(fullPath)) missing++;
    }
    return { active: missing === 0, missing, total: extractedFiles.length };
  } catch (e) {
    return { active: false, error: e.message };
  }
});

ipcMain.handle('launch-steam', (event, steamPath) => {
  try {
    if (!steamPath || !fs.existsSync(steamPath)) return { success: false, error: 'Steam path tidak ditemukan' };
    const steamExe = path.join(path.resolve(steamPath), 'steam.exe');
    exec('"' + steamExe + '"');
    return { success: true };
  } catch (e) { return { success: false, error: e.message }; }
});

// ── Tombol "LOGIN AKUN" (Steam Account Marketplace) — jalankan Steam
// langsung ke akun yang dibeli, pakai flag CLI resmi Steam `-login`.
// Tahapan (dikirim ke renderer lewat channel 'steam-account-login-progress'
// biar UI bisa tampilkan "Menyiapkan Steam... / Menutup Steam... / Restart
// Steam... / Login akun... / Steam berhasil login." tanpa raw error teknis):
//   1) preparing  — validasi Steam path & kredensial
//   2) closing    — deteksi & tutup Steam yang sedang berjalan (aman, tunggu
//                    proses benar-benar exit sebelum lanjut)
//   3) restarting — jeda singkat supaya file lock Steam benar-benar lepas
//   4) logging_in — jalankan steam.exe -login <user> <pass>
//   5) done / error
// Kredensial dikirim SEKALI PAKAI dari renderer (sudah diambil dari server
// lewat GET /api/steam-accounts/:id/credentials tepat saat tombol diklik),
// TIDAK disimpan di disk oleh proses Electron ini.
let _steamAccountLoginInProgress = false;

function isSteamRunning() {
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq steam.exe"').toString();
    return /steam\.exe/i.test(out);
  } catch (e) {
    return false;
  }
}

function waitForSteamExit(timeoutMs = 8000, intervalMs = 300) {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      if (!isSteamRunning() || Date.now() - start >= timeoutMs) return resolve();
      setTimeout(check, intervalMs);
    };
    check();
  });
}

// ── Tutup Steam dengan AMAN — pakai `-shutdown` (exit halus, Steam sempat
// flush & simpan cache kredensial/sesinya dengan benar) DULU, taskkill paksa
// cuma dipakai sebagai fallback kalau -shutdown tidak selesai dalam batas
// waktu. Ini penting untuk AUTO LOGIN BERULANG KALI: taskkill /F yang selalu
// dipakai sebelumnya bisa memutus Steam di tengah proses tulis file sesi
// (ClientRegistry.blob / loginusers.vdf), sehingga sewaktu-waktu Steam jadi
// "lupa" kredensial tersimpan dan minta login manual lagi. ──
function shutdownSteamGracefully(steamExe, { timeoutMs = 7000, intervalMs = 300 } = {}) {
  return new Promise((resolve) => {
    if (!isSteamRunning()) return resolve();
    try { execFile(steamExe, ['-shutdown'], () => {}); } catch (e) { /* diabaikan, fallback taskkill di bawah */ }
    const start = Date.now();
    const check = () => {
      if (!isSteamRunning()) return resolve();
      if (Date.now() - start >= timeoutMs) {
        try { execSync('taskkill /F /IM steam.exe'); } catch (e2) { /* race — mungkin sudah exit sendiri, aman */ }
        return waitForSteamExit(4000, 300).then(resolve);
      }
      setTimeout(check, intervalMs);
    };
    setTimeout(check, intervalMs);
  });
}

// ── Baca SEMUA baris akun di config/loginusers.vdf, termasuk AccountName
// (username LOGIN yang sebenarnya — beda dari PersonaName/nama tampilan yang
// dipakai getSteamAccountInfo() punya halaman Settings). Dipakai KHUSUS untuk
// verifikasi status login akun target, jadi dibuat terpisah supaya
// getSteamAccountInfo() (fitur Settings yang sudah ada) tidak ikut disentuh. ──
function readLoginUsersAccounts(steamPath) {
  try {
    const vdfPath = path.join(steamPath, 'config', 'loginusers.vdf');
    if (!fs.existsSync(vdfPath)) return [];
    const content = fs.readFileSync(vdfPath, 'utf8');
    const blocks = [...content.matchAll(/"(\d{17})"\s*\{([^}]*)\}/g)];
    return blocks.map(b => {
      const body = b[2];
      const accountNameMatch = body.match(/"AccountName"\s+"([^"]*)"/);
      return {
        steamId64: b[1],
        accountName: accountNameMatch ? accountNameMatch[1] : null
      };
    });
  } catch (e) {
    return [];
  }
}

function readSteamActiveUserId() {
  try {
    const reg = execSync('reg query "HKCU\\Software\\Valve\\Steam\\ActiveProcess" /v ActiveUser').toString();
    const m = reg.match(/ActiveUser\s+REG_DWORD\s+0x([0-9a-f]+)/i);
    if (m) {
      const steam32 = parseInt(m[1], 16);
      if (steam32 > 0) return (BigInt(steam32) + 76561197960265728n).toString();
    }
  } catch (e) { /* Steam belum jalan / registry belum ada — aman, anggap tidak ada active user */ }
  return null;
}

// ── Verifikasi NYATA bahwa Steam benar-benar sudah login ke akun target —
// bukan sekadar asumsi karena proses steam.exe berhasil dijalankan. Dicek
// dengan mencocokkan AccountName (username login) di loginusers.vdf terhadap
// SteamID64 yang SEDANG aktif di registry (ActiveUser). Kalau belum cocok
// sampai timeout, dianggap gagal/timeout — bukan "berhasil". ──
function waitForSteamLoginConfirmed(steamPath, expectedUsername, { timeoutMs = 30000, intervalMs = 1000 } = {}) {
  return new Promise((resolve) => {
    const start = Date.now();
    const target = String(expectedUsername || '').trim().toLowerCase();
    let sawRunning = false;
    const tick = () => {
      const elapsed = Date.now() - start;
      const running = isSteamRunning();
      if (running) sawRunning = true;
      if (running) {
        const activeId = readSteamActiveUserId();
        const accounts = readLoginUsersAccounts(steamPath);
        const match = target ? accounts.find(a => (a.accountName || '').toLowerCase() === target) : null;
        if (match && activeId && match.steamId64 === activeId) {
          return resolve({ ok: true });
        }
      } else if (sawRunning) {
        // Steam sempat jalan lalu berhenti sebelum login terkonfirmasi —
        // kemungkinan besar Steam crash di tengah proses login.
        return resolve({ ok: false, reason: 'crashed' });
      }
      if (elapsed >= timeoutMs) return resolve({ ok: false, reason: 'timeout' });
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

const STEAM_LOGIN_TIMEOUT_MS = 30000;
const STEAM_LOGIN_MAX_ATTEMPTS = 2; // retry limit AMAN — jangan infinite retry

ipcMain.handle('steam-account-login', async (event, { steamPath, username, password }) => {
  // Login lock/state machine: IDLE -> LOGGING_IN -> (SUCCESS/FAILED/TIMEOUT) -> IDLE.
  // Kalau user mengklik LOGIN AKUN berkali-kali (double click, dst) selagi
  // masih LOGGING_IN, request tambahan ditolak langsung — TIDAK ikut
  // menjalankan/restart proses steam.exe baru, TIDAK ada proses auto-login
  // paralel. Lock selalu dilepas di `finally` (termasuk kalau exception),
  // jadi user selalu bisa login lagi setelah proses sebelumnya benar-benar
  // selesai — tidak pernah nyangkut permanen.
  if (_steamAccountLoginInProgress) {
    return { success: false, code: 'busy', error: 'Proses login Steam sebelumnya masih berjalan, tunggu sebentar.' };
  }
  _steamAccountLoginInProgress = true;
  const sendProgress = (stage, message) => mainWindow?.webContents.send('steam-account-login-progress', { stage, message });

  try {
    sendProgress('preparing', 'Menyiapkan Steam...');
    if (!steamPath || !fs.existsSync(steamPath)) {
      sendProgress('error', 'Steam path tidak ditemukan.');
      return { success: false, code: 'steam_not_found', error: 'Steam path tidak ditemukan. Pastikan Steam sudah terinstall di PC ini.' };
    }
    if (!username || !password) {
      sendProgress('error', 'Kredensial tidak lengkap.');
      return { success: false, code: 'invalid_credentials', error: 'Kredensial akun tidak lengkap.' };
    }
    const steamExe = path.join(path.resolve(steamPath), 'steam.exe');
    if (!fs.existsSync(steamExe)) {
      sendProgress('error', 'steam.exe tidak ditemukan.');
      return { success: false, code: 'exe_missing', error: 'steam.exe tidak ditemukan di folder Steam.' };
    }

    let lastReason = null;
    for (let attempt = 1; attempt <= STEAM_LOGIN_MAX_ATTEMPTS; attempt++) {
      const attemptSuffix = attempt > 1 ? ` (percobaan ${attempt}/${STEAM_LOGIN_MAX_ATTEMPTS})` : '';

      // Tutup Steam yang sedang berjalan (baik dari akun lain, sisa attempt
      // sebelumnya, atau sudah terbuka duluan) — tidak pernah membiarkan 2
      // proses steam.exe jalan bersamaan.
      if (isSteamRunning()) {
        sendProgress('closing', `Menutup Steam...${attemptSuffix}`);
        await shutdownSteamGracefully(steamExe);
      }

      sendProgress('restarting', `Restart Steam...${attemptSuffix}`);
      // Jeda singkat supaya file lock Steam benar-benar lepas sebelum proses
      // baru dibuka dengan akun target.
      await new Promise(r => setTimeout(r, 1200));

      sendProgress('logging_in', `Login akun...${attemptSuffix}`);
      try {
        // spawn (bukan execFile) + detached/unref, dan SENGAJA TIDAK ditunggu
        // exit-nya — Steam bisa saja tidak pernah "keluar" dari proses yang
        // kita spawn ini di level OS, jadi menunggu callback-nya bisa membuat
        // tombol nyangkut MEMPROSES... selamanya. Argumen dilempar sebagai
        // array (bukan string), jadi TIDAK lewat shell interpolation dan
        // TIDAK muncul di process list lewat gabungan string.
        // '-noreactlogin' — flag undocumented Steam yang mengembalikan login
        // window versi LAMA (bukan React-based) yang masih menghormati
        // '-login user pass' buat auto-fill + auto-submit. Sejak Steam client
        // update ~2022/2023, '-login' TANPA flag ini cuma buka window login
        // KOSONG (user harus ketik ulang manual) — itu penyebab kenapa
        // Auto Login sebelumnya "nyangkut" minta username/password lagi;
        // BUKAN bug di App ini, tapi perubahan dari sisi Steam client sendiri.
        const child = spawn(steamExe, ['-noreactlogin', '-login', username, password], { detached: true, stdio: 'ignore' });
        child.unref();
        child.on('error', (e) => console.warn('[Steam Account Login] gagal spawn steam.exe:', e.message));
      } catch (e) {
        lastReason = 'spawn_failed';
        continue;
      }

      // Verifikasi NYATA — bukan cuma anggap berhasil karena proses berhasil
      // dijalankan. Kalau Steam gagal login, proses dihentikan di sini dan UI
      // langsung dikasih status gagal/timeout lewat return di bawah.
      const result = await waitForSteamLoginConfirmed(steamPath, username, { timeoutMs: STEAM_LOGIN_TIMEOUT_MS });
      if (result.ok) {
        sendProgress('done', 'Steam berhasil login.');
        return { success: true };
      }
      lastReason = result.reason;
      // Cuma 'crashed' yang otomatis dicoba ulang (masih dalam retry limit
      // aman di atas) — 'timeout' (Steam jalan tapi akun aktif tidak cocok,
      // kemungkinan besar minta Steam Guard/verifikasi manual) TIDAK diulang
      // otomatis karena mengulang restart tidak akan menyelesaikan itu.
      if (result.reason !== 'crashed') break;
    }

    const messages = {
      timeout: 'Steam gagal login. Silakan coba lagi.',
      crashed: 'Steam berhenti/crash saat proses login. Silakan coba lagi.',
      spawn_failed: 'Steam gagal dijalankan. Silakan coba lagi.'
    };
    sendProgress('error', 'Steam gagal login.');
    return { success: false, code: lastReason || 'unknown', error: messages[lastReason] || 'Steam gagal login. Silakan coba lagi.' };
  } catch (e) {
    sendProgress('error', 'Steam gagal login.');
    return { success: false, code: 'exception', error: e.message };
  } finally {
    _steamAccountLoginInProgress = false;
  }
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

// ══════════════════════════════════════════════════════════════════════════
// STEAM & DISCORD DETECTION (halaman Settings)
// ══════════════════════════════════════════════════════════════════════════
// Semua data di sini dibaca dari file/registry LOKAL yang memang publik &
// non-sensitif (lokasi instalasi, folder library, manifest game terinstal,
// status proses berjalan/tidak, nama akun Steam yang tersimpan di
// loginusers.vdf). SENGAJA TIDAK membaca local storage/LevelDB Discord untuk
// mengambil nama akun — itu adalah mekanisme yang sama dipakai malware
// pencuri token Discord, jadi bagian itu tidak diimplementasikan. Status
// (Running/Closed) dan lokasi instalasi Discord tetap bisa dideteksi dengan
// aman (cuma cek proses & file di disk, tidak baca kredensial).
// ══════════════════════════════════════════════════════════════════════════

// Cek apakah sebuah proses (by nama .exe) sedang berjalan — dipakai buat status
// Steam & Discord (Running/Closed).
//
// PERF FIX: sebelumnya pakai execSync(), yang MEMBLOKIR seluruh main process
// Electron (event loop, IPC, window controls) sampai proses "tasklist.exe"
// selesai. Karena fungsi ini dipanggil tiap 5 detik oleh
// startSystemDetectionWatcher() (sampai 4x per tick — 1x Steam + 3x varian
// Discord), efeknya adalah micro-freeze berkala di SELURUH app (window jadi
// kerasa "Not Responding" sesaat, terutama di PC yang lebih lambat). Sekarang
// pakai exec() versi async, jadi main process tetap bisa balas IPC/render
// window selagi menunggu hasil "tasklist".
function isProcessRunning(exeName) {
  return new Promise((resolve) => {
    exec(`tasklist /FI "IMAGENAME eq ${exeName}" /NH`, { windowsHide: true }, (err, stdout) => {
      if (err || !stdout) return resolve(false);
      resolve(stdout.toLowerCase().includes(exeName.toLowerCase()));
    });
  });
}

// Baca config/loginusers.vdf buat dapat nama akun Steam + SteamID64. Dicocokkan
// ke ActiveUser di registry (kalau Steam lagi jalan) supaya akun yang ditampilkan
// beneran akun yang SEDANG login, bukan cuma "terakhir pernah login" di PC ini.
function getSteamAccountInfo(steamPath) {
  try {
    const vdfPath = path.join(steamPath, 'config', 'loginusers.vdf');
    if (!fs.existsSync(vdfPath)) return null;
    const content = fs.readFileSync(vdfPath, 'utf8');

    // SteamID64 yang lagi aktif SEKARANG (kalau Steam lagi jalan & ada yang login),
    // dari registry ActiveProcess > ActiveUser (isinya SteamID32 dalam hex).
    let activeSteamId64 = null;
    try {
      const reg = execSync('reg query "HKCU\\Software\\Valve\\Steam\\ActiveProcess" /v ActiveUser').toString();
      const m = reg.match(/ActiveUser\s+REG_DWORD\s+0x([0-9a-f]+)/i);
      if (m) {
        const steam32 = parseInt(m[1], 16);
        if (steam32 > 0) activeSteamId64 = (BigInt(steam32) + 76561197960265728n).toString();
      }
    } catch (e) {}

    const blocks = [...content.matchAll(/"(\d{17})"\s*\{([^}]*)\}/g)];
    const accounts = blocks.map(b => {
      const body = b[2];
      const nameMatch = body.match(/"PersonaName"\s+"([^"]*)"/);
      const mostRecentMatch = body.match(/"MostRecent"\s+"(\d)"/);
      const timestampMatch = body.match(/"Timestamp"\s+"(\d+)"/);
      return {
        steamId64: b[1],
        personaName: nameMatch ? nameMatch[1] : null,
        mostRecent: mostRecentMatch ? mostRecentMatch[1] === '1' : false,
        timestamp: timestampMatch ? parseInt(timestampMatch[1], 10) : 0
      };
    });
    if (!accounts.length) return null;

    let chosen = activeSteamId64 ? accounts.find(a => a.steamId64 === activeSteamId64) : null;
    if (!chosen) chosen = accounts.find(a => a.mostRecent) || accounts.sort((a, b) => b.timestamp - a.timestamp)[0];
    if (!chosen) return null;

    return {
      steamId64: chosen.steamId64,
      personaName: chosen.personaName || null,
      // "Aktif sekarang" cuma valid interpretasinya kalau kita juga tahu Steam lagi
      // jalan — kalau Steam ketutup, ini cuma akun TERAKHIR yang login (ditandai
      // di UI sebagai "akun terakhir", bukan diklaim sebagai "sedang login").
      isConfirmedActive: !!activeSteamId64 && chosen.steamId64 === activeSteamId64
    };
  } catch (e) {
    return null;
  }
}

// Scan appmanifest_*.acf di semua Steam library — daftar game yang beneran
// terinstal (bukan cuma game yang launcher ini yang install).
function getInstalledSteamGames(libraries) {
  const games = [];
  for (const lib of libraries) {
    try {
      const steamappsDir = path.join(lib, 'steamapps');
      if (!fs.existsSync(steamappsDir)) continue;
      const files = fs.readdirSync(steamappsDir).filter(f => /^appmanifest_\d+\.acf$/i.test(f));
      for (const f of files) {
        try {
          const content = fs.readFileSync(path.join(steamappsDir, f), 'utf8');
          const appIdM = content.match(/"appid"\s+"(\d+)"/i);
          const nameM = content.match(/"name"\s+"([^"]*)"/i);
          const installDirM = content.match(/"installdir"\s+"([^"]*)"/i);
          const sizeM = content.match(/"SizeOnDisk"\s+"(\d+)"/i);
          if (appIdM) {
            games.push({
              appId: appIdM[1],
              name: (nameM && nameM[1]) || (installDirM && installDirM[1]) || `App ${appIdM[1]}`,
              installDir: installDirM ? installDirM[1] : null,
              sizeBytes: sizeM ? Number(sizeM[1]) : null,
              library: lib
            });
          }
        } catch (e2) {}
      }
    } catch (e) {}
  }
  return games;
}

// Status Discord (Running/Closed) — HANYA status proses, tidak ambil lokasi
// instalasi ataupun apapun dari local storage Discord. Info akun (username,
// display name, avatar, user ID, role) diambil dari sesi login user yang SUDAH
// terautentikasi lewat Discord OAuth di server (lihat renderSystemDetection()
// di app.js) — bukan dari file lokal, jadi tidak ada isu keamanan/privasi.
async function getDiscordStatus() {
  let running = false;
  for (const exe of ['Discord.exe', 'DiscordPTB.exe', 'DiscordCanary.exe', 'DiscordDevelopment.exe']) {
    if (await isProcessRunning(exe)) { running = true; break; } // short-circuit, sama seperti .some() sebelumnya
  }
  return { status: running ? 'running' : 'closed' };
}

// Kumpulkan semua data deteksi sekaligus — dipanggil app.js pas halaman Settings
// dibuka & pas user klik "Refresh Data".
ipcMain.handle('get-system-detection', async () => {
  const steamPath = detectSteamPathFromRegistry();
  const steamRunning = await isProcessRunning('steam.exe');

  let steam = {
    installed: !!steamPath,
    location: steamPath,
    status: steamRunning ? 'running' : 'closed',
    accountName: null,
    steamId: null,
    isConfirmedActive: false,
    libraries: [],
    libraryCount: 0,
    installedGames: [],
    installedGameCount: 0
  };

  if (steamPath) {
    const account = getSteamAccountInfo(steamPath);
    if (account) {
      steam.accountName = account.personaName;
      steam.steamId = account.steamId64;
      steam.isConfirmedActive = account.isConfirmedActive;
    }
    const libraries = getSteamLibraryFolders(steamPath);
    const games = getInstalledSteamGames(libraries);
    steam.libraries = libraries.map(lib => ({
      path: lib,
      gameCount: games.filter(g => g.library === lib).length
    }));
    steam.libraryCount = libraries.length;
    steam.installedGames = games.map(({ library, ...g }) => g); // buang field internal `library` dari payload ke renderer
    steam.installedGameCount = games.length;
  }

  const discord = await getDiscordStatus();

  return { steam, discord, checkedAt: new Date().toISOString() };
});

// Buka folder di File Explorer — dipakai tombol "Buka Folder Steam/Library/Discord".
ipcMain.handle('open-folder', async (event, folderPath) => {
  try {
    if (!folderPath || !fs.existsSync(folderPath)) {
      return { success: false, error: 'Folder tidak ditemukan di perangkat ini.' };
    }
    const result = await shell.openPath(folderPath); // string kosong = sukses, selain itu = pesan error
    if (result) return { success: false, error: result };
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// ── Watcher realtime: status Running/Closed Steam & Discord tanpa perlu klik
// Refresh atau restart app — cek tiap beberapa detik, cuma kirim event kalau
// statusnya BENERAN berubah (biar tidak spam IPC). ──
let _lastDetectionStatus = { steam: null, discord: null };
let _sysdetWatcherBusy = false; // cegah tick numpuk kalau tasklist pernah lambat/lag
async function startSystemDetectionWatcher() {
  setInterval(async () => {
    if (_sysdetWatcherBusy) return; // tick sebelumnya belum selesai — skip, jangan numpuk
    _sysdetWatcherBusy = true;
    try {
      const steamRunning = await isProcessRunning('steam.exe');
      let discordRunning = false;
      for (const exe of ['Discord.exe', 'DiscordPTB.exe', 'DiscordCanary.exe', 'DiscordDevelopment.exe']) {
        if (await isProcessRunning(exe)) { discordRunning = true; break; } // short-circuit, sama seperti .some() sebelumnya
      }
      if (_lastDetectionStatus.steam !== steamRunning || _lastDetectionStatus.discord !== discordRunning) {
        _lastDetectionStatus = { steam: steamRunning, discord: discordRunning };
        mainWindow?.webContents.send('system-detection-status', {
          steam: { status: steamRunning ? 'running' : 'closed' },
          discord: { status: discordRunning ? 'running' : 'closed' }
        });
      }
    } catch (e) {
      // diam-diam gagal — sama seperti perilaku lama
    } finally {
      _sysdetWatcherBusy = false;
    }
  }, 5000);
}