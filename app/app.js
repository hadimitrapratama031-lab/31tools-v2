const SERVER_URL = 'https://31store-production.up.railway.app';
const WS_URL = SERVER_URL.replace(/^http/, 'ws') + '/ws';

let currentUser = null;
let loginStatusEl, pollTimer = null;

function getOrCreateDeviceId() {
  let id = localStorage.getItem('deviceId');
  if (!id) {
    id = 'dev_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
    localStorage.setItem('deviceId', id);
  }
  return id;
}

// ── Auto-refresh token saat 401 ──
let _refreshing = false;
let _refreshPending = null;

async function refreshToken() {
  if (_refreshing) return _refreshPending;
  _refreshing = true;
  _refreshPending = (async () => {
    const old = localStorage.getItem('token');
    if (!old) return null;
    try {
      const res = await fetch(SERVER_URL + '/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${old}` }
      });
      if (!res.ok) return null;
      const data = await res.json();
      if (data.token) { localStorage.setItem('token', data.token); return data.token; }
    } catch(e) {}
    return null;
  })();
  try { return await _refreshPending; }
  finally { _refreshing = false; _refreshPending = null; }
}

async function api(path, options = {}) {
  const doFetch = (token) => fetch(SERVER_URL + path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {})
    }
  });

  let token = localStorage.getItem('token');
  let res = await doFetch(token);

  const newTokenFromHeader = res.headers.get('X-New-Token');
  if (newTokenFromHeader) localStorage.setItem('token', newTokenFromHeader);

  if (res.status === 401 && token) {
    const newToken = await refreshToken();
    if (newToken) {
      res = await doFetch(newToken);
    } else {
      localStorage.removeItem('token');
      showLogin();
      throw new Error('Sesi kamu sudah berakhir. Silakan login ulang.');
    }
  }

  const data = await res.json().catch(() => ({}));
  if (data.newToken) localStorage.setItem('token', data.newToken);
  if (!res.ok) {
    const err = new Error(data.error || 'Terjadi kesalahan.');
    // Tambahan ADDITIVE saja (tidak mengubah perilaku existing yang cuma
    // pakai e.message) — beberapa endpoint (mis. POST /api/steam-accounts/purchase)
    // mengirim flag tambahan di body error (mis. { alreadyOwned:true }) yang
    // berguna buat caller tanpa harus parsing teks pesan error.
    err.data = data;
    throw err;
  }
  return data;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

// Simpan & ambil data user dari localStorage supaya nama+avatar bisa ditampilkan di login
function _getSavedUser() {
  try { return JSON.parse(localStorage.getItem('_savedUser') || 'null'); } catch(e) { return null; }
}
function _saveUser(user) {
  try { localStorage.setItem('_savedUser', JSON.stringify({ username: user.username, avatarUrl: user.avatarUrl, role: user.role })); } catch(e) {}
}

// ── DEVICE LOCK — dipanggil SEKALI tiap sesi login, SEBELUM masuk dashboard.
async function verifyDeviceLock() {
  try {
    const info = (window.electronAPI?.getDeviceInfo) ? await window.electronAPI.getDeviceInfo() : {};
    await api('/api/device/verify', { method: 'POST', body: JSON.stringify(info || {}) });
    return { ok: true };
  } catch (e) {
    const isNetworkError = /fetch|network/i.test(e.message || '');
    if (isNetworkError) return { ok: true };
    return { ok: false, message: e.message || 'Perangkat ini tidak diizinkan mengakses akun ini.' };
  }
}

function showLogin(errorMsg = '') {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (!document.getElementById('nvLoginOverlay')) buildLoginOverlay();
  const overlay = document.getElementById('nvLoginOverlay');
  if (overlay) overlay.style.display = 'flex';
  const appShell = document.getElementById('app');
  if (appShell) appShell.style.display = 'none';
  if (errorMsg && loginStatusEl) {
    loginStatusEl.textContent = errorMsg;
    loginStatusEl.style.color = '#ff7eb3';
  }
}

function buildLoginOverlay() {
  const overlay = document.createElement('div');
  overlay.id = 'nvLoginOverlay';
  // FIX (App Customization background bug — Login tidak ikut berubah):
  // overlay ini DULU punya background gradient ungu hardcode sendiri di
  // sini, sama sekali terpisah dari #appBgLayer/applyAppBackground() (app
  // customization dari Admin Web). Karena overlay ini dibuat & tampil
  // SEBELUM #app (yang punya #appBgLayer di dalamnya) pernah terlihat,
  // Login jadi TIDAK PERNAH bisa mengikuti App Customization apapun yang
  // terjadi. Sekarang overlay TIDAK diberi background sendiri (transparent)
  // supaya #appBgLayer — yang sekarang jadi layer global fixed di belakang
  // SEMUA halaman termasuk Login, lihat .app-bg-layer di styles.css & blok
  // markup-nya di index.html — otomatis terlihat di baliknya. Tidak ada
  // sistem background baru yang dibuat di sini.
  Object.assign(overlay.style, {
    position: 'fixed', inset: '0', zIndex: '9999',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'transparent',
    fontFamily: "'Manrope', sans-serif"
  });

  const card = document.createElement('div');
  Object.assign(card.style, {
    width: '360px', maxWidth: '90vw', padding: '38px 32px', textAlign: 'center',
    borderRadius: '22px', background: 'rgba(18,12,32,0.55)',
    border: '1px solid rgba(255,255,255,0.08)', backdropFilter: 'blur(30px)',
    boxShadow: '0 40px 80px rgba(10,5,25,0.45)'
  });

  const savedToken  = localStorage.getItem('token');
  const savedUser   = _getSavedUser();
  const isReturning = !!(savedToken && savedUser);

  if (isReturning) {
    card.innerHTML = `
      <img id="nvReturnAvatar" src="${escapeHtml(savedUser.avatarUrl || '')}"
        style="width:72px;height:72px;border-radius:50%;object-fit:cover;
               border:3px solid rgba(255,255,255,0.15);margin-bottom:14px;
               box-shadow:0 8px 24px rgba(0,0,0,0.4);"
        onerror="this.style.display='none'">
      <h2 style="font-family:'Poppins',sans-serif;color:#f3eefc;margin:0 0 4px;font-size:20px;">
        Selamat datang kembali!
      </h2>
      <p style="color:#a78bfa;font-size:14px;font-weight:700;margin:0 0 6px;">
        ${escapeHtml(savedUser.username || '')}
      </p>
      <p style="color:#b6a9d1;font-size:12px;margin:0 0 26px;line-height:1.5;">
        Tekan tombol di bawah untuk langsung masuk ke aplikasi.
      </p>
      <button id="nvBtnQuickLogin" style="width:100%;border:none;padding:14px;border-radius:12px;
        background:linear-gradient(90deg,#7c5cff,#a855f7);color:#fff;font-weight:700;font-size:14px;
        cursor:pointer;box-shadow:0 10px 25px rgba(124,92,255,0.45);
        display:flex;align-items:center;justify-content:center;gap:8px;margin-bottom:12px;">
        <svg class="icon icon-18"><use href="#ic-zap"></use></svg> Masuk Sekarang
      </button>
      <button id="nvBtnSwitchAccount" style="width:100%;border:1px solid rgba(255,255,255,0.12);
        padding:11px;border-radius:12px;background:transparent;color:#8f8ab0;
        font-size:12.5px;font-weight:600;cursor:pointer;">
        Ganti Akun (Login Discord)
      </button>
      <div id="nvLoginStatus" style="margin-top:14px;font-size:12px;color:#8f8ab0;min-height:16px;"></div>
    `;

    overlay.appendChild(card);
    document.body.appendChild(overlay);
    loginStatusEl = card.querySelector('#nvLoginStatus');

    card.querySelector('#nvBtnQuickLogin').addEventListener('click', async () => {
      const btn = card.querySelector('#nvBtnQuickLogin');
      btn.disabled = true;
      btn.textContent = 'Memverifikasi...';
      if (loginStatusEl) { loginStatusEl.textContent = ''; }
      try {
        const user = await api('/api/me');
        const deviceCheck = await verifyDeviceLock();
        if (!deviceCheck.ok) {
          btn.disabled = false;
          btn.innerHTML = '<svg class="icon icon-16"><use href="#ic-zap"></use></svg> Masuk Sekarang';
          localStorage.removeItem('token');
          localStorage.removeItem('_savedUser');
          overlay.remove();
          buildLoginOverlay();
          showLogin(deviceCheck.message);
          return;
        }
        hideLogin();
        enterApp(user);
        api('/api/quick-login-notify', { method: 'POST' }).catch(() => {});
      } catch (e) {
        btn.disabled = false;
        btn.innerHTML = '<svg class="icon icon-16"><use href="#ic-zap"></use></svg> Masuk Sekarang';
        const isNetworkError = /fetch|network/i.test(e.message || '');
        if (isNetworkError) {
          if (loginStatusEl) {
            loginStatusEl.textContent = 'Server tidak bisa dihubungi. Cek koneksi internet lalu coba lagi.';
            loginStatusEl.style.color = '#ff7eb3';
          }
          return;
        }
        localStorage.removeItem('token');
        localStorage.removeItem('_savedUser');
        overlay.remove();
        buildLoginOverlay();
        showLogin('Sesi kamu sudah berakhir, login ulang dengan Discord.');
      }
    });

    card.querySelector('#nvBtnSwitchAccount').addEventListener('click', () => {
      localStorage.removeItem('token');
      localStorage.removeItem('_savedUser');
      overlay.remove();
      buildLoginOverlay();
    });

  } else {
    card.innerHTML = `
      <div style="font-size:42px;margin-bottom:10px;"><svg class="icon icon-18"><use href="#ic-gamepad-2"></use></svg></div>
      <h2 id="nvLoginAppName" style="font-family:'Poppins',sans-serif;color:#f3eefc;margin:0 0 8px;font-size:20px;">31 Tools</h2>
      <p style="color:#b6a9d1;font-size:13px;line-height:1.6;margin:0 0 24px;">
        Login pakai Discord untuk masuk. Akun kamu akan otomatis terdeteksi
        setelah verifikasi berhasil.
      </p>
      <button id="nvBtnLoginDiscord" style="width:100%;border:none;padding:13px;border-radius:12px;
        background:linear-gradient(90deg,#5865F2,#7c5cff);color:#fff;font-weight:700;font-size:14px;
        cursor:pointer;box-shadow:0 10px 25px rgba(92,102,255,0.4);display:flex;align-items:center;
        justify-content:center;gap:8px;">
        <svg class="icon icon-18"><use href="#ic-message-circle"></use></svg> Login dengan Discord
      </button>
      <div id="nvLoginStatus" style="margin-top:16px;font-size:12.5px;color:#8f8ab0;min-height:16px;"></div>
    `;

    overlay.appendChild(card);
    document.body.appendChild(overlay);
    loginStatusEl = card.querySelector('#nvLoginStatus');
    card.querySelector('#nvBtnLoginDiscord').addEventListener('click', startLogin);
  }

  return overlay;
}

function hideLogin() {
  const overlay = document.getElementById('nvLoginOverlay');
  if (overlay) overlay.style.display = 'none';
  const appShell = document.getElementById('app');
  if (appShell) appShell.style.display = '';
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  // TODO (Phase 4/6 — menyusul saat halaman Setting dipindah):
  // loadSystemDetection(); refreshActiveToolsStatus(); refreshCloudFixStatus();
  // Automatic Watermark Detection — dipindah UTUH dari APP LAMA (lihat
  // runWatermarkScan() di bawah). Ditunda 4 detik supaya BENAR-BENAR tidak
  // ikut membebani proses startup (dashboard/daftar game/dll dimuat duluan).
  // Hasil scan cuma menghasilkan LOG & notifikasi realtime ke Admin Web —
  // TIDAK PERNAH mempengaruhi apapun di App user.
  setTimeout(() => { runWatermarkScan().catch(() => {}); }, 4000);
}

// ── AUTOMATIC WATERMARK DETECTION — scan startup — dipindah UTUH dari APP
// LAMA (app/app.js). Baca watermark yang ditemukan launcher di folder Game
// (config/depotcache Steam) & folder Bypass yang PERNAH dipasangi (dari
// localStorage installMeta kita sendiri — lihat getLocalInstallMeta() di
// bawah), lalu kirim ke server buat dicocokkan lewat /api/watermark/scan
// (watermarkManager.processScanBatch — TIDAK diubah). Server yang memutuskan
// "perangkat sama/beda" — di sini CUMA kumpul & kirim data. IPC scanWatermarks
// (main.js `scan-watermarks`) sudah tersedia sejak awal — fungsi ini yang
// akhirnya benar-benar memanggilnya.
async function runWatermarkScan() {
  if (!window.electronAPI?.scanWatermarks) return; // build lama / platform non-Electron
  try {
    const steamPath = await window.electronAPI.getSteamPath().catch(() => null);
    const meta = getLocalInstallMeta();
    const bypassFolders = Object.values(meta)
      .filter(m => m?.type === 'bypass' && m?.folderPath)
      .map(m => m.folderPath);

    const scanResult = await window.electronAPI.scanWatermarks({ steamPath, bypassFolders: [...new Set(bypassFolders)] });
    if (!scanResult?.success || !scanResult.items?.length) return;

    const deviceInfo = await window.electronAPI.getDeviceInfo().catch(() => ({}));
    await api('/api/watermark/scan', { method: 'POST', body: JSON.stringify({ deviceInfo, items: scanResult.items }) });
  } catch (e) {
    // Diamkan — scan watermark TIDAK PERNAH boleh menampilkan error ke user,
    // ini murni proses background utk keperluan admin.
  }
}

function startLogin() {
  const deviceId = getOrCreateDeviceId();
  const openExternal = window.electronAPI?.openExternal || (url => window.open(url, '_blank'));
  openExternal(`${SERVER_URL}/auth/discord?state=${encodeURIComponent(deviceId)}`);

  const discordBtn = document.getElementById('nvBtnLoginDiscord');
  if (discordBtn) { discordBtn.disabled = true; discordBtn.innerHTML = '<svg class="icon icon-16"><use href="#ic-loader-circle"></use></svg> Menunggu login di browser...'; }

  if (loginStatusEl) {
    loginStatusEl.innerHTML = 'Selesaikan login di jendela browser yang baru terbuka. <a href="#" id="nvCancelLogin" style="color:#a78bfa;text-decoration:underline;">Batal</a>';
    loginStatusEl.style.color = '#8f8ab0';
    const cancelLink = loginStatusEl.querySelector('#nvCancelLogin');
    if (cancelLink) cancelLink.addEventListener('click', (e) => { e.preventDefault(); resetLoginButton('Dibatalkan. Silakan coba lagi.'); });
  }

  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }

  const POLL_TIMEOUT_MS = 5 * 60 * 1000;
  const pollStartedAt = Date.now();

  pollTimer = setInterval(async () => {
    if (Date.now() - pollStartedAt > POLL_TIMEOUT_MS) {
      resetLoginButton('Waktu login habis. Silakan coba lagi.');
      return;
    }
    try {
      const res = await fetch(`${SERVER_URL}/auth/poll?state=${encodeURIComponent(deviceId)}`);
      const data = await res.json();
      if (data.ready) {
        clearInterval(pollTimer);
        pollTimer = null;
        localStorage.setItem('token', data.token);

        const deviceCheck = await verifyDeviceLock();
        if (!deviceCheck.ok) {
          localStorage.removeItem('token');
          localStorage.removeItem('_savedUser');
          resetLoginButton(deviceCheck.message);
          return;
        }

        hideLogin();
        enterApp(data.user);
      }
    } catch (e) {}
  }, 2000);
}

function resetLoginButton(message) {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  const discordBtn = document.getElementById('nvBtnLoginDiscord');
  if (discordBtn) { discordBtn.disabled = false; discordBtn.innerHTML = '<svg class="icon icon-16"><use href="#ic-message-circle"></use></svg> Login dengan Discord'; }
  if (loginStatusEl) {
    loginStatusEl.textContent = message || '';
    loginStatusEl.style.color = '#ff7eb3';
  }
}

async function tryAutoLogin() {
  // PENTING: jangan pernah auto-masuk ke dashboard di sini. App harus SELALU
  // mendarat di halaman login dulu setiap kali dibuka. Kalau ada sesi
  // tersimpan, buildLoginOverlay() otomatis menampilkan cabang "Selamat
  // datang kembali" dengan tombol "Masuk Sekarang" — user tinggal 1x klik.
  showLogin();
}

// ── Dipanggil sekali begitu login (baru ATAU quick-login) berhasil ──
/* ══════════════════════════════════════════════════════════════════════════
   APP CUSTOMIZATION — Background & Branding App Desktop, diatur dari Admin
   Web ("App Customization"), realtime lewat WebSocket event
   'app-customization:update' (lihat connectRealtime() di atas & broadcastUpdate()
   di appCustomizationManager.js — TIDAK ada sistem realtime baru).
   Config terakhir yang berhasil diterima di-cache di localStorage supaya App
   tetap tampil benar walau lagi offline (persyaratan #11), dan langsung
   diganti config terbaru begitu online lagi (loadAppCustomization() dipanggil
   ulang tiap kali enterApp()/reconnect WS).
   ══════════════════════════════════════════════════════════════════════════ */
const APP_CUSTOMIZATION_CACHE_KEY = 'appCustomizationCache';

function _readAppCustomizationCache() {
  try { return JSON.parse(localStorage.getItem(APP_CUSTOMIZATION_CACHE_KEY) || 'null'); }
  catch (e) { return null; }
}
function _writeAppCustomizationCache(cfg) {
  try { localStorage.setItem(APP_CUSTOMIZATION_CACHE_KEY, JSON.stringify(cfg)); } catch (e) {}
}

async function loadAppCustomization() {
  // Tampilkan dulu config terakhir yang tersimpan (kalau ada) supaya tidak
  // ada jeda balik ke default sebelum fetch selesai (terutama saat offline).
  const cached = _readAppCustomizationCache();
  console.log('[App Customization] loadAppCustomization() dipanggil. Cache lokal:', cached);
  if (cached) applyAppCustomization(cached);
  try {
    const cfg = await api('/api/app-customization');
    console.log('[App Customization] GET /api/app-customization berhasil:', cfg);
    if (cfg) applyAppCustomization(cfg);
  } catch (e) {
    // Offline/gagal fetch -> tetap pakai cache (kalau ada) atau default CSS
    // bawaan (.app punya gradient default sendiri, lihat styles.css).
    console.warn('[App Customization] GET /api/app-customization GAGAL, tetap pakai cache/default:', e);
  }
}

function applyAppCustomization(cfg) {
  if (!cfg || typeof cfg !== 'object') { console.warn('[App Customization] applyAppCustomization() dilewati, cfg kosong/invalid:', cfg); return; }
  console.log('[App Customization] Menerapkan config. Background mode:', cfg.background?.mode, '| Branding text:', cfg.branding?.text?.value);
  _writeAppCustomizationCache(cfg);
  applyAppBranding(cfg.branding);
  // PERSONAL BACKGROUND (Settings -> Background Aplikasi) — kalau user sudah
  // pilih background sendiri, itu SELALU menang atas background GLOBAL dari
  // Admin Web ini (personal/local, tidak boleh tertimpa update global —
  // lihat requirement #4 "Prioritas Background"). Global tetap disimpan ke
  // cache di atas apa adanya supaya begitu user pilih "Gunakan Background
  // Default", App langsung tahu background global terbaru tanpa fetch ulang.
  const personal = _readPersonalBackground();
  if (personal && personal.dataUrl) {
    applyAppBackground(_personalBackgroundToBgConfig(personal), null);
  } else {
    applyAppBackground(cfg.background, cfg.version);
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   BACKGROUND APLIKASI PERSONAL — Settings -> Background Aplikasi. Berbeda
   dari App Customization GLOBAL di atas (yang diatur Admin Web & berlaku
   untuk semua user): ini murni LOCAL/PERSONAL, disimpan di localStorage
   (mekanisme local preference yang SUDAH ADA, pola sama persis dengan
   APP_CUSTOMIZATION_CACHE_KEY/DASHBOARD_BANNER_CACHE_KEY di atas — tidak
   ada storage/API/database baru). Dirender lewat applyAppBackground() YANG
   SAMA dengan background global (bukan renderer kedua) — lihat
   applyAppCustomization() di atas untuk urutan prioritasnya.
   ══════════════════════════════════════════════════════════════════════════ */
const PERSONAL_BACKGROUND_KEY = 'personalBackgroundImage';
const PERSONAL_BG_MAX_BYTES = 8 * 1024 * 1024; // 8 MB
const PERSONAL_BG_ALLOWED_MIME = ['image/png', 'image/jpeg', 'image/webp'];

function _readPersonalBackground() {
  try { return JSON.parse(localStorage.getItem(PERSONAL_BACKGROUND_KEY) || 'null'); }
  catch (e) { return null; }
}
function _writePersonalBackground(entry) {
  try { localStorage.setItem(PERSONAL_BACKGROUND_KEY, JSON.stringify(entry)); } catch (e) {}
}
function _clearPersonalBackground() {
  try { localStorage.removeItem(PERSONAL_BACKGROUND_KEY); } catch (e) {}
}
// Disimpan sebagai data URI base64 (pola SAMA dengan Upload Logo/Background
// Admin Web — lihat komentar di appCustomizationManager.js), jadi dipakai
// langsung sebagai mode 'image' oleh applyAppBackground() yang SUDAH ADA,
// tanpa perlu URL.createObjectURL() sama sekali (jadi tidak ada object URL
// yang perlu di-revoke/bisa leak memory).
function _personalBackgroundToBgConfig(personal) {
  return {
    mode: 'image',
    image: { url: personal.dataUrl, source: 'upload', fit: 'cover', position: 'center', opacity: 1 },
    overlay: { enabled: false }
  };
}
function _formatFileSize(bytes) {
  if (!bytes && bytes !== 0) return '';
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

let _bgsetBusy = false;

function initBackgroundSettings() {
  const input = document.getElementById('bgsetFileInput');
  if (!input) return; // markup belum ada di halaman ini -> lewati diam2

  renderBackgroundSettingsUI();

  const openPicker = () => { if (!_bgsetBusy) input.click(); };
  const btnUpload = document.getElementById('bgsetUploadBtn');
  const btnChange = document.getElementById('bgsetChangeBtn');
  const btnRemove = document.getElementById('bgsetRemoveBtn');
  const btnDefault = document.getElementById('bgsetDefaultBtn');
  if (btnUpload) btnUpload.addEventListener('click', openPicker);
  if (btnChange) btnChange.addEventListener('click', openPicker);
  if (btnRemove) btnRemove.addEventListener('click', removePersonalBackground);
  if (btnDefault) btnDefault.addEventListener('click', removePersonalBackground);

  input.addEventListener('change', () => {
    const file = input.files && input.files[0];
    input.value = ''; // reset supaya file yang sama bisa dipilih ulang & tetap trigger 'change'
    if (file) handlePersonalBackgroundFile(file);
  });
}

function renderBackgroundSettingsUI() {
  const personal = _readPersonalBackground();
  const previewImg = document.getElementById('bgsetPreviewImg');
  const previewEmpty = document.getElementById('bgsetPreviewEmpty');
  const meta = document.getElementById('bgsetMeta');
  const metaName = document.getElementById('bgsetFileName');
  const metaSize = document.getElementById('bgsetFileSize');
  const uploadRow = document.getElementById('bgsetUploadRow');
  const manageRow = document.getElementById('bgsetManageRow');
  if (!previewImg) return;

  if (personal && personal.dataUrl) {
    previewImg.src = personal.dataUrl;
    previewImg.style.display = '';
    if (previewEmpty) previewEmpty.style.display = 'none';
    if (metaName) metaName.textContent = personal.fileName || 'background-custom';
    if (metaSize) metaSize.textContent = _formatFileSize(personal.fileSize);
    if (meta) meta.style.display = '';
    if (uploadRow) uploadRow.style.display = 'none';
    if (manageRow) manageRow.style.display = '';
  } else {
    previewImg.removeAttribute('src');
    previewImg.style.display = 'none';
    if (previewEmpty) previewEmpty.style.display = '';
    if (meta) meta.style.display = 'none';
    if (uploadRow) uploadRow.style.display = '';
    if (manageRow) manageRow.style.display = 'none';
  }
}

function _setBgsetBusy(busy) {
  _bgsetBusy = busy;
  ['bgsetUploadBtn', 'bgsetChangeBtn', 'bgsetRemoveBtn', 'bgsetDefaultBtn'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = busy;
  });
}

function handlePersonalBackgroundFile(file) {
  if (_bgsetBusy) return;
  // Validasi MIME/type (BUKAN cuma extension) — sesuai requirement.
  if (!PERSONAL_BG_ALLOWED_MIME.includes(file.type)) {
    if (typeof showToast === 'function') {
      showToast('error', 'Format Tidak Didukung', 'Gunakan gambar PNG, JPG/JPEG, atau WEBP.');
    }
    return;
  }
  // Validasi ukuran SEBELUM image diproses/disimpan.
  if (file.size > PERSONAL_BG_MAX_BYTES) {
    if (typeof showToast === 'function') {
      showToast('error', 'Ukuran Gambar Terlalu Besar', 'Ukuran gambar terlalu besar. Maksimal 8 MB.');
    }
    return;
  }
  _setBgsetBusy(true);
  const reader = new FileReader();
  reader.onerror = () => {
    // File corrupt/tidak bisa dibaca -> jangan crash, tampilkan error & jangan sentuh background lama.
    _setBgsetBusy(false);
    if (typeof showToast === 'function') {
      showToast('error', 'Gagal Membaca Gambar', 'File tidak dapat dibaca atau rusak.');
    }
  };
  reader.onload = () => {
    _setBgsetBusy(false);
    const dataUrl = typeof reader.result === 'string' ? reader.result : '';
    if (!dataUrl.startsWith('data:image/')) {
      if (typeof showToast === 'function') {
        showToast('error', 'Gagal Memproses Gambar', 'File tidak dapat dibaca atau rusak.');
      }
      return;
    }
    const entry = { dataUrl, fileName: file.name, fileSize: file.size, mimeType: file.type, savedAt: Date.now() };
    // Preview realtime sekaligus apply — applyAppBackground() yang SUDAH ADA
    // sudah preload image dulu (lihat komentarnya) jadi background lama
    // TIDAK rusak kalau ternyata gagal decode, dan transisinya smooth tanpa
    // restart/reload/logout.
    applyAppBackground(_personalBackgroundToBgConfig(entry), null);
    _writePersonalBackground(entry);
    renderBackgroundSettingsUI();
    if (typeof showToast === 'function') {
      showToast('success', 'Background Diperbarui', 'Background aplikasi personal berhasil diterapkan.');
    }
  };
  reader.readAsDataURL(file);
}

function removePersonalBackground() {
  if (_bgsetBusy) return;
  _clearPersonalBackground();
  renderBackgroundSettingsUI();
  // Balik ke background GLOBAL Admin Web terbaru yang tersimpan di cache
  // (tanpa fetch ulang) — lewat applyAppCustomization() yang sama, supaya
  // logic prioritas #4 tidak diduplikasi di sini.
  const cached = _readAppCustomizationCache();
  if (cached) applyAppCustomization(cached);
  if (typeof showToast === 'function') {
    showToast('success', 'Background Direset', 'Aplikasi kembali memakai background default.');
  }
}

// Image URL (bukan Upload/data-URI) bisa jadi Admin ganti Image A -> Image B
// tapi pakai URL yang SAMA (mis. overwrite file yang sama di CDN) — kalau
// begitu, browser/Electron (Chromium) bisa saja pakai versi lama dari HTTP
// cache walau server sudah kirim file baru. Upload (data:) TIDAK kena ini
// sama sekali karena base64-nya sendiri sudah unik per isi file. Cache-bust
// pakai cfg.version (timestamp updatedAt, SUDAH ADA di toPublicPayload()
// appCustomizationManager.js, sebelumnya tidak dipakai di mana pun) — cuma
// ditambahkan kalau version ada & url-nya http(s), tidak menyentuh data:.
function _cacheBustImageUrl(url, version) {
  if (!url || !version || url.startsWith('data:')) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}v=${encodeURIComponent(version)}`;
}

function _gradientCss(grad) {
  const stops = (grad?.stops || []).slice().sort((a, b) => a.pos - b.pos)
    .map(s => `${s.color} ${s.pos}%`).join(', ');
  if (grad?.type === 'radial') return `radial-gradient(circle at center, ${stops})`;
  return `linear-gradient(${Number(grad?.angle) || 0}deg, ${stops})`;
}

const BG_POSITION_CSS = { center: 'center center', top: 'center top', bottom: 'center bottom', left: 'left center', right: 'right center' };
const BG_FIT_CSS = { cover: 'cover', contain: 'contain', fill: '100% 100%' };

// Background berubah realtime TANPA restart/refresh: layer .app-bg-image (di
// bawah) diisi Solid/Gradient/Image, layer .app-bg-overlay (di atasnya)
// khusus mode Image. Kalau image gagal load, fallback otomatis ke config
// sebelumnya yang tersimpan di cache (atau gradient default .app kalau
// belum pernah ada config sama sekali) — App tidak pernah blank/rusak.
function applyAppBackground(bg, version) {
  const imgLayer = document.getElementById('appBgImage');
  const overlayLayer = document.getElementById('appBgOverlay');
  if (!imgLayer || !overlayLayer || !bg) {
    console.warn('[App Customization] applyAppBackground() dilewati — imgLayer:', !!imgLayer, 'overlayLayer:', !!overlayLayer, 'bg:', bg);
    return;
  }
  console.log('[App Customization] applyAppBackground() mode:', bg.mode);

  if (bg.mode === 'solid') {
    console.log('[App Customization] Menerapkan Solid Color:', bg.color);
    imgLayer.style.backgroundImage = 'none';
    imgLayer.style.backgroundColor = bg.color || '#0B1020';
    imgLayer.style.opacity = '1';
    imgLayer.style.filter = 'none';
    overlayLayer.style.backgroundColor = 'transparent';
  } else if (bg.mode === 'gradient') {
    console.log('[App Customization] Menerapkan Gradient:', bg.gradient);
    imgLayer.style.backgroundColor = 'transparent';
    imgLayer.style.backgroundImage = _gradientCss(bg.gradient);
    imgLayer.style.opacity = '1';
    imgLayer.style.filter = 'none';
    overlayLayer.style.backgroundColor = 'transparent';
  } else if (bg.mode === 'image' && bg.image?.url) {
    const rawUrl = bg.image.url;
    // Cache-bust HANYA untuk Image URL (http/https) yang bisa saja dipakai
    // ulang persis sama walau isinya diganti — lihat _cacheBustImageUrl().
    // Upload/data: URI tidak pernah kena ini.
    const url = _cacheBustImageUrl(rawUrl, version);
    console.log('[App Customization] Mode Image terdeteksi. Source:', bg.image.source || '(auto)', '| Panjang url:', rawUrl.length, '| Preview awal:', rawUrl.slice(0, 60));
    // Preload dulu supaya kalau gagal, layer TIDAK ikut berubah (tetap
    // tampilan sebelumnya) — bukan langsung diset lalu pecah/kosong.
    const preload = new Image();
    preload.onload = () => {
      console.log('[App Customization] Image BERHASIL di-load, menerapkan ke layer.');
      imgLayer.style.backgroundColor = 'transparent';
      imgLayer.style.backgroundImage = `url("${url}")`;
      imgLayer.style.backgroundSize = BG_FIT_CSS[bg.image.fit] || 'cover';
      imgLayer.style.backgroundPosition = BG_POSITION_CSS[bg.image.position] || 'center center';
      imgLayer.style.opacity = String(bg.image.opacity ?? 1);
      imgLayer.style.filter = bg.image.blur ? `blur(${bg.image.blur}px)` : 'none';
      if (bg.overlay?.enabled) {
        overlayLayer.style.backgroundColor = _hexToRgba(bg.overlay.color, bg.overlay.opacity);
      } else {
        overlayLayer.style.backgroundColor = 'transparent';
      }
    };
    preload.onerror = (err) => {
      // Gambar rusak/tidak bisa diakses -> fallback ke config sebelumnya di
      // cache (kalau berbeda dari yang sekarang), atau biarkan layer apa
      // adanya (tidak dirender jadi kosong/blank).
      console.error('[App Customization] Image GAGAL di-load (onerror) — background TIDAK berubah. url panjang:', rawUrl.length, err);
      const prevCache = _readAppCustomizationCache();
      // FIX: dibandingkan pakai rawUrl (bukan url yang sudah di-cache-bust
      // dengan ?v=...) — kalau tidak, perbandingan ini SELALU beda tiap
      // kali config di-refetch (karena query string ?v= berubah tiap
      // updatedAt), jadi fallback recursive ini bisa salah nge-trigger
      // walau image-nya sebenarnya sama persis dengan sebelumnya.
      if (prevCache?.background && prevCache.background.image?.url !== rawUrl) {
        console.log('[App Customization] Fallback ke background dari cache sebelumnya.');
        applyAppBackground(prevCache.background, prevCache.version);
      }
    };
    preload.src = url;
  } else if (bg.mode === 'image' && !bg.image?.url) {
    console.warn('[App Customization] Mode Image tapi bg.image.url KOSONG — background TIDAK berubah, layer dibiarkan seperti sebelumnya.');
  } else {
    console.warn('[App Customization] bg.mode tidak dikenali:', bg.mode);
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   AUTO DARK READING OVERLAY — menggelapkan #appReadingOverlay (lihat
   index.html/styles.css) HANYA saat halaman aktif memang panjang/penuh text.
   TIDAK bikin router/state baru: deteksi halaman aktif lewat MutationObserver
   yang mengamati class="active" pada elemen `.page` — class itu SENDIRI
   sudah jadi satu-satunya sumber kebenaran "halaman mana yang sedang aktif"
   di seluruh App (dipakai setNav(), openDetailPage(), openMarketplaceDetail(),
   openTutorialDetail(), dll — SEMUA SUDAH ADA, tidak diubah/diduplikasi di
   sini). Sengaja TIDAK pakai setTimeout sebagai logika utama — observer
   bereaksi langsung begitu class berubah, dicek ulang dari DOM (bukan dari
   isi mutation itu sendiri) supaya selalu akurat walau beberapa `.page`
   berubah class hampir bersamaan.
   ══════════════════════════════════════════════════════════════════════════ */
const READING_OVERLAY_PAGE_IDS = new Set([
  'page-tutorial-detail',    // Baca Tutorial (rich text panjang)
  'page-detail',             // Detail Game/Bypass (deskripsi panjang)
  'page-marketplace-detail'  // Detail Marketplace (deskripsi panjang)
]);

function _updateReadingOverlay() {
  const overlay = document.getElementById('appReadingOverlay');
  if (!overlay) return;
  const activePage = document.querySelector('.page.active');
  const shouldDarken = !!activePage && READING_OVERLAY_PAGE_IDS.has(activePage.id);
  overlay.classList.toggle('active', shouldDarken);
}

function initReadingOverlay() {
  const overlay = document.getElementById('appReadingOverlay');
  const pages = document.querySelectorAll('.page');
  if (!overlay || !pages.length) return;
  _updateReadingOverlay(); // state awal, kalau2 sudah ada .page.active sebelum observer terpasang
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.attributeName === 'class') { _updateReadingOverlay(); return; }
    }
  });
  pages.forEach(sec => observer.observe(sec, { attributes: true, attributeFilter: ['class'] }));
}

function _hexToRgba(hex, opacity) {
  const h = (hex || '#000000').replace('#', '');
  const r = parseInt(h.slice(0, 2), 16) || 0;
  const g = parseInt(h.slice(2, 4), 16) || 0;
  const b = parseInt(h.slice(4, 6), 16) || 0;
  return `rgba(${r}, ${g}, ${b}, ${opacity ?? 1})`;
}

// APP CUSTOMIZATION — Font Style (Brand Text). Whitelist SAMA PERSIS dengan
// FONT_WHITELIST di appCustomizationManager.js (backend sudah memvalidasi
// fontFamily masuk whitelist ini sebelum disimpan, jadi di sisi App cukup
// fallback ke 'Inter' kalau somehow dapat nilai di luar daftar — mis. App
// versi lama connect ke backend yang sudah menambah font baru). Tiap entri
// punya fallback stack ke font sistem supaya App tidak pernah gagal render
// teks branding walau font online-nya belum sempat/tidak bisa dimuat (poin
// #14 permintaan — App tidak bergantung ke internet untuk fitur ini).
const APP_FONT_STACKS = {
  'Inter': "'Inter', 'Segoe UI', sans-serif",
  'Poppins': "'Poppins', 'Segoe UI', sans-serif",
  'Roboto': "'Roboto', 'Segoe UI', sans-serif",
  'Montserrat': "'Montserrat', 'Segoe UI', sans-serif",
  'Space Grotesk': "'Space Grotesk', 'Segoe UI', sans-serif",
  'Orbitron': "'Orbitron', 'Segoe UI', sans-serif",
  'Rajdhani': "'Rajdhani', 'Segoe UI', sans-serif",
  'Bebas Neue': "'Bebas Neue', Impact, sans-serif",
  'Oswald': "'Oswald', 'Segoe UI', sans-serif",
  'Plus Jakarta Sans': "'Plus Jakarta Sans', 'Segoe UI', sans-serif"
};
function _appFontStack(id) {
  return APP_FONT_STACKS[id] || APP_FONT_STACKS['Inter'];
}

// Branding (logo + teks "31 Tools") berubah realtime — component titlebar
// yang SUDAH DITAMBAHKAN di index.html (#appBrand), bukan dibuat ulang di
// sini, cuma diisi/disembunyikan sesuai config.
function applyAppBranding(branding) {
  const logoEl = document.getElementById('appBrandLogo');
  const textEl = document.getElementById('appBrandText');
  if (!logoEl || !textEl || !branding) return;

  const logo = branding.logo || {};
  if (logo.enabled && logo.url) {
    logoEl.src = logo.url;
    logoEl.style.display = '';
    logoEl.style.width = `${logo.size || 20}px`;
    logoEl.style.height = `${logo.size || 20}px`;
    logoEl.style.opacity = String(logo.opacity ?? 1);
    logoEl.onerror = () => { logoEl.style.display = 'none'; };
  } else {
    logoEl.style.display = 'none';
  }

  const text = branding.text || {};
  if (text.enabled !== false && text.value) {
    textEl.textContent = text.value;
    textEl.style.display = '';
    textEl.style.fontFamily = _appFontStack(text.fontFamily);
    textEl.style.fontSize = `${text.fontSize || 16}px`;
    textEl.style.fontWeight = String(text.fontWeight || 600);
  } else {
    textEl.style.display = 'none';
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   DASHBOARD HERO BANNER — MULTI BANNER DINAMIS di halaman Dashboard
   (`.dash-banner`), diatur penuh dari Admin Web ("Setting Banner"), realtime
   lewat WebSocket event 'dashboard-banner:update' (lihat connectRealtime()
   di atas & dashboardBannerManager.broadcastUpdate() — TIDAK ada sistem
   realtime baru, pola SAMA PERSIS dengan App Customization di atas: WS cuma
   bawa sinyal ringan {changed, version}, App WAJIB fetch ulang lewat REST
   GET /api/dashboard-banner yang sudah ada).

   1 banner aktif  -> tampil sebagai banner biasa (tanpa dot, tanpa autoplay).
   >=2 banner aktif -> otomatis jadi carousel: ganti slide tiap 3 detik,
   animasi slide horizontal halus + fade (~750ms), loop ke banner pertama
   setelah banner terakhir, dot indicator di bawah (klik dot -> pindah +
   reset timer autoplay). Semua banner & urutannya 100% dari backend/
   database (source of truth) — TIDAK ada banner hardcode di sini, kecuali
   DASHBOARD_BANNER_FALLBACK di bawah yang MURNI anti-blank sebelum data
   backend sempat dibaca (sama fungsinya dengan markup fallback statis versi
   lama), bukan sumber data permanen.

   BUKAN sistem carousel `banners` (multi-slide/Code Banner/dot indicator)
   yang sudah ada di file ini — sistem itu TIDAK disentuh sama sekali di
   sini, cuma dipakai kalau memang ada UI-nya sendiri di tempat lain.

   Config terakhir yang berhasil diterima di-cache di localStorage (pola
   SAMA dengan APP_CUSTOMIZATION_CACHE_KEY di atas) supaya banner tetap
   tampil benar walau App lagi offline, dan langsung diganti config terbaru
   begitu online lagi.
   ══════════════════════════════════════════════════════════════════════════ */
const DASHBOARD_BANNER_CACHE_KEY = 'dashboardBannerCache';
const DASHBOARD_BANNER_AUTOPLAY_MS = 3000;   // ganti slide tiap 3 detik (poin permintaan)
const DASHBOARD_BANNER_ANIM_MS = 750;        // 600–900ms, "premium & elegan" (poin permintaan)

function _readDashboardBannerCache() {
  try { return JSON.parse(localStorage.getItem(DASHBOARD_BANNER_CACHE_KEY) || 'null'); }
  catch (e) { return null; }
}
function _writeDashboardBannerCache(cfg) {
  try { localStorage.setItem(DASHBOARD_BANNER_CACHE_KEY, JSON.stringify(cfg)); } catch (e) {}
}

const DASHBOARD_BANNER_FALLBACK = {
  banners: [{
    id: '__fallback__',
    imageUrl: 'https://cdn.akamai.steamstatic.com/steam/apps/1245620/header.jpg',
    eyebrow: 'Featured This Week',
    title: 'Elden Ring',
    description: 'Jelajahi Lands Between, kumpulkan kekuatan runa, dan hadapi para Demigod dalam dunia terbuka yang luas.',
    buttonText: 'Lihat Detail',
    buttonTargetType: 'page',
    buttonTargetPage: 'mygames',
    buttonTargetUrl: ''
  }],
  version: 0
};

// ── State carousel — semua di satu tempat supaya gampang di-reset & dicegah
// duplikat (poin permintaan: "jangan sampai ada timer menumpuk / duplicate
// listener / carousel jalan lebih dari satu"). ──
let _dashBannerData = [];           // array banner AKTIF yang lagi dirender, urutan = urutan tampil (dari backend)
let _dashBannerVersion = 0;         // dipakai buat cache-bust Image URL (link), sama pola dengan versi lama
let _dashBannerIndex = 0;           // index slide yang sedang aktif
let _dashBannerAutoplayTimer = null;
let _dashHomePageActive = true;     // Dashboard adalah halaman awal APP -> default true, di-update lewat setNav()
let _dashBannerDotsBound = false;   // event delegation dot cuma dibind SEKALI (node wrapper-nya persist antar render)
let _dashBannerTrackBound = false;  // event delegation tombol banner cuma dibind SEKALI

function _dashEscapeHtml(str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}
function _dashBannerImgSrc(b) {
  if (!b.imageUrl) return '';
  if (_dashBannerVersion && !b.imageUrl.startsWith('data:')) {
    return `${b.imageUrl}${b.imageUrl.includes('?') ? '&' : '?'}v=${encodeURIComponent(_dashBannerVersion)}`;
  }
  return b.imageUrl;
}

async function loadDashboardBanner() {
  // Tampilkan dulu cache terakhir (kalau ada) supaya tidak ada jeda balik
  // ke fallback statis sebelum fetch selesai (terutama saat offline) —
  // sama alasan dengan loadAppCustomization() di atas. Kalau belum pernah
  // ada cache sama sekali (App baru pertama kali dibuka), pakai
  // DASHBOARD_BANNER_FALLBACK dulu supaya tidak pernah blank.
  const cached = _readDashboardBannerCache();
  applyDashboardBanner(cached || DASHBOARD_BANNER_FALLBACK);
  try {
    const cfg = await api('/api/dashboard-banner');
    if (cfg) applyDashboardBanner(cfg);
  } catch (e) {
    // Offline/gagal fetch -> tetap pakai cache/fallback yang sudah dirender
    // di atas (field kosong/belum pernah diatur admin TIDAK BOLEH bikin
    // blank/crash).
    console.warn('[Dashboard Banner] GET /api/dashboard-banner GAGAL, tetap pakai cache/fallback:', e);
  }
}

// ── Terima config baru (dari cache, REST, atau resync WS) -> render ulang
// carousel. Menjaga slide yang SEDANG TAMPIL berdasarkan ID banner (bukan
// posisi array) supaya kalau Admin cuma ubah banner LAIN, slide yang lagi
// dilihat user tidak loncat/reset tanpa alasan. Kalau banner yang sedang
// tampil itu sendiri dihapus/dinonaktifkan Admin, otomatis clamp ke banner
// valid terdekat — TIDAK PERNAH menampilkan slide kosong (poin permintaan).
function applyDashboardBanner(cfg) {
  if (!cfg || typeof cfg !== 'object' || !Array.isArray(cfg.banners)) return;
  _writeDashboardBannerCache(cfg);

  const prevActiveId = _dashBannerData[_dashBannerIndex] ? _dashBannerData[_dashBannerIndex].id : null;
  _dashBannerVersion = cfg.version || 0;
  // Kosong total di database -> tetap pakai fallback statis (bukan slide
  // kosong) — konsisten dengan poin "field kosong tidak boleh bikin blank".
  _dashBannerData = cfg.banners.length ? cfg.banners.slice() : DASHBOARD_BANNER_FALLBACK.banners.slice();

  let nextIndex = _dashBannerData.findIndex(b => b.id === prevActiveId);
  if (nextIndex === -1) nextIndex = 0;
  nextIndex = Math.min(Math.max(nextIndex, 0), _dashBannerData.length - 1);

  _dashCarouselRender(nextIndex);
}

// ── Rebuild SEMUA slide + dot indicator dari _dashBannerData (bukan diff),
// lalu tampilkan `activeIndex` TANPA animasi transisi (dipakai saat data
// baru masuk — animasi geser cuma untuk perpindahan slide lewat autoplay/
// klik dot, lihat _dashCarouselGoTo()). Rebuild penuh supaya render SELALU
// konsisten dengan urutan array terbaru dari backend (source of truth). ──
function _dashCarouselRender(activeIndex) {
  const track = document.getElementById('dashBannerTrack');
  const dotsWrap = document.getElementById('dashBannerDots');
  if (!track) return;

  track.innerHTML = _dashBannerData.map((b, i) => `
    <div class="dash-banner-slide${i === activeIndex ? ' dash-banner-slide--active' : ''}" data-index="${i}">
      ${b.imageUrl ? `<img class="dash-banner-slide-img" src="${_dashBannerImgSrc(b)}" alt="">` : ''}
      <div class="dash-banner-overlay">
        <span class="dash-banner-eyebrow">${_dashEscapeHtml(b.eyebrow)}</span>
        <h2 class="dash-banner-title">${_dashEscapeHtml(b.title)}</h2>
        <p class="dash-banner-desc">${_dashEscapeHtml(b.description)}</p>
        <button class="dash-banner-btn" type="button" data-banner-action="click">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>
          <span class="dash-banner-btn-text">${_dashEscapeHtml(b.buttonText || 'Lihat Detail')}</span>
        </button>
      </div>
    </div>
  `).join('');

  _dashBannerIndex = activeIndex;
  _dashCarouselBindTrackEvents(track);
  _dashCarouselRenderDots(dotsWrap);
  _dashCarouselRestartAutoplay();
}

// ── Dot indicator — HANYA ditampilkan kalau banner aktif > 1 (poin
// permintaan: 1 banner = banner biasa, tanpa dot). Listener klik dibind
// SEKALI di wrapper-nya (event delegation, node #dashBannerDots sendiri
// TIDAK pernah diganti — cuma innerHTML-nya — jadi tidak pernah dobel
// listener walau dirender ulang berkali-kali). ──
function _dashCarouselRenderDots(dotsWrap) {
  if (!dotsWrap) return;
  if (_dashBannerData.length > 1) {
    dotsWrap.style.display = '';
    dotsWrap.innerHTML = _dashBannerData.map((b, i) => (
      `<button type="button" class="dash-banner-dot${i === _dashBannerIndex ? ' active' : ''}" data-dot-index="${i}" aria-label="Banner ${i + 1}"></button>`
    )).join('');
  } else {
    dotsWrap.style.display = 'none';
    dotsWrap.innerHTML = '';
  }
  if (!_dashBannerDotsBound) {
    dotsWrap.addEventListener('click', (e) => {
      const dot = e.target.closest('.dash-banner-dot[data-dot-index]');
      if (!dot) return;
      const idx = Number(dot.dataset.dotIndex);
      // Klik dot -> langsung pindah ke banner tersebut, timer autoplay
      // di-reset (lihat akhir _dashCarouselGoTo()), tunggu 3 detik lagi
      // sebelum autoplay berikutnya jalan (poin permintaan INDICATOR).
      if (!Number.isNaN(idx)) _dashCarouselGoTo(idx);
    });
    _dashBannerDotsBound = true;
  }
}
function _dashCarouselUpdateDotsActive() {
  const dotsWrap = document.getElementById('dashBannerDots');
  if (!dotsWrap) return;
  dotsWrap.querySelectorAll('.dash-banner-dot').forEach((d, i) => d.classList.toggle('active', i === _dashBannerIndex));
}

// Tombol "Lihat Detail" tiap slide — event delegation di track (dibind
// SEKALI, node track TIDAK pernah diganti walau innerHTML-nya di-rebuild).
function _dashCarouselBindTrackEvents(track) {
  if (_dashBannerTrackBound) return;
  track.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-banner-action="click"]');
    if (!btn) return;
    const slideEl = btn.closest('.dash-banner-slide');
    if (!slideEl) return;
    const idx = Number(slideEl.dataset.index);
    handleDashboardBannerClick(idx);
  });
  _dashBannerTrackBound = true;
}

// Tujuan tombol (halaman internal APP via setNav(), ATAU link eksternal)
// SEPENUHNYA ditentukan config banner itu dari Admin Web — TIDAK ada tujuan
// hardcode di sini, sama filosofi dengan versi single-banner sebelumnya.
function handleDashboardBannerClick(index) {
  const b = _dashBannerData[index];
  if (!b) return;
  if (b.buttonTargetType === 'url' && b.buttonTargetUrl) {
    window.open(b.buttonTargetUrl, '_blank', 'noopener,noreferrer');
  } else if (typeof setNav === 'function') {
    setNav(b.buttonTargetPage || 'mygames');
  }
}

// ── Pindah slide dengan animasi "slide horizontal halus + fade" premium
// (poin permintaan ANIMASI — bukan bounce/zoom/rotate/flashy). Slide baru
// diposisikan di luar frame TANPA transition dulu (loncat instan, tidak
// ikut teranimasi), lalu di frame berikutnya transition dinyalakan & kedua
// slide digeser ke posisi akhir — teknik FLIP sederhana biar mulus di
// segala kecepatan device. ──
function _dashCarouselGoTo(newIndex, opts) {
  opts = opts || {};
  const track = document.getElementById('dashBannerTrack');
  const total = _dashBannerData.length;
  if (!track || total < 2) return;
  newIndex = ((newIndex % total) + total) % total;
  if (newIndex === _dashBannerIndex && !opts.force) { _dashCarouselRestartAutoplay(); return; }

  const slides = track.querySelectorAll('.dash-banner-slide');
  const oldEl = slides[_dashBannerIndex];
  const newEl = slides[newIndex];
  if (!oldEl || !newEl || oldEl === newEl) { _dashBannerIndex = newIndex; return; }

  const forward = (newIndex === (_dashBannerIndex + 1) % total);
  const direction = opts.direction || (forward ? 1 : -1);

  newEl.style.transition = 'none';
  newEl.style.opacity = '0';
  newEl.style.transform = `translateX(${direction * 32}px)`;
  newEl.style.zIndex = '2';
  newEl.classList.add('dash-banner-slide--active');
  oldEl.style.zIndex = '1';
  void newEl.offsetWidth; // force reflow — supaya transition:none di atas benar-benar "settle" dulu

  requestAnimationFrame(() => {
    newEl.style.transition = `transform ${DASHBOARD_BANNER_ANIM_MS}ms cubic-bezier(.4,0,.2,1), opacity ${DASHBOARD_BANNER_ANIM_MS}ms ease`;
    oldEl.style.transition = `transform ${DASHBOARD_BANNER_ANIM_MS}ms cubic-bezier(.4,0,.2,1), opacity ${DASHBOARD_BANNER_ANIM_MS}ms ease`;
    newEl.style.opacity = '1';
    newEl.style.transform = 'translateX(0)';
    oldEl.style.opacity = '0';
    oldEl.style.transform = `translateX(${-direction * 32}px)`;
  });

  _dashBannerIndex = newIndex;
  _dashCarouselUpdateDotsActive();

  // Bersihkan slide lama setelah animasi selesai supaya statenya "netral"
  // lagi (siap dipakai dari arah manapun kalau dia jadi target berikutnya).
  window.setTimeout(() => {
    if (!oldEl.isConnected) return;
    oldEl.classList.remove('dash-banner-slide--active');
    oldEl.style.transition = 'none';
    oldEl.style.transform = 'translateX(0)';
    oldEl.style.zIndex = '';
    void oldEl.offsetWidth;
    oldEl.style.transition = '';
  }, DASHBOARD_BANNER_ANIM_MS + 50);

  // Reset timer autoplay setiap kali slide berpindah (baik dari autoplay
  // itu sendiri maupun klik dot manual) — poin INDICATOR: "reset timer,
  // tunggu 3 detik sebelum autoplay berikutnya".
  _dashCarouselRestartAutoplay();
}

// ── Autoplay — SELALU clearInterval dulu sebelum (mungkin) bikin yang baru,
// jadi manapun pemicunya (render ulang data baru/reconnect WS/klik dot/
// pindah halaman) TIDAK PERNAH ada 2 interval jalan bersamaan (poin
// permintaan: "jangan pakai timer yang menumpuk/duplicate"). Autoplay hanya
// aktif kalau: banner aktif > 1, halaman Dashboard sedang dibuka, DAN tab
// App sedang terlihat (document.hidden === false) — supaya tidak jalan
// sia-sia di background. ──
function _dashCarouselRestartAutoplay() {
  if (_dashBannerAutoplayTimer) {
    clearInterval(_dashBannerAutoplayTimer);
    _dashBannerAutoplayTimer = null;
  }
  if (_dashBannerData.length > 1 && _dashHomePageActive && !document.hidden) {
    _dashBannerAutoplayTimer = setInterval(() => {
      _dashCarouselGoTo(_dashBannerIndex + 1, { direction: 1 });
    }, DASHBOARD_BANNER_AUTOPLAY_MS);
  }
}

// Dipanggil dari setNav() (lihat blok nav di bawah file ini) — autoplay
// cuma jalan "selama halaman Dashboard aktif" (poin permintaan AUTO SLIDE),
// berhenti begitu user pindah ke halaman lain, jalan lagi begitu balik.
function _dashCarouselSetHomeActive(active) {
  _dashHomePageActive = active;
  _dashCarouselRestartAutoplay();
}

// Tab/App di-minimize atau window kehilangan visibility -> pause autoplay
// (hemat kerja & mencegah timer "ngebut mengejar" saat balik terlihat);
// balik terlihat -> _dashCarouselRestartAutoplay() otomatis nyalakan lagi
// KALAU memang masih di halaman Dashboard. Listener ini didaftar SEKALI di
// scope module (bukan di dalam fungsi yang dipanggil berulang), jadi tidak
// pernah dobel.
document.addEventListener('visibilitychange', () => {
  _dashCarouselRestartAutoplay();
});

function enterApp(user) {
  currentUser = user;
  _saveUser(user);

  // Isi data profil REAL di titlebar/profile menu APP DEMO (gantikan dummy
  // "John Smith" bawaan demo — lihat #profileBtn & #profileMenu di
  // index.html). renderProfileIdentity() mengisi titlebar DAN mini account
  // card di dalam dropdown sekaligus, dari satu sumber data (user) yang sama.
  renderProfileIdentity(user);

  const appShell = document.getElementById('app');
  if (appShell) appShell.style.display = '';

  // Package/Role user ASLI dari backend (Phase 4 — SELESAI): badge di titlebar
  // & fungsi hasAccess()/mktOrRoleLocked() di atas sudah pakai currentUser.role
  // yang sebenarnya, BUKAN hardcode. Dipanggil ulang di handleAccountUpdate()
  // nanti (Phase 9) supaya berubah realtime kalau admin ubah role user ini.
  applyUserPackageBadge(user);

  // APP CUSTOMIZATION (Background & Branding) — ambil config terbaru begitu
  // masuk App (GET /api/app-customization, tidak perlu tunggu WS konek dulu),
  // realtime selanjutnya lewat event WS 'app-customization:update' di atas.
  loadAppCustomization();

  // DASHBOARD HERO BANNER — sama pola dengan App Customization di atas:
  // ambil config terbaru begitu masuk App (poin #10 permintaan — App baru
  // dibuka HARUS langsung lihat data dari REST, tidak nunggu WS pertama),
  // realtime selanjutnya lewat event WS 'dashboard-banner:update' di bawah.
  loadDashboardBanner();

  // MAINTENANCE MODE — cek ulang begitu login berhasil, dengan token akun
  // yang baru login (checkMaintenanceStatus() paling awal di titik masuk App
  // di atas bisa saja jalan tanpa token kalau ini pertama kali buka App)
  // supaya status `bypass` (whitelist Discord ID / role admin) dievaluasi
  // dengan identitas user yang benar (lihat blok "MAINTENANCE MODE" di
  // bawah). Realtime selanjutnya lewat event WS 'maintenance:config' & resync
  // tiap reconnect (lihat connectRealtime()).
  if (typeof checkMaintenanceStatus === 'function') checkMaintenanceStatus();

  // Widget Limit Download Harian (kiri-bawah) — render pertama dari data
  // accountStatus.download yang sudah ikut di response /api/me (lihat
  // publicUser() di server.js APP LAMA, TIDAK diubah). Realtime-nya lewat
  // handleAccountUpdate() di bawah.
  renderDownloadLimitWidget(user);

  // Games (Phase 5 — SELESAI, lihat blok "PHASE 5 — GAMES" di atas): ganti
  // kartu dummy #page-mygames dengan data asli dari server + Steam Store API.
  loadGames();

  // Bypass (Phase 6 — SELESAI, lihat blok "PHASE 6 — BYPASS" di bawah):
  // ganti kartu dummy #page-explore dengan data asli.
  loadBypasses();

  // WELCOME POPUP dulu, GOLD TRIAL sesudahnya (requirement urutan untuk user
  // baru) — checkWelcomePopup() cek status begitu user login/masuk App, dan
  // baru memanggil loadGoldTrialOffer() (Flow A — normal, cek eligible/tidak
  // lewat backend, modal tawaran otomatis muncul lewat applyGoldTrialAutoOffer()
  // kalau eligible — lihat blok "GOLD TRIAL" di bawah) SETELAH Welcome Popup
  // ditutup, atau langsung kalau memang tidak ada Welcome Popup yang perlu
  // tampil untuk akun ini. Fallback ke loadGoldTrialOffer() langsung kalau
  // checkWelcomePopup entah kenapa belum ke-load (harusnya tidak pernah terjadi).
  const _afterWelcomePopup = () => { if (typeof loadGoldTrialOffer === 'function') loadGoldTrialOffer(); };
  if (typeof checkWelcomePopup === 'function') checkWelcomePopup(_afterWelcomePopup);
  else _afterWelcomePopup();

  // REALTIME (lihat blok "REALTIME" di atas) — begitu konek, games:update /
  // bypasses:update / account:update / leaderboard:update dari server
  // langsung diterapkan ke UI TANPA perlu refresh/buka ulang app.
  connectRealtime();

  // Top Installer Mingguan (Dashboard) — ambil ranking terbaru dari server
  // begitu app dibuka (GET /api/leaderboard, dihitung dari histori install
  // asli). Setelah ini update-nya realtime lewat event WS 'leaderboard:update'
  // di atas — TIDAK ada polling/setInterval.
  loadLeaderboard();

  // Active Tools (Settings) — ambil config publik (GET /api/active-tools),
  // render kartu di halaman Settings, & pasang gate di handleInstall() (lihat
  // blok "ACTIVE TOOLS" di atas). Realtime lewat WS 'active-tools:config'.
  loadActiveToolsConfig();
  wireActiveTools();

  // Tutorial — ambil daftar tutorial published terbaru begitu App dibuka
  // (GET /api/tutorials, sistem existing dari project lama/Demo — TIDAK ada
  // API baru). Realtime selanjutnya lewat event WS 'tutorials:update' di
  // atas & resync tiap reconnect (lihat connectRealtime()).
  loadTutorials();

  // Nyalakan shell UI APP DEMO (Dashboard/Games/Bypass/Histori) — lihat
  // definisi initAppShellDemo() di bagian bawah file. Dijaga guard supaya
  // tidak dobel-init kalau enterApp() sempat terpanggil lebih dari sekali
  // dalam satu sesi (misal quick-login setelah sempat logout tanpa reload).
  if (!window._appShellInited) {
    window._appShellInited = true;
    if (typeof initAppShellDemo === 'function') initAppShellDemo();
  }

  // Auto Remove Installed Premium Content (Premium Cleanup) — dipanggil sekali
  // di sini persis seperti APP LAMA: "kalau app tidak dibuka [saat job
  // dijadwalkan], pengecekan dilakukan saat app dibuka kembali" (best-effort,
  // gagal diam-diam supaya tidak mengganggu proses buka app — lihat
  // checkPendingPremiumCleanups() di bawah file ini). Realtime-nya sendiri
  // (event WS 'premium:cleanup', kalau app LAGI kebuka saat job dikirim)
  // sudah ditangani terpisah di connectRealtime() di atas.
  if (typeof checkPendingPremiumCleanups === 'function') checkPendingPremiumCleanups();
  startAutoRefresh(); // jaring pengaman role/package kalau WebSocket putus/diam-diam gagal — lihat blok "POLLING FALLBACK" di bawah

  // TODO (migrasi fitur per halaman berikutnya, BELUM dikerjakan, logic-nya
  // masih di app/app.js APP LAMA, akan disambungkan satu-satu secara
  // bertahap): loadNotifications(); checkWelcomePopup();
  //   loadCategories(); loadBanners();
  //   loadSteamAccounts(); loadMarketplaceProducts();
  //   flushPendingHistory().
  //   checkPendingPremiumCleanups() & startAutoRefresh() SUDAH disambungkan
  //   di atas (lihat blok "Auto Remove Installed Premium Content" & "POLLING
  //   FALLBACK ROLE-CHECK" persis di atas TODO ini).
  // Package/Role (Phase 4), Games (Phase 5), Bypass (Phase 6), Histori,
  // Realtime WebSocket, Top Installer Mingguan, Active Tools, dan Tutorial
  // sudah TIDAK ada di daftar ini lagi — sudah aktif di atas. Dashboard
  // (Banner) MASIH dummy shell APP DEMO — jadi REAL setelah disambungkan
  // (New Games di Dashboard sudah ikut REAL otomatis karena sumbernya sama
  // dengan Games, lihat populateDashboardNewGames()).
}

// Sign out — real logout (catat activity log di server, hapus sesi lokal),
// dipindah dari wireNavigation() di APP LAMA. Menggantikan placeholder
// `alert('Signed out (demo only).')` bawaan APP DEMO.
function signOut() {
  disconnectRealtime();
  stopAutoRefresh();
  api('/api/logout', { method: 'POST' }).catch(() => {});
  localStorage.removeItem('token');
  localStorage.removeItem('_savedUser');
  location.reload();
}

// DEVICE RESET REALTIME — dipanggil kalau Admin menekan "Reset Device" (Admin
// Web) SAAT App ini sedang aktif — paksa logout sekarang juga tanpa perlu
// restart App, user tinggal login ulang dan perangkat ini otomatis
// didaftarkan lagi sebagai perangkat baru. Migrasi UTUH dari APP LAMA (fungsi
// & behavior-nya SAMA PERSIS, TIDAK ada auth/session system baru): berbeda
// dari signOut() (logout manual oleh user sendiri, yang masih memanggil
// POST /api/logout), di sini TIDAK memanggil endpoint logout — sesi di
// backend sudah diinvalidasi oleh admin lewat endpoint reset device itu
// sendiri, jadi database/backend tetap satu-satunya source of truth. Dipicu
// dari cabang 'device:reset' di _ws.onmessage di atas.
function handleDeviceReset() {
  disconnectRealtime();
  stopAutoRefresh();
  localStorage.removeItem('token');
  localStorage.removeItem('_savedUser');
  currentUser = null;
  location.reload();
}
/* ══════════════════════════════════════════════════════════════════════════
   AKHIR BLOK AUTH / LOGIN
   ══════════════════════════════════════════════════════════════════════════ */

/* ══════════════════════════════════════════════════════════════════════════
   PACKAGE / ROLE (Public, Gold, Platinum) — dipindah dari app/app.js APP LAMA.
   INI SUMBER KEBENARAN AKSES untuk SELURUH APP DEMO (Games, Bypass, Install).
   Role SELALU dibaca dari currentUser.role (hasil login/realtime dari
   server), TIDAK PERNAH di-hardcode di frontend — sesuai requirement wajib
   di instruksi migrasi ("Jangan hardcode package dari frontend").
   ══════════════════════════════════════════════════════════════════════════ */
const CLIENT_ROLE_LEVEL = { public: 0, gold: 1, platinum: 2, admin: 3 };
const ROLE_DISPLAY_NAME = { public: 'Gratis', gold: 'Gold', platinum: 'Platinum', admin: 'Admin' };

// Akses berbasis HIERARKI ROLE (Public < Gold < Platinum) — dipakai utk item
// biasa. Item yang di-gate Marketplace (marketplaceProductIds.length > 0)
// TIDAK memakai fungsi ini sama sekali — akses satu-satunya sumber
// kebenarannya adalah `item.hasAccess` dari server (lihat isMktGated/
// mktOrRoleLocked di bawah, dipasang saat Phase 5/6 - Games/Bypass).
function hasAccess(item) {
  if (currentUser?.role === 'admin') return true;
  const myLevel = CLIENT_ROLE_LEVEL[currentUser?.role] ?? 0;
  const itemLevel = CLIENT_ROLE_LEVEL[item?.role] ?? 0;
  return myLevel >= itemLevel;
}
function isMktGated(item) {
  return Array.isArray(item?.marketplaceProductIds) && item.marketplaceProductIds.length > 0;
}
function mktOrRoleLocked(item) {
  return isMktGated(item) ? !item.hasAccess : !hasAccess(item);
}

// Isi badge paket ASLI di titlebar (#profilePkgBadge, lihat index.html) +
// dipanggil ulang REALTIME tiap kali role user berubah (upgrade/downgrade
// dari Admin Web) — akan disambungkan ke connectRealtime()/handleAccountUpdate
// di Phase 9. Reuse renderPackageBadges()/PACKAGE_BADGES yang sudah ada di
// bawah file ini (dideklarasikan lebih lanjut, tapi function declaration
// otomatis hoisted jadi aman dipanggil dari sini).
// Sekarang juga mengisi badge yang sama di dalam mini account card
// (#pmPkgBadge) di dropdown, dan memanggil renderProfileExpiry() supaya
// info masa aktif paket ikut sinkron setiap kali badge diperbarui.
function applyUserPackageBadge(user) {
  const el = document.getElementById('profilePkgBadge');
  const pmEl = document.getElementById('pmPkgBadge');
  const tier = packageTierOf(user);
  // tier 'admin' TIDAK PERNAH ditulis ke data-tier pkg-badge (PACKAGE_BADGES
  // cuma kenal public/gold/platinum) — node-nya toh disembunyikan oleh
  // applyAdminBadge() di bawah, jadi biarkan dataset.tier apa adanya
  // (nilai tier user biasa terakhir) supaya kalau nanti role balik dari
  // Admin ke user biasa, tidak ada flicker "public" sesaat sebelum data
  // asli masuk.
  if (tier !== 'admin') {
    [el, pmEl].forEach(node => {
      if (!node) return;
      node.dataset.tier = tier;
      delete node.dataset.rendered; // paksa render ulang walau tier sama kaya sebelumnya
    });
    if (typeof renderPackageBadges === 'function') renderPackageBadges();
  }
  // ADMIN badge — SATU sumber kebenaran: user.role dari backend/session
  // existing (sama persis yang dipakai hasAccess()/CLIENT_ROLE_LEVEL di
  // atas), BUKAN username/Discord ID/hardcode. Ditempatkan di sini supaya
  // ikut ke-refresh di titik yang sama dengan badge paket (enterApp() +
  // handleAccountUpdate() realtime, lihat pemanggil applyUserPackageBadge()).
  if (typeof applyAdminBadge === 'function') applyAdminBadge(user);
  renderProfileExpiry(user);
}

// Tampil/sembunyikan badge ADMIN (#profileAdminBadge, #pmAdminBadge) — murni
// REPRESENTASI VISUAL dari user.role === 'admin' yang sudah datang dari
// backend (login/session/realtime), TIDAK pernah menentukan permission apa
// pun sendiri (akses tetap lewat hasAccess()/backend seperti sebelumnya).
// Saat admin -> pkg-badge (Gratis/Gold/Platinum) disembunyikan di slot yang
// sama, karena sistem existing cuma punya SATU field user.role (public|gold|
// platinum|admin), bukan role+package terpisah — lihat catatan di
// applyUserPackageBadge()/packageTierOf() serta styles.css.
function applyAdminBadge(user) {
  const isAdmin = user?.role === 'admin';
  const nodes = [document.getElementById('profileAdminBadge'), document.getElementById('pmAdminBadge')];
  const pkgNodes = [document.getElementById('profilePkgBadge'), document.getElementById('pmPkgBadge')];
  nodes.forEach(node => {
    if (!node) return;
    node.hidden = !isAdmin;
    if (isAdmin && typeof renderAdminBadge === 'function') renderAdminBadge(node);
  });
  pkgNodes.forEach(node => { if (node) node.hidden = isAdmin; });
}

// Isi avatar + nama di titlebar (#profileBtn) DAN di mini account card
// dropdown (#profileMenu header) sekaligus, dari data user yang sama —
// dipanggil dari enterApp() saat login, dan handleAccountUpdate() kalau
// nama/avatar profil App berubah realtime.
function renderProfileIdentity(user) {
  const avatarMarkup = user.avatarUrl
    ? `<img src="${escapeHtml(user.avatarUrl)}" alt="${escapeHtml(user.username)}" onerror="this.parentElement.innerHTML='<svg viewBox=&quot;0 0 24 24&quot; fill=&quot;none&quot; stroke=&quot;currentColor&quot; stroke-width=&quot;1.5&quot;><circle cx=&quot;12&quot; cy=&quot;8&quot; r=&quot;4&quot;/><path d=&quot;M4 20c0-4 4-6 8-6s8 2 8 6&quot;/></svg>'">`
    : null;

  const nameEl = document.querySelector('#profileBtn .profile-name');
  if (nameEl) { nameEl.textContent = user.username; nameEl.title = user.username; }
  const avatarSlot = document.querySelector('#profileBtn .avatar');
  if (avatarSlot && avatarMarkup) avatarSlot.innerHTML = avatarMarkup;

  const pmName = document.getElementById('pmName');
  if (pmName) { pmName.textContent = user.username; pmName.title = user.username; }
  const pmAvatar = document.getElementById('pmAvatar');
  if (pmAvatar && avatarMarkup) pmAvatar.innerHTML = avatarMarkup;
}

// Info masa aktif paket — titlebar #profileExpiry (Profile Grid, versi
// RINGKAS "Aktif X Hari") + dropdown #pmExpiry (TIDAK disentuh, tetap
// tanggal lengkap seperti sebelumnya) — dua-duanya SELALU dihitung dari
// accountStatus.activeUntil ASLI yang dikirim server (lihat
// accountStatusSummary() di server.js), tidak pernah data dummy/tanggal
// hardcode. Public/admin (tanpa masa aktif) -> baris disembunyikan.
function renderProfileExpiry(user) {
  const topEl = document.getElementById('profileExpiry');
  const topText = document.getElementById('profileExpiryText');
  const pmEl = document.getElementById('pmExpiry');
  const pmText = document.getElementById('pmExpiryText');

  // Dropdown (#pmExpiry) — SUDAH BENAR, TIDAK DIUBAH sama sekali: tetap
  // pakai computePackageExpiryInfo() apa adanya (tanggal lengkap "Aktif
  // sampai DD Mon YYYY", "Tanpa batas", "Paket telah berakhir", dst).
  applyExpiryNode(pmEl, pmText, computePackageExpiryInfo(user));

  // Profile Grid titlebar (#profileExpiry) — versi RINGKAS "Aktif X Hari"
  // dari nilai hari/durasi REAL yang sama (accountStatus.activeUntil),
  // supaya Profile Grid tidak melebar karena tanggal lengkap. Tanggal
  // lengkap tetap hanya tampil di dropdown (baris di atas), sesuai
  // permintaan — bukan logic paket baru, cuma teks tampilan yang beda.
  applyExpiryNode(topEl, topText, computeProfileGridDuration(user));
}

// Terapkan { text, state } (atau null = hidden) ke satu node expiry
// (dipakai bareng oleh titlebar #profileExpiry & dropdown #pmExpiry).
function applyExpiryNode(wrap, text, info) {
  if (!wrap || !text) return;
  if (!info) { wrap.hidden = true; wrap.dataset.state = ''; text.textContent = ''; wrap.title = ''; return; }
  wrap.hidden = false;
  wrap.dataset.state = info.state;
  text.textContent = info.text;
  // title = tooltip kalau kepotong ellipsis — disamakan dengan teks yang
  // tampil (bukan tanggal lengkap), supaya tanggal lengkap tetap cuma
  // muncul lewat dropdown, tidak "bocor" lewat hover di titlebar.
  wrap.title = info.text;
}

// Hitung teks + state ('normal' | 'warning' | 'expired' | 'unlimited') dari
// currentUser.accountStatus (Public/admin tidak punya masa aktif -> null).
// DIPAKAI KHUSUS UNTUK DROPDOWN (#pmExpiry) — TIDAK DIUBAH.
function computePackageExpiryInfo(user) {
  const status = user?.accountStatus;
  if (!status || !status.hasActivePeriod) return null; // Public/admin — no masa aktif line
  if (!status.hasExpiry) return { text: 'Tanpa batas', state: 'unlimited' };
  if (status.isExpired) return { text: 'Paket telah berakhir', state: 'expired' };

  const until = new Date(status.activeUntil);
  if (isNaN(until.getTime())) return null;
  const daysLeft = Math.max(1, Math.ceil((until.getTime() - Date.now()) / 86400000));

  if (daysLeft <= 7) {
    return { text: `${daysLeft} hari tersisa`, state: daysLeft <= 3 ? 'warning' : 'normal' };
  }
  const formatted = until.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' });
  return { text: `Aktif sampai ${formatted}`, state: 'normal' };
}

// Versi RINGKAS khusus Profile Grid titlebar (#profileExpiry) — "Aktif X
// Hari" dari SISA HARI REAL yang dihitung dari accountStatus.activeUntil
// yang sama persis dengan computePackageExpiryInfo() di atas (SATU sumber
// data, cuma format teksnya beda), supaya Profile Grid tetap compact dan
// tidak pernah menampilkan tanggal lengkap (tanggal lengkap sudah ada di
// dropdown lewat computePackageExpiryInfo()). Bukan logic/state paket
// baru: hasActivePeriod/hasExpiry/isExpired tetap murni dari
// accountStatusSummary() backend existing, tidak diutak-atik di sini.
function computeProfileGridDuration(user) {
  const status = user?.accountStatus;
  if (!status || !status.hasActivePeriod) return null; // Public/admin — no masa aktif line
  if (!status.hasExpiry) return { text: 'Tidak Terbatas', state: 'unlimited' };
  if (status.isExpired) return { text: 'Paket Berakhir', state: 'expired' };

  const until = new Date(status.activeUntil);
  if (isNaN(until.getTime())) return null;
  const daysLeft = Math.max(1, Math.ceil((until.getTime() - Date.now()) / 86400000));
  return { text: `Aktif ${daysLeft} Hari`, state: daysLeft <= 7 ? (daysLeft <= 3 ? 'warning' : 'normal') : 'normal' };
}

// Tier badge (public/gold/platinum/admin) dari role user ASLI — SATU sumber
// kebenaran dipakai bareng oleh applyUserPackageBadge() (badge titlebar),
// renderDownloadLimitWidget() (badge widget limit download), DAN
// handleAccountUpdate() (notif paket naik/turun/jadi Admin), supaya
// semuanya selalu konsisten.
// PENTING (fix laporan "APP masih muncul Platinum padahal sudah ADMIN"):
// dulu fungsi ini me-return 'platinum' untuk admin supaya "muat" ke
// .pkg-badge (yang cuma kenal public/gold/platinum) — itu akar masalahnya.
// Sekarang 'admin' dikembalikan APA ADANYA (BUKAN salah satu dari
// Gratis/Gold/Platinum). Konsekuensinya: TIAP pemanggil yang membedakan
// tier lewat PKG_TIER_LEVEL/pkg-badge WAJIB cek `tier === 'admin'` dan
// menampilkan tampilan Admin terpisah — TIDAK boleh lagi memasukkan hasil
// fungsi ini langsung ke `<span class="pkg-badge" data-tier="...">`
// tanpa guard, karena data-tier="admin" tidak dikenali PACKAGE_BADGES.
function packageTierOf(user){
  return user?.role === 'admin' ? 'admin' : (user?.role || 'public');
}

/* ── Widget Limit Download Harian (#dlLimitWidget, kiri-bawah) ──────────
   TIDAK ADA logic limit baru sama sekali di sini — murni menerjemahkan
   currentUser.accountStatus.download (field ASLI dari accountStatusSummary()
   di server.js APP LAMA: { game: {limit,used,remaining,unlimited}, bypass:
   {...} }, backend TIDAK diubah) ke UI. Dipanggil dari enterApp() (render
   pertama setelah login) dan handleAccountUpdate() (realtime — termasuk
   PERSIS setelah user berhasil download: consumeAttemptQuota() ->
   consumeDownloadQuota() -> pushAccountUpdate() di server.js memicu event WS
   'account:update' yang sudah aktif lewat connectRealtime(), jadi angka di
   widget ini ikut berubah tanpa refresh app sama sekali). */
// State Hide/Reopen widget ini — SENGAJA di memori (bukan localStorage),
// reset ke `false` tiap kali App di-load ulang/restart, supaya widget
// selalu mulai dalam kondisi FULL/terlihat begitu App dibuka (lihat catatan
// FIX di dalam renderDownloadLimitWidget() di bawah). Hapus juga key
// localStorage LAMA dari versi sebelumnya (kalau ada, dari sesi App yang
// sudah pernah menyimpan preferensi Hide permanen) supaya tidak ada sisa
// state basi yang membingungkan.
let _dlLimitWidgetHiddenSession = false;
try { localStorage.removeItem('dlLimitWidgetHidden'); } catch (e) {}

function renderDownloadLimitWidget(user){
  const widget = document.getElementById('dlLimitWidget');
  const reopenBtn = document.getElementById('dlLimitReopenBtn');
  if (!widget) return;
  const download = user?.accountStatus?.download;
  if (!download){ widget.hidden = true; if (reopenBtn) reopenBtn.hidden = true; return; }

  // Fitur Hide: sekali user klik ×, widget tersembunyi HANYA untuk sesi App
  // yang sedang berjalan sekarang — sampai user menekan tombol reopen kecil
  // di pojok yang sama, ATAU App dibuka ulang. Preferensi murni tampilan,
  // TIDAK mempengaruhi data. Data di bawah tetap di-isi ulang walau lagi
  // hidden, supaya begitu user reopen, angkanya sudah pasti up to date
  // (bukan angka basi dari sebelum hide).
  //
  // FIX (poin "saat buka App jangan langsung minimize, tampilkan FULL
  // widgetnya"): sebelumnya preferensi Hide disimpan ke localStorage —
  // sekali user klik × sekalipun cuma iseng, widget ini TETAP tersembunyi
  // (cuma muncul tombol reopen kecil) di SETIAP App dibuka lagi, termasuk
  // setelah restart, sampai user ingat untuk klik reopen manual. Sekarang
  // preferensi Hide cuma dipegang di memori (`_dlLimitWidgetHiddenSession`,
  // reset ke false tiap App di-load ulang/restart) — jadi widget SELALU
  // tampil FULL begitu App dibuka, dan user tetap bebas meng-×/reopen kalau
  // lagi menghalangi selama sesi App itu berjalan (perilaku ×/reopen dalam
  // satu sesi tidak berubah sama sekali).
  widget.hidden = _dlLimitWidgetHiddenSession;
  if (reopenBtn) reopenBtn.hidden = !_dlLimitWidgetHiddenSession;

  // Wiring tombol Hide/Reopen — sekali saja (guard _wired), aman dipanggil
  // ulang tiap render tanpa numpuk listener.
  if (!widget._wired) {
    widget._wired = true;
    document.getElementById('dlLimitHideBtn')?.addEventListener('click', () => {
      widget.hidden = true;
      if (reopenBtn) reopenBtn.hidden = false;
      _dlLimitWidgetHiddenSession = true;
    });
    reopenBtn?.addEventListener('click', () => {
      _dlLimitWidgetHiddenSession = false;
      widget.hidden = false;
      reopenBtn.hidden = true;
    });
  }

  const pkgBadge = document.getElementById('dlLimitPkgBadge');
  const adminBadge = document.getElementById('dlLimitAdminBadge');
  const tier = packageTierOf(user);
  const isAdmin = tier === 'admin';
  if (pkgBadge) {
    pkgBadge.hidden = isAdmin;
    if (!isAdmin && pkgBadge.dataset.tier !== tier){
      pkgBadge.dataset.tier = tier;
      delete pkgBadge.dataset.rendered; // paksa renderPackageBadges() isi ulang icon+label buat tier baru
    }
    if (!isAdmin && typeof renderPackageBadges === 'function') renderPackageBadges();
  }
  if (adminBadge) {
    adminBadge.hidden = !isAdmin;
    if (isAdmin && typeof renderAdminBadge === 'function') renderAdminBadge(adminBadge);
  }

  fillDownloadLimitRow('game', download.game);
  fillDownloadLimitRow('bypass', download.bypass);
}

// Isi 1 baris widget (Game ATAU Bypass) dari 1 objek stat ASLI
// {limit,used,remaining,unlimited} — tidak pernah dikarang/dihitung ulang,
// cuma format tampilan (X / Y, persen buat lebar bar, teks sisa/habis).
function fillDownloadLimitRow(type, stat){
  const row = document.getElementById(type === 'game' ? 'dlLimitRowGame' : 'dlLimitRowBypass');
  const countEl = document.getElementById(type === 'game' ? 'dlLimitGameCount' : 'dlLimitBypassCount');
  const fillEl = document.getElementById(type === 'game' ? 'dlLimitGameFill' : 'dlLimitBypassFill');
  const subEl = document.getElementById(type === 'game' ? 'dlLimitGameSub' : 'dlLimitBypassSub');
  if (!row || !stat) return;

  if (stat.unlimited){
    row.classList.remove('empty');
    row.classList.add('unlimited');
    if (subEl) subEl.textContent = 'Unlimited Download';
    return;
  }
  row.classList.remove('unlimited');

  const limit = stat.limit || 0;
  const used = stat.used || 0;
  const remaining = stat.remaining != null ? stat.remaining : Math.max(0, limit - used);
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 100;

  if (countEl) countEl.textContent = `${used} / ${limit}`;
  if (fillEl) fillEl.style.width = pct + '%';

  if (remaining <= 0){
    row.classList.add('empty');
    if (subEl) subEl.textContent = 'Limit habis hari ini';
  } else {
    row.classList.remove('empty');
    if (subEl) subEl.textContent = `${remaining} tersisa hari ini`;
  }
}
/* ── AKHIR Widget Limit Download Harian ── */
/* ══════════════════════════════════════════════════════════════════════════
   AKHIR BLOK PACKAGE / ROLE
   ══════════════════════════════════════════════════════════════════════════ */

/* ══════════════════════════════════════════════════════════════════════════
   REALTIME — WebSocket, dipindah dari app/app.js APP LAMA (connectRealtime()).
   Backend TIDAK punya socket.io — server.js APP LAMA/APP DEMO memakai native
   `ws` (WebSocket.Server di path /ws) dan sudah broadcast 'games:update' /
   'bypasses:update' dst ke SEMUA client begitu admin ubah data (lihat
   broadcastGamesUpdate()/broadcastBypassesUpdate() di server.js — server.js
   TIDAK diubah sama sekali, sudah identik di kedua project). Jadi cukup
   nyalakan koneksi WS ini di App Demo supaya Games & Bypass ikut REALTIME
   tanpa refresh/reload app sama sekali — sama seperti App Lama.

   Untuk sekarang listener yang diaktifkan HANYA yang sudah punya
   fungsi/UI nyata di App Demo (games/bypasses/account). Event lain
   (banners/leaderboard/notification/dst) sengaja BELUM ditangani di sini —
   menyusul begitu halaman terkait dimigrasikan, tinggal tambah 1 cabang
   `else if` baru di onmessage, tidak perlu bikin koneksi WS baru.
   ══════════════════════════════════════════════════════════════════════════ */
let _ws = null;
let _wsReconnectTimer = null;
let _wsReconnectDelay = 2000;
let _wsHasConnectedOnce = false; // resync games/bypasses cuma perlu saat RECONNECT, bukan koneksi pertama (sudah di-load di enterApp())

function connectRealtime() {
  const token = localStorage.getItem('token');
  if (!token || !currentUser) return;
  try { _ws?.close(); } catch (e) {}

  _ws = new WebSocket(`${WS_URL}?token=${encodeURIComponent(token)}`);
  console.log('[App Customization] Socket connecting ke', WS_URL);

  _ws.onopen = () => {
    console.log('[App Customization] Socket connected.');
    _wsReconnectDelay = 2000;
    // Kalau socket sempat putus lalu admin ubah game/bypass/role SELAGI
    // putus, event WS itu fire-and-forget (server tidak nge-queue) jadi
    // hilang begitu saja — resync sekali tiap RECONNECT (bukan koneksi
    // pertama, itu sudah di-cover enterApp()).
    if (_wsHasConnectedOnce && currentUser) {
      loadGames();
      loadBypasses();
      api('/api/me').then(u => { if (u) handleAccountUpdate(u); }).catch(() => {});
      // FIX (App Customization realtime, poin #8/#11 permintaan): sebelumnya
      // TIDAK di-refetch di sini padahal komentar di atas loadAppCustomization()
      // (lihat definisinya) sudah mengklaim ini dipanggil ulang tiap reconnect —
      // nyatanya tidak. Karena wsBroadcastAll bersifat fire-and-forget (server
      // tidak nge-queue event yang terlewat saat koneksi putus), background/
      // branding yang diubah Admin SELAGI App sedang disconnect akan hilang dan
      // App tetap memakai config lama sampai app displines direstart manual.
      // Query ulang /api/app-customization di sini menutup celah itu, sama
      // seperti games/bypasses/account di atas.
      loadAppCustomization();
      // FIX (Beli Paket — poin #10, "APP start/reconnect"): sama alasannya
      // dengan games/bypasses/app-customization di atas — kalau koneksi WS
      // sempat putus SELAGI Admin Web mengubah paket, sinyal 'packages:update'
      // fire-and-forget itu hilang begitu saja. Resync sekali di sini
      // (aman dipanggil walau halaman Beli Paket sedang tidak dibuka —
      // loadPackages() cuma no-op di error box kalau elemennya tidak ada
      // relevan, dan hasilnya tetap ke-cache di _pkgLastData buat kapan pun
      // halaman itu dibuka).
      if (typeof loadPackages === 'function') loadPackages();
      // Tutorial — sama alasannya: 'tutorials:update' fire-and-forget, jadi
      // perubahan Admin Web SELAGI App disconnect harus di-resync manual di
      // sini (poin "APP reconnect harus sinkron ulang", server/DB tetap
      // source of truth, bukan mengandalkan state lama).
      if (typeof loadTutorials === 'function') loadTutorials();
      // MARKETPLACE — 'marketplace:products:update'/'marketplace:access:update'
      // juga fire-and-forget seperti event lain di atas: kalau koneksi WS
      // sempat putus SELAGI Admin Web mengubah produk (atau akses user
      // berubah), sinyalnya hilang begitu saja. Resync sekali di sini, sama
      // pola dengan loadPackages()/loadTutorials() (aman dipanggil walau
      // halaman Marketplace sedang tidak dibuka).
      if (typeof loadMarketplaceProducts === 'function') loadMarketplaceProducts();
      // GOLD TRIAL (requirement #13 "RESTART/LOGIN/RECONNECT") — sinkronkan
      // ulang status Gold Trial dari backend tiap Socket.IO reconnect, sama
      // alasannya dengan resync lain di atas (event realtime fire-and-forget
      // bisa hilang selagi koneksi putus). Database tetap source of truth:
      // kalau user/device ternyata sudah claim di tempat lain SELAGI App ini
      // disconnect, modal tawaran otomatis tidak akan muncul lagi setelah
      // resync ini (lihat applyGoldTrialAutoOffer() di dalam loadGoldTrialOffer()).
      if (typeof loadGoldTrialOffer === 'function') loadGoldTrialOffer();
      // WELCOME POPUP — sama alasannya dengan resync lain di atas: sinyal
      // 'welcome-popup:update' bersifat fire-and-forget, jadi perubahan Admin
      // Web SELAGI App disconnect (enable/disable/isi/version) bisa hilang.
      // Dipanggil TANPA onDone (bukan alur login) & checkWelcomePopup() sendiri
      // sudah aman dipanggil berkali-kali (no-op kalau lagi ada popup terbuka).
      if (typeof checkWelcomePopup === 'function') checkWelcomePopup();
      // MAINTENANCE MODE (poin "Socket.IO reconnect -> status Maintenance
      // tersinkron kembali") — sama alasannya dengan resync lain di atas:
      // event 'maintenance:config' bersifat fire-and-forget (server tidak
      // nge-queue), jadi Admin bisa saja aktif/nonaktifkan atau ubah isi
      // Maintenance SELAGI App ini disconnect. Fetch ulang lewat REST publik
      // existing (GET /api/maintenance-status, database tetap source of
      // truth) supaya App selalu sinkron begitu reconnect.
      if (typeof checkMaintenanceStatus === 'function') checkMaintenanceStatus();
      // DASHBOARD BANNER (poin #11 permintaan — "WS sempat putus lalu admin
      // ubah banner SELAGI putus, begitu APP reconnect, banner harus ikut
      // di-resync") — sama alasannya dengan resync lain di atas: sinyal
      // 'dashboard-banner:update' bersifat fire-and-forget (server tidak
      // nge-queue), jadi perubahan Admin Web SELAGI App disconnect bisa
      // hilang kalau tidak di-resync manual di sini.
      if (typeof loadDashboardBanner === 'function') loadDashboardBanner();
      // ACTIVE TOOLS — 'active-tools:config' juga fire-and-forget seperti
      // event lain di atas: kalau koneksi WS sempat putus SELAGI Admin Web
      // mengubah Activation Method/link/command/status enabled, sinyalnya
      // hilang begitu saja. Resync sekali di sini (requirement #9/#16 — "saat
      // reconnect, sync ulang konfigurasi/status dari backend").
      if (typeof loadActiveToolsConfig === 'function') loadActiveToolsConfig();
    }
    // LIVE CHAT — resync riwayat/status Admin online setiap kali socket
    // (re)connect (lihat onSocketOpen() di livechat.js untuk penjelasan akar
    // masalahnya: balasan Admin yang masuk SELAGI koneksi putus tidak pernah
    // sampai karena wsSendToUser/broadcastAdmin bersifat fire-and-forget,
    // sama seperti resync lain di atas). Sengaja DIPANGGIL DI LUAR blok
    // `if (_wsHasConnectedOnce...)` — beda dari resync lain di atas — karena
    // livechat.js sendiri sudah idempotent & punya guard `_syncing` (aman
    // dipanggil di koneksi PERTAMA maupun reconnect tanpa efek samping).
    if (typeof LiveChatWidget !== 'undefined' && LiveChatWidget.onSocketOpen) LiveChatWidget.onSocketOpen();
    _wsHasConnectedOnce = true;
  };

  _ws.onmessage = (ev) => {
    let msg;
    // FIX DEBUG: sebelumnya error parse ditelan diam-diam (cuma `return`),
    // jadi kalau ada pesan WS yang gagal/kepotong (mis. payload besar),
    // App diam-diam tidak berubah tanpa jejak sama sekali. Sekarang di-log
    // supaya kelihatan di DevTools console App kalau ini terjadi lagi.
    try { msg = JSON.parse(ev.data); } catch (e) { console.warn('[Realtime] Gagal parse pesan WS:', e); return; }
    if (!msg || !msg.event) return;

    if (msg.event === 'account:update') {
      handleAccountUpdate(msg.data);
    } else if (msg.event === 'games:update') {
      // Push realtime dari Admin Web (tambah/edit/hapus game) — langsung
      // dipakai, TIDAK fetch ulang.
      applyGamesUpdate(msg.data);
    } else if (msg.event === 'bypasses:update') {
      applyBypassesUpdate(msg.data);
    } else if (msg.event === 'premium:cleanup') {
      // Auto Remove Installed Premium Content — dipicu server (WS) begitu masa
      // aktif Gold/Platinum habis, ATAU admin klik "Hapus Manual" di Admin Web.
      // Migrasi UTUH dari APP LAMA (lihat handlePremiumCleanup() di bawah file
      // ini) — TIDAK ada logic baru, cuma disambungkan ke listener WS yang
      // sudah ada di sini. Backend (schedulePremiumCleanup/sweepPendingPremiumCleanups/
      // endpoint /api/premium-cleanup/*, semua di server.js) TIDAK diubah sama
      // sekali, sudah 100% aktif sejak awal — yang selama ini hilang cuma sisi
      // APP-nya (bug: Admin Web dapat toast "Dijadwalkan" tapi APP tidak pernah
      // benar-benar menghapus file, karena handler ini belum ada).
      if (typeof handlePremiumCleanup === 'function') handlePremiumCleanup(msg.data);
    } else if (msg.event === 'leaderboard:update') {
      // Realtime Top Installer Mingguan — server sudah broadcast event ini
      // setiap ada install baru (lihat POST /api/history di server.js), jadi
      // di sini tinggal render ulang, TIDAK perlu fetch ulang / polling.
      renderTopInstaller(msg.data);
    } else if (msg.event === 'active-tools:config') {
      // Admin ubah config Active Tools (Admin Web) -> broadcast realtime ke
      // semua App yang online (lihat wsBroadcastAll di activeToolsManager.js,
      // TIDAK diubah). Kartu di Settings + gate di handleInstall() langsung
      // pakai config terbaru tanpa perlu restart/refresh app.
      applyActiveToolsConfig(msg.data);
    } else if (msg.event === 'app-customization:update') {
      console.log('[App Customization] Received config signal via WS:', msg.data);
      // Admin ubah Background/Branding App (Admin Web) -> semua App yang
      // online langsung berubah TANPA restart/refresh.
      // FIX: WS sekarang cuma kirim sinyal ringan {changed, version} (lihat
      // appCustomizationManager.broadcastUpdate()) — BUKAN payload penuh
      // lagi, karena background.image/branding.logo bisa berupa base64
      // beberapa MB yang rawan gagal terkirim utuh lewat WS. Config
      // lengkap di-fetch ulang lewat REST yang SUDAH ADA (loadAppCustomization
      // -> GET /api/app-customization), jadi payload besar tidak pernah
      // lewat WS sama sekali.
      loadAppCustomization();
    } else if (msg.event === 'dashboard-banner:update') {
      // Admin ubah Dashboard Hero Banner (Admin Web) -> semua App yang
      // online langsung berubah TANPA restart/refresh. Sama pola dengan
      // 'app-customization:update' di atas: WS cuma kirim sinyal ringan
      // {changed, version} (gambar bisa base64 besar), config lengkap
      // di-fetch ulang lewat REST yang sudah ada (loadDashboardBanner ->
      // GET /api/dashboard-banner).
      console.log('[Dashboard Banner] Received update signal via WS:', msg.data);
      loadDashboardBanner();
    } else if (msg.event === 'welcome-popup:update') {
      // Admin ubah/simpan Welcome Popup ATAU klik "Paksa Tampil Kembali"
      // (Admin Web) -> semua App yang online langsung sync ulang lewat REST
      // existing (GET /api/welcome-popup, server-side gated), TANPA
      // restart/refresh/logout-login. TIDAK menyentuh urutan Gold Trial sama
      // sekali di sini (bukan alur login) — checkWelcomePopup() no-op kalau
      // lagi ada popup lain yang sedang terbuka.
      console.log('[Welcome Popup] Received update signal via WS:', msg.data);
      if (typeof checkWelcomePopup === 'function') checkWelcomePopup();
    } else if (msg.event === 'transaction:update') {
      // Realtime status transaksi Beli Paket (dibuat/dibayar/gagal/dibatalkan/
      // kedaluwarsa) — lihat handlePkgTransactionUpdate() di blok "BELI PAKET".
      // Aktivasi role/activeUntil-nya sendiri datang lewat event 'account:update'
      // terpisah (dikirim server bareng transaction:update saat status jadi
      // 'completed') dan sudah ditangani handleAccountUpdate() di atas.
      if (typeof handlePkgTransactionUpdate === 'function') handlePkgTransactionUpdate(msg.data);
      // Halaman Transaksi (Fitur B/C) — update realtime juga kalau lagi dibuka.
      if (typeof handleTxPageTransactionUpdate === 'function') handleTxPageTransactionUpdate(msg.data);
      // Gold Trial — kalau item transaksi yang barusan berubah adalah klaim
      // Gold Trial (mis. Admin memakai tombol TEST, atau akun ini sedang
      // login di device lain lalu klaim di sana), refresh kartu promo/status
      // di halaman Beli Paket supaya selalu sinkron tanpa perlu pindah halaman.
      if (msg.data?.kind === 'gold_trial' && typeof loadGoldTrialOffer === 'function') loadGoldTrialOffer();
    } else if (msg.event === 'notification') {
      // Notifikasi personal (in-app) dari notifyUser() — dipakai a.l. oleh
      // fitur Admin Web "Kirim Notifikasi Gold Trial" (POST
      // /api/admin/gold-trial/notify) & notifikasi klaim sukses/gagal.
      // Notifikasi jenis lain sengaja dibiarkan lewat dulu (belum ada
      // halaman/lonceng notifikasi umum di App Demo ini) — lihat TODO di
      // atas.
      if (typeof handleGoldTrialPushNotification === 'function') handleGoldTrialPushNotification(msg.data);
      // Welcome Popup TEST (Admin Web "Kirim Test" -> POST
      // /api/admin/welcome-popup/test -> notifyUser() existing, type
      // 'welcome_popup_test') — tampil langsung, TIDAK menandai status
      // dismiss Welcome Popup NORMAL akun ini (lihat handleWelcomePopupTestPush()
      // di blok WELCOME POPUP di atas).
      if (msg.data?.type === 'welcome_popup_test' && typeof handleWelcomePopupTestPush === 'function') {
        handleWelcomePopupTestPush(msg.data.meta);
      }
    } else if (msg.event === 'tutorials:update') {
      // Realtime Tutorial — server SUDAH broadcast event ini (lihat
      // broadcastPublishedTutorials() di server.js) setiap kali Admin Web
      // Tambah/Edit/Hapus/ubah status Publish-Draft Tutorial. Payload =
      // daftar tutorial published TERBARU (bukan sinyal ringan), jadi
      // langsung dipakai untuk render ulang — TIDAK fetch ulang REST.
      if (typeof applyTutorialsUpdate === 'function') applyTutorialsUpdate(msg.data);
    } else if (msg.event === 'packages:update') {
      // FIX (Admin Web -> App tidak sinkron): server SUDAH broadcast event ini
      // sejak lama lewat wsBroadcastAll('packages:update', ...) tiap kali Admin
      // Web save Upgrade Paket (lihat PUT /api/admin/packages/:tier di
      // server.js), tapi cabang untuk event ini belum pernah ada di sini —
      // jadi selama halaman Beli Paket sedang terbuka, perubahan Admin Web
      // (description/benefit/price/duration/limit/badge/active) TIDAK PERNAH
      // sampai ke App tanpa pindah halaman lalu balik lagi (yang men-trigger
      // loadPackages() manual) atau restart App. Root cause-nya PERSIS di
      // sini: bukan di Admin Web, bukan di backend, bukan di database (ketiga
      // itu sudah benar — packageManager.updateTier() menulis ke DB lalu
      // dibaca ulang tanpa cache apa pun), tapi di App yang tidak mendengarkan
      // sinyal realtime-nya. Lihat applyPackagesUpdate() di blok "BELI PAKET".
      if (typeof applyPackagesUpdate === 'function') applyPackagesUpdate(msg.data);
    } else if (msg.event === 'marketplace:products:update') {
      // Admin Web tambah/edit/hapus/ubah harga/gambar/status produk
      // Marketplace -> server broadcast sinyal ringan (bukan payload penuh,
      // lihat wsBroadcastAll di server.js) -> di sini cukup fetch ulang lewat
      // REST yang sudah personalized (isOwner/hasPendingOrder per user),
      // sama pola dengan games:update/bypasses:update di atas.
      if (typeof loadMarketplaceProducts === 'function') loadMarketplaceProducts();
    } else if (msg.event === 'marketplace:access:update') {
      // Entitlement user berubah realtime (whitelist admin ATAU order
      // siapapun baru saja lunas) — lihat handleMktAccessUpdate() di blok
      // MARKETPLACE.
      if (typeof handleMktAccessUpdate === 'function') handleMktAccessUpdate(msg.data);
    } else if (msg.event === 'marketplace:order:update') {
      // Realtime status order Marketplace (dibuat/dibayar/gagal/dibatalkan/
      // kedaluwarsa) — lihat handleMktOrderUpdate() di blok MARKETPLACE.
      if (typeof handleMktOrderUpdate === 'function') handleMktOrderUpdate(msg.data);
    } else if (msg.event === 'steamAccounts:products:update') {
      // Sinyal global (Admin tambah/edit/hapus akun ATAU game di akun) —
      // sama pola dengan marketplace:products:update di atas.
      if (typeof handleStaProductsSignal === 'function') handleStaProductsSignal();
    } else if (msg.event === 'steamAccounts:order:update') {
      // Realtime status order Steam Account (dibuat/dibayar/gagal/dibatalkan/
      // kedaluwarsa) — lihat handleStaOrderUpdate() di blok STEAM ACCOUNT.
      if (typeof handleStaOrderUpdate === 'function') handleStaOrderUpdate(msg.data);
    } else if (msg.event === 'steamAccounts:credentialsDm') {
      // Status pengiriman DM kredensial ke Discord setelah lunas — murni
      // notifikasi, TIDAK mempengaruhi tombol LOGIN AKUN di App.
      if (typeof handleStaCredentialsDm === 'function') handleStaCredentialsDm(msg.data);
    } else if (msg.event === 'app-update:config') {
      // AUTO UPDATE / FORCE UPDATE — migrasi dari APP LAMA. Admin Web publish
      // versi baru (atau ubah setting App Update) -> server broadcast event ini
      // (wsBroadcastAll di appUpdateManager.js, TIDAK diubah) -> di sini
      // langsung dievaluasi ulang (applyAppUpdateConfig, lihat blok "APP
      // UPDATE" di bawah) TANPA perlu restart/refresh App sama sekali.
      if (typeof applyAppUpdateConfig === 'function') applyAppUpdateConfig(msg.data);
    } else if (msg.event === 'maintenance:config') {
      // MAINTENANCE MODE — Admin Web aktif/nonaktifkan Maintenance (atau ubah
      // title/description/message/estimasi selesai) -> backend broadcast
      // event ini PER USER lewat WS existing (wsSendToUser, lihat
      // maintenanceManager.broadcastToClients(), TIDAK diubah) karena status
      // `bypass` tergantung whitelist/role masing-masing user. Payload sudah
      // final (personalized) jadi langsung dipakai TANPA fetch ulang — App
      // berubah realtime TANPA refresh/restart/logout-login (lihat blok
      // "MAINTENANCE MODE" di bawah).
      if (typeof applyMaintenanceStatus === 'function') applyMaintenanceStatus(msg.data);
    } else if (msg.event === 'device:reset') {
      // DEVICE RESET REALTIME — migrasi UTUH dari APP LAMA (handleDeviceReset()
      // di blok AUTH di bawah, TIDAK ada logic baru). Backend (wsSendToUser di
      // server.js, endpoint reset device Admin Web) sudah aktif sejak awal dan
      // sudah mengirim event ini lewat Socket.IO existing — yang selama ini
      // hilang cuma cabang listener di sisi App ini, jadi App yang sedang
      // terbuka tidak pernah bereaksi sampai direstart manual. wsSendToUser
      // sudah menargetkan `discordId` device yang direset secara spesifik
      // (server-side), jadi user lain yang online TIDAK ikut logout.
      if (typeof handleDeviceReset === 'function') handleDeviceReset();
    } else if (msg.event === 'gameRequest:update') {
      // REQUEST GAME — status request MILIK USER INI berubah (baru dibuat,
      // di-approve/reject Admin). Event & payload (publicGameRequest) SUDAH
      // ADA di server.js (wsSendToUser di POST /api/requests/games & endpoint
      // approve/reject Admin) — TIDAK ada Socket.IO baru, cuma listener ini
      // yang sebelumnya belum ada di App. Lihat handleGameRequestUpdate() di
      // blok REQUEST GAME.
      if (typeof handleGameRequestUpdate === 'function') handleGameRequestUpdate(msg.data);
    } else if (msg.event === 'request-game-settings:update') {
      // Admin ubah pengaturan Request Game (aktif/nonaktif, limit harian per
      // paket, jam reset) -> broadcast ke SEMUA App online (wsBroadcastAll di
      // server.js, TIDAK diubah). Halaman Request Game yang sedang terbuka
      // langsung menyesuaikan (tombol/limit/status) tanpa restart.
      if (typeof handleRequestGameSettingsUpdate === 'function') handleRequestGameSettingsUpdate(msg.data);
    } else if (typeof msg.event === 'string' && msg.event.indexOf('livechat:') === 0) {
      // LIVE CHAT REALTIME — meneruskan SELURUH event 'livechat:*'
      // (livechat:message/typing/adminStatus/cleared) ke widget (livechat.js)
      // lewat _ws yang SAMA dengan fitur lain di atas — TIDAK membuat koneksi
      // WebSocket baru sama sekali. Backend (liveChatManager.js broadcast
      // lewat wsSendToUser/broadcastAdmin, server.js) SUDAH mengirim event
      // ini sejak awal; yang selama ini hilang cuma cabang listener App di
      // sini, sama persis pola root-cause fitur lain (device:reset,
      // packages:update, dst) di atas — jadi App tidak pernah bereaksi sampai
      // sekarang, padahal Backend & Admin Web sudah 100% aktif.
      if (typeof LiveChatWidget !== 'undefined' && LiveChatWidget.handleWsEvent) LiveChatWidget.handleWsEvent(msg);
    }
    // TODO (menyusul per halaman): banners:update, categories:update,
    // notification, dst — sama seperti App Lama, tinggal tambah cabang di
    // sini begitu UI-nya siap.
  };

  _ws.onclose = () => {
    console.warn('[App Customization] Socket closed/putus.');
    if (!currentUser) return; // sudah logout, tidak perlu reconnect
    clearTimeout(_wsReconnectTimer);
    _wsReconnectTimer = setTimeout(connectRealtime, _wsReconnectDelay);
    _wsReconnectDelay = Math.min(_wsReconnectDelay * 1.5, 30000);
  };
  _ws.onerror = (err) => { console.error('[App Customization] Socket error:', err); try { _ws.close(); } catch (e) {} };
}

function disconnectRealtime() {
  clearTimeout(_wsReconnectTimer);
  _wsReconnectTimer = null;
  try { _ws?.close(); } catch (e) {}
  _ws = null;
  _wsHasConnectedOnce = false;
}

// ═════════════════════════════════════════════════
// POLLING FALLBACK ROLE-CHECK — migrasi UTUH dari APP LAMA (startAutoRefresh(),
// TIDAK ada sistem baru). Realtime WebSocket (event 'account:update', lihat
// handleAccountUpdate() & _ws.onmessage di atas) TETAP jadi mekanisme utama;
// polling di sini MURNI jaring pengaman kalau WS putus, gagal diam-diam
// (connected tapi event tidak sampai), atau internet sempat terputus. Poll
// ringan tiap 3 detik lewat /api/me/role-check (endpoint existing, HANYA
// return { role, roleUpdatedAt } jadi overhead-nya kecil) — baru hit /api/me
// lengkap & pakai handleAccountUpdate() KALAU terdeteksi berubah, jadi
// polling dan WebSocket sama-sama bermuara ke SATU flow update state yang
// sama persis (tidak ada dua sistem state terpisah).
// ═══════════════════════════════════════════════
let _roleCheckTimer = null; // polling ringan KHUSUS deteksi perubahan role/package
let _lastKnownRoleUpdatedAt = null;

function startAutoRefresh() {
  if (_roleCheckTimer) clearInterval(_roleCheckTimer); // guard: cegah duplicate interval kalau startAutoRefresh() sempat terpanggil lebih dari sekali (login/reconnect/reload)

  _roleCheckTimer = setInterval(async () => {
    if (!currentUser) return; // tidak ada authenticated user (belum login/sudah logout) -> no-op
    await _checkRoleRealtime();
  }, 3000);
}

function stopAutoRefresh() {
  if (_roleCheckTimer) { clearInterval(_roleCheckTimer); _roleCheckTimer = null; }
}

// Poll ringan role: /api/me/role-check dulu (murah), baru hit /api/me lengkap
// KALAU role atau roleUpdatedAt ternyata beda dari yang terakhir diketahui.
async function _checkRoleRealtime() {
  try {
    const check = await api('/api/me/role-check');
    const updatedAtChanged = check.roleUpdatedAt && check.roleUpdatedAt !== _lastKnownRoleUpdatedAt;
    const roleChanged = check.role && currentUser && check.role !== currentUser.role;

    if (!roleChanged && !updatedAtChanged) return; // tidak ada perubahan, selesai

    _lastKnownRoleUpdatedAt = check.roleUpdatedAt;

    // Pakai flow update state yang SAMA PERSIS dengan realtime WebSocket
    // ('account:update' -> handleAccountUpdate(), lihat _ws.onmessage di
    // atas) supaya badge/akses/toast/UI lain yang bergantung role/package
    // selalu konsisten baik update datang dari WS maupun dari fallback ini.
    const fresh = await api('/api/me');
    if (fresh) handleAccountUpdate(fresh);
  } catch (e) {} // jangan ganggu app kalau network sesaat terganggu (mis. internet sempat putus)
}

// ══════════════════════════════════════════════════════════════════════════
// AUTO REMOVE INSTALLED PREMIUM CONTENT (Premium Cleanup) — dipindah UTUH
// dari app/app.js PROJECT LAMA. Backend (server.js: schedulePremiumCleanup/
// sweepPendingPremiumCleanups/getPremiumInstalledItems/getAllInstalledItems/
// endpoint GET /api/premium-cleanup/pending, POST /api/premium-cleanup/:id/
// start & /:id/complete) dan Admin Web (tombol "Hapus Manual" ->
// doManualPremiumCleanup()) TIDAK diubah sama sekali di migrasi ini — semua
// SUDAH aktif sejak awal. Yang dipindah di sini HANYA sisi APP: menerima job
// dari server & benar-benar mengeksekusi hapus file lewat IPC Electron
// (removeGame/removeBypass/getSteamPath/restartSteam di main.js/preload.js,
// juga TIDAK diubah).
//
// Dipicu server (event WS 'premium:cleanup', lihat connectRealtime() di
// atas) begitu masa aktif Gold/Platinum habis — realtime kalau app lagi
// kebuka, atau lewat checkPendingPremiumCleanups() begitu app dibuka lagi
// kalau tadi sempat tertutup (dipanggil dari enterApp() di atas). Job yang
// sama TIDAK PERNAH diproses dua kali (WS + polling/pending-check nyaris
// bareng) berkat _processedCleanupJobs di bawah.
//
// Ownership/entitlement adalah TANGGUNG JAWAB BACKEND, bukan APP ini — APP
// hanya mengeksekusi persis `items` yang sudah ditentukan server di dalam
// job (lihat getPremiumInstalledItems/getAllInstalledItems di server.js):
//   - reason 'expired' (otomatis) -> server HANYA menyertakan histori yang
//     installedViaRole-nya 'gold'/'platinum' (field disimpan apa adanya saat
//     install, sumber kebenaran, BUKAN ditebak dari nama file/game). Item
//     yang diinstal waktu masih Public/Gratis TIDAK PERNAH masuk daftar ini.
//   - reason 'manual' (tombol Hapus Manual admin) -> server menyertakan
//     SEMUA histori user ini apapun role-nya (termasuk Public/Gratis),
//     sesuai permintaan eksplisit fitur ini.
//   - Produk Marketplace TIDAK PERNAH ikut sama sekali di kedua kasus di
//     atas, karena pembelian Marketplace disimpan di koleksi terpisah
//     (`marketplaceOrders`, lihat marketplaceOrderManager.js) — bukan di
//     koleksi `history` yang jadi sumber query getPremiumInstalledItems/
//     getAllInstalledItems, jadi tidak akan pernah muncul di `job.items`.
// ══════════════════════════════════════════════════════════════════════════
const _processedCleanupJobs = new Set(); // cegah job yang sama diproses 2x (WS + polling nyaris bareng)

async function checkPendingPremiumCleanups() {
  try {
    const { jobs } = await api('/api/premium-cleanup/pending');
    for (const job of (jobs || [])) {
      await handlePremiumCleanup(job);
    }
  } catch (e) {} // best-effort — jangan sampai gagal ganggu proses buka app
}

async function handlePremiumCleanup(job) {
  if (!job || !job.jobId || _processedCleanupJobs.has(job.jobId)) return;
  _processedCleanupJobs.add(job.jobId);

  // SILENT untuk manual (dipicu admin dari tombol "Hapus Manual") — sesuai
  // permintaan eksplisit, TIDAK ADA popup/notifikasi apapun yang ditampilkan
  // ke user, file tetap dihapus di background seperti biasa. Auto-delete
  // setelah paket Gold/Platinum expired TETAP tampilkan modal peringatan.
  const silent = job.reason === 'manual';
  if (!silent) showPremiumCleanupModal('start', job);

  try { await api(`/api/premium-cleanup/${job.jobId}/start`, { method: 'POST' }); } catch (e) {}

  const results = [];
  let needRestartSteam = false;
  let cachedSteamPath = null;

  for (const item of (job.items || [])) {
    let removed = false, error = null;
    try {
      if (item.itemType === 'game') {
        if (!item.extractedFiles || !item.extractedFiles.length) {
          error = 'Data file tidak lengkap (histori lama)';
        } else {
          const steamPath = item.steamPath || cachedSteamPath || (cachedSteamPath = await window.electronAPI.getSteamPath());
          if (!steamPath) { error = 'Steam tidak ditemukan di PC ini'; }
          else {
            const rm = await window.electronAPI.removeGame({ steamPath, extractedFiles: item.extractedFiles });
            removed = !!rm?.success;
            if (removed) needRestartSteam = true;
            else error = rm?.error || 'Gagal menghapus file game';
          }
        }
      } else if (item.itemType === 'bypass') {
        if (!item.extractedFiles || !item.extractedFiles.length || !item.folderPath) {
          error = 'Data file tidak lengkap (histori lama)';
        } else {
          const rm = await window.electronAPI.removeBypass({ folderPath: item.folderPath, extractedFiles: item.extractedFiles });
          removed = !!rm?.success;
          if (!removed) error = rm?.error || 'Gagal menghapus file bypass';
        }
      } else {
        error = 'Tipe item tidak dikenal';
      }
    } catch (e) {
      error = e.message || 'Terjadi kesalahan';
    }

    if (removed && typeof removeLocalInstallMeta === 'function') removeLocalInstallMeta(item.historyId);
    results.push({ historyId: item.historyId, itemType: item.itemType, itemName: item.itemName, removed, error });
  }

  let serverResult = { removedGames: [], removedBypass: [], failed: [] };
  try {
    serverResult = await api(`/api/premium-cleanup/${job.jobId}/complete`, {
      method: 'POST',
      body: JSON.stringify({ results })
    });
  } catch (e) {}

  if (!silent) showPremiumCleanupModal('done', job, { ...serverResult, needRestartSteam });

  // Refresh tampilan supaya konten yang barusan dihapus langsung hilang dari
  // Histori/Games/Bypass — sama seperti loadHistori/loadGames/loadBypasses
  // yang sudah aktif di APP DEMO ini (Phase 5/6 & Histori).
  setTimeout(() => {
    if (typeof loadHistori === 'function') loadHistori().catch(() => {});
    if (typeof loadGames === 'function') loadGames().catch(() => {});
    if (typeof loadBypasses === 'function') loadBypasses().catch(() => {});
  }, 300);
}

// ── Modal Auto Remove — 2 state: 'start' (peringatan sebelum hapus, tanpa
// tombol tutup — proses tidak bisa dibatalkan) dan 'done' (hasil akhir +
// tombol Perpanjang/Beli). Markup/class (.pcm-*) sama persis dengan APP LAMA,
// cuma ikon disesuaikan ke gaya inline-SVG yang sudah dipakai overlay lain
// di APP DEMO ini (App Update / Maintenance), bukan sprite ic-* lama. ──
function showPremiumCleanupModal(state, job, resultData) {
  let overlay = document.getElementById('premiumCleanupOverlay');
  if (!overlay) return;
  overlay.style.display = 'flex';
  const roleLabel = String(job.role || '').toUpperCase();

  const ICON_WARN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2"/><path d="M5 3 2 6"/><path d="m22 6-3-3"/></svg>';
  const ICON_BRUSH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9.06 11.9 8.07-8.06a2.85 2.85 0 1 1 4.03 4.03l-8.06 8.08"/><path d="M7.07 14.94c-1.66 0-3 1.35-3 3.02 0 1.33-2.5 1.52-2 2.02 1.08 1.1 2.49 2.02 4 2.02 2.2 0 4-1.8 4-4.04a3.01 3.01 0 0 0-3-3.02z"/></svg>';
  const ICON_OK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.801 10A10 10 0 1 1 17 3.335"/><path d="m9 11 3 3L22 4"/></svg>';
  const ICON_PARTIAL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>';

  if (state === 'start') {
    const isManual = job.reason === 'manual';
    const title = isManual
      ? 'Admin Menghapus Konten Kamu'
      : `Paket ${escapeHtml(roleLabel)} Kamu Telah Berakhir`;
    const desc = `Seluruh <b>${job.gameCount || 0} game</b> dan <b>${job.bypassCount || 0} bypass</b>${isManual ? '' : ' premium'} yang kamu install akan otomatis dihapus dari PC ini sekarang. Proses ini tidak bisa dibatalkan.`;
    overlay.innerHTML = `
      <div class="pcm-modal">
        <div class="pcm-icon pcm-icon--warn">${isManual ? ICON_BRUSH : ICON_WARN}</div>
        <div class="pcm-title">${title}</div>
        <div class="pcm-desc">${desc}</div>
        <div class="pcm-progress"><div class="pcm-progress-bar"></div></div>
        <div class="pcm-status">Sedang menghapus, mohon tunggu...</div>
      </div>`;
    return;
  }

  // state === 'done'
  const removedGames  = resultData?.removedGames  || [];
  const removedBypass = resultData?.removedBypass || [];
  const failed        = resultData?.failed || [];
  const ok = failed.length === 0;
  const isManualDone = job.reason === 'manual';
  const doneTitle = ok
    ? (isManualDone ? 'Konten Berhasil Dihapus' : 'Konten Premium Berhasil Dihapus')
    : 'Penghapusan Selesai (Sebagian Gagal)';
  const doneQualifier = isManualDone ? '' : ' premium';

  overlay.innerHTML = `
    <div class="pcm-modal">
      <div class="pcm-icon ${ok ? 'pcm-icon--ok' : 'pcm-icon--partial'}">${ok ? ICON_OK : ICON_PARTIAL}</div>
      <div class="pcm-title">${doneTitle}</div>
      <div class="pcm-desc">
        <b>${removedGames.length}</b> game dan <b>${removedBypass.length}</b> bypass${doneQualifier} sudah dihapus dari PC ini.
        ${failed.length ? `<br><span style="color:var(--danger);">${failed.length} item gagal dihapus otomatis — cek folder Steam/game secara manual kalau perlu.</span>` : ''}
      </div>
      <div class="pcm-actions">
        ${resultData?.needRestartSteam ? `<button class="pcm-btn pcm-btn--ghost" id="pcmRestartSteamBtn"><svg class="icon icon-18"><use href="#ic-refresh-cw"></use></svg> Restart Steam</button>` : ''}
        <button class="pcm-btn pcm-btn--primary" id="pcmUpgradeBtn"><svg class="icon icon-18"><use href="#ic-shopping-cart"></use></svg> Perpanjang / Beli Paket</button>
      </div>
      <button class="pcm-close" id="pcmCloseBtn">Tutup</button>
    </div>`;

  document.getElementById('pcmUpgradeBtn')?.addEventListener('click', () => {
    closePremiumCleanupModal();
    // setNav() adalah versi APP DEMO dari showPage() APP LAMA — halaman
    // "Beli Paket" (id="page-belipaket") setara dengan 'store' di APP LAMA.
    if (typeof setNav === 'function') setNav('belipaket');
  });
  document.getElementById('pcmCloseBtn')?.addEventListener('click', closePremiumCleanupModal);
  document.getElementById('pcmRestartSteamBtn')?.addEventListener('click', async () => {
    const steamPath = await window.electronAPI.getSteamPath();
    if (steamPath) await window.electronAPI.restartSteam(steamPath);
  });
}

function closePremiumCleanupModal() {
  const overlay = document.getElementById('premiumCleanupOverlay');
  if (overlay) overlay.style.display = 'none';
}
// ══════════════════════════════════════════════════════════════════════════
// AKHIR PREMIUM CLEANUP
// ══════════════════════════════════════════════════════════════════════════

/* ══════════════════════════════════════════════════════════════════════════
   ACTIVE TOOLS — dipindah dari app/app.js PROJECT LAMA (activeToolsManager.js
   di backend & IPC handler di main.js TIDAK diubah sama sekali, lihat
   activeToolsManager.js & main.js). Yang baru cuma UI (kartu Settings +
   modal "Active Tools Required") dan koneksi ke komponen premium yang SUDAH
   ADA di App Demo (installBarShow/SetStage/SetSuccess/SetError, showToast)
   menggantikan dlModal* punya App Lama — supaya visualnya konsisten dengan
   redesign premium yang sudah dibuat sebelumnya, bukan bikin komponen baru.

   Alur:
     GET /api/active-tools (publik, dipanggil di enterApp() lewat
     loadActiveToolsConfig()) -> applyActiveToolsConfig() -> render kartu di
     Settings + cek status file/PS terakhir (refreshActiveToolsStatus()).
     Realtime lewat WS 'active-tools:config' (lihat cabang di onmessage di
     atas) begitu admin ubah config, TANPA perlu polling baru.

     Gate dipasang SATU TEMPAT SAJA: awal handleInstall() (lihat di bawah)
     — karena SEMUA tombol Download/Install (Game primary, Bypass dari
     Game, Bypass primer) sudah funnel lewat fungsi itu, jadi otomatis
     berlaku ke semua tanpa perlu diulang per halaman (requirement #6).
   ══════════════════════════════════════════════════════════════════════════ */
let _activeToolsConfig = null;   // { enabled, activationMethod, zipUrl, version, powershellCommand, description }
let _activeToolsActive = false;  // hasil validasi status file/PS TERKINI (bisa false walau pernah pernah install, kalau file hilang/rusak)
let _activeToolsBusy = false;    // sedang proses aktivasi (link atau powershell)
// _activeToolsEverInstalled — flag "pernah berhasil install minimal sekali",
// persist di localStorage. ROOT CAUSE FIX (Active Tools status harus SELALU
// mengikuti kondisi file/folder Steam sebenarnya): flag ini SEBELUMNYA yang
// menentukan LABEL & PERILAKU tombol (Install vs Install Ulang) — sekali true,
// tidak pernah balik ke false lagi walau file/folder-nya kemudian hilang/
// rusak, ATAU walau user itu sebenarnya USER BARU di device/profile lain yang
// localStorage-nya kebetulan masih menyimpan flag lama. Itu melanggar
// persyaratan wajib "status final HARUS mengikuti hasil pengecekan file/
// folder Steam, database/local state cuma boleh jadi informasi tambahan" —
// localStorage bukan source of truth, isi folder Steam-lah source of truth.
// Sekarang flag ini TIDAK LAGI dipakai untuk memutuskan apa pun (label
// tombol, cabang konfirmasi reinstall, dst) — SEMUA keputusan itu memakai
// `_activeToolsActive` (hasil verifikasi file/folder Steam TERKINI via
// activeToolsCheckStatus(), lihat refreshActiveToolsStatus() di bawah).
// Variabel & localStorage-nya sengaja TETAP disimpan (bukan dihapus total)
// murni sebagai informasi/telemetri tambahan yang memang diizinkan — TIDAK
// pernah lagi jadi determinan status/UI.
let _activeToolsEverInstalled = false;

function getActiveToolsFiles() {
  try { return JSON.parse(localStorage.getItem('activeToolsFiles') || '[]'); } catch (e) { return []; }
}
function saveActiveToolsFiles(files) {
  try { localStorage.setItem('activeToolsFiles', JSON.stringify(files || [])); } catch (e) {}
}
function getActiveToolsEverInstalled() {
  try { return localStorage.getItem('activeToolsEverInstalled') === '1'; } catch (e) { return false; }
}
function markActiveToolsEverInstalled() {
  _activeToolsEverInstalled = true;
  try { localStorage.setItem('activeToolsEverInstalled', '1'); } catch (e) {}
}

// Dipanggil best-effort setelah install/reinstall selesai (berhasil ATAU
// gagal) — cuma membungkus POST /api/tools/log-use yang SUDAH ADA di
// server.js (logActivity() existing, bukan sistem log baru). Sebelumnya
// dipanggil di 4 tempat di bawah tapi fungsinya belum pernah didefinisikan
// sama sekali (selalu no-op lewat guard `typeof logToolUsage === 'function'`)
// — errornya di-swallow supaya kalau App lagi offline sebentar, itu TIDAK
// PERNAH mengganggu/membatalkan proses install yang sudah selesai di sisi
// App (sesuai catatan di server.js).
async function logToolUsage(feature, status, message) {
  try { await api('/api/tools/log-use', { method: 'POST', body: JSON.stringify({ feature, status, message: message || null }) }); }
  catch (e) { /* best-effort, diam-diam */ }
}

let _activeToolsConfigPromise = null; // promise load PERTAMA config Active Tools — dipakai gate supaya tidak race (lihat ensureActiveToolsActiveOrPrompt())

async function fetchActiveToolsConfig() {
  try { return await api('/api/active-tools'); } catch (e) { return null; }
}
async function loadActiveToolsConfig() {
  _activeToolsConfigPromise = (async () => {
    const cfg = await fetchActiveToolsConfig();
    if (cfg) applyActiveToolsConfig(cfg);
    return cfg;
  })();
  return _activeToolsConfigPromise;
}
function applyActiveToolsConfig(cfg) {
  _activeToolsConfig = cfg;
  renderActiveToolsCard();
  refreshActiveToolsStatus();
}

function wireActiveTools() {
  document.getElementById('btnActiveTools')?.addEventListener('click', () => handleActiveToolsButtonClick());
  ensureAtProgressListener();
}

// Satu tombol, dua label/behavior tergantung STATUS TERKINI hasil verifikasi
// file/folder Steam (_activeToolsActive) — BUKAN "pernah install" historis:
//   - TIDAK AKTIF (belum pernah verifikasi berhasil ATAU sebelumnya aktif tapi
//     file/folder sekarang hilang/rusak) -> "Install", klik langsung jalan
//     tanpa popup konfirmasi (tidak ada instalasi valid yang bisa "hilang").
//   - AKTIF (file/folder TERBUKTI lengkap & valid saat ini) -> "Install
//     Ulang", klik WAJIB lewat popup konfirmasi dulu (ada instalasi valid
//     yang akan di-overwrite).
function handleActiveToolsButtonClick() {
  if (_activeToolsBusy) return;
  if (_activeToolsActive) {
    showAtReinstallConfirm();
  } else {
    runActiveToolsFlowAndHandleResult();
  }
}

function showAtReinstallConfirm() {
  document.getElementById('atReinstallConfirmOverlay')?.classList.add('show');
}
function hideAtReinstallConfirm() {
  document.getElementById('atReinstallConfirmOverlay')?.classList.remove('show');
}
function cancelAtReinstallConfirm() {
  // Batal = tutup popup, tidak melakukan apa-apa (requirement #12) — TIDAK
  // ada side-effect lain sama sekali.
  hideAtReinstallConfirm();
}
async function confirmAtReinstallConfirm() {
  hideAtReinstallConfirm();
  await runActiveToolsFlowAndHandleResult();
}

function setActiveToolsButtonsDisabled(disabled) {
  document.getElementById('btnActiveTools')?.toggleAttribute('disabled', disabled);
}

// Validasi status TERKINI (bukan status yang di-cache begitu saja) — file
// hasil extract ZIP terakhir (metode Link) atau flag lokal + keberadaan
// folder Steam (metode PowerShell — command-nya bebas ditulis admin apa saja
// jadi tidak ada daftar file tetap yang bisa divalidasi ulang isinya, ini
// keterbatasan BAWAAN sistem existing, bukan sesuatu yang baru dibuat di
// sini; keberadaan folder Steam-nya sendiri TETAP wajib dicek — lihat FIX
// di bawah).
async function refreshActiveToolsStatus() {
  // Info tambahan (bukan penentu status/UI apa pun lagi — lihat catatan
  // lengkap di deklarasi _activeToolsEverInstalled di atas).
  _activeToolsEverInstalled = getActiveToolsEverInstalled();

  if (!_activeToolsConfig?.enabled) { _activeToolsActive = false; renderActiveToolsCard(); return; }

  if (_activeToolsConfig.activationMethod === 'powershell') {
    // ROOT CAUSE FIX (Test 8 — "Steam folder berubah/tidak ditemukan ->
    // TIDAK AKTIF" berlaku untuk SEMUA metode, bukan cuma Link): SEBELUMNYA
    // cabang ini cuma baca flag localStorage tanpa pernah cek folder Steam
    // sama sekali — kalau Steam di-uninstall/folder-nya pindah/hilang
    // SETELAH command PowerShell pernah sukses jalan, status tetap "Active"
    // selamanya. Reuse getSteamPath() yang SAMA dipakai metode Link (bukan
    // deteksi baru) sebagai syarat MINIMAL sebelum flag lokal dipercaya —
    // daftar file/isi command sendiri tetap tidak bisa diverifikasi ulang
    // (keterbatasan bawaan metode PowerShell yang arbitrary, di luar scope
    // "jangan bikin sistem verifikasi baru").
    if (!window.electronAPI?.getSteamPath) { _activeToolsActive = false; renderActiveToolsCard(); return; }
    try {
      const steamPath = await window.electronAPI.getSteamPath();
      _activeToolsActive = !!steamPath && localStorage.getItem('activeToolsPsActivated') === '1';
    } catch (e) {
      _activeToolsActive = false;
    }
    renderActiveToolsCard();
    return;
  }

  if (!window.electronAPI?.getSteamPath || !window.electronAPI?.activeToolsCheckStatus) return;
  const files = getActiveToolsFiles();
  if (!files.length) { _activeToolsActive = false; renderActiveToolsCard(); return; }
  try {
    const steamPath = await window.electronAPI.getSteamPath();
    if (!steamPath) { _activeToolsActive = false; renderActiveToolsCard(); return; }
    const status = await window.electronAPI.activeToolsCheckStatus({ steamPath, extractedFiles: files });
    _activeToolsActive = !!status?.active;
  } catch (e) {
    _activeToolsActive = false;
  }
  renderActiveToolsCard();
}

function renderActiveToolsCard() {
  const card = document.getElementById('activeToolsCard');
  const emptyState = document.getElementById('settingsEmptyState');
  if (!card) return;

  if (!_activeToolsConfig?.enabled) {
    card.style.display = 'none';
    if (emptyState) emptyState.classList.add('show');
    return;
  }
  card.style.display = '';
  if (emptyState) emptyState.classList.remove('show');

  const pill = document.getElementById('atStatusPill');
  const desc = document.getElementById('atCardDesc');
  const versionEl = document.getElementById('atCardVersion');
  const btn = document.getElementById('btnActiveTools');
  const isPowerShell = _activeToolsConfig.activationMethod === 'powershell';

  if (pill) {
    pill.textContent = _activeToolsBusy ? 'Mengaktifkan...' : (_activeToolsActive ? 'Active' : 'Not Active');
    pill.className = 'at-status-pill' + (_activeToolsBusy ? ' busy' : _activeToolsActive ? ' active' : '');
  }
  if (desc) desc.textContent = _activeToolsConfig.description || 'Jalankan Active Tools sebelum download/install game agar game dapat terdeteksi di Steam Library.';
  if (versionEl) {
    if (!isPowerShell && _activeToolsConfig.version) {
      versionEl.hidden = false;
      versionEl.textContent = `Versi Tools: ${_activeToolsConfig.version}`;
    } else {
      versionEl.hidden = true;
    }
  }
  if (btn) {
    // DUA TOMBOL (Install/Install Ulang) TIDAK PERNAH tampil bersamaan —
    // satu elemen tombol saja, label & behavior-nya yang berubah tergantung
    // STATUS TERKINI hasil verifikasi file/folder Steam (_activeToolsActive)
    // — BUKAN _activeToolsEverInstalled (ROOT CAUSE FIX: label sebelumnya
    // permanen "Install Ulang" setelah pernah sukses sekali, walau file/
    // folder-nya kemudian hilang/rusak atau statusnya jadi TIDAK AKTIF —
    // melanggar requirement "status final harus mengikuti hasil pengecekan
    // file/folder Steam", lihat catatan lengkap di deklarasi
    // _activeToolsEverInstalled di atas). Tombol TIDAK PERNAH disembunyikan
    // (requirement: "Install Ulang tetap tersedia walaupun Active Tools
    // sedang aktif") — beda dari versi lama yang menyembunyikan tombol total
    // saat aktif.
    btn.style.display = '';
    btn.disabled = _activeToolsBusy;
    btn.textContent = _activeToolsBusy ? 'Installing...' : (_activeToolsActive ? 'Install Ulang' : 'Install');
  }
}

/* ── PROGRESS PREMIUM — semua fungsi di bawah ini MURNI presentasi, diisi
   dari event/IPC nyata (onDownloadProgress utk metode Link, onActiveToolsPsProgress
   utk metode PowerShell). TIDAK ADA setInterval/setTimeout yang mensimulasikan
   angka progress di mana pun dalam blok ini. ── */
let _atProgressListenerSet = false;
let _atDownloadListenerActive = false; // true HANYA selagi download Active Tools (metode Link) sedang berjalan — supaya event 'download-progress' milik Game/Bypass tidak ikut ditangkap di sini, dan sebaliknya.
let _atSpeedLastTs = 0, _atSpeedLastBytes = 0;

function ensureAtProgressListener() {
  if (_atProgressListenerSet) return;
  _atProgressListenerSet = true;
  window.electronAPI?.onDownloadProgress?.((data) => {
    if (_atDownloadListenerActive) handleAtDownloadProgress(data);
  });
}

function resetAtProgressUI(showSteps) {
  const wrap = document.getElementById('atReqProgress');
  const percentEl = document.getElementById('atProgPercent');
  const metaEl = document.getElementById('atProgMeta');
  const steps = document.getElementById('atProgSteps');
  const barWrap = document.getElementById('atProgBarWrap');
  if (wrap) wrap.hidden = false;
  if (percentEl) { percentEl.hidden = true; percentEl.textContent = '0%'; }
  if (metaEl) { metaEl.hidden = true; metaEl.textContent = ''; }
  if (barWrap) barWrap.classList.remove('at-prog-bar--indeterminate');
  document.getElementById('atProgBarFill').style.width = '0%';
  if (steps) {
    steps.hidden = !showSteps;
    steps.querySelectorAll('.at-prog-step').forEach(el => el.classList.remove('active', 'done'));
  }
  _atSpeedLastTs = 0; _atSpeedLastBytes = 0;
}

function setAtStep(key, status) {
  const el = document.querySelector(`#atProgSteps .at-prog-step[data-step="${key}"]`);
  if (!el) return;
  el.classList.remove('active', 'done', 'failed');
  if (status === 'active' || status === 'done' || status === 'failed') el.classList.add(status);
}

// FIX (requirement #12 — error handling per tahap): tandai tahap yang sedang
// berjalan ('active') sebagai gagal ('failed', ikon ✕) begitu proses Active
// Tools error — supaya user tahu persis di tahap mana gagalnya, bukan cuma
// pesan generik. Tahap yang SUDAH ✓ sebelumnya tidak disentuh/tidak berubah
// jadi gagal. Aman dipanggil untuk metode PowerShell juga (tidak ada elemen
// step yang match -> tidak melakukan apa-apa).
function markCurrentAtStepFailed() {
  const activeEl = document.querySelector('#atProgSteps .at-prog-step.active');
  if (activeEl) { activeEl.classList.remove('active'); activeEl.classList.add('failed'); }
}

function setAtBarPercent(pct) {
  const barWrap = document.getElementById('atProgBarWrap');
  const fill = document.getElementById('atProgBarFill');
  const percentEl = document.getElementById('atProgPercent');
  if (barWrap) barWrap.classList.remove('at-prog-bar--indeterminate');
  if (fill) fill.style.width = Math.max(0, Math.min(100, pct)) + '%';
  if (percentEl) { percentEl.hidden = false; percentEl.textContent = Math.round(pct) + '%'; }
}

function setAtBarIndeterminate(on) {
  const barWrap = document.getElementById('atProgBarWrap');
  const percentEl = document.getElementById('atProgPercent');
  if (barWrap) barWrap.classList.toggle('at-prog-bar--indeterminate', !!on);
  if (on && percentEl) percentEl.hidden = true;
}

function setAtMeta(text) {
  const metaEl = document.getElementById('atProgMeta');
  if (!metaEl) return;
  if (text) { metaEl.hidden = false; metaEl.textContent = text; } else { metaEl.hidden = true; metaEl.textContent = ''; }
}

function setAtStatusText(text) {
  const el = document.getElementById('atProgStatus');
  if (el) el.textContent = text || '';
}

// FIX (popup Active Tools nampilin "i (exit code 0)." / raw log): filter baris
// teknis/internal (exit code, process exited, stdout/stderr mentah, dst) supaya
// TIDAK PERNAH dipakai sebagai status text user-facing. Baris log ASLI tidak
// dihapus/diubah di mana pun — cuma tidak dipakai untuk teks yang dilihat user
// di popup ini. Pola di bawah sengaja spesifik ke penanda teknis, bukan
// memfilter output PowerShell secara umum (supaya progress asli dari script
// tetap bisa tampil apa adanya kalau memang bukan noise teknis).
const AT_RAW_TECHNICAL_LOG_PATTERNS = [
  /exit code/i,
  /^process (exited|closed|finished)/i,
  /^(stdout|stderr)\b\s*:?/i,
  /^command finished/i,
  /^\s*at\s+.*\((.*):\d+:\d+\)\s*$/, // stack trace frame
];
function isRawTechnicalLogLine(line) {
  const s = String(line || '').trim();
  if (!s) return true;
  return AT_RAW_TECHNICAL_LOG_PATTERNS.some(re => re.test(s));
}

function showAtAbortButton(show) {
  const abortBtn = document.getElementById('atReqAbortBtn');
  const activateBtn = document.getElementById('atReqActivateBtn');
  if (abortBtn) abortBtn.hidden = !show;
  if (activateBtn) activateBtn.style.display = show ? 'none' : '';
}

// Handler 'download-progress' KHUSUS Active Tools (metode Link) — byte
// asli dari main.js (downloadFileWithProgress), sama sumbernya dgn progress
// bar Game/Bypass, cuma dipisah lewat flag _atDownloadListenerActive supaya
// tidak saling menimpa. Speed dihitung dari selisih waktu/byte NYATA antar
// event (bukan angka buatan) — kalau server tidak kasih content-length,
// tampil indeterminate + jumlah byte terunduh saja, TANPA persentase palsu.
function handleAtDownloadProgress({ downloaded, total }) {
  const now = Date.now();
  let speedText = '';
  if (_atSpeedLastTs) {
    const dt = (now - _atSpeedLastTs) / 1000;
    const db = downloaded - _atSpeedLastBytes;
    if (dt >= 0.4 && db >= 0) {
      const speed = fmtSpeedAU(db / dt);
      if (speed) speedText = ' • ' + speed;
      _atSpeedLastTs = now; _atSpeedLastBytes = downloaded;
    }
  } else {
    _atSpeedLastTs = now; _atSpeedLastBytes = downloaded;
  }

  if (total > 0) {
    const pct = Math.min(100, Math.round((downloaded / total) * 100));
    setAtBarPercent(pct);
    setAtMeta(`${fmtBytesAU(downloaded)} / ${fmtBytesAU(total)}${speedText}`);
    if (downloaded >= total) {
      // Download 100% selesai — proses main.js lanjut ke tutup Steam +
      // extract + copy file (TIDAK ada progress event granular utk tahap
      // ini di sistem lama), jadi tampilkan sbg indeterminate, BUKAN diam
      // di 100% seakan macet. cancel-download juga tidak relevan lagi
      // setelah file selesai ditulis ke disk.
      setAtStep('download', 'done');
      setAtStep('process', 'active');
      setAtBarIndeterminate(true);
      setAtMeta('');
      setAtStatusText('Menutup Steam & mengekstrak file...');
      showAtAbortButton(false);
    }
  } else {
    // total tidak diketahui (server tidak kirim content-length) — jangan
    // membuat persentase palsu, tampilkan indeterminate dari awal.
    setAtBarIndeterminate(true);
    setAtMeta(downloaded ? `${fmtBytesAU(downloaded)} terunduh` : '');
  }
}

async function abortActiveToolsDownload() {
  if (!window.electronAPI?.cancelDownload) return;
  showAtAbortButton(false);
  try { await window.electronAPI.cancelDownload(); } catch (e) { /* noop — hasil pembatalan tetap ditangani lewat resolve activeToolsInstall di bawah */ }
}

// Dipanggil kalau proses Active Tools dibatalkan user (lewat abortActiveToolsDownload()
// di atas) — TIDAK PERNAH menganggap berhasil, membersihkan pending Game
// Install (kalau ada) supaya tidak ada download game yang tiba-tiba jalan
// sendiri, dan TIDAK navigate ke Settings (tetap di halaman yang sedang
// dibuka user, modal cuma ditutup).
function handleActiveToolsCancelled() {
  const hadPendingGame = !!_pendingInstallAfterActiveTools;
  _pendingInstallAfterActiveTools = null;
  hideActiveToolsRequiredModal();
  showToast('cancel', 'Active Tools', hadPendingGame ? 'Instalasi game dibatalkan.' : 'Instalasi Active Tools dibatalkan.');
}

// Buka overlay modal kalau belum terbuka — dipanggil di awal run*Install()
// supaya popup SELALU tampil baik dipicu dari gate Game Install (overlay
// sudah terbuka lewat showActiveToolsRequiredModal()) MAUPUN dipicu langsung
// dari tombol Settings (overlay belum pernah dibuka sama sekali) — idempotent,
// tidak pernah membuka modal dobel.
function ensureActiveToolsModalOpen() {
  document.getElementById('activeToolsRequiredOverlay')?.classList.add('show');
}


// extract) atau 'powershell' (SISTEM BARU: jalankan command apa adanya).
// Dipanggil dari tombol kartu Settings MAUPUN dari modal "Active Tools
// Required" (activateToolsFromRequiredModal()) — satu fungsi, dua pemanggil.
async function runActiveToolsInstall() {
  if (_activeToolsBusy) return false;
  const cfg = _activeToolsConfig;
  if (!cfg?.enabled) { showToast('error', 'Active Tools belum diaktifkan admin.'); return false; }
  return cfg.activationMethod === 'powershell' ? runActiveToolsPowerShell() : runActiveToolsLinkInstall();
}

// ── Metode Link (SISTEM LAMA) — pakai installBarShow/SetStage/SetSuccess/
// SetError premium yang sudah ada di App Demo, BUKAN dlModal* App Lama, tapi
// alur/IPC call-nya (getSteamPath -> activeToolsInstall -> activeToolsCheckStatus)
// TIDAK diubah sama sekali. ──
async function runActiveToolsLinkInstall() {
  if (!window.electronAPI?.activeToolsInstall) { showToast('error', 'Fitur ini hanya tersedia di aplikasi desktop.'); return false; }
  const cfg = _activeToolsConfig;
  if (!cfg.zipUrl) { showToast('error', 'Admin belum mengatur link download Active Tools.'); return false; }

  _activeToolsBusy = true;
  setActiveToolsButtonsDisabled(true);
  renderActiveToolsCard();
  ensureActiveToolsModalOpen();
  renderActiveToolsRequiredModal('busy', 'Mendeteksi Steam...');
  resetAtProgressUI(true); // steps ditampilkan — metode Link punya 4 tahap nyata

  try {
    const steamPath = await window.electronAPI.getSteamPath();
    if (!steamPath) throw new Error('Steam tidak ditemukan di PC ini. Pastikan Steam sudah terinstall dan pernah dijalankan.');

    setAtStatusText('Mengunduh Active Tools...');
    setAtStep('download', 'active');
    setAtBarPercent(0);
    _atDownloadListenerActive = true;
    showAtAbortButton(true); // cancel-download nyata (IPC 'cancel-download') hanya relevan selagi file masih diunduh

    const result = await window.electronAPI.activeToolsInstall({ steamPath, zipUrl: cfg.zipUrl });
    _atDownloadListenerActive = false;
    showAtAbortButton(false);
    if (result?.cancelled) { handleActiveToolsCancelled(); return false; }
    if (!result?.success) throw new Error(result?.error || 'Gagal mengaktifkan Active Tools.');
    // Jaga-jaga: kalau karena suatu alasan event 100% di handleAtDownloadProgress()
    // tidak sempat kebaca (mis. server tidak kirim content-length sama sekali),
    // tetap pastikan step download/extract ditandai selesai di sini.
    setAtStep('download', 'done');
    setAtStep('process', 'done');
    setAtBarIndeterminate(false);

    setAtStep('verify', 'active');
    // Verifikasi tidak punya percentage granular di sistem lama (cuma satu
    // panggilan IPC yang langsung selesai/gagal) — pakai indeterminate,
    // BUKAN membiarkan angka % terakhir dari download nyangkut di layar
    // (requirement #6: lebih baik "Sedang memproses..." daripada % palsu).
    setAtBarIndeterminate(true);
    setAtMeta('');
    setAtStatusText('Memverifikasi instalasi...');
    saveActiveToolsFiles(result.extractedFiles);
    const statusRes = await window.electronAPI.activeToolsCheckStatus({ steamPath, extractedFiles: result.extractedFiles });
    _activeToolsActive = !!statusRes?.active;
    if (!_activeToolsActive) throw new Error('Active Tools belum berhasil diverifikasi. File sudah diextract tapi validasi tidak menemukan sebagian file.');
    setAtStep('verify', 'done');

    setAtStep('activate', 'active');
    setAtStatusText('Mengaktifkan Active Tools...');
    setAtBarIndeterminate(true); // aktivasi juga tidak punya percentage granular
    // Baru di sini tombol boleh "naik level" jadi Install Ulang (requirement
    // #3: berdasarkan status SEBENARNYA, bukan asumsi) — TIDAK dipanggil di
    // cabang error/throw di atas, dan TIDAK PERNAH di-reset ke false lagi
    // sesudahnya (requirement #11/#15).
    markActiveToolsEverInstalled();
    setAtStep('activate', 'done');
    setAtBarPercent(100);
    renderActiveToolsCard();
    if (typeof logToolUsage === 'function') logToolUsage('active_tools', 'success');
    return true;
  } catch (e) {
    _atDownloadListenerActive = false;
    showAtAbortButton(false);
    markCurrentAtStepFailed();
    renderActiveToolsRequiredModal('error', e.message || 'Terjadi kesalahan saat mengaktifkan Active Tools.');
    renderActiveToolsCard();
    if (typeof logToolUsage === 'function') logToolUsage('active_tools', 'failed', e.message);
    return false;
  } finally {
    _activeToolsBusy = false;
    setActiveToolsButtonsDisabled(false);
    renderActiveToolsCard();
  }
}

// ── Metode PowerShell (SISTEM BARU) — App cuma menjalankan command yang
// diisi admin apa adanya, TIDAK exit/kill/restart Steam (script diasumsikan
// sudah mengurus itu sendiri). Progress ditampilkan realtime dari output
// stdout/stderr yang di-stream main.js. Tidak ada tahapan granular (download/
// extract/dst) dari sistem lama utk metode ini, jadi step indicator
// disembunyikan total & bar SELALU indeterminate (bukan step/persentase
// palsu) — status text-nya adalah baris log asli terakhir dari PowerShell. ──
let _atPsListenerBound = false;
async function runActiveToolsPowerShell() {
  if (!window.electronAPI?.activeToolsRunPowerShell) { showToast('error', 'Fitur ini hanya tersedia di aplikasi desktop.'); return false; }
  const cfg = _activeToolsConfig;
  if (!cfg.powershellCommand) { showToast('error', 'Admin belum mengatur PowerShell Command untuk Active Tools.'); return false; }

  _activeToolsBusy = true;
  setActiveToolsButtonsDisabled(true);
  renderActiveToolsCard();
  ensureActiveToolsModalOpen();
  renderActiveToolsRequiredModal('busy', 'Menyiapkan PowerShell...');
  resetAtProgressUI(false); // tidak ada step granular utk metode ini
  setAtBarIndeterminate(true);
  showAtAbortButton(false); // metode PowerShell tidak punya mekanisme cancel di main.js

  if (!_atPsListenerBound && window.electronAPI.onActiveToolsPsProgress) {
    _atPsListenerBound = true;
    window.electronAPI.onActiveToolsPsProgress(({ line }) => {
      // FIX (popup nampilin "i (exit code 0)." dkk): baris log PowerShell
      // (stdout/stderr mentah + baris internal seperti exit code) TIDAK
      // boleh langsung tampil ke user apa adanya — cuma boleh jadi status
      // text kalau bukan baris teknis/internal. Baris teknis tetap ada di
      // `line` aslinya (dan tetap tersimpan lengkap di log file internal
      // lewat main.js), cuma tidak dipakai sebagai status text di sini.
      if (line && !isRawTechnicalLogLine(line)) setAtStatusText(line.slice(0, 140));
    });
  }

  try {
    const result = await window.electronAPI.activeToolsRunPowerShell({ command: cfg.powershellCommand });
    if (!result?.success) throw new Error(result?.error || 'PowerShell command gagal dijalankan.');

    _activeToolsActive = true;
    try { localStorage.setItem('activeToolsPsActivated', '1'); } catch (e) {}
    markActiveToolsEverInstalled();
    renderActiveToolsCard();
    if (typeof logToolUsage === 'function') logToolUsage('active_tools', 'success', 'method=powershell');
    return true;
  } catch (e) {
    markCurrentAtStepFailed(); // no-op utk metode ini (tidak ada step granular) — aman dipanggil
    renderActiveToolsRequiredModal('error', e.message || 'Terjadi kesalahan saat menjalankan PowerShell command.');
    renderActiveToolsCard();
    if (typeof logToolUsage === 'function') logToolUsage('active_tools', 'failed', `method=powershell; ${e.message || ''}`);
    return false;
  } finally {
    _activeToolsBusy = false;
    setActiveToolsButtonsDisabled(false);
    renderActiveToolsCard();
  }
}

/* ---------- Modal "Active Tools Required" — muncul dari gate handleInstall() ----------
   Menyimpan game/bypass yang tadi ingin di-download sebagai pending
   (_pendingInstallAfterActiveTools) supaya begitu Active Tools berhasil,
   download yang tertahan OTOMATIS dilanjutkan — user tidak perlu balik ke
   Settings atau klik Download lagi (requirement #3/#4). */
let _pendingInstallAfterActiveTools = null; // { itemType, itemId, itemName } | null

// Gate dipanggil di awal handleInstall() — return true kalau boleh lanjut
// download/install, false kalau harus diblokir (modal sudah ditampilkan).
// FIX (race condition login): SEBELUMNYA fungsi ini sinkron & langsung baca
// _activeToolsConfig — kalau user klik Install Game SANGAT cepat setelah App
// terbuka (sebelum GET /api/active-tools yang dipanggil fire-and-forget di
// enterApp() selesai), _activeToolsConfig masih null, dan
// `!_activeToolsConfig?.enabled` otomatis jadi `true` (dibaca sebagai "fitur
// dimatikan admin") — gate ke-BYPASS begitu saja padahal Active Tools bisa
// saja sebenarnya WAJIB. Sekarang async: kalau load PERTAMA belum selesai
// (_activeToolsConfig masih null), tunggu dulu (pakai promise yang sedang
// berjalan dari loadActiveToolsConfig() kalau ada, supaya tidak fetch dobel)
// sebelum mengevaluasi — keputusan gate SELALU berdasarkan config asli dari
// server begitu tersedia, bukan cuma karena belum sempat termuat. Perilaku
// steady-state (config sudah termuat, atau server permanen gagal dibalas)
// TIDAK berubah sama sekali.
async function ensureActiveToolsActiveOrPrompt(itemType, itemId, itemName) {
  if (_activeToolsConfig === null) {
    await (_activeToolsConfigPromise || loadActiveToolsConfig());
  }
  if (!_activeToolsConfig?.enabled) return true; // fitur dimatikan admin -> tidak ada yang perlu diblokir

  // ROOT CAUSE FIX: SEBELUMNYA gerbang ini langsung percaya `_activeToolsActive`
  // apa adanya — nilai itu bisa jadi hasil verifikasi LAMA (saat App startup
  // atau terakhir kali halaman Settings dibuka), padahal persyaratan wajib
  // "verifikasi dijalankan ... sebelum Game Download jika Active Tools memang
  // diperlukan" artinya di titik INI file/folder Steam harus dicek ULANG,
  // bukan mengandalkan cache sesi yang mungkin sudah basi (mis. user sempat
  // menghapus manual file Active Tools-nya di antara buka Settings terakhir &
  // klik Download sekarang). Reuse refreshActiveToolsStatus() yang sudah ada
  // (sama persis dipakai App startup & buka Settings) — TIDAK ada verification
  // system baru — supaya `_activeToolsActive` di bawah ini SELALU representasi
  // kondisi Steam TERKINI, bukan basi.
  await refreshActiveToolsStatus();
  if (_activeToolsActive) return true;

  _pendingInstallAfterActiveTools = (itemType && itemId) ? { itemType, itemId, itemName } : null;
  showActiveToolsRequiredModal();
  return false;
}

function showActiveToolsRequiredModal() {
  const overlay = document.getElementById('activeToolsRequiredOverlay');
  if (!overlay) return;
  renderActiveToolsRequiredModal('idle');
  overlay.classList.add('show');
}
function hideActiveToolsRequiredModal() {
  document.getElementById('activeToolsRequiredOverlay')?.classList.remove('show');
}

// Dibaca oleh tombol utama modal (onclick statis di index.html memanggil
// activateToolsFromRequiredModal()) supaya SATU tombol yang sama berperilaku
// beda tergantung state saat ini ('success' -> cuma tutup, state lain ->
// jalankan/ulangi aktivasi) — tanpa perlu mengubah-ubah listener onclick.
let _atModalCurrentState = 'idle';

// Satu fungsi render untuk 5 state modal — 'idle' (baru muncul, tawarkan
// aktivasi — dipakai baik oleh gate Game Install MAUPUN tombol Settings),
// 'busy' (progress berjalan, `detail` = stage text realtime awal sebelum
// progress premium/step mengambil alih via setAtStatusText()), 'success'
// (berhasil, TIDAK auto-close kalau dipicu dari Settings — lihat
// runActiveToolsFlowAndHandleResult()), dan 'error' (gagal, tombol balik ke
// "Coba Lagi").
function renderActiveToolsRequiredModal(state, detail) {
  const icon = document.getElementById('atReqIcon');
  const title = document.getElementById('atReqTitle');
  const desc = document.getElementById('atReqDesc');
  const progress = document.getElementById('atReqProgress');
  const cancelBtn = document.getElementById('atReqCancelBtn');
  const activateBtn = document.getElementById('atReqActivateBtn');
  if (!icon || !title || !desc || !activateBtn) return;

  _atModalCurrentState = state;
  const itemName = _pendingInstallAfterActiveTools?.itemName;
  icon.className = 'at-req-icon';
  progress.hidden = true;
  cancelBtn.hidden = false;
  cancelBtn.textContent = 'Batal';
  cancelBtn.disabled = false;
  activateBtn.style.display = '';
  activateBtn.disabled = false;
  document.getElementById('atReqAbortBtn').hidden = true;

  if (state === 'busy') {
    icon.classList.add('warn');
    title.textContent = 'Active Tools';
    desc.textContent = itemName ? `Mohon tunggu, "${itemName}" akan otomatis lanjut download setelah ini selesai.` : 'Mohon tunggu, jangan tutup aplikasi ini.';
    progress.hidden = false;
    setAtStatusText(detail || 'Menyiapkan instalasi...');
    cancelBtn.hidden = true;
    activateBtn.disabled = true;
    activateBtn.textContent = 'Memproses...';
  } else if (state === 'success') {
    icon.classList.add('success');
    title.textContent = 'Active Tools Berhasil';
    desc.textContent = 'Active Tools berhasil dipasang dan diaktifkan.';
    // FIX (checklist hilang saat success): SEBELUMNYA `progress.hidden = true`
    // di atas berlaku juga di state ini, jadi 4 checklist (Download/Ekstrak &
    // Pasang/Verifikasi/Aktivasi) yang baru saja selesai langsung hilang
    // begitu masuk ke layar sukses — padahal user harusnya masih bisa melihat
    // semua tahap sudah ✓ (lihat requirement "jangan menutup popup terlalu
    // cepat" / mockup hasil akhir). Sekarang panel progress TETAP ditampilkan
    // di state sukses; `atProgSteps` sendiri hanya terisi kalau memang sudah
    // diisi checklist nyata sebelumnya (metode Link) — untuk metode PowerShell
    // (tidak ada tahap granular) elemen ini tetap hidden karena showSteps di
    // resetAtProgressUI() sudah false dari awal, jadi tidak ada checklist palsu
    // yang dipaksakan tampil.
    progress.hidden = false;
    setAtBarIndeterminate(false);
    setAtBarPercent(100);
    setAtMeta('');
    setAtStatusText('Selesai');
    cancelBtn.hidden = true;
    activateBtn.textContent = 'Tutup';
  } else if (state === 'error') {
    icon.classList.add('error');
    title.textContent = 'Instalasi Gagal';
    desc.textContent = detail || 'Terdapat masalah saat memasang Active Tools.';
    // FIX (requirement #12 error handling): tetap tampilkan panel progress di
    // state gagal supaya user bisa lihat tahap mana yang sudah ✓ dan tahap
    // mana yang gagal (✕) — bukan cuma pesan generik tanpa konteks. Tahap yang
    // sedang 'active' saat error terjadi ditandai gagal oleh
    // markCurrentAtStepFailed() (dipanggil di catch block pemanggil), BUKAN
    // di sini, supaya fungsi render ini tetap murni presentasi.
    progress.hidden = false;
    setAtBarIndeterminate(false);
    cancelBtn.textContent = 'Tutup';
    activateBtn.textContent = 'Coba Lagi';
  } else {
    icon.classList.add('warn');
    title.textContent = 'Active Tools Belum Aktif';
    desc.textContent = itemName
      ? `Untuk menginstall "${itemName}", Active Tools harus diaktifkan terlebih dahulu.`
      : 'Untuk menginstall game, Active Tools harus diaktifkan terlebih dahulu.';
    // Label ikut sama dgn tombol Settings (Install/Install Ulang), sumber
    // kebenarannya SAMA PERSIS (_activeToolsActive — status verifikasi
    // file/folder Steam TERKINI, lihat catatan di renderActiveToolsCard()).
    activateBtn.textContent = _activeToolsActive ? 'Install Ulang' : 'Install';
  }
}

// Orkestrator TUNGGAL — satu-satunya tempat yang menjalankan aktivasi Active
// Tools + menentukan apa yang terjadi setelah berhasil. Dipanggil dari 2 titik
// masuk: (1) tombol di dalam modal ini sendiri (activateToolsFromRequiredModal(),
// baik dari gate Game Install ATAU retry dari state error), dan (2) tombol
// Install/Install Ulang di halaman Settings. Perilaku SETELAH berhasil beda
// tergantung konteks (auto-resume Game Install yang tertahan vs tampilkan
// state sukses & tunggu user klik Tutup) — TAPI proses aktivasi & popup-nya
// SAMA PERSIS di kedua jalur (satu popup, tidak pernah duplikat).
async function runActiveToolsFlowAndHandleResult() {
  ensureActiveToolsModalOpen();
  const ok = await runActiveToolsInstall(); // 'busy'/'error' sudah dirender di dalamnya
  if (!ok) return;

  const pending = _pendingInstallAfterActiveTools;
  if (pending) {
    // Konteks: gate dari Game Install -> auto-resume, TANPA user harus klik
    // Install Game lagi ataupun diarahkan ke Settings.
    renderActiveToolsRequiredModal('busy', 'Active Tools berhasil diaktifkan!');
    _pendingInstallAfterActiveTools = null;
    setTimeout(() => {
      hideActiveToolsRequiredModal();
      setTimeout(() => handleInstall(pending.itemType, pending.itemId, pending.itemName), 180);
    }, 900);
  } else {
    // Konteks: tombol Install/Install Ulang di Settings -> tampilkan state
    // sukses, tunggu user klik "Tutup" (bukan auto-close).
    renderActiveToolsRequiredModal('success');
  }
}

async function activateToolsFromRequiredModal() {
  if (_atModalCurrentState === 'success') { hideActiveToolsRequiredModal(); return; }
  await runActiveToolsFlowAndHandleResult();
}

function cancelActiveToolsRequired() {
  // User menolak mengaktifkan sekarang (ATAU menutup state sukses/error) —
  // batalkan rencana resume supaya aktivasi Active Tools lain (misal dari
  // Settings, tidak berhubungan dengan download ini) tidak tiba-tiba
  // "menyambar" ke download yang sudah dibatalkan user (requirement: jangan
  // lanjutkan download, jangan buat history palsu, jangan navigate ke
  // Settings — tetap di halaman yang sedang dibuka).
  _pendingInstallAfterActiveTools = null;
  hideActiveToolsRequiredModal();
}

/* ══════════════════════════════════════════════════════════════════════════
   TOP INSTALLER MINGGUAN — dipindah dari app/app.js APP LAMA. Dihitung 100%
   di server (computeWeeklyLeaderboard() di server.js, dari koleksi `history`
   asli — TIDAK ada perhitungan/endpoint baru di sini) lewat GET /api/leaderboard,
   lalu diperbarui realtime lewat event WebSocket 'leaderboard:update' yang
   sudah di-broadcast server SETIAP kali install (game/bypass) baru berhasil
   tersimpan ke histori (lihat POST /api/history -> computeWeeklyLeaderboard()
   -> wsBroadcastAll('leaderboard:update', ...) di server.js, tidak diubah).
   Desain widget "Top Installer" di Dashboard (.dash-top-installer / .dash-ti-*
   di index.html) TIDAK diubah — hanya isi .dash-ti-list yang di-generate dari
   data asli ini menggantikan 5 baris hardcode bawaan APP DEMO.
   ══════════════════════════════════════════════════════════════════════════ */
async function loadLeaderboard() {
  try {
    const data = await api('/api/leaderboard');
    renderTopInstaller(data);
  } catch (e) {
    // Best-effort — biarkan widget apa adanya (atau kosong) kalau gagal fetch,
    // jangan sampai error di sini mengganggu bagian Dashboard lain.
    renderTopInstaller({ entries: [] });
  }
}

const DASH_TI_AVATAR_FALLBACK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 4-6 8-6s8 2 8 6"/></svg>';

// Kapasitas tetap widget Top Installer — SELALU render 5 slot baris, apa pun
// jumlah data asli (1, 2, 3, 4, atau 5 user). Slot yang tidak terisi data
// diisi baris "placeholder" (struktur/dash-ti-row yang sama persis, cuma
// disembunyikan via visibility:hidden lewat class .dash-ti-row--placeholder
// di styles.css) supaya tinggi .dash-ti-list — dan otomatis tinggi
// .dash-top-installer serta .dash-banner di sebelahnya (align-items:stretch)
// — selalu presis sama dengan kondisi 5 user terisi penuh. Ini menghindari
// hitung-hitungan px manual yang gampang meleset/berubah kalau font atau
// spacing di CSS berubah nanti.
const DASH_TI_SLOTS = 5;

function dashTiPlaceholderRow() {
  return `
      <div class="dash-ti-row dash-ti-row--placeholder" aria-hidden="true">
        <span class="dash-ti-rank">–</span>
        <span class="dash-ti-avatar">${DASH_TI_AVATAR_FALLBACK_SVG}</span>
        <span class="dash-ti-info">
          <span class="dash-ti-name">—</span>
          <span class="dash-ti-count">—</span>
        </span>
      </div>`;
}

function renderTopInstaller(data) {
  const list = document.querySelector('.dash-ti-list');
  if (!list) return;
  // Maksimal 5 — dipotong di sini juga sebagai jaring pengaman, sama seperti
  // renderLeaderboard() APP LAMA (server-nya sendiri sudah limit 5).
  const entries = ((data && Array.isArray(data.entries)) ? data.entries : []).slice(0, 5);

  let rowsHtml;

  if (entries.length === 0) {
    // Tidak ada instalasi minggu ini — tetap pakai struktur dash-ti-row yang
    // sama (bukan markup baru) supaya layout/desain tidak berubah.
    rowsHtml = `
      <div class="dash-ti-row">
        <span class="dash-ti-rank">–</span>
        <span class="dash-ti-avatar">${DASH_TI_AVATAR_FALLBACK_SVG}</span>
        <span class="dash-ti-info">
          <span class="dash-ti-name">Belum ada install</span>
          <span class="dash-ti-count">minggu ini</span>
        </span>
      </div>`;
  } else {
    rowsHtml = entries.map((u, i) => {
      const rank = i + 1;
      const rankClass = rank <= 3 ? ` dash-ti-row--${rank}` : '';
      // Sama seperti pola fallback avatar/cover di Histori (hcard-cover-fallback):
      // <img> dicoba dulu, kalau gagal load (onerror) disembunyikan dan sibling
      // fallback SVG-nya yang ditampilkan — jangan embed SVG mentah langsung di
      // dalam atribut onerror (bisa bentrok dengan tanda kutip di dalam SVG-nya).
      const avatarInner = u.avatarUrl
        ? `<img src="${escapeHtml(u.avatarUrl)}" alt="" loading="lazy" style="width:100%;height:100%;border-radius:50%;object-fit:cover;display:block;" onerror="this.style.display='none';this.nextElementSibling.style.display='flex';">
           <span style="display:none;width:100%;height:100%;align-items:center;justify-content:center;">${DASH_TI_AVATAR_FALLBACK_SVG}</span>`
        : DASH_TI_AVATAR_FALLBACK_SVG;
      return `
      <div class="dash-ti-row${rankClass}">
        <span class="dash-ti-rank">${String(rank).padStart(2, '0')}</span>
        <span class="dash-ti-avatar">${avatarInner}</span>
        <span class="dash-ti-info">
          <span class="dash-ti-name" title="${escapeHtml(u.username || 'Unknown')}">${escapeHtml(u.username || 'Unknown')}</span>
          <span class="dash-ti-count">${u.installs || 0} Install</span>
        </span>
      </div>`;
    }).join('');
  }

  // Isi sisa slot (kalau kurang dari 5 baris nyata/pesan kosong) dengan
  // placeholder tak-terlihat supaya tinggi list tetap = tinggi 5 baris.
  const filledSlots = entries.length === 0 ? 1 : entries.length;
  const placeholderCount = Math.max(0, DASH_TI_SLOTS - filledSlots);
  rowsHtml += Array.from({ length: placeholderCount }, dashTiPlaceholderRow).join('');

  list.innerHTML = rowsHtml;
}
/* ═══════════════════════ AKHIR TOP INSTALLER MINGGUAN ═══════════════════════ */

// Role/paket user berubah realtime (upgrade/downgrade dari Admin Web) —
// update currentUser, badge titlebar, DAN tombol Install yang lagi tampil
// (baik di grid maupun halaman detail yang lagi terbuka) tanpa reload app.
function handleAccountUpdate(freshUser) {
  if (!freshUser || !currentUser) return;
  // Ambil tier SEBELUM currentUser ditimpa, supaya bisa dibandingkan dengan
  // tier SESUDAHNYA di bawah — ini yang dipakai buat tau paket user
  // naik/turun & munculin notifnya (lihat showPackageChangeToast()).
  const oldTier = packageTierOf(currentUser);
  currentUser = { ...currentUser, ...freshUser };
  _saveUser(currentUser);
  renderProfileIdentity(currentUser);
  applyUserPackageBadge(currentUser);
  // Widget Limit Download Harian — ikut di-refresh REALTIME di sini juga.
  // Ini titik yang kepanggil PERSIS setelah user berhasil download (server
  // ngirim event WS 'account:update' begitu consumeDownloadQuota() jalan di
  // server.js), jadi angka terpakai/sisa/progress bar widget ini otomatis
  // update tanpa refresh app — sesuai requirement realtime, TANPA nambah
  // koneksi/listener baru.
  renderDownloadLimitWidget(currentUser);
  // Re-evaluasi akses di grid & (kalau lagi kebuka) halaman detail —
  // applyGamesUpdate()/applyBypassesUpdate() sendiri yang cek currentDetail.
  applyGamesUpdate(allGames);
  applyBypassesUpdate(allBypasses);
  // Paket user berubah (upgrade/downgrade dari Admin Web, termasuk yang
  // ketangkep pas resync setelah reconnect) — kasih tau user LANGSUNG lewat
  // toast yang sudah ada di app ini (bahasa awam, BUKAN "role updated"),
  // tampilkan nama paket lama -> paket baru dengan jelas. Badge titlebar &
  // akses game/bypass SUDAH ikut berubah realtime lewat pemanggilan di atas;
  // toast ini murni pemberitahuannya saja, tidak fetch/refresh apa pun lagi.
  const newTier = packageTierOf(currentUser);
  if (oldTier !== newTier) {
    if (typeof showPackageChangeToast === 'function') showPackageChangeToast(oldTier, newTier);
    // Role BENERAN berubah (termasuk masuk/keluar Admin) — Gold Trial harus
    // ikut disinkron ulang SEKARANG, bukan nunggu reconnect berikutnya,
    // supaya kartu/modal Gold Trial yang mungkin sedang tampil langsung
    // hilang begitu user dijadikan Admin (dan sebaliknya, bisa muncul lagi
    // kalau memang eligible begitu Admin dikembalikan jadi user biasa).
    if (typeof loadGoldTrialOffer === 'function') loadGoldTrialOffer();
  }
  // Halaman Beli Paket — status "Paket Saat Ini" & tombol tiap kartu
  // (PAKET AKTIF/PERPANJANG/BELI) harus ikut berubah REALTIME begitu role
  // berubah (upgrade/downgrade dari Admin Web ATAU pembayaran baru saja
  // sukses), tanpa fetch ulang /api/packages — cukup render ulang pakai data
  // paket (harga/durasi/benefit) yang sudah di-cache di _pkgLastData.
  if (_pkgLastData && typeof renderPkgStatusWidget === 'function') {
    renderPkgStatusWidget();
    renderPkgCards(_pkgLastData);
    renderPkgCompare(_pkgLastData);
  }
  // Role BENERAN berubah (masuk/keluar Admin) — panel ADMIN ACCOUNT vs
  // 3 kartu paket/Bandingkan Paket harus ikut switch REALTIME juga, tanpa
  // perlu pindah halaman/reload. Aman dipanggil walau Beli Paket belum
  // pernah dibuka (_pkgLastData null) karena applyPkgAdminState() sendiri
  // sudah null-check elemen-elemennya.
  if (typeof applyPkgAdminState === 'function') applyPkgAdminState();
}
/* ══════════════════════════════════════════════════════════════════════════
   AKHIR BLOK REALTIME
   ══════════════════════════════════════════════════════════════════════════ */

/* ══════════════════════════════════════════════════════════════════════════
   PHASE 5 — GAMES (DATA ASLI, menggantikan kartu dummy #page-mygames)
   ---------------------------------------------------------------------
   Semua logic bisnis (fetch API, akses/role, fetch Steam Store API,
   handleInstall) dipindah UTUH dari app/app.js APP LAMA. Yang diadaptasi
   HANYA bagian render (target elemen DOM APP DEMO beda struktur/id dari
   APP LAMA) — lihat renderGameCard()/buildGameDetailModel() di bawah.

   CATATAN JUJUR (belum sempat dites jalan di app Electron asli — cuma lolos
   node --check untuk sintaks): mohon dites end-to-end sebelum dipakai user
   asli, terutama alur handleInstall (inject ke Steam) karena menyentuh
   file system PC user.

   Bypass (findLinkedBypass, tombol "Install Bypass" kedua di halaman detail,
   allBypasses) BELUM disambungkan — masih Phase 6, menyusul. `bypassAvailable`
   di bawah sengaja selalu `false` untuk sekarang supaya tombol itu tetap
   tampil disabled (bukan error) sampai Phase 6 selesai.
   ══════════════════════════════════════════════════════════════════════════ */
let allGames = [];
let _detailFetchToken = 0; // biar response steam-details yang telat/kebalap gak nimpa detail yang lagi dibuka

async function loadGames() {
  try {
    const games = await api('/api/games');
    applyGamesUpdate(games);
  } catch (e) {
    console.warn('[Games] Gagal memuat daftar game:', e.message);
    if (typeof showToast === 'function') showToast('error', 'Gagal memuat daftar game dari server.');
  }
}

function applyGamesUpdate(games) {
  allGames = Array.isArray(games) ? games : [];
  renderGamesGrid();
  if (typeof populateDashboardNewGames === 'function') populateDashboardNewGames();
  // Kalau halaman detail Game lagi kebuka & item-nya ada di list baru ini
  // (mis. abis realtime update role), refresh status akses tombolnya —
  // TODO Phase 9: dipanggil juga dari handleAccountUpdate() nanti.
  if (currentDetail?.type === 'game' && currentDetailData?._isReal) {
    const fresh = allGames.find(g => String(g._id) === String(currentDetailData._id));
    if (fresh) {
      currentDetailData = buildGameDetailModel(fresh, _lastSteamDetailsForCurrent || null);
      if (typeof renderDetailActions === 'function') renderDetailActions(currentDetailData);
    }
  }
}

// Badge & filter card SEKARANG cuma pakai 1 tier: PACKAGE REQUIREMENT ASLI
// item itu sendiri (item.role dari database — field yang sama dipakai
// hasAccess()/mktOrRoleLocked() di atas buat cek akses install, jadi ini
// BUKAN sumber data baru). Sebelumnya fungsi ini (gameRoleTiers) balikin
// SEMUA tier dari role ke atas (mis. game Public -> "Public Gold Platinum"),
// makanya badge-row nampilin 3 badge sekaligus di satu card — membingungkan
// karena tidak langsung kelihatan game itu butuh paket apa. Sekarang balikin
// SATU tier saja (butuh paket apa), badge-row otomatis cuma 1 <span>.
// data-difficulty juga ikut jadi 1 nilai — filter tab Public/Gold/Platinum
// di toolbar jadi berarti "tampilkan game yang PACKAGE REQUIREMENT-nya ini",
// bukan lagi "tampilkan game yang bisa diakses tier ini" (yang sebelumnya
// bikin tab Platinum menampilkan HAMPIR SEMUA game, termasuk yang Public).
// Visibility game TETAP tidak dibatasi paket user — badge/filter ini murni
// soal PACKAGE REQUIREMENT yang ditampilkan, bukan soal boleh/tidaknya
// install (itu tugas hasAccess()/mktOrRoleLocked(), tidak disentuh di sini).
function gameRoleTiers(role) {
  const valid = ['public', 'gold', 'platinum'];
  const r = valid.includes(role) ? role : 'public';
  const displayMap = { public: 'Gratis', gold: 'Gold', platinum: 'Platinum' };
  return [displayMap[r]];
}

// ── Shared markup for the "seamless artwork" game/bypass item ──
// Dipakai oleh renderGameCard() dan renderBypassCard() (dua tipe data yang
// bentuknya identik untuk keperluan grid ini). Struktur BARU (artwork-first,
// tanpa card container — lihat block ".card"/".thumb" di styles.css), tapi
// class/attribute yang dibaca oleh JS lain TETAP SAMA PERSIS:
//   .card, [data-id], [data-real], [data-title], [data-difficulty], [data-tier]
//     -> initCardClickToDetail(), applyFilters() di initGameListPage()
//   .bookmark-btn (+ onclick toggleBookmark)
//   .status-badge[data-status] -> renderStatusBadges()/paintStatusBadge(), dan
//     applyFilters() (card.querySelector('.status-badge'))
//   .pkg-badge[data-tier] -> renderPackageBadges()
// Cuma DI MANA elemen-elemen itu diletakkan yang berubah (overlay di atas
// artwork, bukan panel/card-body terpisah).
function renderMediaGridCard(item) {
  const role = ['public', 'gold', 'platinum'].includes(item.role) ? item.role : 'public';
  const tiers = gameRoleTiers(role); // dipakai HANYA untuk data-difficulty (filter) — TETAP berdasarkan PACKAGE REQUIREMENT asli (role), TIDAK ikut berubah oleh Marketplace (lihat catatan badgeTier di bawah), jadi filter All/Gratis/Gold/Platinum tetap lengkap & akurat apapun source item-nya.
  // Badge yang tampil di artwork (.pkg-badge) BEDA dari data-difficulty di atas:
  // badge menunjukkan SOURCE/ACCESS TYPE (dari mana akses item ini didapat),
  // bukan package requirement. Item konten Marketplace Product (marketplaceProductIds
  // terisi — data BACKEND asli via marketplaceManager, field yang SAMA PERSIS
  // dipakai isMktGated()/hasAccess()/mktOrRoleLocked(), BUKAN dihardcode dari
  // nama game/bypass) tampil badge 'marketplace', MENGGANTIKAN badge Gratis/
  // Gold/Platinum walau package requirement aslinya (role) tetap public/gold/
  // platinum apa adanya di data-difficulty/filter. Item BUKAN Marketplace tetap
  // badge Gratis/Gold/Platinum sesuai role seperti sebelumnya, tidak berubah.
  const badgeTier = isMktGated(item) ? 'marketplace' : role;
  const isOnline = item.isOnline !== false;
  const img = item.imageUrl || '';
  const name = item.name || '';
  // Category footline HANYA muncul kalau datanya memang sudah ada di item
  // (genres/categories dari backend — field yang sama dipakai buildGameDetailModel()
  // untuk halaman detail). Tidak pernah membuat data baru/dummy kalau item
  // tidak punya field ini (lihat catatan doc redesign section 9/21).
  const categorySource = Array.isArray(item.genres) && item.genres.length
    ? item.genres
    : (Array.isArray(item.categories) && item.categories.length ? item.categories : null);
  const category = categorySource ? categorySource[0] : '';
  // Footline (di bawah artwork) sekarang HANYA category — kalau item tidak
  // punya category, baris ini tidak usah dirender sama sekali (tidak ada
  // lagi status di sini yang perlu tempat, lihat card-meta di atas).
  const footlineHtml = category
    ? `<div class="card-footline"><span class="card-category">${escapeHtml(String(category))}</span></div>`
    : '';
  return `
    <div class="card" data-id="${escapeHtml(String(item._id))}" data-real="1" data-title="${escapeHtml(name)}" data-difficulty="${tiers.join(' ')}" data-tier="${role}">
      <div class="thumb">
        <img src="${escapeHtml(img)}" alt="${escapeHtml(name)}" loading="lazy">
        <button class="bookmark-btn" onclick="toggleBookmark(this)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M6 3h12v18l-6-4-6 4V3z"/></svg>
        </button>
        <div class="card-info">
          <span class="card-title">${escapeHtml(name)}</span>
          <div class="card-meta">
            <span class="pkg-badge" data-tier="${badgeTier}"></span>
            <span class="meta-sep" aria-hidden="true"></span>
            <span class="status-badge" data-status="${isOnline ? 'online' : 'offline'}"></span>
          </div>
        </div>
      </div>
      ${footlineHtml}
      <span class="card-accent" aria-hidden="true"></span>
    </div>`;
}

function renderGameCard(item) {
  return renderMediaGridCard(item);
}

function renderGamesGrid() {
  const page = document.getElementById('page-mygames');
  if (!page) return;
  const grid = page.querySelector('.grid');
  if (!grid) return;
  grid.innerHTML = allGames.map(item => renderGameCard(item)).join('');
  if (typeof renderPackageBadges === 'function') renderPackageBadges();
  if (typeof renderStatusBadges === 'function') renderStatusBadges();
  // initGameListPage() menyimpan applyFilters-nya di page._applyFilters —
  // dipanggil ulang di sini supaya search/filter/tab yang lagi aktif tetap
  // konsisten begitu grid-nya diganti isinya (fetch ulang / realtime update).
  if (typeof page._applyFilters === 'function') page._applyFilters();
}

// ── Ubah data ASLI dari server + Steam Store API jadi bentuk `d` yang
// dipahami renderDetailPage()/renderDetailActions() (fungsi UI-nya APP DEMO,
// TIDAK diubah strukturnya — cuma sumber datanya sekarang nyata) ──
function mapReqList(list) {
  const find = (re) => {
    const m = (list || []).find(r => re.test(r.label || ''));
    return m && m.value ? m.value : '—';
  };
  return {
    os: find(/^os$|operating system/i),
    cpu: find(/processor|cpu/i),
    ram: find(/memory|ram/i),
    gpu: find(/graphics|video/i),
    storage: find(/storage|disk/i),
  };
}

function buildGameDetailModel(item, steamData) {
  const locked = mktOrRoleLocked(item);
  const gated = isMktGated(item);
  const tagsSource = steamData
    ? [...(steamData.categories || []), ...(steamData.genres || [])]
    : (Array.isArray(item.genres) && item.genres.length ? item.genres : (item.categories || []));
  return {
    kind: 'game',
    _isReal: true,
    _id: item._id,
    role: item.role || 'public',
    locked, gated,
    marketplaceProductIds: Array.isArray(item.marketplaceProductIds) ? item.marketplaceProductIds : [],
    title: item.name || '—',
    image: steamData?.headerImage || item.imageUrl || '',
    appId: item.appId || null,
    developer: steamData ? (steamData.developers?.length ? steamData.developers.join(', ') : 'Tidak diketahui') : '—',
    publisher: steamData ? (steamData.publishers?.length ? steamData.publishers.join(', ') : 'Tidak diketahui') : '—',
    description: steamData?.shortDescription || item.description || 'Memuat deskripsi dari Steam...',
    releaseDate: steamData ? (steamData.releaseDate || (steamData.comingSoon ? 'Coming Soon' : 'Tidak diketahui')) : '—',
    metacritic: steamData ? steamData.metacritic : null,
    isOnline: item.isOnline !== false,
    tags: tagsSource.slice(0, 8),
    reqProfile: steamData ? {
      minimum: mapReqList(steamData.requirementsMin),
      recommended: mapReqList(steamData.requirementsRec),
    } : {
      minimum: { os: '—', cpu: '—', ram: '—', gpu: '—', storage: '—' },
      recommended: { os: '—', cpu: '—', ram: '—', gpu: '—', storage: '—' },
    },
    // Phase 6 (Bypass) — SELESAI. bypassAvailable/linkedBypass* sekarang
    // dihitung dari data ASLI (findLinkedBypass, lihat blok "PHASE 6 —
    // BYPASS"), bukan hardcode false lagi.
    bypassAvailable: !!findLinkedBypass(item),
    linkedBypassId: findLinkedBypass(item)?._id || null,
    linkedBypassName: findLinkedBypass(item)?.name || null,
  };
}

let _lastSteamDetailsForCurrent = null;

function openRealGameDetailById(id) {
  const item = allGames.find(g => String(g._id) === String(id));
  if (!item) { if (typeof showToast === 'function') showToast('error', 'Game tidak ditemukan.'); return; }

  currentDetail = { type: 'game', title: item.name, image: item.imageUrl };
  _lastSteamDetailsForCurrent = null;
  const myToken = ++_detailFetchToken;

  document.getElementById('detailBackLabel').textContent = 'Back to Games';
  document.querySelectorAll('.nav-item[data-page]').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.pm-item[data-page]').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.page').forEach(sec => sec.classList.toggle('active', sec.id === 'page-detail'));
  const bodyEl = document.getElementById('detailBody');
  if (bodyEl) bodyEl.scrollTop = 0;
  showDetailSkeleton();

  // Isi cepat dulu pakai data yang sudah ada (tanpa nunggu network) — sama
  // seperti perilaku APP LAMA (openDetailPage), supaya halaman detail tidak
  // nge-blank nunggu Steam API sebelum nampilin apa-apa.
  currentDetailData = buildGameDetailModel(item, null);
  renderDetailPage(currentDetailData);
  hideDetailSkeleton();

  if (item.appId) {
    api(`/api/games/${item._id}/steam-details`)
      .then(d => {
        if (myToken !== _detailFetchToken) return; // user udah pindah item, buang hasil ini
        _lastSteamDetailsForCurrent = d;
        currentDetailData = buildGameDetailModel(item, d);
        renderDetailPage(currentDetailData);
      })
      .catch(() => { /* biarin data cepat di atas yang tetap tampil — best-effort seperti APP LAMA */ });
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   AKHIR PHASE 5 — GAMES (bersambung ke handleInstall REAL di bawah, dekat
   fungsi installBar*, dan ke perubahan kecil di renderDetailActions/
   startInstall/initCardClickToDetail/initGameListPage lebih ke bawah file
   ini yang ditandai "PHASE 5" juga)
   ══════════════════════════════════════════════════════════════════════════ */

/* ══════════════════════════════════════════════════════════════════════════
   PHASE 6 — BYPASS (DATA ASLI, menggantikan kartu dummy #page-explore)
   ---------------------------------------------------------------------
   Sama persis polanya seperti PHASE 5 — GAMES di atas: fetch nyata ke
   /api/bypasses, render kartu ASLI, klik kartu -> fetch steam-details,
   akses/role dicek pakai hasAccess()/mktOrRoleLocked() (Phase 4), install
   pakai handleInstall('bypass', ...) REAL (lihat blok INSTALL di bawah,
   cabang else-nya sekarang sudah diisi, bukan "menyusul Phase 6" lagi).
   Push realtime lewat WebSocket 'bypasses:update' (lihat blok REALTIME).
   ══════════════════════════════════════════════════════════════════════════ */
let allBypasses = [];

async function loadBypasses() {
  try {
    const bypasses = await api('/api/bypasses');
    applyBypassesUpdate(bypasses);
  } catch (e) {
    console.warn('[Bypass] Gagal memuat daftar bypass:', e.message);
    if (typeof showToast === 'function') showToast('error', 'Gagal memuat daftar bypass dari server.');
  }
}

function applyBypassesUpdate(bypasses) {
  allBypasses = Array.isArray(bypasses) ? bypasses : [];
  renderBypassesGrid();
  // Kalau halaman detail lagi kebuka & terkait bypass ini (baik dibuka
  // langsung SEBAGAI bypass, ATAU sebagai game yang punya tombol "Install
  // Bypass" terhubung), refresh tombolnya biar akses/link-nya tetap benar
  // begitu ada perubahan realtime — tanpa perlu buka ulang halaman detail.
  if (currentDetail?.type === 'bypass' && currentDetailData?._isReal) {
    const fresh = allBypasses.find(b => String(b._id) === String(currentDetailData._id));
    if (fresh) {
      currentDetailData = buildBypassDetailModel(fresh, _lastSteamDetailsForCurrent || null);
      if (typeof renderDetailActions === 'function') renderDetailActions(currentDetailData);
    }
  } else if (currentDetail?.type === 'game' && currentDetailData?._isReal) {
    // Tombol "Install Bypass" KEDUA di halaman detail Game ikut dihitung
    // ulang (linkedBypass bisa saja baru ditambah/dihapus/berubah akses admin).
    const freshGame = allGames.find(g => String(g._id) === String(currentDetailData._id));
    if (freshGame) {
      currentDetailData = buildGameDetailModel(freshGame, _lastSteamDetailsForCurrent || null);
      if (typeof renderDetailActions === 'function') renderDetailActions(currentDetailData);
    }
  }
}

// ── Cari Bypass yang berkaitan dengan Game ini (buat tombol "Install
// Bypass" kedua di halaman detail Game) — prioritas gameId, fallback appId
// sama persis, sama seperti APP LAMA (findLinkedBypass). ──
function findLinkedBypass(gameItem) {
  if (!gameItem) return null;
  const gid = String(gameItem._id);
  let match = allBypasses.find(b => b.gameId && String(b.gameId) === gid);
  if (!match && gameItem.appId) {
    match = allBypasses.find(b => b.appId && String(b.appId) === String(gameItem.appId));
  }
  return match || null;
}
// Kebalikannya — dari Bypass cari Game yang terhubung, buat tombol "Lihat
// Game" di halaman detail Bypass.
function findLinkedGame(bypassItem) {
  if (!bypassItem) return null;
  if (bypassItem.gameId) {
    const byId = allGames.find(g => String(g._id) === String(bypassItem.gameId));
    if (byId) return byId;
  }
  if (bypassItem.appId) {
    return allGames.find(g => g.appId && String(g.appId) === String(bypassItem.appId)) || null;
  }
  return null;
}

function renderBypassCard(item) {
  return renderMediaGridCard(item);
}

function renderBypassesGrid() {
  const page = document.getElementById('page-explore');
  if (!page) return;
  const grid = page.querySelector('.grid');
  if (!grid) return;
  grid.innerHTML = allBypasses.map(item => renderBypassCard(item)).join('');
  if (typeof renderPackageBadges === 'function') renderPackageBadges();
  if (typeof renderStatusBadges === 'function') renderStatusBadges();
  if (typeof page._applyFilters === 'function') page._applyFilters();
}

function buildBypassDetailModel(item, steamData) {
  const locked = mktOrRoleLocked(item);
  const gated = isMktGated(item);
  const linkedGame = findLinkedGame(item);
  const tagsSource = steamData
    ? [...(steamData.categories || []), ...(steamData.genres || [])]
    : (Array.isArray(item.genres) && item.genres.length ? item.genres : (item.categories || []));
  return {
    kind: 'bypass',
    _isReal: true,
    _id: item._id,
    role: item.role || 'public',
    locked, gated,
    marketplaceProductIds: Array.isArray(item.marketplaceProductIds) ? item.marketplaceProductIds : [],
    title: item.name || '—',
    compatibleGame: linkedGame ? linkedGame.name : 'Game terkait',
    linkedGameId: linkedGame ? linkedGame._id : null,
    image: steamData?.headerImage || item.imageUrl || '',
    appId: item.appId || item.steamAppId || null,
    bypassType: 'Bypass',
    status: 'Active',
    version: '—',
    updatedAt: item.createdAt ? new Date(item.createdAt).toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' }) : '—',
    description: steamData?.shortDescription || item.description || 'Memuat deskripsi dari Steam...',
    isOnline: item.isOnline !== false,
    tags: tagsSource.slice(0, 8),
    reqProfile: steamData ? {
      minimum: mapReqList(steamData.requirementsMin),
      recommended: mapReqList(steamData.requirementsRec),
    } : {
      minimum: { os: '—', cpu: '—', ram: '—', gpu: '—', storage: '—' },
      recommended: { os: '—', cpu: '—', ram: '—', gpu: '—', storage: '—' },
    },
  };
}

function openRealBypassDetailById(id) {
  const item = allBypasses.find(b => String(b._id) === String(id));
  if (!item) { if (typeof showToast === 'function') showToast('error', 'Bypass tidak ditemukan.'); return; }

  currentDetail = { type: 'bypass', title: item.name, image: item.imageUrl };
  _lastSteamDetailsForCurrent = null;
  const myToken = ++_detailFetchToken;

  document.getElementById('detailBackLabel').textContent = 'Back to Bypass';
  document.querySelectorAll('.nav-item[data-page]').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.pm-item[data-page]').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.page').forEach(sec => sec.classList.toggle('active', sec.id === 'page-detail'));
  const bodyEl = document.getElementById('detailBody');
  if (bodyEl) bodyEl.scrollTop = 0;
  showDetailSkeleton();

  currentDetailData = buildBypassDetailModel(item, null);
  renderDetailPage(currentDetailData);
  hideDetailSkeleton();

  const appId = item.appId || item.steamAppId;
  if (appId) {
    api(`/api/bypasses/${item._id}/steam-details`)
      .then(d => {
        if (myToken !== _detailFetchToken) return;
        _lastSteamDetailsForCurrent = d;
        currentDetailData = buildBypassDetailModel(item, d);
        renderDetailPage(currentDetailData);
      })
      .catch(() => { /* biarin data cepat di atas yang tetap tampil */ });
  }
}
/* ══════════════════════════════════════════════════════════════════════════
   AKHIR PHASE 6 — BYPASS
   ══════════════════════════════════════════════════════════════════════════ */

/* ---------- package badges (reusable component) ----------
     Single source of truth for the PUBLIC / GOLD / PLATINUM badge
     look. Markup in HTML is just <span class="pkg-badge" data-tier="gold"></span>;
     this fills in the icon + label so the styling/icon set never
     has to be duplicated per-usage. */
  const PACKAGE_BADGES = {
    // Public/Gratis: kept ShieldCheck — reads as "verified, open access"
    // rather than a bare padlock, so the free tier still feels premium.
    public: {
      label: 'Gratis',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/></svg>'
    },
    // Gold: swapped the old jagged 3-peak zigzag for a proper jeweled
    // crown — the clearest "prestige" signal of the icon set and the
    // biggest gap versus Public/Platinum, which already read well.
    gold: {
      label: 'Gold',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M11.562 3.266a.5.5 0 0 1 .876 0L15.39 8.87a1 1 0 0 0 1.516.294L21.183 5.5a.5.5 0 0 1 .798.519l-2.834 10.246a1 1 0 0 1-.956.734H5.81a1 1 0 0 1-.957-.734L2.02 6.02a.5.5 0 0 1 .798-.519l4.276 3.664a1 1 0 0 0 1.516-.294z"/><path d="M5 21h14"/></svg>'
    },
    // Platinum: kept Gem — already a strong, recognizable faceted shape,
    // just tuned to the same refined stroke weight as the other two.
    platinum: {
      label: 'Platinum',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h12l4 6-10 13L2 9Z"/><path d="M11 3 8 9l4 13 4-13-3-6"/><path d="M2 9h20"/></svg>'
    },
    // Marketplace — BUKAN package tier (Gratis/Gold/Platinum di atas selalu
    // berdasarkan item.role/PACKAGE REQUIREMENT asli), ini SOURCE/ACCESS TYPE
    // indicator: item konten Product Marketplace (marketplaceProductIds
    // terisi, lihat badgeTier di renderMediaGridCard()) akses-nya didapat
    // dari beli/whitelist Product, bukan dari paket akun. Lucide "shopping-bag"
    // dipakai supaya langsung terbaca "didapat dari pembelian", beda dari
    // shield/crown/gem yang sudah dipakai tier paket di atas — sengaja tidak
    // dibuat mirip salah satu dari ketiganya (termasuk tidak dibuat mirip
    // Admin yang juga sudah pakai palet violet→amber) supaya benar-benar
    // terlihat sebagai kategori ke-4 yang berbeda, bukan tier baru.
    marketplace: {
      label: 'Marketplace',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z"/><path d="M3 6h18"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>'
    }
  };
  function renderPackageBadges(){
    document.querySelectorAll('.pkg-badge[data-tier]').forEach(el=>{
      const cfg = PACKAGE_BADGES[el.dataset.tier];
      if(!cfg || el.dataset.rendered) return;
      el.innerHTML = cfg.icon + '<span class="pkg-badge-label">' + cfg.label + '</span>';
      el.dataset.rendered = 'true';
    });
  }

  /* ---------- admin badge (reusable component) ----------
     Separate from PACKAGE_BADGES on purpose — Admin is a ROLE, not a
     Gratis/Gold/Platinum tier (see applyAdminBadge() above). Icon is
     Lucide "badge-check" (scalloped verified-authority glyph) so it never
     reads as a fourth package tier stacked onto ShieldCheck/Crown/Gem
     above. Markup: <span class="admin-badge" id="..."></span>, filled in
     here the same lazy/idempotent way as renderPackageBadges(). */
  const ADMIN_BADGE = {
    label: 'Admin',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z"/><path d="m9 12 2 2 4-4"/></svg>'
  };
  function renderAdminBadge(el){
    if (!el || el.dataset.rendered) return;
    el.innerHTML = ADMIN_BADGE.icon + '<span class="admin-badge-label">' + ADMIN_BADGE.label + '</span>';
    el.dataset.rendered = 'true';
  }

  /* ---------- StatusBadge (reusable component) ----------
     Single source of truth for the Online/Offline badge, same
     pattern as renderPackageBadges above. Markup is just
     <span class="status-badge" data-status="online|offline"></span>;
     this fills in the icon + label. Call setStatusBadge(el, status)
     any time the real status changes — it updates the same element
     in place, no reload needed.

     Icon+label only, no background — matches the artwork game/bypass
     grid's "no card/pill" package badge treatment right next to it.
     Real signal-strength glyphs (not a plain dot) so it reads as a
     deliberate icon, not decoration; icon uses stroke="currentColor" so
     the existing [data-status] color rules below color it automatically. */
  const STATUS_BADGES = {
    online: {
      label: 'Online Mode',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M2 8.82a15 15 0 0 1 20 0"/><path d="M5 12.86a10 10 0 0 1 14 0"/><path d="M8.5 16.9a5 5 0 0 1 7 0"/><circle cx="12" cy="20" r="1" fill="currentColor" stroke="none"/></svg>'
    },
    offline: {
      label: 'Offline Mode',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 16.9a5 5 0 0 1 7 0"/><path d="M2 8.82a15 15 0 0 1 4.17-2.65M19.83 6.17A15 15 0 0 1 22 8.82M5 12.86a10 10 0 0 1 2.24-1.94m9.52 0A10 10 0 0 1 19 12.86"/><circle cx="12" cy="20" r="1" fill="currentColor" stroke="none"/><line x1="1" y1="1" x2="23" y2="23"/></svg>'
    }
  };
  function paintStatusBadge(el, status){
    const cfg = STATUS_BADGES[status];
    if(!cfg) return;
    el.dataset.status = status;
    el.innerHTML = cfg.icon + '<span class="status-label">' + cfg.label + '</span>';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-label', cfg.label);
  }
  function renderStatusBadges(){
    document.querySelectorAll('.status-badge[data-status]').forEach(el => paintStatusBadge(el, el.dataset.status));
  }
  // Call this whenever real status changes, e.g.:
  // setStatusBadge(document.querySelector('.thumb-status'), 'offline');
  function setStatusBadge(el, status){ paintStatusBadge(el, status); }

  /* ---------- game list pages (Games + Bypass) ----------
     Each .page that contains a .grid gets its own independent
     search/filter/view state, scoped to that page only, so the
     same toolbar+grid markup can be reused across pages without
     them interfering with each other. */
  function initGameListPage(page){
    const state = { search:'', difficulty:'all', mode:'all' };
    const grid = page.querySelector('.grid');
    const emptyState = page.querySelector('.empty-state');
    const searchInput = page.querySelector('.search input');
    const filterTabs = page.querySelectorAll('.filter-group[data-filter-group="difficulty"] .filter-tab');
    // Filter Online Mode / Offline Mode — di samping kanan filter Public/Gold/
    // Platinum (dipisah garis .sep). BEDA dari filterTabs di atas: grup ini
    // TIDAK punya tombol "All" tersendiri — klik salah satu tab yang lagi
    // aktif akan MEMATIKANNYA lagi (balik nampilin online+offline sekaligus),
    // klik tab yang lain otomatis pindah eksklusif ke situ. Status online/
    // offline tiap game dibaca dari elemen <span class="status-badge"> yang
    // sudah ada di tiap kartu (data-status="online|offline"), BUKAN atribut
    // baru di .card — datanya memang sudah ada, tinggal dipakai buat filter.
    const modeTabs = page.querySelectorAll('.filter-group[data-filter-group="mode"] .filter-tab');

    function applyFilters(){
      let anyVisible = false;
      grid.querySelectorAll('.card').forEach(card=>{
        const title = (card.dataset.title || '').toLowerCase();
        const diffs = (card.dataset.difficulty || '').split(' ').filter(Boolean);
        const statusEl = card.querySelector('.status-badge');
        const cardMode = statusEl ? statusEl.dataset.status : null;
        let visible = true;
        if(state.search && !title.includes(state.search.toLowerCase())) visible = false;
        if(state.difficulty !== 'all' && !diffs.includes(state.difficulty)) visible = false;
        if(state.mode !== 'all' && cardMode !== state.mode) visible = false;
        card.style.display = visible ? '' : 'none';
        if(visible) anyVisible = true;
      });
      if(emptyState) emptyState.classList.toggle('show', !anyVisible);
    }

    // Halaman seperti Dashboard (Home) punya .grid (New Games) TAPI TANPA
    // toolbar search/filter sendiri — jadi bagian-bagian ini
    // sengaja di-guard null (bukan diasumsikan selalu ada), supaya satu
    // halaman "polos" begini tidak bikin SELURUH script berhenti gara-gara
    // error, yang sebelumnya menyebabkan badge & klik kartu ikut rusak
    // di semua halaman lain juga.
    if(searchInput){
      searchInput.addEventListener('input', ()=>{
        state.search = searchInput.value;
        applyFilters();
      });
    }

    filterTabs.forEach(btn=>{
      btn.addEventListener('click', ()=>{
        state.difficulty = btn.dataset.value;
        filterTabs.forEach(b=>b.classList.toggle('active', b === btn));
        applyFilters();
      });
    });

    modeTabs.forEach(btn=>{
      btn.addEventListener('click', ()=>{
        const alreadyActive = btn.classList.contains('active');
        state.mode = alreadyActive ? 'all' : btn.dataset.value;
        modeTabs.forEach(b=>b.classList.toggle('active', !alreadyActive && b === btn));
        applyFilters();
      });
    });

    applyFilters();
    // PHASE 5: dipanggil ulang dari renderGamesGrid() tiap kali grid-nya
    // diisi ulang dengan data asli (fetch awal / realtime update), supaya
    // search/filter/tab yang lagi aktif tetap konsisten dengan kartu baru.
    page._applyFilters = applyFilters;
  }

  /* =====================================================
     Histori page — SISTEM ASLI DARI PROJECT LAMA
     ---------------------------------------------------
     Data histori sekarang 100% berasal dari server/database
     project lama (koleksi Mongo `history`, endpoint
     GET/POST/DELETE /api/history di server.js — TIDAK ada
     endpoint/skema baru yang dibuat). UI/desain (render/
     filter/sort/kartu/empty-state) TIDAK diubah — hanya
     sumber datanya yang diganti dari array dummy menjadi
     hasil fetch server, dan tombol Uninstall sekarang
     menjalankan proses uninstall Electron/IPC asli
     (removeGame/removeBypass, sama seperti APP LAMA)
     sebelum catatan histori dihapus dari server.
  ===================================================== */
  const HISTORY_ICONS = {
    game: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="8" width="20" height="10" rx="5"/><line x1="6" y1="11" x2="6" y2="15"/><line x1="4" y1="13" x2="8" y2="13"/><circle cx="16" cy="11" r=".6"/><circle cx="18" cy="14" r=".6"/></svg>',
    bypass: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3.5v5.5c0 5-3 8-7 9-4-1-7-4-7-9V6.5L12 3z"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"/><path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/><path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"/></svg>',
    check: '<circle cx="12" cy="12" r="9"/><path d="m8.5 12.5 2.5 2.5 4.5-5"/>',
    alert: '<circle cx="12" cy="12" r="9"/><line x1="12" y1="8" x2="12" y2="13"/><line x1="12" y1="16.5" x2="12" y2="16.6"/>',
    trendUp: '<polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/>',
    trendDown: '<polyline points="22 17 13.5 8.5 8.5 13.5 2 7"/><polyline points="16 17 22 17 22 11"/>',
    cancel: '<circle cx="12" cy="12" r="9"/><line x1="9" y1="9" x2="15" y2="15"/><line x1="15" y1="9" x2="9" y2="15"/>'
  };

  // Data histori nyata (hasil GET /api/history) — kosong sampai loadHistori()
  // pertama kali sukses jalan. Tidak ada lagi seed/dummy data di sini.
  let historyData = [];
  let _historiLoading = false;

  // Ubah satu baris histori dari server (koleksi `history` project lama)
  // jadi bentuk yang dipakai render/filter/sort di UI APP DEMO ini. Field
  // extractedFiles/steamPath/folderPath ikut dibawa (bukan cuma dibuang)
  // supaya tombol Uninstall tahu persis file & lokasi PC mana yang harus
  // dihapus — sama seperti localMeta di APP LAMA.
  function mapHistoryRow(h) {
    return {
      id: String(h._id),
      type: h.itemType,
      name: h.itemName || 'Item',
      image: h.itemImage || null,
      appId: h.appId || null,
      // "Lokasi install taro di lokasi PC mana" — steamPath (game) / folderPath
      // (bypass) dikirim & disimpan server persis sejak POST /api/history
      // (lihat handleInstall di bawah), bukan field baru.
      installPath: h.itemType === 'game' ? (h.steamPath || '') : (h.folderPath || ''),
      steamPath: h.steamPath || null,
      folderPath: h.folderPath || null,
      extractedFiles: Array.isArray(h.extractedFiles) ? h.extractedFiles : [],
      installedAt: h.createdAt,
      // Server (koleksi `history`) cuma pernah menyimpan install yang BENAR-BENAR
      // sukses (POST /api/history dipanggil hanya setelah result.success di
      // handleInstall), dan entrinya dihapus total begitu di-uninstall — jadi
      // setiap baris yang datang dari GET /api/history sudah pasti "installed".
      status: 'installed',
      isInstalled: true
    };
  }

  // Dipanggil tiap kali halaman Histori dibuka (setNav('history')) & setelah
  // install/uninstall — sama seperti loadHistori() di APP LAMA: coba kirim
  // ulang antrian histori yang sempat gagal tersimpan dulu, baru ambil daftar
  // terbaru dari server.
  async function loadHistori() {
    if (_historiLoading) return;
    _historiLoading = true;
    try {
      await flushPendingHistory().catch(() => {});
      const rows = await api('/api/history');
      historyData = Array.isArray(rows) ? rows.map(mapHistoryRow) : [];
    } catch (e) {
      console.warn('[Histori] Gagal memuat histori dari server:', e.message);
      if (typeof showToast === 'function') showToast('error', 'Gagal memuat histori: ' + e.message);
    } finally {
      _historiLoading = false;
    }
    renderHistoryList();
  }

  const historyState = { search:'', type:'all', sort:'newest' };

  function formatHistoryDate(iso){
    const d = new Date(iso);
    const day = String(d.getDate()).padStart(2,'0');
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const hh = String(d.getHours()).padStart(2,'0');
    const mm = String(d.getMinutes()).padStart(2,'0');
    return `${day} ${months[d.getMonth()]} ${d.getFullYear()} • ${hh}:${mm}`;
  }

  function statusLabel(item){
    if(item.status === 'failed') return 'Failed';
    if(item.status === 'uninstalled') return 'Uninstalled';
    return item.type === 'bypass' ? 'Bypass Applied' : 'Installed';
  }

  function computeHistoryStats(){
    const total = historyData.length;
    const games = historyData.filter(h => h.type === 'game' && h.status !== 'failed').length;
    const bypass = historyData.filter(h => h.type === 'bypass' && h.status !== 'failed').length;
    return { total, games, bypass };
  }

  function renderHistoryStats(){
    const s = computeHistoryStats();
    document.getElementById('statTotal').textContent = s.total;
    document.getElementById('statGames').textContent = s.games;
    document.getElementById('statBypass').textContent = s.bypass;
  }

  function buildHistoryItem(item){
    const el = document.createElement('div');
    el.className = 'history-item';
    el.dataset.id = item.id;

    const thumbHtml = item.image
      ? `<div class="history-thumb"><img src="${item.image}" alt="${item.name}" loading="lazy"></div>`
      : `<div class="history-thumb icon-fallback">${HISTORY_ICONS.bypass}</div>`;

    const typeBadge = `<span class="history-type-badge" data-type="${item.type}">${HISTORY_ICONS[item.type]}<span>${item.type === 'game' ? 'Games' : 'Bypass'}</span></span>`;
    const statusBadge = `<span class="history-status-badge" data-status="${item.status}">${statusLabel(item)}</span>`;

    let actionHtml;
    if(item.isInstalled){
      actionHtml = `<button class="uninstall-btn" onclick="openUninstallConfirm('${item.id}')">${HISTORY_ICONS.trash}<span>Uninstall</span></button>`;
    } else {
      actionHtml = `<span class="uninstalled-tag">${item.status === 'failed' ? 'Failed' : 'Uninstalled'}</span>`;
    }

    el.innerHTML = `
      ${thumbHtml}
      <div class="history-info">
        <span class="history-name">${item.name}</span>
        <div class="history-meta-row">
          ${typeBadge}
          ${statusBadge}
          <span class="history-date">${formatHistoryDate(item.installedAt)}</span>
        </div>
      </div>
      <div class="history-actions">${actionHtml}</div>
    `;
    return el;
  }

  function renderHistoryList(){
    const listEl = document.getElementById('historyList');
    const emptyEl = document.getElementById('historyEmptyState');

    let items = historyData.filter(h => {
      if(historyState.type !== 'all' && h.type !== historyState.type) return false;
      if(historyState.search && !h.name.toLowerCase().includes(historyState.search.toLowerCase())) return false;
      return true;
    });

    items.sort((a,b) => {
      const diff = new Date(b.installedAt) - new Date(a.installedAt);
      return historyState.sort === 'newest' ? diff : -diff;
    });

    listEl.innerHTML = '';
    if(items.length === 0){
      listEl.style.display = 'none';
      emptyEl.classList.add('show');
    } else {
      listEl.style.display = '';
      emptyEl.classList.remove('show');
      items.forEach(item => listEl.appendChild(buildHistoryItem(item)));
    }

    renderHistoryStats();
  }

  function initHistoryPage(){
    const page = document.getElementById('page-history');
    const searchInput = document.getElementById('historySearchInput');
    const filterTabs = document.querySelectorAll('#historyFilterGroup .filter-tab');
    const sortButtons = document.querySelectorAll('#historySortToggle button');

    searchInput.addEventListener('input', () => {
      historyState.search = searchInput.value;
      renderHistoryList();
    });

    filterTabs.forEach(btn => {
      btn.addEventListener('click', () => {
        historyState.type = btn.dataset.value;
        filterTabs.forEach(b => b.classList.toggle('active', b === btn));
        renderHistoryList();
      });
    });

    sortButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        historyState.sort = btn.dataset.sort;
        sortButtons.forEach(b => b.classList.toggle('active', b === btn));
        renderHistoryList();
      });
    });

    // Muat histori ASLI dari server begitu halaman ini disiapkan (bukan lagi
    // render array dummy secara sinkron).
    loadHistori();
  }

  /* ---------- uninstall flow ---------- */
  let pendingUninstallId = null;

  function openUninstallConfirm(id){
    const item = historyData.find(h => h.id === id);
    if(!item || !item.isInstalled) return;
    pendingUninstallId = id;

    const titleEl = document.getElementById('uninstallConfirmTitle');
    const descEl = document.getElementById('uninstallConfirmDesc');
    const confirmBtn = document.getElementById('uninstallConfirmBtn');
    const cancelBtn = document.getElementById('uninstallCancelBtn');

    titleEl.textContent = `Uninstall ${item.name}?`;
    descEl.textContent = item.type === 'bypass'
      ? 'File bypass yang dikelola aplikasi akan dihapus.'
      : 'Game ini akan dihapus dari instalasi yang dikelola aplikasi.';

    confirmBtn.textContent = 'Uninstall';
    confirmBtn.disabled = false;
    cancelBtn.disabled = false;

    document.getElementById('uninstallConfirmOverlay').classList.add('show');
  }

  function cancelUninstall(){
    pendingUninstallId = null;
    document.getElementById('uninstallConfirmOverlay').classList.remove('show');
  }

  // ── UNINSTALL (REAL) — dipindah UTUH dari wireHistoriCardActions() APP LAMA. ──
  // Alurnya: (1) jalankan proses uninstall Electron/IPC ASLI (removeGame utk
  // game, removeBypass utk bypass — channel & argumen sama persis dgn APP
  // LAMA, tidak ada sistem baru) memakai extractedFiles + steamPath/folderPath
  // yang sudah tersimpan (localStorage installMeta, fallback ke data dari
  // server); (2) BARU setelah proses itu jalan, catatan histori-nya dihapus
  // dari server (DELETE /api/history/:id — endpoint asli project lama) supaya
  // Total Histori/Game/Bypass ikut update; (3) refresh daftar dari server.
  // Tidak pernah cuma menghapus dari tampilan saja.
  async function confirmUninstall(){
    if(!pendingUninstallId) return;
    const item = historyData.find(h => h.id === pendingUninstallId);
    if(!item) return;

    const confirmBtn = document.getElementById('uninstallConfirmBtn');
    const cancelBtn = document.getElementById('uninstallCancelBtn');
    confirmBtn.disabled = true;
    cancelBtn.disabled = true;
    confirmBtn.textContent = 'Uninstalling...';

    // Utamakan data dari localStorage (installMeta) — disimpan LANGSUNG di PC
    // ini tepat saat install barusan berhasil, jadi dijamin ada & akurat.
    // Data dari server (item.extractedFiles/steamPath/folderPath) cuma
    // fallback kalau localStorage-nya kosong (mis. histori disinkron dari
    // device lain, atau tersimpan sebelum fix ini).
    const localMeta = getLocalInstallMeta()[String(item.id)];
    const itemType        = localMeta?.type          ?? item.type;
    const extractedFiles  = (localMeta?.extractedFiles ?? item.extractedFiles) || [];
    const steamPathMeta   = localMeta?.steamPath     ?? item.steamPath  ?? null;
    const folderPathMeta  = localMeta?.folderPath    ?? item.folderPath ?? null;

    try {
      let fileWarning = '';
      let needRestartSteam = false;

      if (itemType === 'game') {
        if (extractedFiles.length) {
          const steamPath = steamPathMeta || await window.electronAPI.getSteamPath();
          if (steamPath) {
            const rmResult = await window.electronAPI.removeGame({ steamPath, extractedFiles });
            if (!rmResult?.success) fileWarning = ` (file di PC gagal dihapus: ${rmResult?.error || 'tidak diketahui'})`;
            else needRestartSteam = true; // file sudah kehapus, Steam masih baca cache lama sampai di-restart
          } else {
            fileWarning = ' (Steam tidak ditemukan, file di PC tidak ikut dihapus)';
          }
        } else {
          fileWarning = ' (histori lama, daftar file tidak tersimpan — hapus manual dari folder Steam kalau perlu)';
        }
      } else if (itemType === 'bypass') {
        if (extractedFiles.length && folderPathMeta) {
          const rmResult = await window.electronAPI.removeBypass({ folderPath: folderPathMeta, extractedFiles });
          if (!rmResult?.success) fileWarning = ` (file di PC gagal dihapus: ${rmResult?.error || 'tidak diketahui'})`;
        } else {
          fileWarning = ' (histori lama, daftar file tidak tersimpan — hapus manual dari folder game kalau perlu)';
        }
      }

      // Update status histori di server (koleksi `history` project lama) —
      // baru dilakukan SETELAH proses uninstall di atas benar-benar jalan.
      await api('/api/history/' + item.id, { method: 'DELETE' });
      removeLocalInstallMeta(item.id);

      document.getElementById('uninstallConfirmOverlay').classList.remove('show');
      pendingUninstallId = null;

      showToast('success', item.name,
        (itemType === 'game' ? 'Game berhasil dihapus' : 'Bypass berhasil dihapus') +
        (needRestartSteam ? ' — restart Steam agar perubahan berlaku.' : (fileWarning || '')));

      await loadHistori(); // ambil ulang daftar+statistik terbaru dari server
    } catch (err) {
      confirmBtn.disabled = false;
      cancelBtn.disabled = false;
      confirmBtn.textContent = 'Uninstall';
      document.getElementById('uninstallConfirmOverlay').classList.remove('show');
      pendingUninstallId = null;
      showToast('error', item.name, (itemType === 'game' ? 'Game gagal dihapus' : 'Bypass gagal dihapus') + ' — ' + err.message);
    }
  }

  /* ── Toast — REDESIGN PREMIUM (Item 5-7). Signature showToast(type, message)
     TIDAK berubah — semua ~15 pemanggil lama di file ini tetap jalan tanpa
     disentuh. Ditambah parameter ke-3 OPSIONAL `detail` (baris kecil di
     bawah message, dipakai notif Download/Uninstall yang butuh 2 baris —
     lihat installBarSetSuccess/Error & confirmUninstall). Tipe yang didukung
     sekarang: 'success' | 'error' | 'cancel' (baru — visual netral/abu,
     beda dari 'error' yang merah, sesuai requirement "cancel harus beda
     visual dari gagal tapi tetap elegan"). Container #toastStack (top-right,
     lihat .toast-stack di styles.css) tetap dipakai apa adanya. */
  function showToast(type, message, detail){
    const stack = document.getElementById('toastStack');
    if (!stack) return;
    const iconPath = type === 'error' ? HISTORY_ICONS.alert
      : type === 'cancel' ? HISTORY_ICONS.cancel
      : HISTORY_ICONS.check;
    const el = document.createElement('div');
    el.className = 'toast ' + type;
    el.innerHTML = `
      <span class="toast-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${iconPath}</svg></span>
      <span class="toast-body">
        <span class="toast-title"></span>
        ${detail ? '<span class="toast-detail"></span>' : ''}
      </span>`;
    el.querySelector('.toast-title').textContent = message;
    if (detail) el.querySelector('.toast-detail').textContent = detail;
    stack.appendChild(el);
    // 2x rAF supaya transisi opacity/transform ke state ".show" beneran
    // ke-trigger (elemen baru di-insert harus "settle" 1 frame dulu).
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('show')));
    repositionInstallBar();
    setTimeout(() => removeToastEl(el), 3200);
  }

  // Notif KHUSUS paket user berubah (upgrade/downgrade) — dipanggil dari
  // handleAccountUpdate() begitu ada event realtime 'account:update' yang
  // tier-nya beda dari sebelumnya (logic upgrade/downgrade & sumber event
  // realtime-nya TIDAK berubah, murni tampilan/posisi card ini yang beda).
  // SENGAJA pakai container terpisah (#pkgToastStack, top-center) — BUKAN
  // #toastStack (kanan-atas, dekat profile/avatar) — supaya card ini tidak
  // pernah menutupi nama user/profile, dan tetap tidak menyentuh/mengubah
  // showToast() biasa yang masih dipakai ~15 pemanggil lain di file ini.
  function showPackageChangeToast(oldTier, newTier){
    const stack = document.getElementById('pkgToastStack');
    if (!stack) return;
    // Admin BUKAN tier paket (lihat packageTierOf()) — label & judul toast
    // dibedakan di sini supaya transisi ke/dari Admin tidak pernah tertulis
    // "Paket Berhasil Diperbarui ke Gratis" (fallback lama) atau semacamnya.
    const tierLabel = (t) => t === 'admin' ? 'Admin' : (PACKAGE_BADGES[t]?.label || 'Gratis');
    const oldLabel = tierLabel(oldTier);
    const newLabel = tierLabel(newTier);
    const becameAdmin = newTier === 'admin';
    const leftAdmin = oldTier === 'admin' && !becameAdmin;
    const isUpgrade = (CLIENT_ROLE_LEVEL[newTier] ?? 0) > (CLIENT_ROLE_LEVEL[oldTier] ?? 0);
    const dir = isUpgrade ? 'up' : 'down';
    const title = becameAdmin
      ? 'Akun Sekarang Admin'
      : leftAdmin
        ? 'Role Admin Dicabut'
        : (isUpgrade ? 'Paket Berhasil Diperbarui' : 'Paket Diturunkan');

    const el = document.createElement('div');
    el.className = 'pkg-toast ' + dir;
    el.innerHTML = `
      <span class="pkg-toast-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${isUpgrade ? HISTORY_ICONS.trendUp : HISTORY_ICONS.trendDown}</svg>
      </span>
      <span class="pkg-toast-body">
        <span class="pkg-toast-title"></span>
        <span class="pkg-toast-change">
          <span class="pkg-toast-tier old" data-tier="${oldTier}"></span>
          <svg class="pkg-toast-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
          <span class="pkg-toast-tier new" data-tier="${newTier}"></span>
        </span>
      </span>
      <button class="pkg-toast-close" aria-label="Tutup notifikasi" onclick="removePkgToastEl(this.closest('.pkg-toast'))">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>`;
    el.querySelector('.pkg-toast-title').textContent = title;
    el.querySelector('.pkg-toast-tier.old').textContent = oldLabel;
    el.querySelector('.pkg-toast-tier.new').textContent = newLabel;
    stack.appendChild(el);
    // 2x rAF supaya transisi masuk (fade + slide) beneran ke-trigger, sama
    // pola-nya dengan showToast() di atas.
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('show')));
    repositionNotificationStacks();
    setTimeout(() => removePkgToastEl(el), 5200); // durasi lebih lega — isinya 2 baris + perlu waktu dibaca
  }

  // Lepas 1 package-toast dari stack-nya sendiri dengan animasi keluar
  // (fade + slide, sama gaya dengan removeToastEl() tapi untuk
  // #pkgToastStack) — dipanggil otomatis (timeout di atas) maupun manual
  // lewat tombol close.
  function removePkgToastEl(el){
    const stack = document.getElementById('pkgToastStack');
    if (!el || !el.parentNode || !stack) return;
    el.classList.remove('show');
    el.classList.add('pkg-toast-leaving');
    let done = false;
    const finish = () => { if (done) return; done = true; el.remove(); repositionNotificationStacks(); };
    el.addEventListener('transitionend', finish, { once: true });
    setTimeout(finish, 260); // jaring pengaman kalau transitionend tidak ke-fire
  }

  // Lepas 1 toast dari stack dengan animasi keluar, lalu toast-toast yang
  // masih ada di atasnya digeser naik secara smooth (teknik FLIP sederhana)
  // — bukan "loncat" tiba-tiba ke posisi barunya.
  function removeToastEl(el){
    const stack = document.getElementById('toastStack');
    if (!el || !el.parentNode || !stack) return;
    const siblings = Array.from(stack.children).filter(c => c !== el);
    const firstRects = siblings.map(s => s.getBoundingClientRect());
    el.classList.remove('show');
    el.classList.add('toast-leaving');
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      el.remove();
      siblings.forEach((s, i) => {
        const before = firstRects[i];
        const after = s.getBoundingClientRect();
        const dy = before.top - after.top;
        if (dy) {
          s.style.transition = 'none';
          s.style.transform = `translateY(${dy}px)`;
          requestAnimationFrame(() => {
            s.style.transition = 'transform .28s cubic-bezier(.4,0,.2,1)';
            s.style.transform = '';
          });
        }
      });
      repositionInstallBar();
    };
    el.addEventListener('transitionend', finish, { once: true });
    setTimeout(finish, 260); // jaring pengaman kalau transitionend tidak ke-fire
  }

  // Sinkronkan posisi 3 container notifikasi (#pkgToastStack, #toastStack,
  // #installProgressBar — SEMUA sekarang top-center, lihat styles.css) biar
  // selalu ke-stack rapi dari atas ke bawah TANPA saling menutupi, walau
  // muncul bersamaan: pkg-toast-stack (top:104px, paling atas) → toast-stack
  // (geser turun kalau pkg-toast lagi tampil, lewat --pkg-offset) →
  // install-progress-bar (geser turun lagi di bawah toast-stack DAN
  // pkg-toast-stack, lewat --ti-stack-offset + --pkg-offset). Dipanggil tiap
  // kali salah satu dari 3 stack ini bertambah/berkurang isinya. Ini murni
  // penyesuaian posisi (custom property CSS), TIDAK menyentuh logic
  // download/install/Socket.IO ataupun kapan masing-masing notif tampil.
  function repositionNotificationStacks(){
    const pkgStack = document.getElementById('pkgToastStack');
    const toastStack = document.getElementById('toastStack');
    const bar = document.getElementById('installProgressBar');

    const pkgH = pkgStack ? pkgStack.offsetHeight : 0;
    const pkgOffset = pkgH > 0 ? (pkgH + 14) + 'px' : '0px';
    if (toastStack) toastStack.style.setProperty('--pkg-offset', pkgOffset);
    if (bar) bar.style.setProperty('--pkg-offset', pkgOffset);

    const toastH = toastStack ? toastStack.offsetHeight : 0;
    if (bar) bar.style.setProperty('--ti-stack-offset', toastH > 0 ? (toastH + 14) + 'px' : '0px');
  }
  // Nama lama dipertahankan sebagai alias — dipakai beberapa pemanggil lain
  // di file ini yang tidak perlu disentuh satu-satu.
  function repositionInstallBar(){ repositionNotificationStacks(); }

  /* ---------- bookmark ---------- */
  function toggleBookmark(btn){
    const active = btn.classList.toggle('active');
    const path = btn.querySelector('path');
    btn.querySelector('svg').setAttribute('fill', active ? 'currentColor' : 'none');
  }

  /* ---------- nav ---------- */
  function setNav(page){
    document.querySelectorAll('.nav-item[data-page]').forEach(btn=>{
      btn.classList.toggle('active', btn.dataset.page === page);
    });
    // History dipindah ke Profile dropdown (bukan lagi nav-item) — tetap
    // ikut ditandai aktif dengan pola yang sama, supaya kalau dropdown
    // dibuka lagi saat lagi di halaman Histori, statenya konsisten dengan
    // item nav lain yang sedang aktif.
    document.querySelectorAll('.pm-item[data-page]').forEach(btn=>{
      btn.classList.toggle('active', btn.dataset.page === page);
    });
    document.querySelectorAll('.page').forEach(sec=>{
      sec.classList.toggle('active', sec.id === 'page-' + page);
    });
    // Setiap kali halaman Histori dibuka, tarik ulang data terbaru dari
    // server (sama seperti APP LAMA: loadHistori() dipanggil tiap halaman
    // Histori diakses) — supaya install/uninstall dari sesi lain/device lain
    // juga langsung kelihatan, bukan cuma dari cache pertama kali load.
    if (page === 'history' && typeof loadHistori === 'function') {
      loadHistori();
    }
    if (page === 'setting' && typeof refreshActiveToolsStatus === 'function') {
      refreshActiveToolsStatus();
    }
    // Beli Paket — tarik ulang data paket (harga/durasi/benefit dari Admin
    // Web) tiap kali halaman ini dibuka, sama pola dengan history/setting
    // di atas (lihat blok "BELI PAKET" di bawah file ini).
    if (page === 'belipaket' && typeof loadPackages === 'function') {
      loadPackages();
    }
    // Gold Trial — kartu promo/status di halaman Beli Paket, tarik ulang
    // status terbaru tiap kali halaman ini dibuka (pola sama seperti
    // loadPackages() di atas).
    if (page === 'belipaket' && typeof loadGoldTrialOffer === 'function') {
      loadGoldTrialOffer();
    }
    if (page === 'marketplace' && typeof loadMarketplaceProducts === 'function') {
      loadMarketplaceProducts();
      // Steam Account — tab kedua di halaman yang sama, tarik ulang juga
      // (pola sama dgn Marketplace) & pastikan tab yang sedang aktif tetap
      // konsisten (mis. user balik dari detail Steam Account -> setNav
      // dipanggil closeSteamAccountDetail(), section harus tetap "steam-account").
      if (typeof loadSteamAccounts === 'function') loadSteamAccounts();
      if (typeof showMktSection === 'function') showMktSection(_mktActiveSection);
    }
    // Request Game — lazy-load (fetch HubCap browse cuma dilakukan saat
    // halaman ini benar-benar dibuka, BUKAN dipanggil dari initAppShellDemo()
    // seperti Marketplace, supaya tidak ada API request ke HubCap yang
    // tidak perlu tiap kali app dibuka/login).
    if (page === 'requestgame' && typeof loadRequestGamePage === 'function') {
      loadRequestGamePage();
    }
    // Transaksi — tarik ulang riwayat gabungan terbaru tiap kali halaman ini
    // dibuka (pola sama dengan history/setting/belipaket di atas).
    if (page === 'transaksi' && typeof loadTransaksiPage === 'function') {
      loadTransaksiPage();
    }
    // DASHBOARD BANNER CAROUSEL — autoplay cuma jalan "selama halaman
    // Dashboard aktif" (poin permintaan AUTO SLIDE). Pindah ke halaman lain
    // -> pause; balik ke Dashboard -> jalan lagi otomatis (lihat
    // _dashCarouselSetHomeActive() di blok DASHBOARD HERO BANNER di atas).
    if (typeof _dashCarouselSetHomeActive === 'function') {
      _dashCarouselSetHomeActive(page === 'home');
    }
  }

  /* ---------- profile menu ---------- */
  function toggleProfileMenu(){
    const menu = document.getElementById('profileMenu');
    const btn = document.getElementById('profileBtn');
    const open = menu.classList.toggle('open');
    btn.setAttribute('aria-expanded', open);
  }
  // Dipakai tombol X (#pmCloseBtn), klik di luar menu, DAN tombol Escape —
  // satu fungsi supaya ketiganya selalu konsisten (tidak ada state nyangkut).
  function closeProfileMenu(){
    const menu = document.getElementById('profileMenu');
    const btn = document.getElementById('profileBtn');
    menu.classList.remove('open');
    btn.setAttribute('aria-expanded','false');
  }
  document.addEventListener('click', (e)=>{
    const menu = document.getElementById('profileMenu');
    const btn = document.getElementById('profileBtn');
    if(!menu.contains(e.target) && !btn.contains(e.target)){
      closeProfileMenu();
    }
  });
  document.addEventListener('keydown', (e)=>{
    if(e.key === 'Escape'){
      const menu = document.getElementById('profileMenu');
      if(menu.classList.contains('open')) closeProfileMenu();
    }
  });

  /* =====================================================
     REDEEM VOUCHER — popup dibuka dari Profile Dropdown.
     ---------------------------------------------------
     TIDAK ADA sistem/model/API voucher baru di sini. Semua data & logic
     redeem 100% REUSE backend existing:
       - GET  /api/voucher/available -> voucherManager.listVouchers() +
         hasClaimed() (lihat server.js), read-only, cuma nyaring voucher
         yang BENERAN boleh ditampilkan ke user ini sekarang.
       - POST /api/voucher/claim -> voucherManager.claimVoucher() (unique
         index + atomic quota, TIDAK berubah), sudah ada SEBELUM fitur ini.
     Backend tetap authority penuh: kode/kuota/expired/eligibility semua
     divalidasi ulang di server saat redeem, popup ini tidak pernah
     memutuskan sukses/gagal sendiri dari data frontend.
     Efek sukses (role/activeUntil/limit/Profile Grid/dll) datang lewat
     event realtime 'account:update' yang SUDAH di-broadcast server.js
     (pushAccountUpdate) persis seperti alur Gold Trial/Beli Paket -> sudah
     ditangani handleAccountUpdate(), TIDAK ADA kode tambahan di sini untuk
     itu (lihat catatan claimGoldTrialFromModal() di atas, pola sama).
  ===================================================== */
  let _rvClaiming = false;

  async function openRedeemVoucherModal(){
    const modal = document.getElementById('redeemVoucherModal');
    if (!modal) return;
    // Reset ke state bersih setiap dibuka — popup lama TIDAK PERNAH
    // menyisakan kode/error dari percobaan sebelumnya.
    const input = document.getElementById('rvCodeInput');
    const errorEl = document.getElementById('rvError');
    if (input) { input.value = ''; input.disabled = false; }
    if (errorEl) { errorEl.hidden = true; errorEl.textContent = ''; }
    resetRedeemVoucherButton();
    modal.classList.add('show');
    if (input) setTimeout(() => input.focus(), 50);
    // Requirement #13 — saat popup dibuka, ambil data voucher tersedia yang
    // TERBARU dari backend (bukan cache lama), tanpa perlu Socket.IO baru.
    await loadRedeemVoucherAvailable();
  }

  // Dipakai tombol X, tombol "Tutup", klik di luar box, DAN Escape — SATU
  // fungsi supaya konsisten, dan sama sekali TIDAK melakukan redeem atau
  // mengubah state apa pun selain menutup popup (requirement #3).
  function closeRedeemVoucherModal(){
    if (_rvClaiming) return; // sedang proses redeem -> jangan bisa ditutup paksa
    document.getElementById('redeemVoucherModal')?.classList.remove('show');
  }

  async function loadRedeemVoucherAvailable(){
    const section = document.getElementById('rvAvailableSection');
    const list = document.getElementById('rvAvailableList');
    if (!section || !list) return;
    try {
      const data = await api('/api/voucher/available');
      const vouchers = Array.isArray(data.vouchers) ? data.vouchers : [];
      // Requirement #7 — tidak ada voucher aktif -> section disembunyikan
      // total, TIDAK PERNAH menampilkan "undefined"/"null"/placeholder palsu.
      if (!vouchers.length) { section.hidden = true; list.innerHTML = ''; return; }
      list.innerHTML = vouchers.map(v => `
        <button type="button" class="rv-available-chip" onclick="applyRedeemVoucherCode('${v.code.replace(/'/g, "\\'")}')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><use href="#ic-ticket"></use></svg>
          <span>${v.code}</span>
        </button>`).join('');
      section.hidden = false;
    } catch (e) {
      // Gagal ambil data (mis. offline sesaat) -> jangan tampilkan section
      // palsu, cukup sembunyikan; input kode manual tetap bisa dipakai.
      section.hidden = true;
      list.innerHTML = '';
    }
  }

  // Klik salah satu chip "Voucher Tersedia" -> isi otomatis ke input (user
  // tetap harus klik "Redeem Voucher" sendiri, tidak auto-submit).
  function applyRedeemVoucherCode(code){
    const input = document.getElementById('rvCodeInput');
    if (!input) return;
    input.value = code;
    input.focus();
  }

  function resetRedeemVoucherButton(){
    const btn = document.getElementById('rvSubmitBtn');
    const label = document.getElementById('rvSubmitLabel');
    if (btn) { btn.disabled = false; btn.classList.remove('is-loading'); }
    if (label) label.textContent = 'Redeem Voucher';
    const icon = btn?.querySelector('svg');
    if (icon) icon.classList.remove('icon-spin');
  }

  function showRedeemVoucherError(message){
    const errorEl = document.getElementById('rvError');
    if (!errorEl) return;
    errorEl.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:15px;height:15px;flex:none;"><use href="#ic-circle-x"></use></svg><span></span>`;
    errorEl.querySelector('span').textContent = message;
    errorEl.hidden = false;
  }

  // Tombol "Redeem Voucher" di popup — satu-satunya endpoint yang dipanggil
  // tetap POST /api/voucher/claim existing (lihat komentar blok di atas).
  async function submitRedeemVoucher(){
    if (_rvClaiming) return; // cegah double-submit/double-click (requirement #12)
    const input = document.getElementById('rvCodeInput');
    const btn = document.getElementById('rvSubmitBtn');
    const label = document.getElementById('rvSubmitLabel');
    const errorEl = document.getElementById('rvError');
    if (!input || !btn) return;

    // trim whitespace saja — TIDAK mengubah case/format kode secara sepihak,
    // validasi/normalisasi final tetap wewenang backend (voucherManager).
    const code = input.value.trim();
    if (errorEl) errorEl.hidden = true;
    if (!code) { showRedeemVoucherError('Kode voucher wajib diisi.'); return; }

    _rvClaiming = true;
    input.disabled = true;
    btn.disabled = true;
    if (label) label.textContent = 'Memproses...';
    btn.classList.add('is-loading');
    const icon = btn.querySelector('svg');
    if (icon) icon.classList.add('icon-spin');

    try {
      const result = await api('/api/voucher/claim', { method: 'POST', body: JSON.stringify({ code }) });
      // Sukses — popup ditutup & notifikasi premium existing (showToast,
      // TIDAK ADA sistem notifikasi baru). Reward/role/activeUntil/Profile
      // Grid/limit semua ikut update sendiri lewat 'account:update' realtime
      // yang sudah di-broadcast server (pushAccountUpdate), TIDAK di-hardcode
      // di sini — wording notifikasi pakai data asli dari response backend.
      document.getElementById('redeemVoucherModal')?.classList.remove('show');
      const roleLabel = result.role ? (PACKAGE_BADGES[result.role]?.label || result.role) : null;
      const detail = roleLabel && result.durationLabel
        ? `Paket ${roleLabel} kamu ${result.extended ? 'diperpanjang' : 'aktif'} ${result.durationLabel}.`
        : undefined;
      showToast('success', 'Voucher berhasil diredeem.', detail);
    } catch (e) {
      // Gagal — TETAP di popup, tampilkan pesan yang backend kirim apa
      // adanya (mapping VOUCHER_FAIL_MESSAGE existing di server.js, TIDAK
      // di-hardcode ulang di sini), user bisa langsung coba kode lain
      // (requirement #11) tanpa perlu menutup popup.
      showRedeemVoucherError(e.message || 'Voucher tidak dapat diredeem.');
    } finally {
      _rvClaiming = false;
      input.disabled = false;
      resetRedeemVoucherButton();
    }
  }

  document.getElementById('redeemVoucherModal')?.addEventListener('click', (e) => {
    if (e.target && e.target.id === 'redeemVoucherModal') closeRedeemVoucherModal();
  });
  document.getElementById('rvCodeInput')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitRedeemVoucher();
  });
  document.addEventListener('keydown', (e)=>{
    if(e.key === 'Escape'){
      const modal = document.getElementById('redeemVoucherModal');
      if(modal && modal.classList.contains('show')) closeRedeemVoucherModal();
    }
  });

  /* =====================================================
     EDIT PROFIL — popup dibuka dari Profile Dropdown (menggantikan alert()
     lama di tombol "Profile", lihat #editProfileModal di index.html).
     ---------------------------------------------------
     TIDAK ADA backend/database/endpoint/Socket.IO baru di sini. Semua data
     & logic 100% REUSE backend existing:
       - GET  /api/profile       -> profileManager.getProfile() (App +
         Discord read-only, SUDAH fallback ke data Discord kalau field
         profil App masih kosong lewat toProfilePayload()).
       - PUT  /api/profile       -> profileManager.updateProfile()
         (displayName/username/bio — validasi format & unique-check
         username TETAP wewenang backend, di sini cuma validasi ringan
         supaya user langsung tau tanpa round-trip).
       - POST /api/profile/photo -> profileManager.savePhoto() (base64 data
         URL — batas ASLI (3MB, mime PNG/JPG/WEBP) tetap divalidasi ULANG
         di backend meski sudah dicek client-side juga di sini).
     Realtime (account:update ke SEMUA device App user ini, user:update ke
     Admin Web) SUDAH otomatis jalan lewat broadcastProfileChanged() begitu
     PUT/POST di atas sukses (lihat server.js) -> ditangani
     handleAccountUpdate() yang SUDAH ADA lewat _ws.onmessage (lihat
     renderProfileIdentity() dipanggil di dalamnya) — TIDAK ADA
     listener/socket baru ditambahkan di sini, sidebar/profile-name App
     ikut berubah dengan sendirinya begitu event itu tiba.
     Data Discord (avatarUrl/discordUsername/discordId) ditampilkan
     read-only saja ("Terhubung sebagai @discordUsername"), tidak pernah
     dikirim balik ke server dari popup ini.
  ===================================================== */
  let _epInitial = null;      // snapshot { displayName, username, bio } saat popup dibuka — dipakai supaya PUT cuma kirim field yang BENERAN berubah
  let _epSaving = false;
  let _epUploadingPhoto = false;

  const EP_PHOTO_MAX_BYTES = 3 * 1024 * 1024; // 3MB, sama dengan PHOTO_MAX_BYTES di profileManager.js
  const EP_ALLOWED_MIME = ['image/png', 'image/jpeg', 'image/webp'];
  const EP_USERNAME_RE = /^[a-z][a-z0-9_]{2,19}$/; // sama dengan USERNAME_RE di profileManager.js

  // Fallback avatar kalau foto profil App belum diisi/gagal dimuat — inisial
  // nama dengan gradient background (tetap terasa didesain), BUKAN kotak
  // abu-abu polos.
  function epInitialsAvatar(name){
    const initials = String(name || '?').trim().split(/\s+/).slice(0, 2)
      .map(w => w[0] || '').join('').toUpperCase() || '?';
    return `<span class="ep-avatar-initials">${escapeHtml(initials)}</span>`;
  }

  function epRenderAvatar(photoUrl, name){
    const avatarEl = document.getElementById('epAvatar');
    if (!avatarEl) return;
    if (photoUrl) {
      avatarEl.innerHTML = `<img alt="Foto profil">`;
      const img = avatarEl.querySelector('img');
      img.onerror = () => { avatarEl.innerHTML = epInitialsAvatar(name); };
      img.src = photoUrl;
    } else {
      avatarEl.innerHTML = epInitialsAvatar(name);
    }
  }

  function epUpdateBioCounter(){
    const bioInput = document.getElementById('epBioInput');
    const counter = document.getElementById('epBioCounter');
    if (!bioInput || !counter) return;
    const len = bioInput.value.length;
    counter.textContent = `${len}/160`;
    counter.classList.toggle('ep-bio-counter-warn', len >= 140 && len < 160);
    counter.classList.toggle('ep-bio-counter-limit', len >= 160);
  }
  document.getElementById('epBioInput')?.addEventListener('input', epUpdateBioCounter);

  function showEditProfileError(message){
    const errorEl = document.getElementById('epError');
    if (!errorEl) return;
    errorEl.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:15px;height:15px;flex:none;"><use href="#ic-circle-x"></use></svg><span></span>`;
    errorEl.querySelector('span').textContent = message;
    errorEl.hidden = false;
  }

  function resetEditProfileSaveButton(){
    const btn = document.getElementById('epSaveBtn');
    const label = document.getElementById('epSaveBtnLabel');
    if (btn) { btn.disabled = false; btn.classList.remove('is-loading'); }
    if (label) label.textContent = 'Simpan Perubahan';
    const icon = btn?.querySelector('svg');
    if (icon) icon.classList.remove('icon-spin');
  }

  // Isi popup dari response GET /api/profile — dipanggil setiap popup
  // dibuka supaya datanya SELALU terbaru (bukan cache lama).
  function epApplyProfileData(data){
    const app = data?.app || {};
    const discord = data?.discord || {};

    epRenderAvatar(app.photoUrl, app.displayName || discord.username);

    const nameInput = document.getElementById('epDisplayNameInput');
    const usernameInput = document.getElementById('epUsernameInput');
    const bioInput = document.getElementById('epBioInput');
    if (nameInput) nameInput.value = app.displayName || '';
    if (usernameInput) usernameInput.value = app.username || '';
    if (bioInput) bioInput.value = app.bio || '';
    epUpdateBioCounter();

    // Snapshot NILAI AWAL apa adanya dari backend (bukan dari input) —
    // dipakai submitEditProfile() supaya PUT cuma kirim field yang memang
    // diubah user, bukan semua field tiap kali simpan.
    _epInitial = {
      displayName: app.displayName || '',
      username: app.username || '',
      bio: app.bio || ''
    };

    // Info Discord — read-only, kecil & rapi, TIDAK bisa diedit dari sini.
    const discordAvatarEl = document.getElementById('epDiscordAvatar');
    if (discordAvatarEl) {
      discordAvatarEl.innerHTML = discord.avatarUrl
        ? `<img src="${escapeHtml(discord.avatarUrl)}" alt="" onerror="this.style.display='none';">`
        : '';
    }
    const discordUsernameEl = document.getElementById('epDiscordUsername');
    if (discordUsernameEl) discordUsernameEl.textContent = discord.username ? '@' + discord.username : '—';
  }

  async function openEditProfileModal(){
    const modal = document.getElementById('editProfileModal');
    if (!modal) return;
    // Reset ke state bersih setiap dibuka — popup lama TIDAK PERNAH
    // menyisakan error/loading state dari percobaan sebelumnya.
    _epSaving = false;
    _epUploadingPhoto = false;
    const errorEl = document.getElementById('epError');
    if (errorEl) { errorEl.hidden = true; errorEl.textContent = ''; }
    resetEditProfileSaveButton();
    document.getElementById('epAvatarSpinner')?.setAttribute('hidden', '');
    document.getElementById('epAvatarWrap')?.classList.remove('is-uploading');
    const photoInput = document.getElementById('epPhotoInput');
    if (photoInput) photoInput.value = '';
    const nameInput = document.getElementById('epDisplayNameInput');
    const usernameInput = document.getElementById('epUsernameInput');
    const bioInput = document.getElementById('epBioInput');
    if (nameInput) nameInput.disabled = false;
    if (usernameInput) usernameInput.disabled = false;
    if (bioInput) bioInput.disabled = false;

    // Tampilkan dulu data ringkas dari currentUser (kalau ada) supaya popup
    // tidak kosong total sambil nunggu network, lalu ditimpa data ASLI dari
    // GET /api/profile di bawah begitu selesai.
    if (currentUser) epRenderAvatar(currentUser.avatarUrl, currentUser.username);

    modal.classList.add('show');
    if (nameInput) setTimeout(() => nameInput.focus(), 50);

    try {
      const data = await api('/api/profile');
      epApplyProfileData(data);
    } catch (e) {
      showEditProfileError(e.message || 'Gagal memuat data profil.');
    }
  }

  // Dipakai tombol X, tombol "Batal", DAN klik di luar box/Escape — SATU
  // fungsi supaya konsisten, tidak melakukan perubahan apa pun selain
  // menutup popup.
  function closeEditProfileModal(){
    if (_epSaving || _epUploadingPhoto) return; // sedang proses -> jangan bisa ditutup paksa
    document.getElementById('editProfileModal')?.classList.remove('show');
  }

  /* ---- Ganti Foto ---- */
  document.getElementById('epAvatarWrap')?.addEventListener('click', () => {
    if (_epUploadingPhoto) return;
    document.getElementById('epPhotoInput')?.click();
  });
  document.getElementById('epAvatarWrap')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); document.getElementById('epPhotoInput')?.click(); }
  });

  document.getElementById('epPhotoInput')?.addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = ''; // reset supaya pilih file yang SAMA lagi tetap trigger change berikutnya
    if (!file) return;
    const errorEl = document.getElementById('epError');
    if (errorEl) errorEl.hidden = true;

    // Validasi CLIENT-SIDE dulu (format & ukuran max 3MB) supaya user
    // langsung tau tanpa nunggu round-trip ke server — batas ASLI tetap
    // divalidasi ULANG di backend (savePhoto() di profileManager.js),
    // validasi di sini bukan satu-satunya pertahanan.
    if (!EP_ALLOWED_MIME.includes(file.type)) {
      showEditProfileError('Format foto harus PNG, JPG, atau WEBP.');
      return;
    }
    if (file.size > EP_PHOTO_MAX_BYTES) {
      showEditProfileError('Ukuran foto maksimal 3MB.');
      return;
    }

    let dataUrl;
    try {
      dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('Gagal membaca file gambar.'));
        reader.readAsDataURL(file);
      });
    } catch (err) {
      showEditProfileError(err.message);
      return;
    }

    // Preview instan (optimistic) sambil upload jalan di background.
    const avatarEl = document.getElementById('epAvatar');
    const prevHtml = avatarEl ? avatarEl.innerHTML : '';
    if (avatarEl) avatarEl.innerHTML = `<img src="${dataUrl}" alt="Foto profil">`;

    _epUploadingPhoto = true;
    document.getElementById('epAvatarSpinner')?.removeAttribute('hidden');
    document.getElementById('epAvatarWrap')?.classList.add('is-uploading');

    try {
      const result = await api('/api/profile/photo', { method: 'POST', body: JSON.stringify({ imageBase64: dataUrl }) });
      // Sukses — pakai URL ASLI dari server (persisten & sudah termasuk
      // cache-busting ?v=timestamp, lihat savePhoto()), bukan data URL
      // sementara di atas.
      epRenderAvatar(result?.app?.photoUrl, result?.app?.displayName || document.getElementById('epDisplayNameInput')?.value);
      showToast('success', 'Foto profil berhasil diganti.');
      // Sidebar/profile-name App ikut berubah otomatis lewat
      // handleAccountUpdate() yang dipicu event WS 'account:update'
      // (broadcastProfileChanged() di server.js) — TIDAK ADA refresh
      // manual tambahan di sini.
    } catch (err) {
      if (avatarEl) avatarEl.innerHTML = prevHtml; // gagal -> balikin avatar sebelumnya
      showEditProfileError(err.message || 'Gagal mengganti foto profil.');
    } finally {
      _epUploadingPhoto = false;
      document.getElementById('epAvatarSpinner')?.setAttribute('hidden', '');
      document.getElementById('epAvatarWrap')?.classList.remove('is-uploading');
    }
  });

  /* ---- Simpan Perubahan (Display Name/Username/Bio) ---- */
  async function submitEditProfile(){
    if (_epSaving) return; // cegah double-submit/double-click
    const nameInput = document.getElementById('epDisplayNameInput');
    const usernameInput = document.getElementById('epUsernameInput');
    const bioInput = document.getElementById('epBioInput');
    const btn = document.getElementById('epSaveBtn');
    const label = document.getElementById('epSaveBtnLabel');
    const errorEl = document.getElementById('epError');
    if (!nameInput || !usernameInput || !bioInput || !btn) return;
    if (errorEl) errorEl.hidden = true;

    const displayName = nameInput.value.trim();
    const usernameRaw = usernameInput.value.trim().toLowerCase();
    const bio = bioInput.value;

    // Validasi RINGAN di sisi client (batas panjang/format) supaya user
    // langsung tau tanpa round-trip — validasi FINAL (termasuk cek username
    // sudah dipakai orang lain) TETAP sepenuhnya wewenang backend.
    if (displayName.length < 2 || displayName.length > 32) {
      showEditProfileError('Display Name harus 2-32 karakter.');
      return;
    }
    if (usernameRaw && !EP_USERNAME_RE.test(usernameRaw)) {
      showEditProfileError('Username 3-20 karakter, huruf kecil/angka/underscore, wajib diawali huruf.');
      return;
    }
    if (!usernameRaw && _epInitial && _epInitial.username) {
      showEditProfileError('Username tidak boleh dikosongkan setelah pernah diatur.');
      return;
    }
    if (bio.length > 160) {
      showEditProfileError('Bio maksimal 160 karakter.');
      return;
    }

    // Kirim CUMA field yang memang berubah dari nilai awal (snapshot saat
    // popup dibuka/terakhir sukses simpan), bukan semua field tiap kali
    // simpan.
    const patch = {};
    if (!_epInitial || displayName !== _epInitial.displayName) patch.displayName = displayName;
    if (usernameRaw && (!_epInitial || usernameRaw !== _epInitial.username)) patch.username = usernameRaw;
    if (!_epInitial || bio !== _epInitial.bio) patch.bio = bio;

    if (!Object.keys(patch).length) {
      // Tidak ada perubahan sama sekali -> tutup popup saja, tidak perlu
      // panggil API sia-sia.
      closeEditProfileModal();
      return;
    }

    _epSaving = true;
    nameInput.disabled = true; usernameInput.disabled = true; bioInput.disabled = true;
    btn.disabled = true;
    if (label) label.textContent = 'Menyimpan...';
    btn.classList.add('is-loading');
    const icon = btn.querySelector('svg');
    if (icon) icon.classList.add('icon-spin');

    try {
      const result = await api('/api/profile', { method: 'PUT', body: JSON.stringify(patch) });
      // Snapshot nilai awal ikut diperbarui supaya kalau user buka lagi
      // tanpa reload App, perbandingan "field yang berubah" tetap akurat.
      _epInitial = {
        displayName: result?.app?.displayName ?? displayName,
        username: result?.app?.username ?? usernameRaw,
        bio: result?.app?.bio ?? bio
      };
      document.getElementById('editProfileModal')?.classList.remove('show');
      showToast('success', 'Profil berhasil diperbarui.');
      // Sidebar/profile-name App ikut berubah otomatis lewat
      // handleAccountUpdate() yang dipicu event WS 'account:update'
      // (broadcastProfileChanged() di server.js) — TIDAK ADA refresh
      // manual tambahan di sini.
    } catch (err) {
      // Gagal (mis. username sudah dipakai orang lain) — TETAP di popup,
      // tampilkan pesan ASLI dari backend apa adanya, user bisa langsung
      // perbaiki tanpa perlu menutup popup dulu.
      showEditProfileError(err.message || 'Gagal menyimpan perubahan profil.');
    } finally {
      _epSaving = false;
      nameInput.disabled = false; usernameInput.disabled = false; bioInput.disabled = false;
      resetEditProfileSaveButton();
    }
  }

  document.getElementById('editProfileModal')?.addEventListener('click', (e) => {
    if (e.target && e.target.id === 'editProfileModal') closeEditProfileModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const modal = document.getElementById('editProfileModal');
      if (modal && modal.classList.contains('show')) closeEditProfileModal();
    }
  });

  /* ---------- window controls ---------- */
  const app = document.getElementById('app');
  const maxIcon = document.getElementById('maxIcon');
  const RESTORE_ICON = '<rect x="3.2" y="1.5" width="7.3" height="7.3" stroke="currentColor" stroke-width="1.1" fill="none"/><rect x="1.5" y="3.2" width="7.3" height="7.3" stroke="currentColor" stroke-width="1.1" fill="none"/>';
  const MAX_ICON = '<rect x="1.5" y="1.5" width="9" height="9" stroke="currentColor" stroke-width="1.2" fill="none"/>';

  // Kalau app ini jalan di dalam Electron (lihat preload.js), window.electronAPI
  // tersedia -> tombol titlebar kustom di bawah ini memanggil aksi window ASLI
  // (minimize/maximize/close beneran), bukan cuma simulasi CSS. Kalau dibuka
  // langsung di browser biasa (tanpa Electron), otomatis fallback ke simulasi
  // lama supaya demo tetap jalan seperti sebelumnya.
  const isElectron = typeof window.electronAPI !== 'undefined';

  function toggleMaximize(){
    if (isElectron) { window.electronAPI.toggleMaximize(); return; }
    const windowed = app.classList.toggle('windowed');
    maxIcon.innerHTML = windowed ? RESTORE_ICON : MAX_ICON;
    app.title = windowed ? 'Maximize' : 'Restore';
  }

  function minimizeApp(){
    if (isElectron) { window.electronAPI.minimize(); return; }
    app.classList.add('minimized');
    document.getElementById('taskbarPill').classList.add('show');
  }
  function restoreApp(){
    app.classList.remove('minimized');
    document.getElementById('taskbarPill').classList.remove('show');
  }

  function requestClose(){ document.getElementById('confirmOverlay').classList.add('show'); }
  function cancelClose(){ document.getElementById('confirmOverlay').classList.remove('show'); }
  function confirmClose(){
    document.getElementById('confirmOverlay').classList.remove('show');
    if (isElectron) { window.electronAPI.close(); return; }
    app.classList.add('closed');
    document.getElementById('taskbarPill').classList.remove('show');
    document.getElementById('closedScreen').classList.add('show');
  }
  function reopenApp(){
    app.classList.remove('closed');
    document.getElementById('closedScreen').classList.remove('show');
  }

  // Sinkronkan ikon Maximize/Restore kalau window di-maximize/restore lewat cara
  // LAIN selain tombol ini (double-click titlebar, drag ke tepi layar/Aero Snap).
  if (isElectron) {
    window.electronAPI.onMaximizedChange((isMaximized) => {
      maxIcon.innerHTML = isMaximized ? RESTORE_ICON : MAX_ICON;
      app.title = isMaximized ? 'Restore' : 'Maximize';
    });
  }

  document.addEventListener('keydown', (e)=>{
    if(e.key === 'Escape') cancelClose();
  });

  /* =====================================================
     Detail page (Game / Bypass) — DEMO
     ---------------------------------------------------
     No backend here (same demo-only note as the Histori
     section above). Clicking a card generates plausible,
     deterministic-per-title detail data on the client (so
     the same card always shows the same "fake" detail),
     renders it into #page-detail, and wires the bottom
     action bar to a simulated install/activation progress
     bar. Swap generateGameDetail()/generateBypassDetail()
     for real API/DB calls and this rendering + progress-bar
     UI can stay as-is.
  ===================================================== */
  const DETAIL_ICONS = {
    arrowLeft: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>',
    zap: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 4 14 12 14 11 22 20 10 12 10 13 2"/></svg>',
    shieldCheck: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/></svg>',
    shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
    wifiOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="2" y1="2" x2="22" y2="22"/><path d="M8.5 16.5a5 5 0 0 1 7 0"/><path d="M5 12.5a10 10 0 0 1 5.5-3.5"/><path d="M19 12.5a10 10 0 0 0-2.5-2.2"/><path d="M2 8.5a15 15 0 0 1 4-2.7"/><path d="M22 8.5a15 15 0 0 0-8-4"/><line x1="12" y1="20" x2="12.01" y2="20"/></svg>',
    globe: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><line x1="3" y1="12" x2="21" y2="12"/><path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18z"/></svg>',
    gamepad: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="8" width="20" height="10" rx="5"/><line x1="6" y1="11" x2="6" y2="15"/><line x1="4" y1="13" x2="8" y2="13"/><circle cx="16" cy="11" r=".6"/><circle cx="18" cy="14" r=".6"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>'
  };

  /* ---- deterministic "random" helpers, seeded by title ----
     Same card title always produces the same demo data, so the
     detail page doesn't reshuffle every time you reopen it. */
  function hashStr(str){
    let h = 0;
    for(let i=0;i<str.length;i++){ h = (Math.imul(31,h) + str.charCodeAt(i)) | 0; }
    return Math.abs(h);
  }
  function extractSteamAppId(src){
    const m = src && src.match(/steam\/apps\/(\d+)\//);
    return m ? m[1] : null;
  }
  function seededDate(seed, minYear, maxYear){
    const span = maxYear - minYear + 1;
    const year = minYear + (seed % span);
    const month = Math.floor(seed / 7) % 12;
    const day = 1 + (seed % 28);
    return new Date(year, month, day);
  }
  function formatLongDate(d){
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
  }
  function seededShuffle(arr, seed){
    return arr.slice().sort((a,b) => (hashStr(a+seed) % 13) - (hashStr(b+seed) % 13));
  }

  const DEV_PUBLISHER_POOL = [
    { dev:'Nightfall Interactive', pub:'Aurora Games' },
    { dev:'Ember Peak Studios', pub:'Northlight Publishing' },
    { dev:'Glasswing Softworks', pub:'Vanta Interactive' },
    { dev:'Redline Forge', pub:'Ironvale Studios' },
    { dev:'Hollow Pine Games', pub:'Driftwood Publishing' },
    { dev:'Static Owl Studio', pub:'Cobalt Frame' },
    { dev:'Pinefall Games', pub:'Meridian Play' },
    { dev:'Copper Frog Studio', pub:'Lanternlight Games' }
  ];
  const GAME_DESC_TEMPLATES = [
    t => `Jelajahi dunia ${t} dengan gameplay yang dirancang untuk pengalaman seru, baik dimainkan sendiri maupun bareng teman. Visual detail, kontrol responsif, dan konten yang terus diperbarui.`,
    t => `${t} menghadirkan pengalaman bermain yang imersif dengan progression yang mendalam dan tantangan yang terus berkembang di setiap tahap permainan.`,
    t => `Rasakan sensasi bermain ${t} dengan performa yang dioptimalkan, kontrol presisi, dan berbagai mode permainan untuk dinikmati kapan saja.`,
    t => `${t} cocok buat kamu yang cari pengalaman kompetitif maupun santai, lengkap dengan sistem progression dan komunitas yang aktif.`,
    t => `Bangun strategi, kuasai peta, dan taklukkan tantangan di ${t} — game yang terus mendapat pembaruan konten dan perbaikan performa.`
  ];
  const GAME_TAGS_POOL = ['Single-player','Multi-player','Co-op','Online Co-op','PvP','Online PvP','Steam Achievements','Full controller support','Steam Cloud','Steam Trading Cards','Remote Play on TV','Captions available','Steam Workshop','Action','Adventure','Racing','Simulation','Strategy','Open World','Survival','Sandbox','Family Sharing','Cross-Platform Multiplayer'];
  const REQ_PROFILES = [
    { minimum:{os:'Windows 10 64-bit', cpu:'Intel Core i3-4160 / AMD FX-6300', ram:'8 GB RAM', gpu:'NVIDIA GTX 660 (2GB) / AMD Radeon HD 7850', storage:'25 GB available space'},
      recommended:{os:'Windows 10/11 64-bit', cpu:'Intel Core i5-7500 / AMD Ryzen 5 1600', ram:'12 GB RAM', gpu:'NVIDIA GTX 1060 (6GB) / AMD RX 580', storage:'25 GB available space'} },
    { minimum:{os:'Windows 10 64-bit', cpu:'Intel Core i5-4460 / AMD FX-8350', ram:'8 GB RAM', gpu:'NVIDIA GTX 970 (4GB) / AMD R9 290', storage:'50 GB available space'},
      recommended:{os:'Windows 11 64-bit', cpu:'Intel Core i7-8700 / AMD Ryzen 5 3600', ram:'16 GB RAM', gpu:'NVIDIA RTX 2060 (6GB) / AMD RX 5700', storage:'50 GB available space'} },
    { minimum:{os:'Windows 10 64-bit (latest SP)', cpu:'Intel Core i7-4770 / AMD FX-9590', ram:'8 GB RAM', gpu:'NVIDIA GTX 1630 (4GB) / AMD RX 6400 (4GB)', storage:'105 GB available space'},
      recommended:{os:'Windows 11 64-bit', cpu:'Intel Core i5-9600K / AMD Ryzen 5 3600', ram:'16 GB RAM', gpu:'NVIDIA RTX 3060 (8GB) / AMD RX 6600 XT (8GB)', storage:'105 GB available space'} }
  ];
  const BYPASS_TYPE_POOL = ['Anti-Cheat Bypass','DRM Bypass','Online Bypass','License Bypass'];
  const BYPASS_TAGS_POOL = ['Anti-Cheat Bypass','DRM Bypass','Online Bypass','Auto Update','Low Detection Risk','No Reinstall Needed','Steam Overlay Compatible','One-Click Activation'];
  const BYPASS_DESC_TEMPLATES = [
    g => `Bypass ini memungkinkan kamu menjalankan ${g} tanpa hambatan proteksi tambahan, dengan proses aktivasi yang cepat dan aman.`,
    g => `Aktifkan bypass untuk ${g} dan langsung mainkan tanpa perlu konfigurasi manual. Update otomatis mengikuti versi game terbaru.`,
    g => `Dirancang khusus untuk ${g}, bypass ini menjaga kompatibilitas dengan versi terbaru sambil meminimalkan risiko deteksi.`,
    g => `Satu klik aktivasi untuk ${g} — bypass berjalan di background dan otomatis nonaktif saat game ditutup.`
  ];

  function generateGameDetail(title, image){
    const seed = hashStr(title);
    const devPair = DEV_PUBLISHER_POOL[seed % DEV_PUBLISHER_POOL.length];
    const appId = extractSteamAppId(image) || String(100000 + (seed % 899999));
    const hasMeta = (seed % 5) !== 0;
    const reqProfile = REQ_PROFILES[seed % REQ_PROFILES.length];
    const shuffledTags = seededShuffle(GAME_TAGS_POOL, title);
    return {
      kind:'game', title, image, appId,
      developer: devPair.dev, publisher: devPair.pub,
      description: GAME_DESC_TEMPLATES[seed % GAME_DESC_TEMPLATES.length](title),
      releaseDate: formatLongDate(seededDate(seed, 2016, 2025)),
      metacritic: hasMeta ? 55 + (seed % 41) : null,
      isOnline: (seed % 3) !== 0,
      tags: shuffledTags.slice(0, 8 + (seed % 6)),
      reqProfile,
      bypassAvailable: (seed % 4) !== 0
    };
  }
  function generateBypassDetail(gameTitle, image){
    const seed = hashStr(gameTitle + '::bypass');
    const appId = extractSteamAppId(image) || String(100000 + (seed % 899999));
    const shuffledTags = seededShuffle(BYPASS_TAGS_POOL, gameTitle + 'b');
    return {
      kind:'bypass', title:`${gameTitle} Bypass`, compatibleGame: gameTitle, image, appId,
      bypassType: BYPASS_TYPE_POOL[seed % BYPASS_TYPE_POOL.length],
      status: (seed % 6 === 0) ? 'Beta' : 'Active',
      version: `v${1 + (seed % 4)}.${seed % 10}.${Math.floor(seed/8) % 9}`,
      updatedAt: formatLongDate(seededDate(seed, 2024, 2026)),
      description: BYPASS_DESC_TEMPLATES[seed % BYPASS_DESC_TEMPLATES.length](gameTitle),
      tags: shuffledTags.slice(0, 5 + (seed % 3)),
      reqProfile: REQ_PROFILES[seed % REQ_PROFILES.length]
    };
  }

  /* Dashboard "New Games" TIDAK punya daftar game sendiri -- grid-nya
     (#dashNewGamesGrid) sengaja kosong di HTML dan diisi di sini dengan
     meng-clone SEMUA kartu game dari halaman Games (#page-mygames .grid),
     supaya Dashboard selalu menampilkan katalog game yang sama persis
     dengan halaman Games (bukan daftar terpisah yang bisa jadi tidak
     sinkron). Dipanggil PALING AKHIR di urutan init di bawah file ini --
     setelah renderPackageBadges() jalan di kartu asli (#page-mygames),
     supaya badge PUBLIC/GOLD/PLATINUM ikut ke-clone dalam kondisi sudah
     ter-render (tidak perlu render ulang utk kartu hasil clone). Listener
     klik kartu (initCardClickToDetail) sudah attached di level grid
     (event delegation), jadi otomatis ikut berlaku juga utk kartu yang
     baru ditambahkan lewat clone ini. */
  function populateDashboardNewGames(){
    const source = document.querySelector('#page-mygames .grid');
    const target = document.getElementById('dashNewGamesGrid');
    if(!source || !target) return;
    target.innerHTML = '';
    source.querySelectorAll('.card').forEach(card => {
      const clone = card.cloneNode(true);
      // Kartu asli bisa lagi 'display:none' kalau kebetulan halaman Games
      // sedang difilter -- reset supaya SEMUA game tetap tampil di Dashboard.
      clone.style.display = '';
      target.appendChild(clone);
    });
  }

  function findGameCardByTitle(title){
    try{
      return document.querySelector('#page-mygames .grid .card[data-title="' + CSS.escape(title) + '"]');
    }catch(e){ return null; }
  }

  function renderReqList(id, req){
    document.getElementById(id).innerHTML = `
      <li><strong>OS:</strong> ${req.os}</li>
      <li><strong>Processor:</strong> ${req.cpu}</li>
      <li><strong>Memory:</strong> ${req.ram}</li>
      <li><strong>Graphics:</strong> ${req.gpu}</li>
      <li><strong>Storage:</strong> ${req.storage}</li>
    `;
  }

  let currentDetail = null;     // { type, title, image } — what was clicked
  let currentDetailData = null; // generated detail object (game or bypass)
  let activeProgressTimer = null;

  function renderDetailPage(d){
    const body = document.getElementById('detailBody');
    body.classList.toggle('type-bypass', d.kind === 'bypass');

    const img = document.getElementById('detailImage');
    img.src = d.image || '';
    img.alt = d.title;

    document.getElementById('detailTitle').textContent = d.title;
    document.getElementById('detailSteamId').textContent = d.kind === 'game'
      ? `STEAM ID: ${d.appId}`
      : `COMPATIBLE: ${d.compatibleGame} • STEAM ID: ${d.appId}`;
    document.getElementById('detailDescription').textContent = d.description;

    const typeLabel = d.kind === 'game' ? 'Game' : 'Bypass';
    const typeIcon = d.kind === 'game' ? DETAIL_ICONS.gamepad : DETAIL_ICONS.shield;
    let tagsHtml = `<span class="detail-tag primary">${typeIcon}<span>${typeLabel}</span></span>`;
    d.tags.forEach(t => { tagsHtml += `<span class="detail-tag">${t}</span>`; });
    document.getElementById('detailTags').innerHTML = tagsHtml;

    const labelIds = ['infoLabel1','infoLabel2','infoLabel3','infoLabel4'];
    const valueIds = ['infoValue1','infoValue2','infoValue3','infoValue4'];
    let labels, values;
    if(d.kind === 'game'){
      labels = ['Release Date','Metacritic','Developer','Publisher'];
      values = [d.releaseDate, d.metacritic ? `${d.metacritic} (Meta)` : 'Tidak ada skor', d.developer, d.publisher];
    } else {
      labels = ['Bypass Type','Status','Version','Last Updated'];
      values = [d.bypassType, d.status, d.version, d.updatedAt];
    }
    labelIds.forEach((id,i)=> document.getElementById(id).textContent = labels[i]);
    valueIds.forEach((id,i)=> document.getElementById(id).textContent = values[i]);

    const panelIcon = document.getElementById('detailStatusIcon');
    const panelTitle = document.getElementById('detailStatusTitle');
    const panelDesc = document.getElementById('detailStatusDesc');
    if(d.kind === 'game'){
      panelIcon.style.background = d.isOnline ? 'var(--success-bg)' : 'var(--accent-bg)';
      panelIcon.style.color = d.isOnline ? 'var(--success)' : 'var(--accent)';
      panelIcon.innerHTML = d.isOnline ? DETAIL_ICONS.globe : DETAIL_ICONS.wifiOff;
      panelTitle.textContent = d.isOnline ? 'Online Multiplayer' : 'Single Player / Offline';
      panelDesc.textContent = d.isOnline
        ? 'Game ini bisa dimainkan online bareng teman — pastikan koneksi internet stabil untuk pengalaman terbaik.'
        : 'Game ini didesain untuk dimainkan sendiri tanpa perlu koneksi online — cocok buat kamu yang mau fokus menikmati cerita dan gameplay-nya dengan tenang.';
    } else {
      panelIcon.style.background = 'var(--violet-bg)';
      panelIcon.style.color = 'var(--violet)';
      panelIcon.innerHTML = DETAIL_ICONS.shieldCheck;
      panelTitle.textContent = d.status === 'Active' ? 'Bypass Aktif & Siap Dipakai' : 'Versi Beta — Gunakan dengan Hati-hati';
      panelDesc.textContent = `Kompatibel dengan ${d.compatibleGame}, terakhir diperbarui ${d.updatedAt}.`;
    }

    renderReqList('reqMinimumList', d.reqProfile.minimum);
    renderReqList('reqRecommendedList', d.reqProfile.recommended);

    renderDetailActions(d);
  }

  function renderDetailActions(d){
    const primaryBtn = document.getElementById('detailPrimaryBtn');
    const secondaryBtn = document.getElementById('detailSecondaryBtn');
    primaryBtn.disabled = false;

    if(d.kind === 'bypass'){
      // PHASE 6: bypass ASLI (d._isReal) sama aturannya seperti game ASLI —
      // tombol tetap bisa diklik walau terkunci, klik-nya cuma nampilin
      // info kebutuhan paket/Marketplace, TIDAK memulai aktivasi.
      if (d._isReal && d.locked) {
        primaryBtn.className = 'detail-btn-primary locked';
        primaryBtn.innerHTML = d.gated
          ? DETAIL_ICONS.zap + '<span>Tidak ada akses — Marketplace</span>'
          : DETAIL_ICONS.zap + `<span>Butuh Paket ${ROLE_DISPLAY_NAME[d.role] || d.role}</span>`;
        // FITUR A: klik SEBELUM download/install dimulai -> tampilkan modal
        // premium "Akses Paket Diperlukan" (menggantikan showToast() teks
        // biasa). Access-check-nya sendiri (d.locked/d.gated) TIDAK berubah,
        // masih dari hasAccess()/isMktGated()/mktOrRoleLocked() yang sudah ada.
        primaryBtn.onclick = () => openPackageAccessModal({ title: d.title, requiredRole: d.role, gated: d.gated, productIds: d.marketplaceProductIds });
      } else {
        primaryBtn.className = 'detail-btn-primary violet';
        primaryBtn.innerHTML = DETAIL_ICONS.shieldCheck + '<span>Aktifkan Bypass</span>';
        primaryBtn.onclick = () => startInstall('primary');
      }

      if (d._isReal) {
        // Bypass ASLI: cari kartu Game ASLI yang terhubung (via linkedGameId),
        // bukan generateGameDetail() dummy findGameCardByTitle() lagi.
        const relatedCard = d.linkedGameId ? document.querySelector(`#page-mygames .grid .card[data-id="${CSS.escape(String(d.linkedGameId))}"]`) : null;
        if (relatedCard) {
          secondaryBtn.style.display = '';
          secondaryBtn.disabled = false;
          secondaryBtn.dataset.unavailable = 'false';
          secondaryBtn.title = '';
          secondaryBtn.className = 'detail-btn-secondary cyan';
          secondaryBtn.innerHTML = DETAIL_ICONS.gamepad + '<span>Lihat Game</span>';
          secondaryBtn.onclick = () => openRealGameDetailById(d.linkedGameId);
        } else {
          secondaryBtn.style.display = 'none';
        }
      } else {
        const relatedCard = findGameCardByTitle(d.compatibleGame);
        if(relatedCard){
          secondaryBtn.style.display = '';
          secondaryBtn.disabled = false;
          secondaryBtn.dataset.unavailable = 'false';
          secondaryBtn.title = '';
          secondaryBtn.className = 'detail-btn-secondary cyan';
          secondaryBtn.innerHTML = DETAIL_ICONS.gamepad + '<span>Lihat Game</span>';
          secondaryBtn.onclick = () => openDetailPage('game', relatedCard);
        } else {
          secondaryBtn.style.display = 'none';
        }
      }
    } else {
      // PHASE 5: kalau ini game ASLI dan user tidak punya akses (role/paket
      // kurang, ATAU di-gate Marketplace), tombol Install TETAP bisa diklik
      // (sesuai APP LAMA — game tetap kelihatan & terbuka normal) tapi
      // klik-nya hanya menampilkan info kebutuhan paket, TIDAK memulai
      // install. Reuse hasAccess()/isMktGated()/mktOrRoleLocked() Phase 4.
      if (d._isReal && d.locked) {
        primaryBtn.className = 'detail-btn-primary locked';
        primaryBtn.innerHTML = d.gated
          ? DETAIL_ICONS.zap + '<span>Tidak ada akses — Marketplace</span>'
          : DETAIL_ICONS.zap + `<span>Butuh Paket ${ROLE_DISPLAY_NAME[d.role] || d.role}</span>`;
        // FITUR A — lihat catatan sama di cabang bypass di atas.
        primaryBtn.onclick = () => openPackageAccessModal({ title: d.title, requiredRole: d.role, gated: d.gated, productIds: d.marketplaceProductIds });
      } else {
        primaryBtn.className = 'detail-btn-primary';
        primaryBtn.innerHTML = DETAIL_ICONS.zap + '<span>Install Game</span>';
        primaryBtn.onclick = () => startInstall('primary');
      }

      secondaryBtn.style.display = '';
      secondaryBtn.className = 'detail-btn-secondary violet';
      if(!d.bypassAvailable){
        // PHASE 6: masih sama seperti sebelumnya kalau memang tidak ada
        // Bypass yang terhubung ke game ini di database (bukan "belum
        // Phase 6" lagi, tapi datanya sendiri memang belum ada).
        secondaryBtn.innerHTML = DETAIL_ICONS.shieldCheck + '<span>Install Bypass</span>';
        secondaryBtn.disabled = true;
        secondaryBtn.dataset.unavailable = 'true';
        secondaryBtn.title = 'Bypass tidak tersedia untuk game ini.';
      } else if (d._isReal) {
        // PHASE 6: bypass yang terhubung SUDAH ada — cek akses paket/
        // Marketplace bypass itu SENDIRI (bisa beda role requirement dari
        // game-nya), sama seperti applyDetailAccessState() APP LAMA.
        const linkedBypass = allBypasses.find(b => String(b._id) === String(d.linkedBypassId));
        const bLocked = linkedBypass ? mktOrRoleLocked(linkedBypass) : true;
        const bGated = linkedBypass ? isMktGated(linkedBypass) : false;
        secondaryBtn.disabled = false;
        secondaryBtn.dataset.unavailable = 'false';
        secondaryBtn.title = '';
        if (bLocked) {
          secondaryBtn.className = 'detail-btn-secondary locked';
          secondaryBtn.innerHTML = bGated
            ? DETAIL_ICONS.shieldCheck + '<span>Tidak ada akses — Marketplace</span>'
            : DETAIL_ICONS.shieldCheck + `<span>Bypass Butuh Paket ${ROLE_DISPLAY_NAME[linkedBypass?.role] || linkedBypass?.role}</span>`;
          // FITUR A — lihat catatan sama di cabang bypass primary di atas.
          secondaryBtn.onclick = () => openPackageAccessModal({ title: d.linkedBypassName || d.title, requiredRole: linkedBypass?.role, gated: bGated, productIds: linkedBypass?.marketplaceProductIds });
        } else {
          secondaryBtn.innerHTML = DETAIL_ICONS.shieldCheck + '<span>Install Bypass</span>';
          secondaryBtn.onclick = () => startInstall('secondary');
        }
      } else {
        secondaryBtn.innerHTML = DETAIL_ICONS.shieldCheck + '<span>Install Bypass</span>';
        secondaryBtn.disabled = false;
        secondaryBtn.dataset.unavailable = 'false';
        secondaryBtn.title = '';
        secondaryBtn.onclick = () => startInstall('secondary');
      }
    }
  }

  function setDetailButtonsDisabled(disabled){
    const p = document.getElementById('detailPrimaryBtn');
    const s = document.getElementById('detailSecondaryBtn');
    if(p) { p.disabled = disabled; p.classList.toggle('is-loading', disabled); }
    if(s && s.dataset.unavailable !== 'true') { s.disabled = disabled; s.classList.toggle('is-loading', disabled); }
  }

  /* ---- simulated install / activate progress (demo) ----
     Real build: replace the setInterval loop with progress
     events from the actual install/bypass system (Electron
     IPC / API), keep the same DOM updates. */
  function runProgress(cfg){
    if(activeProgressTimer) return;
    const bar = document.getElementById('installProgressBar');
    const iconEl = document.getElementById('installProgressIcon');
    const nameEl = document.getElementById('installProgressName');
    const percentEl = document.getElementById('installProgressPercent');
    const fillEl = document.getElementById('installProgressFill');
    const metaEl = document.getElementById('installProgressMeta');
    const cancelBtn = document.getElementById('installProgressCancel');
    const accentVar = cfg.accent === 'violet' ? 'var(--violet)' : 'var(--accent)';
    const accentBgVar = cfg.accent === 'violet' ? 'var(--violet-bg)' : 'var(--accent-bg)';

    setDetailButtonsDisabled(true);
    iconEl.style.background = accentBgVar;
    iconEl.style.color = accentVar;
    iconEl.innerHTML = DETAIL_ICONS[cfg.iconKey];
    nameEl.textContent = cfg.label;
    percentEl.textContent = '0%';
    fillEl.style.width = '0%';
    fillEl.style.background = accentVar;
    fillEl.style.color = accentVar; // dipakai CSS box-shadow:currentColor buat glow tipis di ujung fill
    metaEl.textContent = `${cfg.verb}...`;
    cancelBtn.style.display = '';
    cancelBtn.textContent = 'Cancel';
    bar.classList.add('show');

    let pct = 0;
    activeProgressTimer = setInterval(() => {
      pct += 4 + Math.random()*9;
      if(pct >= 100){
        pct = 100;
        clearInterval(activeProgressTimer);
        activeProgressTimer = null;
        fillEl.style.width = '100%';
        percentEl.textContent = '100%';
        iconEl.style.background = 'var(--success-bg)';
        iconEl.style.color = 'var(--success)';
        iconEl.innerHTML = DETAIL_ICONS.check;
        metaEl.textContent = cfg.doneVerb;
        cancelBtn.style.display = 'none';
        showToast('success', cfg.label, cfg.doneVerb);
        addDemoHistory(cfg);
        setTimeout(() => {
          bar.classList.remove('show');
          setDetailButtonsDisabled(false);
        }, 1400);
        return;
      }
      fillEl.style.width = pct + '%';
      percentEl.textContent = Math.floor(pct) + '%';
      const speed = (30 + Math.random()*90).toFixed(0);
      metaEl.textContent = `${cfg.verb}... • ${speed} MB/s`;
    }, 260);

    cancelBtn.onclick = () => {
      clearInterval(activeProgressTimer);
      activeProgressTimer = null;
      bar.classList.remove('show');
      setDetailButtonsDisabled(false);
      showToast('cancel', cfg.label, 'Dibatalkan');
    };
  }

  function startInstall(button){
    if(!currentDetailData) return;
    const d = currentDetailData;

    // PHASE 5/6: data ASLI (game/bypass) pakai jalur handleInstall() nyata
    // (IPC ke main.js) — lihat blok "PHASE 5/6 — INSTALL (REAL)" di bawah
    // file ini. Berlaku utk 3 kombinasi: Install Game (primary, game asli),
    // Install Bypass terhubung (secondary, dari halaman detail game asli),
    // dan Aktifkan Bypass (primary, dari halaman detail bypass asli).
    if (d._isReal && d.kind === 'game' && button === 'primary') {
      if (d.locked) return; // seharusnya sudah dicegat di renderDetailActions, jaga-jaga saja
      handleInstall('game', d._id, d.title);
      return;
    }
    if (d._isReal && d.kind === 'game' && button === 'secondary') {
      if (!d.bypassAvailable || !d.linkedBypassId) return; // jaga-jaga, seharusnya sudah disabled
      const linkedBypass = allBypasses.find(b => String(b._id) === String(d.linkedBypassId));
      if (linkedBypass && mktOrRoleLocked(linkedBypass)) return; // sudah dicegat di renderDetailActions
      handleInstall('bypass', d.linkedBypassId, d.linkedBypassName || d.title);
      return;
    }
    if (d._isReal && d.kind === 'bypass' && button === 'primary') {
      if (d.locked) return; // seharusnya sudah dicegat di renderDetailActions, jaga-jaga saja
      handleInstall('bypass', d._id, d.title);
      return;
    }

    let cfg = null;
    if(d.kind === 'game' && button === 'primary'){
      cfg = { label:d.title, verb:'Menginstall', doneVerb:'Instalasi selesai', accent:'cyan', iconKey:'zap', historyType:'game', appId:d.appId, image:d.image };
    } else if(d.kind === 'game' && button === 'secondary'){
      cfg = { label:`${d.title} Bypass`, verb:'Menginstall Bypass', doneVerb:'Bypass berhasil diinstall', accent:'violet', iconKey:'shieldCheck', historyType:'bypass', appId:d.appId, image:null };
    } else if(d.kind === 'bypass' && button === 'primary'){
      cfg = { label:d.title, verb:'Mengaktifkan Bypass', doneVerb:'Bypass berhasil diaktifkan', accent:'violet', iconKey:'shieldCheck', historyType:'bypass', appId:d.appId, image:null };
    }
    if(cfg) runProgress(cfg);
  }

  function addDemoHistory(cfg){
    if(typeof historyData === 'undefined') return;
    historyData.unshift({
      id: 'h' + Date.now(),
      type: cfg.historyType,
      name: cfg.label,
      image: cfg.image || null,
      appId: cfg.appId || null,
      installPath: `C:/31Tools/${cfg.historyType === 'game' ? 'Games' : 'Bypass'}/${cfg.label.replace(/[^a-zA-Z0-9]/g,'')}`,
      tier: 'public',
      installedAt: new Date().toISOString(),
      status: 'installed',
      isInstalled: true
    });
    if(typeof renderHistoryList === 'function') renderHistoryList();
  }

  function showDetailSkeleton(){
    document.getElementById('detailSkeleton').style.display = 'flex';
    document.getElementById('detailContent').style.display = 'none';
  }
  function hideDetailSkeleton(){
    document.getElementById('detailSkeleton').style.display = 'none';
    document.getElementById('detailContent').style.display = 'grid';
  }

  function openDetailPage(type, cardEl){
    // PHASE 5/6: kartu Games & Bypass sekarang data ASLI (data-real="1",
    // lihat renderGameCard()/renderBypassCard()) — pakai jalur detail asli
    // (fetch Steam Store API dsb), bukan generateGameDetail()/
    // generateBypassDetail() dummy di bawah ini lagi.
    if (type === 'game' && cardEl.dataset.real === '1') {
      openRealGameDetailById(cardEl.dataset.id);
      return;
    }
    if (type === 'bypass' && cardEl.dataset.real === '1') {
      openRealBypassDetailById(cardEl.dataset.id);
      return;
    }
    const title = cardEl.dataset.title;
    const imgEl = cardEl.querySelector('.thumb img');
    const image = imgEl ? imgEl.src : '';
    currentDetail = { type, title, image };
    currentDetailData = null;

    document.getElementById('detailBackLabel').textContent = type === 'bypass' ? 'Back to Bypass' : 'Back to Games';
    document.querySelectorAll('.nav-item[data-page]').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.pm-item[data-page]').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.page').forEach(sec => sec.classList.toggle('active', sec.id === 'page-detail'));
    document.getElementById('detailBody').scrollTop = 0;
    showDetailSkeleton();

    setTimeout(() => {
      currentDetailData = type === 'bypass' ? generateBypassDetail(title, image) : generateGameDetail(title, image);
      renderDetailPage(currentDetailData);
      hideDetailSkeleton();
    }, 350);
  }

  function closeDetailPage(){
    const target = currentDetail && currentDetail.type === 'bypass' ? 'explore' : 'mygames';
    currentDetail = null;
    currentDetailData = null;
    setNav(target);
  }

  function initCardClickToDetail(){
    document.querySelectorAll('.page .grid').forEach(grid => {
      const page = grid.closest('.page');
      // ROOT CAUSE FIX: Request Game TIDAK PUNYA halaman Detail Game (requirement
      // eksplisit). Grid-nya (#rgGrid, class "grid rg-grid") tetap cocok dengan
      // selector generik '.page .grid' di atas, jadi klik tombol "Request Game"
      // (yang notabene anak dari .card di dalam grid ini) ikut bubbling ke
      // listener ini dan memanggil openDetailPage('game', card) — itu sebabnya
      // setelah popup konfirmasi ditutup, halaman yang tampil adalah Detail Game
      // KOSONG (openDetailPage mengaktifkan #page-detail padahal datanya cuma
      // dikarang dari title/image kartu, bukan game asli). Skip grid Request
      // Game di sini sama sekali — satu-satunya aksi kartunya memang cuma
      // tombol Request Game (lihat renderRgGrid()/openRgConfirm() di bawah).
      if (page.id === 'page-requestgame') return;
      const type = page.id === 'page-explore' ? 'bypass' : 'game';
      grid.addEventListener('click', (e) => {
        if(e.target.closest('.bookmark-btn')) return;
        const card = e.target.closest('.card');
        if(!card) return;
        openDetailPage(type, card);
      });
    });
  }

  /* ═══════════════════════════════════════════════════════════════════════
     PHASE 5/6 — INSTALL (REAL) — dipindah dari handleInstall() APP LAMA.
     ---------------------------------------------------------------------
     Logic bisnisnya (fetch link download, deteksi Steam, panggil IPC
     injectGame/installBypass, simpan histori, lapor kegagalan ke server)
     SAMA PERSIS dengan APP LAMA untuk KEDUA cabang (game & bypass) — cuma
     UI progress-nya diadaptasi supaya nembak bar inline #installProgressBar
     milik APP DEMO (bukan modal dlModal* APP LAMA yang tidak ada di HTML
     APP DEMO). Cancel (Item 3) sudah nyata juga — lihat installBarShow().

     BELUM ikut porting di langkah ini (sengaja — Item 4, "Active Tools
     harus aktif dulu" sesuai instruksi terakhir, menyusul kemudian):
       - ensureActiveToolsActiveOrPrompt() — gerbang "Active Tools harus
         aktif dulu". Kalau nanti diaktifkan, taruh pemanggilannya di baris
         pertama handleInstall() di bawah, persis seperti APP LAMA.
     ═══════════════════════════════════════════════════════════════════════ */

  // ── Progress listener dari main process (sekali saja) ──
  let _progressListenerSet = false;
  function ensureProgressListener() {
    if (_progressListenerSet) return;
    _progressListenerSet = true;
    const handler = ({ downloaded, total }) => installBarSetProgress(downloaded, total);
    window.electronAPI?.onDownloadProgress?.(handler);
  }

  // ── Meta install lokal (localStorage) — sumber data uninstall nanti (Phase 8) ──
  function getLocalInstallMeta() {
    try { return JSON.parse(localStorage.getItem('installMeta') || '{}'); } catch (e) { return {}; }
  }
  function saveLocalInstallMeta(historyId, meta) {
    if (!historyId) return;
    const map = getLocalInstallMeta();
    map[String(historyId)] = meta;
    localStorage.setItem('installMeta', JSON.stringify(map));
  }
  // Dipakai Histori (Uninstall) sesudah catatan histori berhasil dihapus dari
  // server — sama persis APP LAMA (removeLocalInstallMeta di app/app.js).
  function removeLocalInstallMeta(historyId) {
    if (!historyId) return;
    const map = getLocalInstallMeta();
    delete map[String(historyId)];
    localStorage.setItem('installMeta', JSON.stringify(map));
  }

  // ── Histori: kirim ke server dengan retry + antrian offline (sama persis APP LAMA) ──
  function _getPendingHistoryQueue() {
    try { return JSON.parse(localStorage.getItem('pendingHistorySync') || '[]'); } catch (e) { return []; }
  }
  function _setPendingHistoryQueue(list) {
    try { localStorage.setItem('pendingHistorySync', JSON.stringify(list)); } catch (e) {}
  }
  async function saveHistoryWithRetry(payload, attempts = 3) {
    for (let i = 0; i < attempts; i++) {
      try {
        return await api('/api/history', { method: 'POST', body: JSON.stringify(payload) });
      } catch (e) {
        if (i === attempts - 1) {
          const queue = _getPendingHistoryQueue();
          queue.push({ payload, queuedAt: Date.now() });
          _setPendingHistoryQueue(queue);
          console.warn('[Histori] Gagal simpan ke server, diantrikan buat dicoba lagi nanti:', e.message);
          return null;
        }
        await new Promise(r => setTimeout(r, 700 * (i + 1)));
      }
    }
  }
  // Dipanggil dari Phase 8 (loadHistori asli) tiap kali halaman Histori dibuka.
  async function flushPendingHistory() {
    const queue = _getPendingHistoryQueue();
    if (!queue.length) return false;
    const stillPending = [];
    let anySucceeded = false;
    for (const entry of queue) {
      try { await api('/api/history', { method: 'POST', body: JSON.stringify(entry.payload) }); anySucceeded = true; }
      catch (e) { stillPending.push(entry); }
    }
    _setPendingHistoryQueue(stillPending);
    return anySucceeded;
  }

  // ── Watermark otomatis (best-effort, tidak boleh mengganggu proses install) ──
  async function issueWatermarkSafe(productType, productId) {
    try {
      const deviceInfo = (window.electronAPI?.getDeviceInfo) ? await window.electronAPI.getDeviceInfo() : {};
      const res = await api('/api/watermark/issue', { method: 'POST', body: JSON.stringify({ productType, productId, deviceInfo }) });
      if (res?.downloadId && res?.blob) return { downloadId: res.downloadId, blob: res.blob };
    } catch (e) { /* diamkan — observability saja, bukan syarat install */ }
    return null;
  }

  // ── Lapor hasil gagal/batal ke server (best-effort, tidak pernah mengurangi limit) ──
  function reportDownloadOutcome({ itemType, itemName, itemImage, downloadAttemptId, stage, rollback, reason }) {
    api('/api/downloads/failed', {
      method: 'POST',
      body: JSON.stringify({ itemType, itemName, itemImage: itemImage || null, downloadAttemptId, stage, rollback, reason })
    }).catch(() => {});
  }

  function fmtBytesAU(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  // ── Bar install inline (#installProgressBar) — adaptasi dari dlModal* APP LAMA ──
  let _installCancelRequested = false; // dibaca handleInstall() supaya tidak lapor 'gagal' kalau memang user yang batalkan

  // FIX (Cancel Download Game/Bypass sebelum progress muncul): SEBELUMNYA,
  // klik "Batal" di tahap paling awal (fetch link download dari server,
  // deteksi Steam, cari folder game, issue watermark — SEMUA ini terjadi
  // SEBELUM window.electronAPI.injectGame()/installBypass() benar-benar
  // dipanggil) cuma memanggil IPC 'cancel-download', yang di main process
  // TIDAK melakukan apa-apa kalau memang belum ada request download yang
  // sedang berjalan (activeDownloadRequest masih null di main.js). Akibatnya
  // sinyal cancel user "hilang" — handleInstall() tetap lanjut ke
  // injectGame()/installBypass() begitu tahap2 di atas selesai, dan download
  // tetap mulai seolah user tidak pernah klik Batal.
  //
  // Fix-nya BUKAN bikin cancellation/AbortController baru — tetap pakai
  // 'cancel-download' yang sudah ada (dipanggil di cancelBtn.onclick di
  // bawah, tetap jalan sebagai jaga-jaga kalau kebetulan download beneran
  // sudah mulai). Yang ditambah cuma pengecekan flag _installCancelRequested
  // di setiap titik SEBELUM tahap async berikutnya jalan (lihat
  // throwIfInstallCancelled() dipanggil di handleInstall()) — begitu user
  // klik Batal, tahap manapun yang sedang berjalan/next SELESAI TANPA PERNAH
  // memanggil injectGame()/installBypass() sama sekali, jadi tidak perlu
  // menunggu ada progress% dulu baru cancel "kepakai".
  function throwIfInstallCancelled() {
    if (_installCancelRequested) {
      const err = new Error('Dibatalkan oleh user sebelum download dimulai.');
      err.cancelledEarly = true;
      throw err;
    }
  }
  function installBarShow(title, iconKey, accent) {
    const bar = document.getElementById('installProgressBar');
    const iconEl = document.getElementById('installProgressIcon');
    const nameEl = document.getElementById('installProgressName');
    const percentEl = document.getElementById('installProgressPercent');
    const fillEl = document.getElementById('installProgressFill');
    const metaEl = document.getElementById('installProgressMeta');
    const cancelBtn = document.getElementById('installProgressCancel');
    if (!bar) return;
    const accentVar = accent === 'violet' ? 'var(--violet)' : 'var(--accent)';
    const accentBgVar = accent === 'violet' ? 'var(--violet-bg)' : 'var(--accent-bg)';
    setDetailButtonsDisabled(true);
    iconEl.style.background = accentBgVar;
    iconEl.style.color = accentVar;
    iconEl.innerHTML = DETAIL_ICONS[iconKey] || DETAIL_ICONS.zap;
    nameEl.textContent = title;
    percentEl.textContent = '0%';
    fillEl.style.width = '0%';
    fillEl.style.background = accentVar;
    fillEl.style.color = accentVar; // dipakai CSS box-shadow:currentColor buat glow tipis di ujung fill
    metaEl.textContent = 'Menghubungkan ke server...';
    _speedLastBytes = 0; _speedLastTs = 0; // reset estimasi kecepatan tiap mulai download baru
    // Cancel REAL (Item 3) — panggil window.electronAPI.cancelDownload(),
    // channel IPC 'cancel-download' sudah ada di main.js/preload.js (sama
    // persis APP LAMA, tidak ada yang perlu diubah di sisi Electron). Main
    // process akan menghentikan proses download/inject yang sedang jalan;
    // hasilnya balik lewat Promise injectGame()/installBypass() sebagai
    // { cancelled: true } — sudah ditangani handleInstall() di bawah.
    _installCancelRequested = false;
    cancelBtn.style.display = '';
    cancelBtn.disabled = false;
    cancelBtn.textContent = 'Cancel';
    cancelBtn.onclick = async () => {
      if (_installCancelRequested) return; // sudah diklik, jangan dobel
      _installCancelRequested = true;
      cancelBtn.disabled = true;
      cancelBtn.textContent = 'Membatalkan...';
      metaEl.textContent = 'Membatalkan...';
      try { await window.electronAPI.cancelDownload(); } catch (e) { /* best-effort — tetap lanjut, hasil final tetap dari Promise install yg sedang jalan */ }
    };
    if (typeof repositionInstallBar === 'function') repositionInstallBar(); // jaga-jaga kalau toast stack sedang tidak kosong
    bar.classList.add('show');
  }
  function installBarSetStage(text) {
    const metaEl = document.getElementById('installProgressMeta');
    if (metaEl) metaEl.textContent = text;
  }
  // Estimasi kecepatan download REAL — dihitung dari selisih byte & waktu
  // antar-event progress asli (window.electronAPI.onDownloadProgress), BUKAN
  // data buatan. Direset tiap kali installBarShow() dipanggil ulang.
  let _speedLastBytes = 0, _speedLastTs = 0;
  function fmtSpeedAU(bytesPerSec) {
    if (!isFinite(bytesPerSec) || bytesPerSec <= 0) return '';
    if (bytesPerSec < 1024 * 1024) return (bytesPerSec / 1024).toFixed(0) + ' KB/s';
    return (bytesPerSec / (1024 * 1024)).toFixed(1) + ' MB/s';
  }
  function installBarSetProgress(downloaded, total) {
    const percentEl = document.getElementById('installProgressPercent');
    const fillEl = document.getElementById('installProgressFill');
    const metaEl = document.getElementById('installProgressMeta');
    if (!percentEl) return;

    const now = Date.now();
    let speedText = '';
    if (_speedLastTs) {
      const dt = (now - _speedLastTs) / 1000;
      const db = downloaded - _speedLastBytes;
      if (dt >= 0.4 && db >= 0) { // sampling min ~400ms biar angkanya stabil, bukan tiap event kecil
        const speed = fmtSpeedAU(db / dt);
        if (speed) speedText = ' • ' + speed;
        _speedLastTs = now; _speedLastBytes = downloaded;
      }
    } else {
      _speedLastTs = now; _speedLastBytes = downloaded;
    }

    if (total > 0) {
      const pct = Math.min(100, Math.round((downloaded / total) * 100));
      fillEl.style.width = pct + '%';
      percentEl.textContent = pct + '%';
      metaEl.textContent = `${fmtBytesAU(downloaded)} / ${fmtBytesAU(total)}${speedText}`;
    } else {
      percentEl.textContent = fmtBytesAU(downloaded);
      metaEl.textContent = 'Mengunduh...' + speedText;
    }
  }
  function installBarSetSuccess(itemName, statusMsg) {
    const iconEl = document.getElementById('installProgressIcon');
    const percentEl = document.getElementById('installProgressPercent');
    const fillEl = document.getElementById('installProgressFill');
    const metaEl = document.getElementById('installProgressMeta');
    const bar = document.getElementById('installProgressBar');
    const cancelBtn = document.getElementById('installProgressCancel');
    iconEl.style.background = 'var(--success-bg)';
    iconEl.style.color = 'var(--success)';
    iconEl.innerHTML = DETAIL_ICONS.check;
    fillEl.style.width = '100%';
    fillEl.style.background = 'var(--success)';
    fillEl.style.color = 'var(--success)';
    percentEl.textContent = '100%';
    metaEl.textContent = statusMsg;
    if (cancelBtn) cancelBtn.style.display = 'none';
    if (typeof showToast === 'function') showToast('success', itemName, statusMsg);
    setTimeout(() => { bar.classList.remove('show'); setDetailButtonsDisabled(false); }, 1400);
  }
  function installBarSetError(itemName, statusMsg, detail, isCancelled) {
    const bar = document.getElementById('installProgressBar');
    const metaEl = document.getElementById('installProgressMeta');
    const cancelBtn = document.getElementById('installProgressCancel');
    if (metaEl) metaEl.textContent = detail ? `${statusMsg} — ${detail}` : statusMsg;
    if (cancelBtn) cancelBtn.style.display = 'none';
    if (typeof showToast === 'function') showToast(isCancelled ? 'cancel' : 'error', itemName, statusMsg + (detail ? ` — ${detail}` : ''));
    setTimeout(() => { bar.classList.remove('show'); setDetailButtonsDisabled(false); }, 2200);
  }

  // ── INSTALL -> catat ke histori (Phase 5: cabang 'game' aktif; 'bypass' Phase 6) ──
  async function handleInstall(itemType, itemId, itemName) {
    // Gate Maintenance Mode — dicek PALING AWAL (sebelum Active Tools),
    // sesuai logic existing maintenanceManager.js: kalau Maintenance aktif
    // & user ini TIDAK bypass (bukan admin/whitelist), jangan mulai
    // download/install baru sama sekali. Overlay #maintenanceOverlay
    // sendiri sudah mengunci layar (z-index tertinggi) jadi tombol install
    // seharusnya sudah tidak bisa dijangkau user — guard ini cuma jaring
    // pengaman tambahan (mis. klik yang sempat terdaftar tepat sebelum
    // overlay muncul realtime). TIDAK ada logic permission/download baru
    // dibuat di sini, cuma reuse showToast() existing.
    if (_maintenanceActive) {
      showToast('error', 'Sedang Maintenance', 'App sedang dalam pemeliharaan. Download/install dinonaktifkan sementara.');
      return;
    }
    // Gate Active Tools (requirement Game Install #2/#6/#11) — HANYA dipasang
    // di jalur GAME. Bypass (baik "Install Bypass" primer maupun bypass
    // terhubung yang diklik dari halaman Game) TIDAK PERNAH memicu popup ini
    // sama sekali, sesuai requirement eksplisit "BYPASS TIDAK MEMERLUKAN
    // ACTIVE TOOLS". handleInstall() dipakai bersama utk game & bypass, jadi
    // guard-nya harus dicek per itemType di sini, BUKAN dianggap berlaku
    // global untuk semua install/download seperti sebelumnya (bug: versi
    // lama memanggil ensureActiveToolsActiveOrPrompt() tanpa syarat, jadi
    // ikut memblokir Bypass juga — sudah diperbaiki).
    if (itemType === 'game' && !(await ensureActiveToolsActiveOrPrompt(itemType, itemId, itemName))) return;

    ensureProgressListener();
    const isGame = itemType === 'game';

    installBarShow(itemName, isGame ? 'zap' : 'shieldCheck', isGame ? 'cyan' : 'violet');
    installBarSetStage('Menghubungkan ke server...');

    let downloadAttemptId = null;
    try {
      if (isGame) {
        // ── GAME INJECT (sama persis APP LAMA) ──
        const data = await api(`/api/games/${itemId}/download`);
        throwIfInstallCancelled(); // lihat definisi di atas — cancel sebelum download IPC dipanggil
        if (!data.streamPath) throw new Error(data.error || 'Server tidak memberikan link download. Pastikan admin sudah mengisi data game.');
        downloadAttemptId = data.downloadAttemptId || null;
        installBarSetStage('URL diterima, mendeteksi Steam...');

        const token = localStorage.getItem('token') || '';
        const zipUrl = `${SERVER_URL}${data.streamPath}`;
        const streamAuthHeaders = { Authorization: `Bearer ${token}` };

        const steamPath = await window.electronAPI.getSteamPath();
        throwIfInstallCancelled();
        if (!steamPath) throw new Error('Steam tidak ditemukan di PC ini. Pastikan Steam sudah terinstall dan pernah dijalankan.');

        const gameWatermark = await issueWatermarkSafe('game', itemId);
        throwIfInstallCancelled(); // gate TERAKHIR — kalau lolos, baru injectGame() (download nyata) dipanggil

        installBarSetStage('Mengunduh & meng-inject file...');
        const result = await window.electronAPI.injectGame({
          steamPath, zipUrl, extraHeaders: streamAuthHeaders, watermark: gameWatermark
        });

        if (result.cancelled) {
          installBarSetError(itemName, 'Download dibatalkan', null, true);
          reportDownloadOutcome({ itemType, itemName, itemImage: null, downloadAttemptId, stage: 'cancelled', rollback: result.rollback, reason: 'Dibatalkan oleh user.' });
          return;
        }
        if (!result.success) {
          const err = new Error(result.error || 'Inject game gagal tanpa keterangan.');
          err.stage = result.stage || 'install';
          err.rollback = result.rollback || null;
          throw err;
        }

        installBarSetStage('Menyimpan ke histori...');
        const gameMeta = allGames.find(g => String(g._id) === String(itemId));
        const histResp = await saveHistoryWithRetry({
          itemType, itemId, itemName,
          itemImage: gameMeta?.imageUrl || null,
          extractedFiles: result.extractedFiles || [], steamPath, downloadAttemptId
        });
        saveLocalInstallMeta(histResp?._id, { type: 'game', extractedFiles: result.extractedFiles || [], steamPath });

        installBarSetSuccess(itemName, 'Download selesai');

      } else {
        // ── BYPASS INSTALL (Item 1/2 — dipindah UTUH dari handleInstall()
        // APP LAMA, cabang itemType === 'bypass'). Bisa datang dalam 2
        // bentuk dari server: directUrl (link biasa, tanpa auth) atau
        // streamPath (lewat proxy server sendiri, WAJIB Authorization
        // Bearer token, dipakai utk link Ryuu Generator). ──
        installBarSetStage('Mengambil link bypass...');
        const linkData = await api(`/api/bypasses/${itemId}/download-link`);
        throwIfInstallCancelled(); // lihat definisi di atas — cancel sebelum download IPC dipanggil
        if (!linkData.directUrl && !linkData.streamPath) {
          throw new Error(linkData.error || 'Link bypass tidak ditemukan. Pastikan admin sudah mengisi link file bypass.');
        }
        downloadAttemptId = linkData.downloadAttemptId || null;

        const appId = linkData.steamAppId || linkData.appId;
        if (!appId) throw new Error('App ID belum diisi admin pada bypass ini. Hubungi admin.');

        installBarSetStage('Mendeteksi Steam...');
        const steamPath = await window.electronAPI.getSteamPath();
        throwIfInstallCancelled();
        if (!steamPath) throw new Error('Steam tidak ditemukan. Pastikan Steam sudah terinstall.');

        installBarSetStage(`Mencari folder game (App ID: ${appId})...`);
        const folderResult = await window.electronAPI.findGameFolderByAppId({ steamPath, appId: String(appId) });
        throwIfInstallCancelled();
        if (!folderResult.found) throw new Error(folderResult.error || `Game dengan App ID ${appId} belum terinstall di Steam. Install gamenya dulu lalu coba lagi.`);

        installBarSetStage('Mengunduh bypass...');
        const bypassToken = localStorage.getItem('token') || '';
        const bypassDriveUrl = linkData.streamPath ? `${SERVER_URL}${linkData.streamPath}` : linkData.directUrl;
        const bypassExtraHeaders = linkData.streamPath ? { Authorization: `Bearer ${bypassToken}` } : {};
        const bypassWatermark = await issueWatermarkSafe('bypass', itemId);
        throwIfInstallCancelled(); // gate TERAKHIR — kalau lolos, baru installBypass() (download nyata) dipanggil

        const result = await window.electronAPI.installBypass({
          folderPath:   folderResult.folderPath,
          driveUrl:     bypassDriveUrl,
          extraHeaders: bypassExtraHeaders,
          userId:       currentUser?.discordId || currentUser?.userId || '',
          deviceId:     getOrCreateDeviceId(),
          gameId:       itemId,
          gameName:     itemName,
          steamAppId:   String(appId),
          watermark:    bypassWatermark,
        });

        if (result.cancelled) {
          installBarSetError(itemName, 'Download dibatalkan', null, true);
          reportDownloadOutcome({ itemType, itemName, itemImage: null, downloadAttemptId, stage: 'cancelled', rollback: result.rollback, reason: 'Dibatalkan oleh user.' });
          return;
        }
        if (!result.success) {
          const err = new Error(result.error || 'Install bypass gagal tanpa keterangan.');
          err.stage = result.stage || 'install';
          err.rollback = result.rollback || null;
          throw err;
        }

        installBarSetStage('Menyimpan ke histori...');
        const bypassMeta = allBypasses.find(b => String(b._id) === String(itemId));
        const histResp = await saveHistoryWithRetry({
          itemType, itemId, itemName,
          itemImage: bypassMeta?.imageUrl || null,
          extractedFiles: result.extractedFiles || [],
          folderPath: result.folderPath || null,
          downloadAttemptId
        });
        saveLocalInstallMeta(histResp?._id, { type: 'bypass', extractedFiles: result.extractedFiles || [], folderPath: result.folderPath || null });

        installBarSetSuccess(itemName, 'Download selesai');
      }

      // Phase 8 (Histori asli) belum jalan — panggil ulang hanya kalau
      // sudah tersambung nanti, supaya tidak error manggil fungsi dummy.
      if (typeof loadHistori === 'function' && loadHistori !== undefined) { try { loadHistori(); } catch (e) {} }

    } catch (e) {
      // FIX (Cancel Download sebelum progress muncul) — cancel yang terjadi
      // SEBELUM injectGame()/installBypass() dipanggil (lihat
      // throwIfInstallCancelled() di atas) masuk ke sini lewat throw biasa,
      // BUKAN lewat `result.cancelled` (karena IPC download-nya sendiri
      // memang tidak pernah dipanggil). Ditangani SAMA PERSIS seperti cabang
      // `result.cancelled` di atas — pesan "Download dibatalkan", BUKAN
      // dianggap gagal/error, dan dilaporkan ke server dengan stage
      // 'cancelled' (bukan 'failed').
      if (e && e.cancelledEarly) {
        installBarSetError(itemName, 'Download dibatalkan', null, true);
        reportDownloadOutcome({ itemType, itemName, itemImage: null, downloadAttemptId, stage: 'cancelled', rollback: null, reason: 'Dibatalkan oleh user sebelum download dimulai.' });
        return;
      }
      installBarSetError(itemName, 'Download gagal', e.message, false);
      const failedMeta = isGame
        ? allGames.find(g => String(g._id) === String(itemId))
        : allBypasses.find(b => String(b._id) === String(itemId));
      reportDownloadOutcome({
        itemType, itemName, itemImage: failedMeta?.imageUrl || null,
        downloadAttemptId, stage: e.stage || 'download', rollback: e.rollback || null, reason: e.message
      });
    }
  }

  /* ═══════════════════════ AKHIR PHASE 5/6 — INSTALL (REAL) ═══════════════════════ */

  /* ══════════════════════════════════════════════════════════════════════════
     BELI PAKET — halaman "Upgrade Paket" (Public/Gold/Platinum), migrasi dari
     PROJECT LAMA. Backend TIDAK diubah sama sekali — endpoint
     GET /api/packages, POST /api/packages/purchase,
     GET /api/packages/purchase/:orderId, POST /api/packages/purchase/:orderId/cancel
     dan modul packageManager.js/klikqrisManager.js/transactionManager.js
     100% dipakai apa adanya. Harga/durasi/benefit/limit SELALU dari respons
     server (Admin Web = source of truth) — TIDAK ADA yang di-hardcode di sini.

     Frontend TIDAK PERNAH mengubah role/status pembayaran sendiri: kartu
     paket & modal QRIS di bawah murni MENAMPILKAN apa yang dikirim backend.
     Aktivasi role/activeUntil terjadi di server lalu didorong realtime lewat
     event WS 'account:update' (sudah ditangani handleAccountUpdate() di
     atas) + 'transaction:update' (status transaksi, ditangani di sini).
     ══════════════════════════════════════════════════════════════════════════ */
  const PKG_TIER_LABEL = { public: 'Gratis', gold: 'Gold', platinum: 'Platinum' };
  const PKG_STATUS_LABEL = {
    pending: 'Menunggu Pembayaran',
    completed: 'Pembayaran Berhasil',
    failed: 'Pembayaran Gagal',
    cancelled: 'Dibatalkan',
    expired: 'Kedaluwarsa'
  };
  const PKG_TIER_ICON = {
    public: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><use href="#ic-globe"></use></svg>',
    gold: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><use href="#ic-crown"></use></svg>',
    platinum: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><use href="#ic-gem"></use></svg>'
  };

  let _pkgLastData = null;       // respons terakhir GET /api/packages (di-cache biar realtime re-render tidak perlu fetch ulang)
  let _pkgSelectedTier = null;   // tier yang lagi dikonfirmasi di modal Konfirmasi Pembelian
  let _pkgOpenTx = null;         // transaksi yang lagi terbuka di modal Pembayaran QRIS
  let _pkgCountdownTimer = null;
  let _pkgPollTimer = null;

  function rupiah(n) { return 'Rp ' + Number(n || 0).toLocaleString('id-ID'); }

  function pkgIconSpanFallback(html) {
    // Sprite ic-* dimuat di index.html, tapi kalau elemen <use> gagal resolve
    // (mis. sprite belum sempat parse), fallback tetap tampil sebagai kotak
    // kosong transparan — tidak fatal, cuma kosmetik.
    return html;
  }

  // ── Halaman Beli Paket — status paket user saat ini (real, dari currentUser) ──
  function renderPkgStatusWidget() {
    const card = document.getElementById('pkgStatusCard');
    const iconEl = document.getElementById('pkgStatusIcon');
    const tierEl = document.getElementById('pkgStatusTier');
    const expiryEl = document.getElementById('pkgStatusExpiry');
    if (!card || !currentUser) return;

    // Admin BUKAN salah satu dari Gratis/Gold/Platinum (lihat aturan Role
    // Admin) — chip status di header ini menampilkan "Admin" apa adanya,
    // TIDAK PERNAH jatuh ke fallback 'public'/Gratis seperti sebelumnya.
    if (currentUser.role === 'admin') {
      card.dataset.tier = 'admin';
      iconEl.innerHTML = pkgIconSpanFallback('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z"/><path d="m9 12 2 2 4-4"/></svg>');
      tierEl.textContent = 'Admin';
      expiryEl.textContent = 'Akses Administrator';
      expiryEl.dataset.state = '';
      return;
    }

    const tier = ['public', 'gold', 'platinum'].includes(currentUser.role) ? currentUser.role : 'public';
    card.dataset.tier = tier;
    iconEl.innerHTML = pkgIconSpanFallback(PKG_TIER_ICON[tier] || PKG_TIER_ICON.public);
    tierEl.textContent = PKG_TIER_LABEL[tier] || 'Gratis';

    const info = (typeof computePackageExpiryInfo === 'function') ? computePackageExpiryInfo(currentUser) : null;
    if (!info) {
      expiryEl.textContent = tier === 'public' ? 'Akses dasar — upgrade untuk fitur lebih banyak.' : '';
      expiryEl.dataset.state = '';
    } else {
      expiryEl.textContent = info.text;
      expiryEl.dataset.state = info.state;
    }
  }

  function pkgLimitText(limit) {
    return (limit === null || limit === undefined) ? 'Unlimited' : `${limit}x/hari`;
  }

  function pkgBenefitLi(text, ok) {
    const icon = ok
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><use href="#ic-check"></use></svg>'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><use href="#ic-minus"></use></svg>';
    return `<li class="pmc-benefit ${ok ? 'is-on' : 'is-off'}"><span class="pmc-benefit-mark">${icon}</span><span class="pmc-benefit-text">${escapeHtml(text)}</span></li>`;
  }

  // ── Render <ul> benefit SATU kartu — SELALU persis dari
  // packages[tier].benefits (array yang diisi/diedit di Admin Web), apa
  // adanya: urutan sama, jumlah sama, teks sama. TIDAK ADA lagi
  // penggabungan (union) antar-tier dan TIDAK ADA baris tambahan yang
  // di-hardcode di sini (mis. "Download Game"/"Download Bypass") — kalau
  // admin mau baris seperti itu tampil, admin tinggal menuliskannya sendiri
  // di kolom Benefit paket terkait di Admin Web. Dengan begini, mengurangi/
  // menambah benefit di Admin Web lalu Save akan LANGSUNG mengubah jumlah &
  // isi baris yang tampil di App — tidak ada lagi benefit "hantu" dari tier
  // lain yang ikut nongol (cuma ditandai silang) di kartu ini.
  function pkgFeatureListHTML(tierData) {
    const benefits = (tierData && Array.isArray(tierData.benefits)) ? tierData.benefits : [];
    if (!benefits.length) {
      return `
          <div class="pmc-tier-features-label">Fitur Paket</div>
          <div class="pmc-benefit-empty">Benefit paket ini belum diatur di Admin Web.</div>`;
    }
    return `
          <div class="pmc-tier-features-label">Fitur Paket</div>
          <ul class="pmc-benefit-list">${benefits.map(b => pkgBenefitLi(b, true)).join('')}</ul>`;
  }

  // ── 3 kartu paket (Public/Gold/Platinum) ──
  function renderPkgCards(data) {
    const wrap = document.getElementById('pkgCardsGrid');
    if (!wrap || !data || !data.packages) return;
    const { packages } = data;
    const myRole = currentUser?.role || data.current?.role || 'public';
    const myLevel = CLIENT_ROLE_LEVEL[myRole] ?? 0;
    const status = currentUser?.accountStatus || data.current?.status || {};
    const activeSameRole = (tier) => myRole === tier && (tier === 'public' || (status.hasActivePeriod && !status.isExpired));

    const ICON_CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><use href="#ic-check"></use></svg>';

    // ── Public (Gratis) ──
    const pub = packages.public || {};
    const pubActive = activeSameRole('public');
    const publicCard = `
      <div class="pmc-tier pmc-tier--public ${pubActive ? 'is-active' : ''}">
        <span class="pmc-tier-accent" aria-hidden="true"></span>
        <div class="pmc-tier-inner">
          <div class="pmc-tier-head">
            <span class="pmc-tier-icon">${PKG_TIER_ICON.public}</span>
            ${pubActive ? `<span class="pmc-tier-flag pmc-tier-flag--active">${ICON_CHECK}<span>Paket Aktif</span></span>` : ''}
          </div>
          <div class="pmc-tier-name">Gratis</div>
          <div class="pmc-tier-desc">${escapeHtml(pub.description || 'Akses dasar untuk mulai bermain.')}</div>
          <div class="pmc-tier-price"><span class="pmc-price-value">Gratis</span><span class="pmc-price-period">Selamanya</span></div>
          <div class="pmc-tier-hr"></div>
          ${pkgFeatureListHTML(pub)}
          ${pubActive ? `<button type="button" class="pmc-cta pmc-cta--active" disabled>${ICON_CHECK}<span>Paket Aktif</span></button>` : '<span class="pmc-cta-spacer"></span>'}
        </div>
      </div>`;

    // ── Gold & Platinum (paid tier) ──
    const paidCard = (tier) => {
      const p = packages[tier] || {};
      const active = activeSameRole(tier);
      const tierLevel = CLIENT_ROLE_LEVEL[tier];
      const includedInHigher = myLevel > tierLevel; // mis. user Platinum lihat kartu Gold
      let btnLabel, btnDisabled = false;
      if (!p.active) {
        btnLabel = 'Tidak Tersedia'; btnDisabled = true;
      } else if (active) {
        btnLabel = `Perpanjang ${PKG_TIER_LABEL[tier]}`;
      } else if (includedInHigher) {
        btnLabel = 'Sudah Termasuk di Paket Kamu'; btnDisabled = true;
      } else {
        btnLabel = `Upgrade ke ${PKG_TIER_LABEL[tier]}`;
      }
      const btnIcon = !btnDisabled ? PKG_TIER_ICON[tier] : '';
      const flagText = !active ? (p.badge || (tier === 'gold' ? 'Paling Diminati' : 'Tier Tertinggi')) : '';
      return `
      <div class="pmc-tier pmc-tier--${tier} ${active ? 'is-active' : ''} ${!p.active ? 'is-disabled' : ''}">
        <span class="pmc-tier-accent" aria-hidden="true"></span>
        <div class="pmc-tier-inner">
          <div class="pmc-tier-head">
            <span class="pmc-tier-icon">${PKG_TIER_ICON[tier]}</span>
            ${active
              ? `<span class="pmc-tier-flag pmc-tier-flag--active">${ICON_CHECK}<span>Paket Aktif</span></span>`
              : (flagText ? `<span class="pmc-tier-flag">${escapeHtml(flagText)}</span>` : '')}
          </div>
          <div class="pmc-tier-name">${PKG_TIER_LABEL[tier]}</div>
          <div class="pmc-tier-desc">${escapeHtml(p.description || '')}</div>
          <div class="pmc-tier-price"><span class="pmc-price-value">${rupiah(p.price)}</span><span class="pmc-price-period">/ ${escapeHtml(p.durationLabel || '')}</span></div>
          <div class="pmc-tier-hr"></div>
          ${pkgFeatureListHTML(p)}
          <button type="button" class="pmc-cta pmc-cta--${tier}" ${btnDisabled ? 'disabled' : ''} onclick="openPkgConfirm('${tier}')">${btnIcon}<span>${btnLabel}</span></button>
        </div>
      </div>`;
    };

    wrap.innerHTML = publicCard + paidCard('gold') + paidCard('platinum');
  }

  // ── "Bandingkan Paket" — compact comparison strip di bawah 3 kartu.
  // Baris "Install" murni dari data backend (limits) — TIDAK di-hardcode.
  // Baris lain (Akses Game/Support) adalah label kategori presentational,
  // bukan angka/harga/benefit spesifik, jadi aman ditulis statis di sini
  // (sama seperti contoh pada requirement #16). ──
  function renderPkgCompare(data) {
    const wrap = document.getElementById('pkgCompare');
    const table = document.getElementById('pkgCompareTable');
    if (!wrap || !table || !data || !data.packages) return;
    const { packages } = data;
    const gameLimit = (tier) => pkgLimitText(packages[tier]?.limits?.game);
    const rows = [
      {
        icon: 'ic-globe',
        label: 'Akses Game',
        values: ['Dasar', 'Lebih Luas', 'Penuh']
      },
      {
        icon: 'ic-arrow-down-to-line',
        label: 'Install / Hari',
        values: [gameLimit('public'), gameLimit('gold'), gameLimit('platinum')]
      },
      {
        icon: 'ic-shield-check',
        label: 'Support',
        values: ['Standard', 'Standard', 'Prioritas']
      }
    ];
    const cell = (v) => `<div class="pmc-compare-cell">${escapeHtml(String(v))}</div>`;
    const head = `
      <div class="pmc-compare-row pmc-compare-row--head">
        <div class="pmc-compare-cell"></div>
        ${cell('Gratis')}${cell('Gold')}${cell('Platinum')}
      </div>`;
    const body = rows.map(r => `
      <div class="pmc-compare-row">
        <div class="pmc-compare-cell"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><use href="#${r.icon}"></use></svg>${escapeHtml(r.label)}</div>
        ${r.values.map(cell).join('')}
      </div>`).join('');
    table.innerHTML = head + body;
    wrap.hidden = false;
  }

  // ── ADMIN ACCOUNT panel (#pkgAdminPanel) vs flow pembelian user biasa
  // (#pkgCardsGrid + #pkgCompare) — SATU-SATUNYA tempat yang boleh
  // toggle hidden ketiga elemen ini, supaya tidak ada jalur lain yang lupa
  // menyembunyikan salah satunya (requirement: Admin tidak ditawari
  // Gratis/Gold/Platinum sebagai pilihan package). Sumber kebenarannya
  // murni currentUser.role === 'admin' dari backend, bukan hardcode.
  // Dipanggil SETELAH renderPkgCards()/renderPkgCompare() (baik dari
  // loadPackages(), applyPackagesUpdate(), maupun handleAccountUpdate()
  // saat role berubah realtime) karena renderPkgCompare() sendiri yang
  // meng-unhide #pkgCompare tiap kali render — kalau dipanggil sebelumnya,
  // hidden-nya akan langsung ketimpa lagi.
  function applyPkgAdminState() {
    const adminPanel = document.getElementById('pkgAdminPanel');
    const cardsGrid = document.getElementById('pkgCardsGrid');
    const compare = document.getElementById('pkgCompare');
    if (!adminPanel && !cardsGrid && !compare) return;
    const isAdmin = currentUser?.role === 'admin';
    if (adminPanel) adminPanel.hidden = !isAdmin;
    if (cardsGrid) cardsGrid.hidden = isAdmin;
    if (compare) compare.hidden = isAdmin;
  }

  async function loadPackages() {
    const errBox = document.getElementById('pkgLoadError');
    try {
      const data = await api('/api/packages');
      _pkgLastData = data;
      if (errBox) errBox.hidden = true;
      renderPkgStatusWidget();
      renderPkgCards(data);
      renderPkgCompare(data);
      applyPkgAdminState();
    } catch (e) {
      if (errBox) { errBox.hidden = false; errBox.textContent = e.message || 'Gagal memuat daftar paket.'; }
    }
  }

  // ── Realtime push dari Admin Web (event WS 'packages:update', lihat
  // wsBroadcastAll di PUT /api/admin/packages/:tier di server.js) — dipanggil
  // dari ws.onmessage di atas SETIAP KALI admin klik Simpan di halaman
  // Upgrade Paket (Admin Web), tanpa APP perlu pindah halaman/restart.
  //
  // PENTING soal bentuk payload: server mem-broadcast HASIL
  // packageManager.getPackagesPublic() apa adanya, yaitu cuma
  // { public, gold, platinum, updatedAt } — BUKAN bentuk penuh respons
  // GET /api/packages (yang juga membungkus paymentMethods/gatewayEnabled/
  // current di dalam field "packages"). Kalau field ini langsung ditimpakan
  // ke _pkgLastData, field lain (paymentMethods/current) akan hilang dan
  // openPkgConfirm()/renderPkgStatusWidget() ikut rusak. Makanya di sini
  // HANYA bagian packages-nya yang di-merge ke cache lama, sisanya
  // dipertahankan apa adanya (paymentMethods/gatewayEnabled/current memang
  // tidak berubah akibat admin mengedit deskripsi/benefit/harga paket).
  function applyPackagesUpdate(tiers) {
    if (!tiers) return;
    if (!_pkgLastData) return; // Beli Paket belum pernah dibuka di sesi ini — nanti loadPackages() yang tarik data terbaru pas dibuka.
    _pkgLastData = { ..._pkgLastData, packages: tiers, updatedAt: tiers.updatedAt || _pkgLastData.updatedAt };
    renderPkgStatusWidget();
    renderPkgCards(_pkgLastData);
    renderPkgCompare(_pkgLastData);
    applyPkgAdminState();
  }

  /* ══════════════════════════════════════════════════════════════════════════
     WELCOME POPUP — popup selamat datang, tampil SEKALI per akun sesudah login
     pertama. Backend TIDAK diubah struktur/logic-nya: pakai endpoint existing
     GET /api/welcome-popup (server yang menentukan tampil/tidak lewat
     welcomePopupManager.shouldShow(), bukan App) & POST /api/welcome-popup/seen
     (lihat welcomePopupManager.js/server.js). Realtime perubahan dari Admin Web
     lewat event WS existing 'welcome-popup:update' (sinyal ringan, pola SAMA
     dengan 'app-customization:update' — lihat blok REALTIME/onmessage di atas),
     TIDAK ada WebSocket/Socket.IO baru.

     PRIORITAS vs GOLD TRIAL (requirement urutan untuk user baru): enterApp()
     SEKARANG memanggil checkWelcomePopup(onDone) alih-alih langsung
     loadGoldTrialOffer() — Gold Trial baru dipanggil di dalam `onDone`, yaitu
     SETELAH Welcome Popup ditutup (atau langsung, kalau memang tidak ada
     popup yang perlu tampil untuk akun ini). Jadi Welcome Popup & Gold Trial
     Notification TIDAK PERNAH tampil bersamaan, dan Gold Trial TIDAK PERNAH
     dipanggil sebelum Welcome Popup selesai. Logic Gold Trial sendiri (endpoint,
     eligibility, device/user restriction, claim) SAMA SEKALI TIDAK disentuh —
     lihat blok GOLD TRIAL di bawah, cuma URUTAN PEMANGGILANNYA yang berubah. */
  let _wpCurrent = null; // { onClose, markSeen } — popup yang SEDANG tampil (kalau ada)

  // Dipanggil dari enterApp() (login) — `onDone` dijalankan begitu alur Welcome
  // Popup benar-benar selesai (popup ditutup ATAU memang tidak ada yang perlu
  // tampil), supaya Gold Trial (atau proses lain yang menunggu) baru jalan
  // SESUDAHNYA. Dipanggil ulang TANPA `onDone` dari WS event 'welcome-popup:update'
  // & saat reconnect (lihat connectRealtime()) untuk sinkron ulang config
  // terbaru — kalau lagi ada popup TERBUKA, sengaja diabaikan (tidak menimpa/
  // menginterupsi popup yang sedang dilihat user).
  async function checkWelcomePopup(onDone) {
    const done = () => { if (typeof onDone === 'function') onDone(); };
    if (_wpCurrent) { done(); return; }
    try {
      const data = await api('/api/welcome-popup');
      if (data && data.show && data.popup) {
        showWelcomePopupModal(data.popup, { onClose: done, markSeen: true });
      } else {
        done();
      }
    } catch (e) {
      console.warn('[Welcome Popup] Gagal cek status:', e);
      done(); // jangan sampai proses berikutnya (Gold Trial) ikut ke-block gara-gara Welcome Popup gagal fetch
    }
  }

  // Render + tampilkan modal — semua teks 100% dari `popup` (Admin Web/DB),
  // TIDAK ADA copy yang di-hardcode di sini.
  // `markSeen:true` (alur NORMAL) -> tombol "Mulai Sekarang" ATAU "Jangan
  // Tampilkan Lagi" SAMA-SAMA memanggil POST /api/welcome-popup/seen (lihat
  // welcomePopupManager.js: dua-duanya menandai versi ini sudah dilihat;
  // dibedakan lewat mekanisme version per-content saat admin "paksa tampil
  // kembali", BUKAN satu boolean global welcomePopupDismissed).
  // `markSeen:false` (alur TEST, dipicu Admin Web lewat notifyUser existing —
  // lihat handleWelcomePopupTestPush() di bawah) -> tombol cuma menutup modal
  // secara LOKAL, TIDAK pernah memanggil /seen, supaya status dismiss akun
  // ini terhadap Welcome Popup NORMAL tidak ikut berubah gara-gara TEST.
  function showWelcomePopupModal(popup, { onClose, markSeen } = {}) {
    const modal = document.getElementById('welcomePopupModal');
    if (!modal) { if (typeof onClose === 'function') onClose(); return; }

    const titleEl = document.getElementById('wpModalTitle');
    if (titleEl) titleEl.textContent = popup.title || '';

    const descEl = document.getElementById('wpModalDesc');
    if (descEl) { descEl.textContent = popup.description || ''; descEl.hidden = !popup.description; }

    const bannerEl = document.getElementById('wpBannerImg');
    if (bannerEl) {
      if (popup.bannerUrl) { bannerEl.src = popup.bannerUrl; bannerEl.hidden = false; }
      else { bannerEl.hidden = true; bannerEl.removeAttribute('src'); }
    }

    const itemsEl = document.getElementById('wpModalItems');
    if (itemsEl) {
      itemsEl.innerHTML = Array.isArray(popup.items)
        ? popup.items.map(it => `<li>${escapeHtml(String(it))}</li>`).join('')
        : '';
    }

    const primaryBtn = document.getElementById('wpPrimaryBtn');
    if (primaryBtn) primaryBtn.textContent = popup.primaryButtonText || 'Mulai Sekarang';
    const secondaryBtn = document.getElementById('wpSecondaryBtn');
    if (secondaryBtn) secondaryBtn.textContent = popup.secondaryButtonText || 'Jangan Tampilkan Lagi';

    _wpCurrent = { onClose: typeof onClose === 'function' ? onClose : null, markSeen: markSeen !== false, closing: false };
    modal.classList.add('show');
  }

  // Dipanggil dari tombol "Mulai Sekarang"/"Jangan Tampilkan Lagi" (lihat
  // onclick di index.html #welcomePopupModal). `source` sengaja tidak
  // membedakan behavior lain — lihat komentar showWelcomePopupModal() soal
  // kenapa keduanya sama-sama menandai "sudah dilihat" di alur NORMAL.
  async function closeWelcomePopup(source) {
    if (!_wpCurrent || _wpCurrent.closing) return;
    _wpCurrent.closing = true;
    const { onClose, markSeen } = _wpCurrent;

    try {
      if (markSeen) await api('/api/welcome-popup/seen', { method: 'POST' });
    } catch (e) {
      console.warn('[Welcome Popup] Gagal menandai sudah dilihat:', e);
      // Tetap ditutup di App biar user tidak "kejebak" di popup — DB tetap
      // source of truth: kalau gagal tersimpan, popup ini wajar muncul lagi
      // lain kali (bukan kondisi fatal, sama seperti pola modul lain).
    }

    document.getElementById('welcomePopupModal')?.classList.remove('show');
    const cb = onClose;
    _wpCurrent = null;
    if (cb) cb();
  }

  // TEST — dipicu Admin Web (halaman Welcome Popup, tombol "Kirim Test", lewat
  // POST /api/admin/welcome-popup/test -> notifyUser() EXISTING -> event WS
  // 'notification' EXISTING, lihat routing di onmessage/handleGoldTrialPushNotification
  // di atas). Tampil LANGSUNG pakai payload yang sudah dikirim admin (bukan
  // fetch ulang GET /api/welcome-popup), supaya TEST tetap bisa dikirim &
  // tampil meskipun akun ini sudah pernah melihat/dismiss versi yang sedang
  // berjalan. `markSeen:false` -> menutup TEST popup ini TIDAK PERNAH mengubah
  // status dismiss Welcome Popup NORMAL akun ini, dan TIDAK menyentuh/
  // menginterupsi urutan Welcome Popup<->Gold Trial normal sama sekali.
  function handleWelcomePopupTestPush(data) {
    if (!data) return;
    showWelcomePopupModal(data, { markSeen: false });
  }

  /* ══════════════════════════════════════════════════════════════════════════
     GOLD TRIAL — UI baru untuk Demo/Testing (kartu promo/status + tombol Claim
     + notifikasi premium). Backend TIDAK diubah sama sekali: pakai endpoint
     existing GET /api/gold-trial & POST /api/gold-trial/claim (lihat
     goldTrialManager.js/server.js — sudah dimigrasikan utuh dari project
     lama). Logic eligibility/durasi/limit/anti-double-claim SEPENUHNYA
     ditentukan backend; blok ini murni tampilan + pemanggilan API + reaksi
     terhadap event realtime yang sudah ada (account:update, transaction:update,
     notification). Desain kartu & toast SENGAJA baru (lihat .gt-card/.gt-toast
     di styles.css), TIDAK meniru tampilan Gold Trial di project lama. ──────── */
  let _gtLastData = null;   // cache respons terakhir GET /api/gold-trial
  let _gtCountdownTimer = null;
  let _gtClaiming = false;
  // ── Modal Notifikasi Tawaran (Flow A/B) — lihat definisi
  // showGoldTrialOfferModal()/claimGoldTrialFromModal() di bawah.
  // _gtOfferSessionDismissed SENGAJA cuma variabel in-memory (BUKAN
  // localStorage/sessionStorage/field DB) — harus reset ke false tiap App
  // dibuka ulang (requirement: "NANTI SAJA" bukan permanent dismiss, lihat
  // dismissGoldTrialOfferModal()).
  let _gtOfferSessionDismissed = false;
  let _gtOfferClaiming = false;
  // ── BUGFIX: modal tawaran Gold Trial (FORCE) tiba-tiba tertutup sendiri
  // dalam ~1 detik. Root cause: showGoldTrialOfferModal() dipanggil dari 2
  // jalur independen — (1) FLOW A/normal, via applyGoldTrialAutoOffer() yang
  // membaca eligibility ASLI dari GET /api/gold-trial, dan (2) FLOW B/FORCE
  // (Admin TEST / Kirim Notifikasi), via handleGoldTrialPushNotification()
  // yang SENGAJA tidak terikat eligibility (lihat requirement #6/#12/#14 —
  // TEST & Kirim Notifikasi harus tetap tampil walau akun/device sudah
  // pernah klaim/tidak eligible). Modal FORCE ini langsung diikuti panggilan
  // loadGoldTrialOffer() (mis. karena halaman Beli Paket sedang terbuka, atau
  // event realtime lain seperti account:update/transaction:update/reconnect/
  // pindah halaman yang SEMUANYA memanggil loadGoldTrialOffer() juga) — begitu
  // response GET /api/gold-trial itu datang (~1 detik kemudian) & bilang
  // eligible:false (yang MEMANG hampir selalu benar untuk target TEST/force
  // notify), applyGoldTrialAutoOffer() menutup modal yang BARU SAJA tampil,
  // padahal modal itu bukan tawaran normal.
  // Fix: tandai SUMBER modal yang sedang tampil ('auto' vs 'force').
  // applyGoldTrialAutoOffer() (jalur FLOW A) TIDAK BOLEH menutup/menimpa
  // modal yang sumbernya 'force' — modal FORCE hanya boleh ditutup oleh aksi
  // eksplisit user (Claim/Nanti Saja) atau saat trial sudah benar-benar aktif
  // (push 'gold_trial_claim', lihat handleGoldTrialPushNotification()).
  let _gtModalSource = null; // null | 'auto' | 'force'
  // ── Anti-dobel-toast: backend (POST /api/gold-trial/claim, jalur klaim
  // NORMAL) SAMA-SAMA mengirim notifyUser(type:'gold_trial_claim') ke akun
  // yang barusan klaim (lihat server.js) — persis type yang SAMA dipakai
  // Force Claim admin untuk memberi tahu FLOW C (lihat
  // handleGoldTrialPushNotification() di bawah). Karena App yang melakukan
  // klaim normal itu juga otomatis menerima notifikasi WS 'notification'
  // itu sendiri (notifyUser selalu wsSendToUser ke discordId yang sama),
  // tanpa penanda ini toast sukses akan tampil DOBEL: sekali dari respons
  // API langsung (claimGoldTrial()/claimGoldTrialFromModal()), sekali lagi
  // dari push WS. Ditandai sesaat (bukan disimpan/persisten) tiap kali claim
  // NORMAL berhasil dari App ini sendiri, supaya handleGoldTrialPushNotification()
  // tahu untuk TIDAK menampilkan toast kedua kalinya untuk event yang sama.
  let _gtSelfClaimSuppressUntil = 0;

  function gtDurationText(ms) {
    if (ms <= 0) return 'segera berakhir';
    const totalMinutes = Math.floor(ms / 60000);
    const days = Math.floor(totalMinutes / 1440);
    const hours = Math.floor((totalMinutes % 1440) / 60);
    const minutes = totalMinutes % 60;
    if (days > 0) return `${days} hari ${hours} jam lagi`;
    if (hours > 0) return `${hours} jam ${minutes} menit lagi`;
    return `${Math.max(1, minutes)} menit lagi`;
  }

  // ── Render kartu Gold Trial di halaman Beli Paket, berdasarkan cache
  // _gtLastData terakhir.
  //   1. Eligible (belum pernah klaim & memenuhi syarat) -> tombol Claim
  //   2. Selain itu (trial sedang aktif/sudah pernah klaim/device sudah
  //      pernah klaim/tidak eligible/dst) -> kartu DISEMBUNYIKAN TOTAL.
  // BUGFIX: sebelumnya ada state ke-3 "Trial sedang aktif" yang menampilkan
  // kartu dengan status + sisa waktu — ini SALAH BACA requirement #6/#7/#8:
  // requirement #6 eksplisit bilang "Gold Trial Card hanya boleh muncul jika
  // user + device masih eligible UNTUK NORMAL GOLD TRIAL" (bukan buat
  // menampilkan status aktif), dan requirement #7/#8 eksplisit bilang card
  // harus LANGSUNG HILANG baik saat klaim BERHASIL maupun GAGAL karena sudah
  // pernah klaim/tidak eligible (requirement #9 cuma mengecualikan error
  // TEKNIS/sementara). Jadi begitu ada activeTrial (trial sedang berjalan,
  // baik dari klaim normal MAUPUN Force Claim admin), kartu di halaman Beli
  // Paket tetap harus hilang — sesuai instruksi "backend tetap sumber
  // kebenaran, jangan hardcode apa pun di frontend", di sini cuma membaca
  // field yang sudah dihitung backend (eligible), tidak menambah tampilan
  // baru yang tidak diminta.
  function renderGoldTrialCard() {
    const card = document.getElementById('goldTrialCard');
    if (!card) return;
    const data = _gtLastData;
    clearInterval(_gtCountdownTimer);

    if (data?.eligible) {
      card.hidden = false;
      card.dataset.state = 'offer';
      document.getElementById('gtCardTitle').textContent = 'Coba Gold, Gratis';
      const durationLabel = data.offer?.durationLabel || '';
      document.getElementById('gtCardDesc').textContent = `Akses semua benefit Gold secara gratis selama ${durationLabel}. Berlaku satu kali untuk akunmu.`;
      document.getElementById('gtCardMeta').hidden = true;
      // Kalau tombol sempat diganti jadi status pill (mis. sisa dari versi
      // lama), pastikan dikembalikan ke bentuk tombol Claim yang benar.
      let btn = document.getElementById('gtClaimBtn');
      if (!btn || btn.tagName !== 'BUTTON') {
        btn?.outerHTML && (btn.outerHTML = `<button type="button" class="gt-claim-btn" id="gtClaimBtn" onclick="claimGoldTrial()">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><use href="#ic-sparkles"></use></svg>
          <span id="gtClaimBtnLabel">Claim Gold Trial</span>
        </button>`);
        btn = document.getElementById('gtClaimBtn');
      }
      btn.disabled = false;
      const label = document.getElementById('gtClaimBtnLabel');
      if (label) label.textContent = 'Claim Gold Trial';
      return;
    }

    // Trial sedang aktif, sudah pernah klaim, device sudah pernah klaim,
    // tidak eligible, atau data belum ada sama sekali — kartu HILANG TOTAL,
    // tidak ada state lain yang ditampilkan (requirement #6/#7/#8).
    card.hidden = true;
  }

  async function loadGoldTrialOffer() {
    // Admin BUKAN user biasa — jangan pernah fetch/tawarkan Gold Trial sama
    // sekali (backend juga sudah menolak di getEligibility(), ini cuma
    // menghindari round-trip API yang percuma + memastikan kartu/modal
    // Gold Trial yang mungkin masih tersisa dari sesi sebelum jadi Admin
    // langsung hilang tanpa nunggu response server).
    if (currentUser?.role === 'admin') {
      _gtLastData = null;
      if (typeof renderGoldTrialCard === 'function') renderGoldTrialCard();
      if (typeof hideGoldTrialOfferModal === 'function') hideGoldTrialOfferModal();
      return;
    }
    try {
      const data = await api('/api/gold-trial');
      _gtLastData = data;
    } catch (e) {
      // BUGFIX (requirement #9/#12): error TEKNIS/sementara (network error,
      // timeout, server error 500 dari endpoint status ini sendiri) TIDAK
      // BOLEH menghapus kartu/modal Gold Trial yang sudah tampil — cuma
      // eligibility PERMANEN (already_claimed/device_already_claimed/
      // not_eligible/dst, yang datang sebagai response valid dari backend)
      // yang boleh menyembunyikannya. SEBELUMNYA baris ini mengosongkan
      // _gtLastData jadi null tiap kali fetch status gagal (termasuk
      // gangguan jaringan sesaat), yang membuat kartu Gold Trial hilang
      // padahal user masih eligible — cukup pertahankan data terakhir yang
      // diketahui (_gtLastData tidak diubah) dan biarkan kartu/modal apa
      // adanya sampai fetch berikutnya berhasil.
      console.warn('[Gold Trial] Gagal memuat status (mempertahankan tampilan terakhir):', e.message);
      return;
    }
    renderGoldTrialCard();
    // FLOW A (normal) — dipanggil dari enterApp() (login) & tiap Socket.IO
    // reconnect (lihat connectRealtime()), JADI selain merender kartu di
    // halaman Beli Paket, cek juga di sini apakah modal tawaran otomatis
    // perlu ditampilkan. Backend (getEligibility()) SUDAH menghitung eligible
    // dari user+device+claim history — FE murni membaca field ini, TIDAK ada
    // logic eligibility duplikat/hardcode di sisi App.
    applyGoldTrialAutoOffer(_gtLastData);
  }

  // `data.eligible` dari GET /api/gold-trial SUDAH mencakup seluruh syarat
  // Flow A (Gold Trial aktif di Admin Web, user+device belum pernah klaim,
  // member baru sesuai cutoff activatedAt) — kalau true, `data.offer` PASTI
  // terisi (lihat server.js). `_gtOfferSessionDismissed` cuma menyaring jalur
  // OTOMATIS ini (Flow A) supaya tidak spam tiap reconnect dalam SESSION APP
  // yang sama — TIDAK menyaring notifikasi FORCE dari Admin (Flow B), yang
  // selalu lewat showGoldTrialOfferModal() langsung dari
  // handleGoldTrialPushNotification() di bawah.
  function applyGoldTrialAutoOffer(data) {
    // Modal sedang menampilkan notifikasi FORCE (Admin TEST / Kirim
    // Notifikasi) — SENGAJA independen dari eligibility asli (lihat
    // requirement #6/#12/#14), jadi jalur AUTO/normal ini tidak boleh
    // menutup ataupun menimpanya. Modal FORCE hanya ditutup lewat aksi user
    // (Claim/Nanti Saja) atau saat trial sudah aktif beneran (lihat
    // handleGoldTrialPushNotification(), type 'gold_trial_claim').
    if (_gtModalSource === 'force') return;

    if (data?.eligible && data.offer) {
      if (!_gtOfferSessionDismissed) {
        showGoldTrialOfferModal(data.offer.offerMessage, data.offer.durationLabel, 'auto');
      }
    } else {
      // Sudah tidak eligible lagi (mis. baru saja diklaim dari device/akun
      // lain, atau Gold Trial dinonaktifkan admin) — modal tawaran normal
      // tidak relevan lagi kalau kebetulan masih terbuka.
      hideGoldTrialOfferModal();
    }
  }

  // ── Modal premium "GOLD TRIAL TERSEDIA" — satu-satunya template notifikasi
  // tawaran Gold Trial (normal DAN force), sesuai requirement "SATU template
  // notification yang rapi". Semua teks (deskripsi/durasi) dinamis dari
  // parameter yang dikirim backend, TIDAK ADA yang di-hardcode di sini. ──
  function showGoldTrialOfferModal(description, durationLabel, source = 'auto') {
    const modal = document.getElementById('goldTrialOfferModal');
    if (!modal) return;
    // 'force' (Admin TEST/Kirim Notifikasi) selalu boleh menimpa modal 'auto'
    // yang sedang tampil — tapi modal 'auto' TIDAK BOLEH menimpa modal
    // 'force' yang sedang tampil (lihat catatan _gtModalSource di atas),
    // supaya konten FORCE yang sedang dibaca user tidak tiba-tiba berganti
    // isi oleh proses eligibility check yang berjalan di background.
    if (_gtModalSource === 'force' && source !== 'force') return;
    _gtModalSource = source;
    const descEl = document.getElementById('gtOfferDesc');
    if (descEl) descEl.textContent = description || '';
    const durEl = document.getElementById('gtOfferDuration');
    const durLabelEl = document.getElementById('gtOfferDurationLabel');
    if (durationLabel && durEl && durLabelEl) {
      durLabelEl.textContent = durationLabel;
      durEl.hidden = false;
    } else if (durEl) {
      durEl.hidden = true;
    }
    // Pastikan tombol Claim kembali ke state normal (jaga-jaga modal ini
    // sempat menampilkan state "Claiming..." dari kemunculan sebelumnya di
    // session yang sama, mis. Admin kirim FORCE notification lagi).
    const btn = document.getElementById('gtOfferClaimBtn');
    const label = document.getElementById('gtOfferClaimBtnLabel');
    if (btn) { btn.disabled = false; btn.classList.remove('is-loading'); }
    if (label) label.textContent = 'Claim Gold Trial';
    const icon = btn?.querySelector('svg');
    if (icon) icon.classList.remove('icon-spin');
    modal.classList.add('show');
  }

  function hideGoldTrialOfferModal() {
    document.getElementById('goldTrialOfferModal')?.classList.remove('show');
    _gtModalSource = null;
  }

  // Tombol "NANTI SAJA" — TIDAK claim, TIDAK mengubah status klaim/device/
  // eligibility apa pun di backend (database tetap source of truth). Cuma
  // menutup modal untuk SESSION APP SAAT INI lewat variabel in-memory di
  // atas — kalau App ditutup lalu dibuka lagi, _gtOfferSessionDismissed
  // reset ke false dan modal Flow A akan muncul lagi selama backend masih
  // bilang eligible (lihat applyGoldTrialAutoOffer()).
  function dismissGoldTrialOfferModal() {
    _gtOfferSessionDismissed = true;
    hideGoldTrialOfferModal();
  }

  // Tombol "CLAIM GOLD TRIAL" di modal — flow PERSIS sama dengan
  // claimGoldTrial() (kartu di halaman Beli Paket): satu-satunya endpoint
  // yang dipanggil tetap POST /api/gold-trial/claim existing, jadi validasi
  // normal backend (eligibility asli, anti-double-claim per akun MAUPUN per
  // device) tetap berlaku PENUH walau modal ini sebelumnya muncul dari
  // FORCE notification Admin (TEST/Kirim Notifikasi) — kalau akun/device
  // ternyata sudah pernah klaim, backend akan menolak di sini, BUKAN di FE.
  async function claimGoldTrialFromModal() {
    if (_gtOfferClaiming) return;
    const btn = document.getElementById('gtOfferClaimBtn');
    const label = document.getElementById('gtOfferClaimBtnLabel');
    if (!btn) return;
    _gtOfferClaiming = true;
    btn.disabled = true;
    if (label) label.textContent = 'Claiming...';
    btn.classList.add('is-loading');
    const icon = btn.querySelector('svg');
    if (icon) icon.classList.add('icon-spin');

    try {
      const result = await api('/api/gold-trial/claim', { method: 'POST' });
      // Sama seperti claimGoldTrial() (kartu) — cegah toast sukses dobel dari
      // push WS 'gold_trial_claim' yang menyusul (lihat catatan
      // _gtSelfClaimSuppressUntil di atas).
      _gtSelfClaimSuppressUntil = Date.now() + 8000;
      hideGoldTrialOfferModal();
      showGoldTrialToast('success', 'Gold Trial Aktif', result.message || `Gold Trial kamu berhasil diaktifkan selama ${result.durationLabel}.`);
      // BUGFIX (requirement #7): klaim BERHASIL harus LANGSUNG menyembunyikan
      // kartu di halaman Beli Paket SEKARANG JUGA (kalau kebetulan sedang
      // terbuka di belakang modal ini), tanpa menunggu round-trip GET
      // /api/gold-trial berikutnya. account:update dari server tetap
      // memperbarui badge/akses lain seperti biasa lewat handleAccountUpdate().
      document.getElementById('goldTrialCard')?.setAttribute('hidden', '');
      await loadGoldTrialOffer();
    } catch (e) {
      hideGoldTrialOfferModal();
      showGoldTrialToast('error', 'Gold Trial Gagal', e.message || 'Gold Trial tidak dapat diaktifkan.');
      // BUGFIX (requirement #8/#9): sama seperti claimGoldTrial() (kartu) —
      // kalau backend menyertakan `reason` (kegagalan PERMANEN/eligibility,
      // mis. device_already_claimed dari akun/device yang sudah pernah
      // klaim — lihat requirement CASE 6), kartu di Beli Paket langsung
      // hilang juga. Error TEKNIS/sementara (tanpa `reason`) TIDAK menyentuh
      // kartu — biar loadGoldTrialOffer() di bawah yang menentukan (dan
      // kalau refresh itu sendiri gagal karena jaringan, kartu tetap seperti
      // apa adanya, tidak ikut hilang).
      if (e.data && e.data.reason) {
        document.getElementById('goldTrialCard')?.setAttribute('hidden', '');
      }
      await loadGoldTrialOffer();
    } finally {
      _gtOfferClaiming = false;
      btn.disabled = false;
      if (label) label.textContent = 'Claim Gold Trial';
      btn.classList.remove('is-loading');
      if (icon) icon.classList.remove('icon-spin');
    }
  }

  // ── Notifikasi premium klaim Gold Trial (berhasil/gagal) — REUSE penuh
  // infrastruktur toast paket (#pkgToastStack, removePkgToastEl(),
  // repositionNotificationStacks()) yang sudah ada, cuma dengan tampilan
  // .gt-toast baru (lihat styles.css). Bukan alert(), bukan sistem baru. ──
  function showGoldTrialToast(kind, title, message) {
    const stack = document.getElementById('pkgToastStack');
    if (!stack) return;
    const isSuccess = kind === 'success';
    const iconUse = isSuccess ? '#ic-circle-check-big' : '#ic-circle-x';
    const el = document.createElement('div');
    el.className = 'pkg-toast gt-toast ' + (isSuccess ? 'gt-success' : 'gt-error');
    el.innerHTML = `
      <span class="pkg-toast-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><use href="${iconUse}"></use></svg></span>
      <span class="pkg-toast-body">
        <span class="pkg-toast-title"></span>
        <span class="pkg-toast-change" style="display:block;"><span class="pkg-toast-tier" style="color:var(--text-secondary);font-weight:500;"></span></span>
        ${isSuccess ? `<button type="button" class="gt-toast-cta" onclick="setNav('belipaket')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><use href="#ic-crown"></use></svg><span>Lihat Paket</span></button>` : ''}
      </span>
      <button class="pkg-toast-close" aria-label="Tutup notifikasi" onclick="removePkgToastEl(this.closest('.pkg-toast'))">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>`;
    el.querySelector('.pkg-toast-title').textContent = title;
    el.querySelector('.pkg-toast-tier').textContent = message;
    stack.appendChild(el);
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('show')));
    repositionNotificationStacks();
    setTimeout(() => removePkgToastEl(el), isSuccess ? 6000 : 5000);
  }

  // ── Klik tombol Claim Gold Trial — flow PERSIS mengikuti backend existing:
  // POST /api/gold-trial/claim -> backend validasi (eligibility, anti-double-
  // claim via unique index) -> kalau sukses, role/activeUntil user berubah di
  // DB & di-broadcast lewat event 'account:update' (sudah ditangani
  // handleAccountUpdate() -> badge/akses game-bypass/kartu paket lain ikut
  // berubah realtime TANPA kode tambahan apa pun di sini). ──
  async function claimGoldTrial() {
    if (_gtClaiming) return;
    const btn = document.getElementById('gtClaimBtn');
    const label = document.getElementById('gtClaimBtnLabel');
    if (!btn || btn.tagName !== 'BUTTON') return; // sudah aktif/bukan tombol claim lagi
    _gtClaiming = true;
    btn.disabled = true;
    const originalLabel = label ? label.textContent : '';
    if (label) label.textContent = 'Claiming...';
    btn.classList.add('is-loading');
    const iconEl = btn.querySelector('svg');
    if (iconEl) iconEl.classList.add('icon-spin');

    try {
      const result = await api('/api/gold-trial/claim', { method: 'POST' });
      // Tandai supaya push WS 'gold_trial_claim' yang menyusul dari backend
      // (lihat catatan _gtSelfClaimSuppressUntil di atas) tidak menampilkan
      // toast sukses kedua kalinya untuk klaim yang sama.
      _gtSelfClaimSuppressUntil = Date.now() + 8000;
      showGoldTrialToast('success', 'Gold Trial Aktif', result.message || `Gold Trial kamu berhasil diaktifkan selama ${result.durationLabel}.`);
      // BUGFIX (requirement #7 — "Card harus LANGSUNG menghilang berdasarkan
      // perubahan state, tidak perlu refresh/restart"): klaim BERHASIL harus
      // langsung menyembunyikan kartu SEKARANG JUGA, tanpa menunggu round-trip
      // GET /api/gold-trial berikutnya (yang baru selesai ~1 detik kemudian).
      // account:update dari server (dikirim bareng respons ini) tetap
      // memperbarui badge/akses lain lewat handleAccountUpdate() yang sudah
      // ada seperti biasa.
      document.getElementById('goldTrialCard')?.setAttribute('hidden', '');
      await loadGoldTrialOffer();
    } catch (e) {
      showGoldTrialToast('error', 'Gold Trial Gagal', e.message || 'Gold Trial tidak dapat diaktifkan.');
      // BUGFIX (requirement #8/#9): backend SELALU menyertakan field `reason`
      // (mis. already_claimed/device_already_claimed/not_new_member/dst)
      // untuk kegagalan yang sifatnya EEigibility/PERMANEN — kalau `reason`
      // ada, klaim gagal karena Gold Trial memang sudah tidak bisa dipakai
      // lagi untuk akun/device ini, jadi kartu harus LANGSUNG hilang sama
      // seperti klaim berhasil (requirement #8). Error TEKNIS/sementara
      // (network error/timeout/server error generic) TIDAK membawa field
      // `reason` sama sekali (lihat api(), server.js catch(e) generik di
      // POST /api/gold-trial/claim) — untuk kasus ini kartu TETAP ADA supaya
      // user bisa coba lagi (requirement #9/#12).
      if (e.data && e.data.reason) {
        document.getElementById('goldTrialCard')?.setAttribute('hidden', '');
      }
      // Refresh status terbaru dari backend — kalau ternyata memang masih
      // eligible (error jaringan sesaat), kartu & tombol Claim kembali
      // normal; kalau memang sudah tidak eligible, tetap konsisten hilang.
      await loadGoldTrialOffer();
    } finally {
      _gtClaiming = false;
      // Kalau refresh GET /api/gold-trial di atas JUGA gagal (error jaringan
      // yang sama yang bikin klaim gagal), loadGoldTrialOffer() sengaja tidak
      // menyentuh kartu sama sekali (supaya kartu tidak hilang) — tapi itu
      // berarti tombol Claim yang sudah kadung di-disable/"Claiming..." di
      // atas tidak pernah direset. Jaga-jaga: kalau tombol claim ini masih
      // ada di DOM dalam bentuk BUTTON yang sama, pastikan selalu kembali ke
      // state normal supaya user tetap bisa coba klaim lagi.
      const btnNow = document.getElementById('gtClaimBtn');
      if (btnNow && btnNow.tagName === 'BUTTON') {
        btnNow.disabled = false;
        btnNow.classList.remove('is-loading');
        const labelNow = document.getElementById('gtClaimBtnLabel');
        if (labelNow) labelNow.textContent = 'Claim Gold Trial';
        const iconNow = btnNow.querySelector('svg');
        if (iconNow) iconNow.classList.remove('icon-spin');
      }
    }
  }

  // ── Notifikasi personal Gold Trial dari Admin Web, datang lewat event WS
  // 'notification' (notifyUser() existing) — membedakan 2 jenis (FLOW B vs
  // FLOW C, lihat requirement #9):
  //   type 'gold_trial_offer' -> FLOW B: Admin Web "Kirim Notifikasi Gold
  //     Trial" (POST /api/admin/gold-trial/notify) ATAU tombol "TEST" (POST
  //     /api/admin/gold-trial/test). Ini SEKADAR tawaran — SELALU ditampilkan
  //     lewat modal premium yang sama dengan Flow A, TERLEPAS dari
  //     eligibility (server sengaja tidak mengecek eligible utk jalur ini,
  //     lihat requirement #6/#12) — klik Claim di modal tetap kena validasi
  //     normal backend (lihat claimGoldTrialFromModal()).
  //   type 'gold_trial_claim' -> FLOW C: Admin Web "Force Claim". Gold Trial
  //     SUDAH aktif duluan oleh backend (bukan hasil klik Claim user), jadi
  //     TIDAK ADA aksi yang perlu diambil -> toast sukses biasa, BUKAN modal
  //     tawaran (reuse showGoldTrialToast() yang sudah ada).
  function handleGoldTrialPushNotification(notif) {
    if (!notif) return;
    if (notif.type === 'gold_trial_offer') {
      // FLOW B — selalu 'force': independen dari eligibility asli, dan
      // TIDAK BOLEH otomatis ketutup oleh loadGoldTrialOffer() di bawah
      // (lihat catatan _gtModalSource di atas / bugfix "notif 1 detik
      // langsung hilang sendiri").
      showGoldTrialOfferModal(notif.message, notif.meta?.durationLabel, 'force');
      if (document.getElementById('page-belipaket')?.classList.contains('active')) {
        // Tetap refresh KARTU (state eligible/active) di halaman Beli Paket
        // supaya sinkron dengan backend — tapi modal FORCE di atas aman,
        // applyGoldTrialAutoOffer() akan skip karena _gtModalSource==='force'.
        loadGoldTrialOffer();
      }
      return;
    }
    if (notif.type === 'gold_trial_claim') {
      // Kalau modal tawaran normal (Flow A) kebetulan masih terbuka di
      // App ini, tutup — trial akun ini sudah aktif duluan (baik lewat Force
      // Claim admin MAUPUN klaim normal yang barusan berhasil), jadi tawaran
      // claim manual sudah tidak relevan lagi.
      hideGoldTrialOfferModal();
      if (document.getElementById('page-belipaket')?.classList.contains('active')) {
        loadGoldTrialOffer();
      }
      // Push WS ini SAMA-SAMA terkirim untuk klaim NORMAL yang baru saja
      // dilakukan App ini sendiri (lihat catatan _gtSelfClaimSuppressUntil
      // di atas) — kalau memang itu sumbernya, toast sukses SUDAH tampil
      // dari respons API langsung (claimGoldTrial()/claimGoldTrialFromModal()),
      // jadi jangan tampilkan lagi di sini. Selain window itu, satu-satunya
      // sumber event ini adalah FLOW C (Force Claim admin) -> toast tetap
      // ditampilkan seperti biasa.
      if (Date.now() < _gtSelfClaimSuppressUntil) return;
      showGoldTrialToast('success', notif.title || 'Gold Trial Aktif', notif.message || '');
    }
  }

  // ── Modal Konfirmasi Pembelian ──
  function openPkgConfirm(tier) {
    if (!_pkgLastData || !_pkgLastData.packages) return;
    const p = _pkgLastData.packages[tier];
    if (!p || !p.active) return;
    if (!_pkgLastData.gatewayEnabled || !(_pkgLastData.paymentMethods || []).length) {
      showToast('error', 'Payment Gateway Tidak Tersedia', 'Pembayaran sedang tidak tersedia, coba lagi nanti.');
      return;
    }
    _pkgSelectedTier = tier;
    document.getElementById('pkgConfirmTier').textContent = PKG_TIER_LABEL[tier] || tier;
    document.getElementById('pkgConfirmDuration').textContent = p.durationLabel || '-';
    document.getElementById('pkgConfirmPrice').textContent = rupiah(p.price);
    document.getElementById('pkgConfirmTotal').textContent = rupiah(p.price);
    const btn = document.getElementById('pkgConfirmPayBtn');
    btn.disabled = false;
    btn.textContent = 'Bayar Sekarang';
    document.getElementById('pkgConfirmModal').classList.add('show');
  }
  function closePkgConfirm() {
    document.getElementById('pkgConfirmModal').classList.remove('show');
  }
  window.openPkgConfirm = openPkgConfirm;

  async function startPkgPurchase() {
    if (!_pkgSelectedTier) return;
    const btn = document.getElementById('pkgConfirmPayBtn');
    btn.disabled = true;
    btn.textContent = 'Memproses...';
    try {
      const res = await api('/api/packages/purchase', {
        method: 'POST',
        body: JSON.stringify({ tier: _pkgSelectedTier, method: 'qris' })
      });
      closePkgConfirm();
      openPkgPayment(res.transaction);
    } catch (e) {
      showToast('error', 'Gagal Membuat Transaksi', e.message || 'Coba lagi sebentar.');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Bayar Sekarang';
    }
  }

  // ── Modal Pembayaran QRIS (status realtime + fallback polling) ──
  function openPkgPayment(tx) {
    _pkgOpenTx = tx;
    renderPkgPaymentModal(tx);
    document.getElementById('pkgPaymentModal').classList.add('show');
    stopPkgTimers();
    if (tx.status === 'pending') {
      _pkgCountdownTimer = setInterval(updatePkgCountdown, 1000);
      _pkgPollTimer = setInterval(pollPkgPurchaseStatus, 5000);
      updatePkgCountdown();
    }
  }
  function closePkgPayment() {
    document.getElementById('pkgPaymentModal').classList.remove('show');
    stopPkgTimers();
    _pkgOpenTx = null;
    // Riwayat kartu paket (status aktif/tombol) sudah ikut berubah realtime
    // lewat handleAccountUpdate() begitu server konfirmasi lunas — di sini
    // cukup pastikan kartu ter-render ulang dari data terbaru.
    if (_pkgLastData) renderPkgCards(_pkgLastData);
  }
  function stopPkgTimers() {
    if (_pkgCountdownTimer) clearInterval(_pkgCountdownTimer);
    if (_pkgPollTimer) clearInterval(_pkgPollTimer);
    _pkgCountdownTimer = null;
    _pkgPollTimer = null;
  }

  function renderPkgPaymentModal(tx) {
    if (!tx) return;
    document.getElementById('pkgPayTitle').textContent = `Pembayaran ${PKG_TIER_LABEL[tx.tier] || tx.tier}`;
    document.getElementById('pkgPayOrderId').textContent = tx.orderId;

    const badge = document.getElementById('pkgPayStatusBadge');
    badge.textContent = PKG_STATUS_LABEL[tx.status] || tx.status;
    badge.dataset.status = tx.status;

    const qrWrap = document.getElementById('pkgPayQrWrap');
    const resultWrap = document.getElementById('pkgPayResult');
    const cancelBtn = document.getElementById('pkgPayCancelBtn');
    const closeBtn = document.getElementById('pkgPayCloseBtn');

    if (tx.status === 'pending') {
      qrWrap.hidden = false;
      resultWrap.hidden = true;
      cancelBtn.hidden = false;
      closeBtn.hidden = true;
      document.getElementById('pkgPayAmount').textContent = rupiah(tx.totalPayment || tx.amount);

      const qrImg = document.getElementById('pkgPayQrImg');
      const qrErr = document.getElementById('pkgPayQrError');
      // qrDataUrl = gambar QRIS ASLI dari KlikQRIS (lihat transactionManager.publicTransaction).
      // WAJIB dipakai apa adanya — TIDAK generate ulang QR dari teks lain.
      if (tx.qrDataUrl) {
        qrImg.style.display = '';
        qrImg.src = tx.qrDataUrl;
        qrErr.hidden = true;
      } else {
        qrImg.style.display = 'none';
        qrErr.hidden = false;
      }
    } else {
      qrWrap.hidden = true;
      resultWrap.hidden = false;
      cancelBtn.hidden = true;
      closeBtn.hidden = false;
      if (tx.status === 'completed') {
        resultWrap.className = 'pmc-pay-result pmc-pay-result--success';
        resultWrap.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><use href="#ic-circle-check-big"></use></svg><span>Pembayaran berhasil! Paket ${escapeHtml(PKG_TIER_LABEL[tx.tier] || tx.tier)} kamu sudah aktif.</span>`;
      } else if (tx.status === 'expired') {
        resultWrap.className = 'pmc-pay-result pmc-pay-result--muted';
        resultWrap.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><use href="#ic-timer"></use></svg><span>Waktu pembayaran habis. Silakan buat transaksi baru.</span>`;
      } else {
        resultWrap.className = 'pmc-pay-result pmc-pay-result--danger';
        resultWrap.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><use href="#ic-circle-x"></use></svg><span>Transaksi ${escapeHtml(PKG_STATUS_LABEL[tx.status] || tx.status)}.</span>`;
      }
    }
  }

  function updatePkgCountdown() {
    if (!_pkgOpenTx || _pkgOpenTx.status !== 'pending') return;
    const remainMs = new Date(_pkgOpenTx.expiresAt).getTime() - Date.now();
    const el = document.getElementById('pkgPayCountdown');
    if (remainMs <= 0) { if (el) el.textContent = '00:00'; return; }
    const mm = String(Math.floor(remainMs / 60000)).padStart(2, '0');
    const ss = String(Math.floor((remainMs % 60000) / 1000)).padStart(2, '0');
    if (el) el.textContent = `${mm}:${ss}`;
  }

  // Fallback polling tiap 5 detik selagi status masih pending (jaga-jaga WS
  // lagi putus) — handlePkgTransactionUpdate() yang render ulang UI-nya, jadi
  // dipakai bareng dengan jalur realtime WS tanpa duplikasi logic.
  async function pollPkgPurchaseStatus() {
    if (!_pkgOpenTx || _pkgOpenTx.status !== 'pending') { stopPkgTimers(); return; }
    try {
      const res = await api(`/api/packages/purchase/${encodeURIComponent(_pkgOpenTx.orderId)}`);
      handlePkgTransactionUpdate(res.transaction);
    } catch (e) { /* diam-diam, coba lagi 5 detik berikutnya */ }
  }

  // Dipicu WS event 'transaction:update' (realtime, lihat connectRealtime())
  // ATAU hasil polling fallback di atas.
  function handlePkgTransactionUpdate(tx) {
    if (!tx) return;
    if (_pkgOpenTx && _pkgOpenTx.orderId === tx.orderId) {
      _pkgOpenTx = tx;
      renderPkgPaymentModal(tx);
      if (tx.status !== 'pending') stopPkgTimers();
    }
  }

  async function cancelPkgPurchase() {
    if (!_pkgOpenTx || _pkgOpenTx.status !== 'pending') return;
    if (!confirm('Batalkan transaksi ini? Kamu bisa buat transaksi baru kapan saja kalau berubah pikiran.')) return;
    const btn = document.getElementById('pkgPayCancelBtn');
    btn.disabled = true;
    btn.textContent = 'Membatalkan...';
    try {
      const res = await api(`/api/packages/purchase/${encodeURIComponent(_pkgOpenTx.orderId)}/cancel`, { method: 'POST' });
      handlePkgTransactionUpdate(res.transaction);
      showToast('cancel', 'Pembayaran Dibatalkan', 'Transaksi kamu telah dibatalkan dan paket belum diaktifkan.');
    } catch (e) {
      showToast('error', 'Gagal Membatalkan', e.message || '');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Batalkan Pembayaran';
    }
  }

  // Pasang listener tombol statis (dipanggil sekali dari initAppShellDemo()) —
  // tombol per-kartu paket pakai onclick inline (openPkgConfirm(tier)) karena
  // dibuat ulang tiap renderPkgCards(), jadi tidak bisa di-attach di sini.
  function initBeliPaketPage() {
    const closeConfirmBtn = document.getElementById('pkgConfirmCloseBtn');
    if (closeConfirmBtn) closeConfirmBtn.addEventListener('click', closePkgConfirm);

    const payBtn = document.getElementById('pkgConfirmPayBtn');
    if (payBtn) payBtn.addEventListener('click', startPkgPurchase);

    const cancelBtn = document.getElementById('pkgPayCancelBtn');
    if (cancelBtn) cancelBtn.addEventListener('click', cancelPkgPurchase);

    const closePayBtn = document.getElementById('pkgPayCloseBtn');
    if (closePayBtn) closePayBtn.addEventListener('click', closePkgPayment);
  }
  /* ══════════════════════════════════════════════════════════════════════════
     AKHIR BLOK BELI PAKET
     ══════════════════════════════════════════════════════════════════════════ */

  /* ══════════════════════════════════════════════════════════════════════════
     REQUEST GAME — halaman baru (nav "Request Game", tepat setelah
     Marketplace). Backend 100% EXISTING & sudah dipakai Admin Web duluan —
     TIDAK ada endpoint/database/Socket.IO/limit system baru di sini:
       GET  /api/requests/limit-info   -> status limit harian user (role-based,
                                           reset jam yang diatur Admin)
       GET  /api/requests/browse       -> katalog HubCap (App ID/nama/artwork
                                           asli), + requestStatus per user
       POST /api/requests/games        -> buat request (backend yang validasi
                                           enabled/limit/duplicate/existing game,
                                           App CUMA pre-check pakai limit-info
                                           utk UX, backend TETAP authority)
       WS 'gameRequest:update'               -> status request user berubah
       WS 'request-game-settings:update'     -> Admin ubah limit/enable/reset

     TIDAK ADA halaman Detail Game di sini (requirement eksplisit) — satu-
     satunya aksi per game adalah tombol "Request Game" di grid -> popup
     konfirmasi YES/NO -> kirim.

     REDESIGN (pagination): sebelumnya "Muat Lebih Banyak" (akumulasi
     infinite-load, 50/batch). Sekarang numbered pagination sungguhan,
     80 game/halaman (RG_PAGE_SIZE — HARUS sama dengan PAGE_SIZE di
     server.js GET /api/requests/browse), totalPages SELALU dihitung dari
     totalData yang backend kembalikan (Math.ceil(totalData/80)), tidak
     pernah hardcode. Ganti halaman = fetch ulang halaman itu (replace,
     bukan concat) — lihat loadRgBrowsePage()/renderRgPagination(). ──── */
  const RG_PAGE_SIZE = 80;
  let _rgSettings = null;      // hasil terakhir /api/requests/limit-info (enabled/role/limit/used/remaining/allowed/resetAt)
  let _rgItems = [];           // item HALAMAN YANG SEDANG TAMPIL SAJA (bukan akumulasi lagi)
  let _rgCurrentPage = 1;
  let _rgTotalPages = 1;
  let _rgTotalData = 0;
  let _rgSearchTerm = '';
  let _rgSearchDebounceTimer = null;
  let _rgLoading = false;
  let _rgConfirmTarget = null; // { appId, name } yang lagi dikonfirmasi di popup
  let _rgSubmitting = false;

  function rgFmtResetTime(iso) {
    try {
      return new Date(iso).toLocaleString('id-ID', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jakarta' }) + ' WIB';
    } catch (e) { return ''; }
  }

  async function loadRgLimitInfo() {
    try {
      _rgSettings = await api('/api/requests/limit-info');
      renderRgLimitBox();
    } catch (e) {
      // Diam-diam — limit box tetap hidden, tidak menghalangi grid tampil
      // (backend tetap authority saat request beneran dikirim nanti).
    }
  }

  function renderRgLimitBox() {
    const box = document.getElementById('rgLimitBox');
    if (!box || !_rgSettings) return;
    if (!_rgSettings.enabled) { box.hidden = true; return; }
    box.hidden = false;
    const valueEl = document.getElementById('rgLimitValue');
    const resetEl = document.getElementById('rgLimitReset');
    if (_rgSettings.limit >= 999) {
      valueEl.textContent = 'Tanpa Batas';
      resetEl.hidden = true;
    } else if (_rgSettings.limit <= 0) {
      valueEl.textContent = 'Tidak Tersedia';
      resetEl.hidden = true;
    } else {
      valueEl.textContent = `${_rgSettings.used} / ${_rgSettings.limit} digunakan`;
      if (_rgSettings.resetAt) {
        resetEl.hidden = false;
        resetEl.textContent = `Reset ${rgFmtResetTime(_rgSettings.resetAt)}`;
      } else {
        resetEl.hidden = true;
      }
    }
  }

  // VISIBILITY ≠ ACCESS (requirement #1): package/limit user TIDAK PERNAH
  // menyembunyikan grid/search — game (termasuk yang requirement-nya
  // Gratis/Public) tetap tampil apa adanya dari Hubcap. Package/limit HANYA
  // menentukan apakah tombol "Request Game" bisa dipakai atau tidak (lihat
  // rgGloballyBlocked() & renderRgCardHtml() di bawah). Fungsi ini dulu
  // bernama renderRgBlockedState() dan menyembunyikan TOTAL toolbar+grid+
  // pagination lalu menampilkan section besar di tengah halaman — itu
  // sekaligus bug "text section besar di tengah" (requirement #2) DAN bug
  // "game hilang" (requirement #1), karena keduanya disebabkan section yang
  // sama ini. Sekarang cuma 1 baris notice tipis di atas grid, grid/search/
  // pagination tidak pernah disembunyikan karena status ini.
  function renderRgAccessNotice() {
    const notice = document.getElementById('rgAccessNotice');
    const textEl = document.getElementById('rgAccessNoticeText');
    const ctaEl = document.getElementById('rgAccessNoticeCta');
    if (!notice || !_rgSettings) { if (notice) notice.hidden = true; return; }

    if (!_rgSettings.enabled) {
      notice.hidden = false;
      textEl.textContent = 'Fitur Request Game sedang dinonaktifkan oleh Admin.';
      ctaEl.hidden = true;
    } else if (_rgSettings.limit <= 0) {
      notice.hidden = false;
      textEl.textContent = `Request Game tidak tersedia untuk paket ${ROLE_DISPLAY_NAME[_rgSettings.role] || _rgSettings.role} kamu — upgrade paket untuk bisa request.`;
      ctaEl.hidden = false;
    } else if (_rgSettings.limit < 999 && _rgSettings.remaining <= 0) {
      notice.hidden = false;
      textEl.textContent = `Limit request game kamu hari ini sudah habis.${_rgSettings.resetAt ? ' Reset ' + rgFmtResetTime(_rgSettings.resetAt) + '.' : ''}`;
      ctaEl.hidden = true;
    } else {
      notice.hidden = true;
    }
  }

  // Backend tetap authority (requirement #1/#8): fungsi ini CUMA dipakai buat
  // menentukan tampilan tombol per kartu (disabled + label "Tidak Tersedia"),
  // BUKAN buat menyaring/menyembunyikan item apapun dari _rgItems.
  function rgGloballyBlocked() {
    if (!_rgSettings) return false;
    if (!_rgSettings.enabled) return true;
    if (_rgSettings.limit <= 0) return true;
    if (_rgSettings.limit < 999 && _rgSettings.remaining <= 0) return true;
    return false;
  }

  async function loadRequestGamePage() {
    _rgItems = [];
    _rgCurrentPage = 1;
    await loadRgLimitInfo();
    renderRgAccessNotice();
    // Search/grid/pagination SELALU dimuat & ditampilkan apa adanya (requirement
    // #1/#2/#9) — tidak ada lagi cabang early-return yang mengganti halaman ini
    // jadi blocked-state besar. Kalau fitur benar-benar dimatikan Admin,
    // backend (/api/requests/browse) yang menolak dengan 503 dan pesannya
    // tampil di #rgLoadError (lihat loadRgBrowsePage()) — bukan section baru.
    await loadRgBrowsePage(1);
  }

  // Ambil 1 HALAMAN (80 game) dari backend dan GANTIKAN isi grid — bukan lagi
  // akumulasi "Muat Lebih Banyak". Dipakai baik untuk load pertama, ganti
  // halaman lewat pagination, maupun search/filter (selalu mulai dari page 1).
  async function loadRgBrowsePage(page) {
    if (_rgLoading) return;
    _rgLoading = true;
    const grid = document.getElementById('rgGrid');
    const emptyState = document.getElementById('rgEmptyState');
    const errBox = document.getElementById('rgLoadError');
    const pagination = document.getElementById('rgPagination');
    emptyState.classList.remove('show');
    pagination.hidden = true;
    grid.innerHTML = Array(10).fill('<div class="card"><div class="thumb rg-skeleton"></div></div>').join('');
    try {
      const qs = new URLSearchParams({ page: String(page) });
      if (_rgSearchTerm) qs.set('search', _rgSearchTerm);
      const data = await api(`/api/requests/browse?${qs.toString()}`);
      errBox.hidden = true;
      _rgItems = Array.isArray(data.items) ? data.items : [];
      // Total halaman SELALU dari backend (yang dihitung dari totalData
      // Hubcap sebenarnya, PAGE_SIZE=80) — tidak pernah dihitung/ditebak di
      // sini, dan tidak pernah hardcode angka apapun.
      _rgCurrentPage = data.currentPage || page;
      _rgTotalPages = data.totalPages || 1;
      _rgTotalData = data.totalData || _rgItems.length;
      renderRgGrid();
      renderRgPagination();
    } catch (e) {
      _rgItems = [];
      renderRgGrid();
      errBox.hidden = false;
      errBox.textContent = e.message || 'Game gagal dimuat. Silakan coba lagi.';
      // Fitur baru saja dinonaktifkan Admin di tengah sesi -> sinkronkan
      // notice-nya (grid tetap di tempat, cuma kosong karena fetch-nya
      // gagal — pesannya sudah tampil di errBox di atas).
      // BUG FIX (audit): api() menaruh body error di `err.data`, BUKAN
      // `err.disabled` langsung — kode lama cek `e.disabled` yang selalu
      // undefined/falsy, jadi cabang ini TIDAK PERNAH jalan sebelumnya.
      if (e.data && e.data.disabled) {
        await loadRgLimitInfo();
        renderRgAccessNotice();
      }
    } finally {
      _rgLoading = false;
    }
  }

  // Daftar nomor halaman yang ditampilkan di pagination bar: selalu halaman
  // pertama & terakhir, +-1 di sekitar halaman aktif, sisanya "…" — supaya
  // tetap ringkas walau totalPages besar (mis. 500 game HubCap / 80 = 7
  // halaman masih semua tampil, tapi kalau jadi puluhan halaman tetap rapi).
  function rgPageNumbers(current, total) {
    const pages = [1];
    for (let p = current - 1; p <= current + 1; p++) { if (p > 1 && p < total) pages.push(p); }
    if (total > 1) pages.push(total);
    const uniq = [...new Set(pages)].sort((a, b) => a - b);
    const out = [];
    let prev = 0;
    for (const p of uniq) {
      if (prev && p - prev > 1) out.push('…');
      out.push(p);
      prev = p;
    }
    return out;
  }

  function renderRgPagination() {
    const el = document.getElementById('rgPagination');
    if (_rgTotalPages <= 1) { el.hidden = true; el.innerHTML = ''; return; }
    el.hidden = false;
    const nums = rgPageNumbers(_rgCurrentPage, _rgTotalPages);
    let html = `<button type="button" class="pagination-btn" data-nav="prev" ${_rgCurrentPage <= 1 ? 'disabled' : ''} aria-label="Halaman sebelumnya"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg></button>`;
    nums.forEach(n => {
      html += (n === '…')
        ? `<span class="pagination-ellipsis">…</span>`
        : `<button type="button" class="pagination-btn${n === _rgCurrentPage ? ' active' : ''}" data-page="${n}">${n}</button>`;
    });
    html += `<button type="button" class="pagination-btn" data-nav="next" ${_rgCurrentPage >= _rgTotalPages ? 'disabled' : ''} aria-label="Halaman berikutnya"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg></button>`;
    el.innerHTML = html;
    const goTo = (p) => {
      if (!p || p === _rgCurrentPage || p < 1 || p > _rgTotalPages) return;
      loadRgBrowsePage(p);
      const wrap = document.getElementById('rgGridWrap');
      if (wrap) wrap.scrollTop = 0;
    };
    el.querySelectorAll('.pagination-btn[data-page]').forEach(btn => {
      btn.addEventListener('click', () => goTo(parseInt(btn.dataset.page, 10)));
    });
    const prevBtn = el.querySelector('[data-nav="prev"]');
    const nextBtn = el.querySelector('[data-nav="next"]');
    if (prevBtn) prevBtn.addEventListener('click', () => goTo(_rgCurrentPage - 1));
    if (nextBtn) nextBtn.addEventListener('click', () => goTo(_rgCurrentPage + 1));
  }

  function rgStatusTagHtml(item) {
    const map = {
      available: { cls: 'success', icon: 'ic-circle-check-big', label: 'Sudah Tersedia' },
      pending: { cls: 'gold', icon: 'ic-timer', label: 'Menunggu Review' },
      approved: { cls: 'success', icon: 'ic-circle-check-big', label: 'Disetujui' },
      rejected: { cls: 'danger', icon: 'ic-circle-x', label: 'Ditolak' }
    };
    const meta = map[item.requestStatus];
    if (!meta) return '';
    return `<span class="rg-status-tag rg-status-tag--${meta.cls}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><use href="#${meta.icon}"></use></svg> ${meta.label}</span>`;
  }

  // Kartu Request Game — reuse markup .card/.thumb/.card-info PERSIS sama
  // dengan Games/Bypass (renderMediaGridCard), cuma footer-nya beda: tombol
  // "Request Game", bukan overlay klik-ke-detail/install. Tidak ada
  // category/mode di sini karena browse HubCap memang tidak membawa data
  // itu (lihat fetchRequestGameBrowsePage di server.js) — sesuai requirement
  // "jangan fabrikasi data yang tidak ada".
  function renderRgCardHtml(item) {
    const img = item.headerImage || (Array.isArray(item.images) && item.images[0]) || '';
    const imgTag = img ? `<img src="${escapeHtml(img)}" alt="${escapeHtml(item.name)}" loading="lazy">` : '';
    // Game SELALU tampil di grid apa adanya (requirement #1: visibility != access)
    // — status di bawah ini HANYA memutuskan apakah tombolnya bisa dipakai +
    // labelnya, tidak pernah dipakai buat filter/hilangkan item dari _rgItems.
    const statusDisabled = item.requestStatus === 'available' || item.requestStatus === 'pending' || item.requestStatus === 'approved';
    // Backend (limit-info) tetap authority untuk eligibility paket/limit harian
    // (rgGloballyBlocked()) — kalau user memang tidak boleh request sama sekali
    // saat ini, tombol dinonaktifkan + label diganti "Tidak Tersedia" yang jelas,
    // TAPI game itu sendiri tetap terlihat di grid (bukan disembunyikan).
    const blockedByAccess = !statusDisabled && rgGloballyBlocked();
    const disabled = statusDisabled || blockedByAccess;
    let label = item.requestStatus === 'rejected' ? 'Request Lagi' : 'Request Game';
    if (blockedByAccess) label = 'Tidak Tersedia';
    return `
    <div class="card rg-card" data-appid="${escapeHtml(item.appId)}">
      <div class="thumb">
        ${imgTag}
        ${item.requestStatus ? rgStatusTagHtml(item) : ''}
        <div class="card-info">
          <span class="card-title">${escapeHtml(item.name)}</span>
        </div>
      </div>
      <div class="rg-card-actions">
        <button type="button" class="rg-request-btn" data-appid="${escapeHtml(item.appId)}" data-name="${escapeHtml(item.name)}" data-img="${escapeHtml(img)}" ${disabled ? 'disabled' : ''}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><use href="#ic-send"></use></svg>
          <span>${label}</span>
        </button>
      </div>
    </div>`;
  }

  function renderRgGrid() {
    const grid = document.getElementById('rgGrid');
    const emptyState = document.getElementById('rgEmptyState');
    const emptyText = document.getElementById('rgEmptyText');
    if (!_rgItems.length) {
      grid.innerHTML = '';
      emptyState.classList.add('show');
      emptyText.textContent = _rgSearchTerm ? 'Game yang kamu cari tidak ditemukan.' : 'Game tidak ditemukan.';
      return;
    }
    emptyState.classList.remove('show');
    grid.innerHTML = _rgItems.map(renderRgCardHtml).join('');
    grid.querySelectorAll('.rg-request-btn[data-appid]').forEach(btn => {
      // stopPropagation() = jaga-jaga event bubbling (requirement #6) — supaya
      // klik tombol ini TIDAK PERNAH ikut memicu handler klik lain di parent
      // kartu/grid manapun, sekarang atau di masa depan.
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        openRgConfirm(btn.dataset.appid, btn.dataset.name, btn.dataset.img);
      });
    });
  }

  // Search: reset ke Page 1 & hitung ulang total (requirement #11) — TIDAK
  // pernah mempertahankan halaman lama begitu hasil pencarian berubah.
  document.getElementById('rgSearchInput')?.addEventListener('input', (e) => {
    clearTimeout(_rgSearchDebounceTimer);
    const value = e.target.value.trim();
    _rgSearchDebounceTimer = setTimeout(() => {
      _rgSearchTerm = value;
      loadRgBrowsePage(1);
    }, 450); // debounce — cegah request HubCap berlebihan tiap ketikan
  });

  // ── Popup konfirmasi (requirement #10-12): counter/limit TIDAK berubah
  // sampai backend benar-benar berhasil membuat request (POST di bawah). ──
  function openRgConfirm(appId, name, img) {
    _rgConfirmTarget = { appId, name };
    document.getElementById('rgConfirmName').textContent = name;
    const thumb = document.getElementById('rgConfirmThumb');
    if (img) { thumb.src = img; thumb.style.display = ''; } else { thumb.removeAttribute('src'); thumb.style.display = 'none'; }
    resetRgConfirmButtons();
    document.getElementById('rgConfirmOverlay').classList.add('show');
  }
  function closeRgConfirm() {
    if (_rgSubmitting) return; // cegah tutup di tengah proses kirim
    document.getElementById('rgConfirmOverlay').classList.remove('show');
    _rgConfirmTarget = null;
  }
  function resetRgConfirmButtons() {
    const yesBtn = document.getElementById('rgConfirmYesBtn');
    const noBtn = document.getElementById('rgConfirmNoBtn');
    yesBtn.disabled = false; noBtn.disabled = false;
    yesBtn.innerHTML = 'Ya, Request Game';
  }

  async function submitRgRequest() {
    if (!_rgConfirmTarget || _rgSubmitting) return; // cegah double-click
    _rgSubmitting = true;
    const yesBtn = document.getElementById('rgConfirmYesBtn');
    const noBtn = document.getElementById('rgConfirmNoBtn');
    yesBtn.disabled = true;
    noBtn.disabled = true;
    yesBtn.innerHTML = '<svg class="rg-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><use href="#ic-loader-circle"></use></svg><span>Mengirim...</span>';

    const target = _rgConfirmTarget;
    try {
      // Backend (POST /api/requests/games) yang melakukan SEMUA validasi
      // final: session, limit harian, duplicate, existing game, HubCap —
      // App di sini TIDAK mengecek ulang apapun, murni terusin ke server.
      await api('/api/requests/games', { method: 'POST', body: JSON.stringify({ appId: target.appId }) });

      document.getElementById('rgConfirmOverlay').classList.remove('show');
      _rgConfirmTarget = null;

      const found = _rgItems.find(it => it.appId === target.appId);
      if (found) { found.requestStatus = 'pending'; renderRgGrid(); }

      // Limit HANYA berkurang di UI setelah backend konfirmasi sukses —
      // ambil ulang dari /api/requests/limit-info (bukan dihitung sendiri
      // di frontend), sesuai requirement #16/#20.
      await loadRgLimitInfo();

      showToast('success', 'Request Terkirim', `Request game "${target.name}" berhasil dikirim ke Admin.${(_rgSettings && _rgSettings.limit < 999) ? ` Sisa request: ${_rgSettings.remaining}.` : ''}`);
    } catch (e) {
      // Pesan error APA ADANYA dari backend (LIMIT_REACHED/ALREADY_REQUESTED/
      // dst sudah dikemas jadi message ramah di server.js) — tidak ditimpa.
      showToast('error', 'Request Gagal', e.message || 'Request game gagal dikirim.');
      if (/limit/i.test(e.message || '')) {
        // Popup close (requirement #4/#7: TIDAK pernah menyisakan modal state
        // aneh) + refresh notice/tombol grid dari data backend — TIDAK PERNAH
        // mengganti halaman jadi blocked-state besar ataupun navigate kemana
        // pun, tetap di Request Game (requirement #1/#9).
        document.getElementById('rgConfirmOverlay').classList.remove('show');
        _rgConfirmTarget = null;
        await loadRgLimitInfo();
        renderRgAccessNotice();
        renderRgGrid();
      }
    } finally {
      _rgSubmitting = false;
      resetRgConfirmButtons();
    }
  }

  // ── Realtime (dipanggil dari connectRealtime(), lihat cabang WS
  // 'gameRequest:update'/'request-game-settings:update' di atas) ──
  function handleGameRequestUpdate(data) {
    if (!data) return;
    const found = _rgItems.find(it => it.appId === data.appId);
    if (found) { found.requestStatus = data.status; found.rejectReason = data.rejectReason; renderRgGrid(); }
    // Toast in-app pelengkap — notifikasi utama (Discord DM/webhook) SUDAH
    // dikirim server lewat notifyUser() existing, TIDAK dibuat ulang di sini.
    if (data.status === 'approved') {
      showToast('success', 'Request Disetujui', `Request game "${data.name}" telah disetujui Admin.`);
    } else if (data.status === 'rejected') {
      showToast('error', 'Request Ditolak', data.rejectReason ? `"${data.name}": ${data.rejectReason}` : `Request game "${data.name}" ditolak Admin.`);
    }
  }
  function handleRequestGameSettingsUpdate() {
    // Cuma relevan kalau user SEDANG membuka halaman ini — refresh limit
    // info & notice akses dari backend (bukan dari payload event, supaya
    // selalu konsisten dengan role user masing-masing). Grid TIDAK pernah
    // disembunyikan di sini (requirement #1) — cuma notice + status tombol
    // per kartu yang diperbarui.
    if (!document.getElementById('page-requestgame')?.classList.contains('active')) return;
    loadRgLimitInfo().then(() => {
      renderRgAccessNotice();
      renderRgGrid();
    });
  }
  /* ══════════════════════════════════════════════════════════════════════════
     AKHIR BLOK REQUEST GAME
     ══════════════════════════════════════════════════════════════════════════ */

  /* ══════════════════════════════════════════════════════════════════════════
     MARKETPLACE — halaman produk digital baru (nav "Marketplace"). Backend
     TIDAK diubah sama sekali — endpoint GET /api/marketplace/products,
     GET /api/marketplace/products/:id, POST /api/marketplace/purchase,
     GET /api/marketplace/purchase/:orderId, POST /api/marketplace/purchase/:orderId/cancel,
     GET /api/marketplace/purchase/pending, dan modul marketplaceManager.js/
     marketplaceOrderManager.js/klikqrisManager.js 100% dipakai apa adanya.
     Harga/deskripsi/gambar/badge/status SELALU dari respons server (Admin
     Web = source of truth) — TIDAK ADA yang di-hardcode di sini.

     Pola SENGAJA dibuat semirip mungkin dengan blok BELI PAKET di atas
     (sama-sama KlikQRIS, satu-satunya metode pembayaran adalah 'qris' jadi
     TIDAK ada langkah "pilih metode" terpisah) — cuma beda total soal apa
     yang didapat user setelah lunas: bukan aktivasi role, tapi ENTITLEMENT
     akses ke 1 produk digital (dicatat di collection marketplaceAccess).

     SCOPE ITERASI INI: cuma bagian "Marketplace" (listing, detail, beli,
     realtime). Bagian "Steam Account" SENGAJA belum dikerjakan — lihat
     komentar di index.html (#mktSectionTabs) & ringkasan akhir tugas.
     ══════════════════════════════════════════════════════════════════════════ */
  const MKT_BADGE_CLASS = { hot: 'mkt-badge--hot', new: 'mkt-badge--new', sale: 'mkt-badge--sale' };
  const MKT_STATUS_LABEL = {
    pending: 'Menunggu Pembayaran',
    completed: 'Pembayaran Berhasil',
    failed: 'Pembayaran Gagal',
    cancelled: 'Dibatalkan',
    expired: 'Kedaluwarsa'
  };

  let _mktLastData = null;        // respons terakhir GET /api/marketplace/products (di-cache biar realtime re-render tidak perlu fetch ulang)
  let _mktLastProducts = [];
  let _openMktProduct = null;     // produk yang lagi dibuka di halaman detail
  let _openMktOrder = null;       // order yang lagi ditampilkan di modal QRIS
  let _mktCountdownTimer = null;
  let _mktPollTimer = null;

  function mktProductImage(p) { return p?.imageData || p?.imageUrl || ''; }

  function mktBadgeHtml(badge) {
    if (!badge) return '';
    const key = String(badge).toLowerCase();
    const cls = MKT_BADGE_CLASS[key] || 'mkt-badge--custom';
    return `<span class="mkt-badge ${cls}">${escapeHtml(badge)}</span>`;
  }

  async function loadMarketplaceProducts() {
    const errBox = document.getElementById('mktLoadError');
    try {
      const data = await api('/api/marketplace/products');
      _mktLastData = data;
      if (errBox) errBox.hidden = true;
      applyMktProductsUpdate(data.products || []);
    } catch (e) {
      if (errBox) { errBox.hidden = false; errBox.textContent = e.message || 'Gagal memuat daftar produk Marketplace.'; }
    }
  }

  // ── Dipanggil setelah loadMarketplaceProducts() ATAU tiap kali ada sinyal
  // realtime yang perlu resync (order lunas/dibatalkan, akses berubah, dst). ──
  function applyMktProductsUpdate(products) {
    _mktLastProducts = products || [];
    renderMktGrid(_mktLastProducts);

    // Kalau user lagi buka halaman Detail produk ini, refresh datanya juga
    // (harga/badge/status bisa berubah kapan saja dari Admin Web/pembelian).
    if (_openMktProduct) {
      const fresh = _mktLastProducts.find(p => p.id === _openMktProduct.id);
      if (fresh) {
        _openMktProduct = fresh;
        renderMktBuyBar(fresh);
      } else if (document.getElementById('page-marketplace-detail')?.classList.contains('active')) {
        _openMktProduct = null;
        showToast('error', 'Produk Tidak Tersedia', 'Product ini sudah tidak tersedia (dinonaktifkan/dihapus Admin).');
        closeMarketplaceDetail();
      }
    }
  }

  // ── Grid listing utama ──
  function renderMktGrid(products) {
    const grid = document.getElementById('mktGrid');
    const emptyState = document.getElementById('mktEmptyState');
    if (!grid) return;
    if (!products.length) {
      grid.hidden = true;
      if (emptyState) emptyState.hidden = false;
      return;
    }
    grid.hidden = false;
    if (emptyState) emptyState.hidden = true;
    grid.innerHTML = products.map(p => renderMktCardHtml(p)).join('');
    grid.querySelectorAll('.mkt-card[data-id]').forEach(card => {
      card.addEventListener('click', () => openMarketplaceDetail(card.dataset.id));
    });
  }

  function renderMktCardHtml(p) {
    const img = mktProductImage(p);
    const imgTag = img
      ? `<img src="${escapeHtml(img)}" alt="${escapeHtml(p.name)}" loading="lazy">`
      : `<div class="mkt-card-art-empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><use href="#ic-package"></use></svg></div>`;
    const unavailable = p.status !== 'active';
    return `
    <div class="mkt-card" data-id="${p.id}">
      <div class="mkt-card-art">
        ${imgTag}
        <div class="mkt-badge-slot">${mktBadgeHtml(p.badge)}</div>
        ${unavailable ? `<div class="mkt-card-unavailable-slot"><span class="mkt-badge-unavailable">Tidak Tersedia</span></div>` : ''}
      </div>
      <div class="mkt-card-info">
        <div class="mkt-card-title" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</div>
        <div class="mkt-card-desc">${escapeHtml(p.description || '')}</div>
        <div class="mkt-card-footer">
          ${p.isOwner
            ? `<span class="mkt-card-owned-tag"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><use href="#ic-circle-check-big"></use></svg> Dimiliki</span>`
            : (p.hasPendingOrder
              ? `<span class="mkt-card-pending-tag"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><use href="#ic-timer"></use></svg> Diproses</span>`
              : `<span class="mkt-card-price">${rupiah(p.price)}</span>`)}
          <span class="mkt-card-arrow"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><use href="#ic-arrow-right"></use></svg></span>
        </div>
      </div>
    </div>`;
  }

  // ── Halaman Detail Produk Marketplace — navigasi manual (BUKAN nav-item
  // biasa via setNav()), supaya tombol "Kembali" selalu balik ke halaman
  // Marketplace tanpa perlu melacak halaman sebelumnya (Marketplace cuma bisa
  // diakses dari nav-item Marketplace itu sendiri). ──
  async function openMarketplaceDetail(productId) {
    document.querySelectorAll('.nav-item[data-page]').forEach(b => b.classList.toggle('active', b.dataset.page === 'marketplace'));
    document.querySelectorAll('.pm-item[data-page]').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.page').forEach(sec => sec.classList.toggle('active', sec.id === 'page-marketplace-detail'));

    const bodyEl = document.getElementById('mktDetailBody');
    if (bodyEl) bodyEl.scrollTop = 0;
    showMktDetailSkeleton();

    const cached = _mktLastProducts.find(p => p.id === productId);
    if (cached) _openMktProduct = cached;

    try {
      const data = await api(`/api/marketplace/products/${productId}`);
      if (!data?.product) return;
      _openMktProduct = data.product;
      renderMktHero(data.product);
      renderMktHeadline(data.product);
      renderMktSidebar(data.product);
      renderMktContentSections(data.content || { games: [], bypasses: [] });
      renderMktBuyBar(data.product, data.pendingOrder);
      hideMktDetailSkeleton();
    } catch (e) {
      showToast('error', 'Gagal Memuat Produk', e.message || 'Gagal memuat detail produk.');
      closeMarketplaceDetail();
    }
  }

  function closeMarketplaceDetail() {
    _openMktProduct = null;
    setNav('marketplace');
  }

  function showMktDetailSkeleton() {
    const sk = document.getElementById('mktDetailSkeleton');
    const content = document.getElementById('mktDetailContent');
    if (sk) sk.style.display = '';
    if (content) content.style.display = 'none';
  }
  function hideMktDetailSkeleton() {
    const sk = document.getElementById('mktDetailSkeleton');
    const content = document.getElementById('mktDetailContent');
    if (sk) sk.style.display = 'none';
    if (content) content.style.display = 'grid';
  }

  function renderMktHero(p) {
    const wrap = document.getElementById('mktHeroWrap');
    if (!wrap) return;
    const img = mktProductImage(p);
    const badgeSlot = document.getElementById('mktHeroBadgeSlot');
    if (badgeSlot) badgeSlot.innerHTML = mktBadgeHtml(p.badge);
    if (!img) { wrap.style.backgroundImage = ''; return; }
    // Probe dulu supaya gambar rusak/URL invalid tidak jadi background pecah.
    const probe = new Image();
    probe.onload = () => { wrap.style.backgroundImage = `url('${img}')`; };
    probe.onerror = () => { wrap.style.backgroundImage = ''; };
    probe.src = img;
  }

  function renderMktHeadline(p) {
    document.getElementById('mktDetailTitle').textContent = p.name;
    document.getElementById('mktDetailPriceText').textContent = rupiah(p.price);
    const descEl = document.getElementById('mktDetailDescription');
    descEl.textContent = (p.description && p.description.trim()) ? p.description.trim() : '-';
  }

  function renderMktSidebar(p) {
    const statusBadge = document.getElementById('mktSideStatusBadge');
    if (p.isOwner) {
      statusBadge.textContent = 'Dimiliki';
      statusBadge.className = 'mkt-badge-status mkt-badge-status--owned';
    } else if (p.hasPendingOrder) {
      statusBadge.textContent = 'Diproses';
      statusBadge.className = 'mkt-badge-status mkt-badge-status--pending';
    } else if (p.status !== 'active') {
      statusBadge.textContent = 'Tidak Tersedia';
      statusBadge.className = 'mkt-badge-status';
    } else {
      statusBadge.textContent = 'Tersedia';
      statusBadge.className = 'mkt-badge-status mkt-badge-status--available';
    }

    const infoRows = document.getElementById('mktSideInfoRows');
    const rows = [
      ['Harga', rupiah(p.price)],
      ['Status', p.isOwner ? 'Dimiliki' : (p.status === 'active' ? 'Tersedia' : 'Tidak Tersedia')]
    ];
    if (p.isOwner && p.accessSource) {
      rows.push(['Sumber Akses', p.accessSource === 'whitelist' ? 'Whitelist Admin' : 'Pembelian']);
    }
    infoRows.innerHTML = rows.map(([k, v]) => `<div class="mkt-side-row"><span>${escapeHtml(k)}</span><b>${escapeHtml(String(v))}</b></div>`).join('');
  }

  // ── Section "Barang yang Didapatkan" (games/bypasses) — kategori kosong
  // TIDAK dirender ke DOM sama sekali (bukan disembunyikan via CSS). ──
  function renderMktContentSections(content) {
    const wrap = document.getElementById('mktContentSection');
    if (!wrap) return;
    const games = content.games || [];
    const bypasses = content.bypasses || [];

    const contentCard = (item) => {
      const img = item.imageUrl || '';
      return `
      <div class="mkt-content-card" title="${escapeHtml(item.name)}">
        <div class="mkt-content-card-img"${img ? ` style="background-image:url('${escapeHtml(img)}')"` : ''}></div>
        <div class="mkt-content-card-name">${escapeHtml(item.name)}</div>
      </div>`;
    };

    let html = `<h3 class="mkt-detail-section-title"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><use href="#ic-package"></use></svg> Barang yang Didapatkan</h3>`;

    if (!games.length && !bypasses.length) {
      html += `<div class="mkt-content-empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width:28px;height:28px;opacity:.4"><use href="#ic-package"></use></svg> Belum ada konten pada produk ini.</div>`;
      wrap.innerHTML = html;
      return;
    }

    const singleColumn = !(games.length && bypasses.length);
    html += `<div class="mkt-content-columns${singleColumn ? ' mkt-content-columns--single' : ''}">`;

    if (games.length) {
      html += `
      <div class="mkt-content-group">
        <div class="mkt-content-group-title"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><use href="#ic-gamepad-2"></use></svg> Akses Game</div>
        <div class="mkt-content-grid">${games.map(contentCard).join('')}</div>
      </div>`;
    }
    if (bypasses.length) {
      html += `
      <div class="mkt-content-group">
        <div class="mkt-content-group-title"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><use href="#ic-shield-check"></use></svg> Akses Bypass</div>
        <div class="mkt-content-grid">${bypasses.map(contentCard).join('')}</div>
      </div>`;
    }
    html += `</div>`;
    wrap.innerHTML = html;
  }

  // ── Floating Buy Bar — state SELALU dari data backend (isOwner/hasPendingOrder/status). ──
  function renderMktBuyBar(p, pendingOrder) {
    const priceLabelEl = document.getElementById('mktFloatPriceLabel');
    const priceValueEl = document.getElementById('mktFloatPriceValue');
    const statusEl = document.getElementById('mktBuyStatus');
    const btn = document.getElementById('mktDetailBuyBtn');
    const labelEl = document.getElementById('mktDetailBuyLabel');
    if (!btn) return;

    if (p.isOwner) {
      priceLabelEl.textContent = 'Produk Dimiliki';
      priceValueEl.textContent = rupiah(p.price);
      statusEl.innerHTML = '<span class="mkt-status-dot"></span> Kamu sudah memiliki akses ini';
      statusEl.className = 'mkt-float-bar-status mkt-float-bar-status--owned';
      btn.disabled = true;
      btn.className = 'mkt-float-bar-btn mkt-float-bar-btn--owned';
      labelEl.textContent = 'Sudah Dibeli';
      btn.onclick = null;
    } else if (p.hasPendingOrder) {
      priceLabelEl.textContent = 'Harga';
      priceValueEl.textContent = rupiah(p.price);
      statusEl.innerHTML = '<span class="mkt-status-dot"></span> Menunggu pembayaran';
      statusEl.className = 'mkt-float-bar-status mkt-float-bar-status--processing';
      btn.disabled = false;
      btn.className = 'mkt-float-bar-btn mkt-float-bar-btn--processing';
      labelEl.textContent = 'Pembayaran Diproses';
      btn.onclick = () => resumeMktPendingOrder(p.id);
    } else if (p.status !== 'active') {
      priceLabelEl.textContent = 'Harga';
      priceValueEl.textContent = rupiah(p.price);
      statusEl.innerHTML = '<span class="mkt-status-dot"></span> Tidak tersedia';
      statusEl.className = 'mkt-float-bar-status';
      btn.disabled = true;
      btn.className = 'mkt-float-bar-btn mkt-float-bar-btn--owned';
      labelEl.textContent = 'Tidak Tersedia';
      btn.onclick = null;
    } else {
      priceLabelEl.textContent = 'Harga';
      priceValueEl.textContent = rupiah(p.price);
      statusEl.innerHTML = '<span class="mkt-status-dot"></span> Tersedia';
      statusEl.className = 'mkt-float-bar-status';
      btn.disabled = false;
      btn.className = 'mkt-float-bar-btn';
      labelEl.textContent = 'Beli Sekarang';
      btn.onclick = () => openMktConfirm();
    }
  }

  async function resumeMktPendingOrder(productId) {
    try {
      const data = await api(`/api/marketplace/purchase/pending?productId=${encodeURIComponent(productId)}`);
      if (data?.order) openMktPayModal(data.order);
    } catch (e) {
      showToast('error', 'Gagal Memuat Status', e.message || 'Gagal memuat status pembayaran.');
    }
  }

  // ── Modal Konfirmasi Pembelian — satu-satunya metode pembayaran adalah
  // QRIS, jadi langsung konfirmasi lalu buat order (sama pola Beli Paket). ──
  function openMktConfirm() {
    if (!_openMktProduct) return;

    // Gate: kalau produk ini mensyaratkan produk Game/Bypass lain yang belum
    // tersedia/dimiliki user, tampilkan mktLockedModal DULU — jangan lanjut
    // ke konfirmasi/pembuatan order sama sekali (lihat getMktRequirement()).
    const requirement = getMktRequirement(_openMktProduct);
    if (requirement && !requirement.available) {
      openMktLockedModal(_openMktProduct, requirement);
      return;
    }

    if (!_mktLastData?.gatewayEnabled || !(_mktLastData?.paymentMethods || []).length) {
      showToast('error', 'Payment Gateway Tidak Tersedia', 'Pembayaran sedang tidak tersedia, coba lagi nanti.');
      return;
    }
    document.getElementById('mktConfirmProductName').textContent = _openMktProduct.name;
    document.getElementById('mktConfirmPrice').textContent = rupiah(_openMktProduct.price);
    document.getElementById('mktConfirmTotal').textContent = rupiah(_openMktProduct.price);
    const btn = document.getElementById('mktConfirmPayBtn');
    btn.disabled = false;
    btn.textContent = 'Bayar Sekarang';
    document.getElementById('mktConfirmModal').classList.add('show');
  }
  function closeMktConfirm() {
    document.getElementById('mktConfirmModal').classList.remove('show');
  }

  /* ══════════════════════════════════════════════════════════════════════════
     MODAL "AKSES BELUM TERSEDIA" (mktLockedModal) — product gating.
     Requirement dibaca dari data produk (field `requirement`/`requiredProduct`
     /`lockRequirement`, apa pun yang dikirim endpoint /api/marketplace/products
     — dicek berurutan supaya tahan terhadap perubahan penamaan field
     backend). Kalau produk TIDAK punya field ini sama sekali, gating otomatis
     tidak aktif dan openMktConfirm() jalan seperti biasa — jadi menambahkan
     blok ini TIDAK mengubah perilaku produk yang tidak butuh requirement.
     Bentuk requirement yang diharapkan:
       { productId, productName, type: 'game'|'bypass', available: boolean }
     `available` = true berarti user SUDAH memiliki akses ke produk
     requirement tsb (dari purchase/whitelist) — modal ini hanya tampil kalau
     available === false.
     ══════════════════════════════════════════════════════════════════════════ */
  const MKT_REQ_ICON_HTML = {
    game: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><use href="#ic-gamepad-2"></use></svg>',
    bypass: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><use href="#ic-shield-check"></use></svg>'
  };
  const MKT_REQ_TYPE_LABEL = { game: 'Game', bypass: 'Bypass' };

  function getMktRequirement(p) {
    const req = p?.requirement || p?.requiredProduct || p?.lockRequirement || null;
    if (!req || !req.productId) return null;
    return {
      productId: req.productId,
      productName: req.productName || req.name || 'Produk terkait',
      type: req.type === 'game' ? 'game' : 'bypass',
      available: !!req.available
    };
  }

  function openMktLockedModal(product, requirement) {
    const modal = document.getElementById('mktLockedModal');
    if (!modal || !requirement) return;
    const productName = product?.name || 'Produk ini';
    const typeLabel = MKT_REQ_TYPE_LABEL[requirement.type];

    document.getElementById('mktLockedDesc').textContent =
      `${productName} membutuhkan akses ${typeLabel} berikut sebelum dapat dibeli.`;
    document.getElementById('mktLockedReqIcon').innerHTML = MKT_REQ_ICON_HTML[requirement.type];
    document.getElementById('mktLockedReqName').textContent = requirement.productName;

    // Label CTA kontekstual, bukan satu teks kaku untuk semua kasus.
    const ctaBtn = document.getElementById('mktLockedCtaBtn');
    ctaBtn.textContent = requirement.type === 'game' ? 'Lihat & Dapatkan' : 'Beli Requirement';
    ctaBtn.onclick = () => {
      closeMktLockedModal();
      openMarketplaceDetail(requirement.productId); // routing existing, productId dari backend — bukan URL hardcode
    };

    modal.classList.add('show');
  }
  function closeMktLockedModal() {
    // Cuma menutup modal — TIDAK membuat order, TIDAK mengubah
    // ownership/entitlement/state user apapun. User tetap di halaman
    // Marketplace/detail produk yang sedang dibuka.
    document.getElementById('mktLockedModal')?.classList.remove('show');
  }
  function initMktLockedModal() {
    const modal = document.getElementById('mktLockedModal');
    const xBtn = document.getElementById('mktLockedXBtn');
    const closeBtn = document.getElementById('mktLockedCloseBtn');
    if (xBtn) xBtn.addEventListener('click', closeMktLockedModal);
    if (closeBtn) closeBtn.addEventListener('click', closeMktLockedModal);
    if (modal) modal.addEventListener('click', (e) => { if (e.target === modal) closeMktLockedModal(); });
  }

  async function startMktPurchase() {
    if (!_openMktProduct) return;
    const btn = document.getElementById('mktConfirmPayBtn');
    btn.disabled = true;
    btn.textContent = 'Memproses...';
    try {
      const res = await api('/api/marketplace/purchase', {
        method: 'POST',
        body: JSON.stringify({ productId: _openMktProduct.id, method: 'qris' })
      });
      closeMktConfirm();
      openMktPayModal(res.order);
    } catch (e) {
      showToast('error', 'Gagal Membuat Pesanan', e.message || 'Coba lagi sebentar.');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Bayar Sekarang';
    }
  }

  // ── Modal Pembayaran QRIS (status realtime + fallback polling) ──
  function openMktPayModal(order) {
    _openMktOrder = order;
    renderMktPayModal(order);
    document.getElementById('mktPaymentModal').classList.add('show');
    stopMktTimers();
    if (order.status === 'pending') {
      _mktCountdownTimer = setInterval(updateMktCountdown, 1000);
      _mktPollTimer = setInterval(pollMktPurchaseStatus, 5000);
      updateMktCountdown();
    }
  }
  function closeMktPayModal() {
    document.getElementById('mktPaymentModal').classList.remove('show');
    stopMktTimers();
    _openMktOrder = null;
    // Kartu produk & buy bar sudah ikut berubah realtime lewat
    // handleMktOrderUpdate()/handleMktAccessUpdate() begitu server konfirmasi
    // lunas — di sini cukup pastikan grid ter-render ulang dari data terbaru.
    if (_mktLastProducts.length) renderMktGrid(_mktLastProducts);
  }
  function stopMktTimers() {
    if (_mktCountdownTimer) clearInterval(_mktCountdownTimer);
    if (_mktPollTimer) clearInterval(_mktPollTimer);
    _mktCountdownTimer = null;
    _mktPollTimer = null;
  }

  function renderMktPayModal(order) {
    if (!order) return;
    document.getElementById('mktPayTitle').textContent = order.productName || _openMktProduct?.name || 'Produk';
    document.getElementById('mktPayOrderId').textContent = order.orderId;

    const badge = document.getElementById('mktPayStatusBadge');
    badge.textContent = MKT_STATUS_LABEL[order.status] || order.status;
    badge.dataset.status = order.status;

    const qrWrap = document.getElementById('mktPayQrWrap');
    const resultWrap = document.getElementById('mktPayResult');
    const cancelBtn = document.getElementById('mktPayCancelBtn');
    const closeBtn = document.getElementById('mktPayCloseBtn');

    if (order.status === 'pending') {
      qrWrap.hidden = false;
      resultWrap.hidden = true;
      cancelBtn.hidden = false;
      closeBtn.hidden = true;
      document.getElementById('mktPayAmount').textContent = rupiah(order.totalPayment || order.amount);

      const qrImg = document.getElementById('mktPayQrImg');
      const qrErr = document.getElementById('mktPayQrError');
      // qrDataUrl = gambar QRIS ASLI dari KlikQRIS — WAJIB dipakai apa
      // adanya, TIDAK generate ulang QR dari teks lain.
      if (order.qrDataUrl) {
        qrImg.style.display = '';
        qrImg.src = order.qrDataUrl;
        qrErr.hidden = true;
      } else {
        qrImg.style.display = 'none';
        qrErr.hidden = false;
      }
    } else {
      qrWrap.hidden = true;
      resultWrap.hidden = false;
      cancelBtn.hidden = true;
      closeBtn.hidden = false;
      if (order.status === 'completed') {
        resultWrap.className = 'pmc-pay-result pmc-pay-result--success';
        resultWrap.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><use href="#ic-circle-check-big"></use></svg><span>Pembayaran berhasil! Akses ke produk ini sudah aktif.</span>`;
      } else if (order.status === 'expired') {
        resultWrap.className = 'pmc-pay-result pmc-pay-result--muted';
        resultWrap.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><use href="#ic-timer"></use></svg><span>Waktu pembayaran habis. Silakan buat pesanan baru.</span>`;
      } else {
        resultWrap.className = 'pmc-pay-result pmc-pay-result--danger';
        resultWrap.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><use href="#ic-circle-x"></use></svg><span>Pesanan ${escapeHtml(MKT_STATUS_LABEL[order.status] || order.status)}.</span>`;
      }
    }
  }

  function updateMktCountdown() {
    if (!_openMktOrder || _openMktOrder.status !== 'pending') return;
    const remainMs = new Date(_openMktOrder.expiresAt).getTime() - Date.now();
    const el = document.getElementById('mktPayCountdown');
    if (remainMs <= 0) { if (el) el.textContent = '00:00'; return; }
    const mm = String(Math.floor(remainMs / 60000)).padStart(2, '0');
    const ss = String(Math.floor((remainMs % 60000) / 1000)).padStart(2, '0');
    if (el) el.textContent = `${mm}:${ss}`;
  }

  // Fallback polling tiap 5 detik selagi status masih pending (jaga-jaga WS
  // lagi putus) — handleMktOrderUpdate() yang render ulang UI-nya, jadi
  // dipakai bareng jalur realtime WS tanpa duplikasi logic.
  async function pollMktPurchaseStatus() {
    if (!_openMktOrder || _openMktOrder.status !== 'pending') { stopMktTimers(); return; }
    try {
      const res = await api(`/api/marketplace/purchase/${encodeURIComponent(_openMktOrder.orderId)}`);
      handleMktOrderUpdate(res.order);
    } catch (e) { /* diam-diam, coba lagi 5 detik berikutnya */ }
  }

  // Dipicu WS event 'marketplace:order:update' (realtime) ATAU hasil polling
  // fallback di atas.
  function handleMktOrderUpdate(order) {
    if (!order) return;
    if (_openMktOrder && _openMktOrder.orderId === order.orderId) {
      _openMktOrder = order;
      renderMktPayModal(order);
      if (order.status !== 'pending') stopMktTimers();
    }
    // Order lunas/berubah -> refresh grid Product Marketplace (isOwner/harga/
    // status bisa berubah) supaya tombol Beli langsung berubah realtime.
    if (order.status === 'completed') {
      loadMarketplaceProducts();
    }
  }

  // ── Event 'marketplace:access:update' — entitlement user berubah REALTIME
  // (Admin grant/revoke Whitelist, ATAU order siapapun baru saja lunas).
  // Payload ini personalized per-koneksi, jadi TIDAK dipakai langsung — cukup
  // jadi sinyal "ada perubahan akses" lalu refetch REST yang sudah
  // personalized (pola sama dengan handlePkgTransactionUpdate di atas). ──
  //
  // ROOT CAUSE FIX (realtime akses Marketplace -> Game/Bypass): sebelumnya
  // handler ini CUMA memanggil loadMarketplaceProducts() (grid Product &
  // sidebar Product Detail) — TIDAK PERNAH loadGames()/loadBypasses().
  // Padahal access resolver tombol Download/Install di Game & Bypass
  // (hasAccess(item), lihat mktOrRoleLocked() di atas) SATU-SATUNYA sumber
  // kebenarannya adalah `item.hasAccess` yang datang dari allGames/
  // allBypasses — array yang HANYA di-refresh lewat loadGames()/
  // loadBypasses() (GET /api/games /api/bypasses, personalized per user).
  // Server SUDAH mengirim event 'marketplace:access:update' ini persis pada
  // saat purchase lunas MAUPUN saat Admin cabut akses (lihat
  // pushMarketplaceAccessUpdate() di server.js — dipanggil dari
  // activateCompletedMarketplaceOrder() dan endpoint revoke whitelist), jadi
  // sinyalnya sudah realtime dari backend; yang hilang cuma listener App ini
  // tidak meneruskannya ke Games/Bypass. Akibatnya tombol Download/Install
  // baru berubah kalau ada trigger LAIN yang kebetulan memanggil loadGames()/
  // loadBypasses() (mis. games:update dari Admin, atau reconnect WS) —
  // sampai App direstart. Menambah 2 baris ini menutup celah root cause-nya
  // TANPA WebSocket/event baru: applyGamesUpdate()/applyBypassesUpdate()
  // (dipanggil dari dalam loadGames()/loadBypasses()) sudah otomatis
  // me-render ulang grid DAN re-evaluasi tombol halaman detail Game/Bypass
  // yang sedang terbuka (lihat definisinya) — jadi requirement "user sedang
  // di halaman Product/Game/Bypass saat akses berubah -> UI langsung
  // berubah tanpa pindah halaman" terpenuhi oleh mekanisme yang sudah ada,
  // cukup disambungkan di sini.
  function handleMktAccessUpdate(data) {
    loadMarketplaceProducts();
    loadGames();
    loadBypasses();

    const isDetailOpen = document.getElementById('page-marketplace-detail')?.classList.contains('active');
    if (isDetailOpen && _openMktProduct) {
      const affectsOpen = !data?.productId || data.productId === _openMktProduct.id;
      if (affectsOpen) {
        api(`/api/marketplace/products/${_openMktProduct.id}`)
          .then((res) => {
            if (!res?.product) return;
            _openMktProduct = res.product;
            renderMktSidebar(res.product);
            renderMktBuyBar(res.product, res.pendingOrder);
          })
          .catch(() => { /* diam-diam, loadMarketplaceProducts() di atas tetap jalan sebagai fallback */ });
      }
    }
  }

  async function cancelCurrentMktOrder() {
    if (!_openMktOrder || _openMktOrder.status !== 'pending') return;
    if (!confirm('Batalkan pesanan ini? Kamu bisa beli lagi kapan saja kalau berubah pikiran.')) return;
    const btn = document.getElementById('mktPayCancelBtn');
    btn.disabled = true;
    btn.textContent = 'Membatalkan...';
    try {
      const res = await api(`/api/marketplace/purchase/${encodeURIComponent(_openMktOrder.orderId)}/cancel`, { method: 'POST' });
      handleMktOrderUpdate(res.order);
      showToast('cancel', 'Pesanan Dibatalkan', 'Pesanan kamu telah dibatalkan.');
    } catch (e) {
      showToast('error', 'Gagal Membatalkan', e.message || '');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Batalkan Pesanan';
    }
  }

  // Pasang listener tombol statis (dipanggil sekali dari initAppShellDemo()).
  function initMarketplacePage() {
    const backBtn = document.getElementById('mktDetailBackBtn');
    if (backBtn) backBtn.addEventListener('click', closeMarketplaceDetail);

    const confirmCloseBtn = document.getElementById('mktConfirmCloseBtn');
    if (confirmCloseBtn) confirmCloseBtn.addEventListener('click', closeMktConfirm);

    const confirmPayBtn = document.getElementById('mktConfirmPayBtn');
    if (confirmPayBtn) confirmPayBtn.addEventListener('click', startMktPurchase);

    const cancelBtn = document.getElementById('mktPayCancelBtn');
    if (cancelBtn) cancelBtn.addEventListener('click', cancelCurrentMktOrder);

    const closePayBtn = document.getElementById('mktPayCloseBtn');
    if (closePayBtn) closePayBtn.addEventListener('click', closeMktPayModal);
  }
  /* ══════════════════════════════════════════════════════════════════════════
     AKHIR BLOK MARKETPLACE
     ══════════════════════════════════════════════════════════════════════════ */


  /* ══════════════════════════════════════════════════════════════════════════
     TAB SWITCHER — #mktSectionTabs (Marketplace / Steam Account). Kedua
     sub-halaman hidup di dalam #page-marketplace yang sama; tab cuma
     toggle [hidden] di #mktSectionMarketplace / #mktSectionSteamAccount.
     Data masing-masing tab tetap di-load sekali di awal (initAppShellDemo())
     supaya realtime WS tetap bisa update badge/status walau tabnya lagi
     tidak aktif dilihat user — switchMktSection() MURNI urusan tampilan.
     ══════════════════════════════════════════════════════════════════════════ */
  let _mktActiveSection = 'marketplace';

  function showMktSection(section) {
    _mktActiveSection = section === 'steam-account' ? 'steam-account' : 'marketplace';
    document.querySelectorAll('.mkt-section-tab[data-mkt-section]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.mktSection === _mktActiveSection);
    });
    const mktPanel = document.getElementById('mktSectionMarketplace');
    const staPanel = document.getElementById('mktSectionSteamAccount');
    if (mktPanel) mktPanel.hidden = _mktActiveSection !== 'marketplace';
    if (staPanel) staPanel.hidden = _mktActiveSection !== 'steam-account';
  }

  function initMktSectionTabs() {
    document.querySelectorAll('.mkt-section-tab[data-mkt-section]').forEach(btn => {
      btn.addEventListener('click', () => showMktSection(btn.dataset.mktSection));
    });
  }
  /* ══════════════════════════════════════════════════════════════════════════
     AKHIR TAB SWITCHER
     ══════════════════════════════════════════════════════════════════════════ */


  /* ══════════════════════════════════════════════════════════════════════════
     STEAM ACCOUNT — tab kedua halaman Marketplace. Backend TIDAK diubah sama
     sekali — GET /api/steam-accounts, GET /api/steam-accounts/:id,
     GET /api/steam-accounts/:id/credentials, POST /api/steam-accounts/purchase,
     GET /api/steam-accounts/purchase/:orderId, POST .../cancel, dan modul
     steamAccountManager.js/steamAccountOrderManager.js/klikqrisManager.js
     100% dipakai apa adanya — sama seperti Marketplace di atas.

     BEDA UTAMA dari Marketplace: model kepemilikan UNLIMITED USER (banyak
     user bisa "memiliki" akun Steam yang sama sekaligus — publicProduct
     TIDAK PERNAH berubah jadi 'sold'). Begitu isOwner true, tombol beli
     berubah jadi "LOGIN AKUN" (bukan "Sudah Dibeli") — memicu IPC
     'steam-account-login' yang SUDAH ADA & matang di main.js/preload.js
     (auto-restart Steam & login pakai kredensial akun). Kalau Steam tidak
     terdeteksi di PC user, fallback ke modal kredensial manual (copy-paste),
     BUKAN dianggap gagal total.
     ══════════════════════════════════════════════════════════════════════════ */
  const STA_STATUS_LABEL = {
    pending: 'Menunggu Pembayaran',
    completed: 'Pembayaran Berhasil',
    failed: 'Pembayaran Gagal',
    cancelled: 'Dibatalkan',
    expired: 'Kedaluwarsa'
  };
  // Tahapan channel 'steam-account-login-progress' (main.js) -> teks yang
  // ditampilkan modal staLoginProgressModal. 'error' sengaja tidak di sini
  // (dihandle langsung dari hasil ipcRenderer.invoke, lihat openSteamAccountLogin()).
  const STA_LOGIN_STAGE_LABEL = {
    preparing: 'Menyiapkan Steam...',
    closing: 'Menutup Steam...',
    restarting: 'Restart Steam...',
    logging_in: 'Login akun...',
    done: 'Steam berhasil login.'
  };

  let _staLastData = null;
  let _staLastProducts = [];
  let _openStaProduct = null;
  let _openStaOrder = null;
  let _staCountdownTimer = null;
  let _staPollTimer = null;

  function staProductImage(p) { return p?.imageData || p?.imageUrl || ''; }

  async function loadSteamAccounts() {
    const errBox = document.getElementById('staLoadError');
    try {
      const data = await api('/api/steam-accounts');
      _staLastData = data;
      if (errBox) errBox.hidden = true;
      applyStaProductsUpdate(data.products || []);
    } catch (e) {
      if (errBox) { errBox.hidden = false; errBox.textContent = e.message || 'Gagal memuat daftar akun Steam.'; }
    }
  }

  function applyStaProductsUpdate(products) {
    _staLastProducts = products || [];
    renderStaGrid(_staLastProducts);
    if (_openStaProduct) {
      const fresh = _staLastProducts.find(p => p.id === _openStaProduct.id);
      if (fresh) {
        _openStaProduct = fresh;
        renderStaBuyBar(fresh);
      } else if (document.getElementById('page-steam-account-detail')?.classList.contains('active')) {
        _openStaProduct = null;
        showToast('error', 'Akun Tidak Tersedia', 'Akun ini sudah tidak tersedia (dihapus Admin).');
        closeSteamAccountDetail();
      }
    }
  }

  function renderStaGrid(products) {
    const grid = document.getElementById('staGrid');
    const emptyState = document.getElementById('staEmptyState');
    if (!grid) return;
    if (!products.length) {
      grid.hidden = true;
      if (emptyState) emptyState.hidden = false;
      return;
    }
    grid.hidden = false;
    if (emptyState) emptyState.hidden = true;
    grid.innerHTML = products.map(p => renderStaCardHtml(p)).join('');
    grid.querySelectorAll('.mkt-card[data-id]').forEach(card => {
      card.addEventListener('click', () => openSteamAccountDetail(card.dataset.id));
    });
  }

  function renderStaCardHtml(p) {
    const img = staProductImage(p);
    const imgTag = img
      ? `<img src="${escapeHtml(img)}" alt="${escapeHtml(p.name)}" loading="lazy">`
      : `<div class="mkt-card-art-empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><use href="#ic-gamepad-2"></use></svg></div>`;
    const unavailable = p.status !== 'available';
    return `
    <div class="mkt-card" data-id="${p.id}">
      <div class="mkt-card-art">
        ${imgTag}
        ${unavailable ? `<div class="mkt-card-unavailable-slot"><span class="mkt-badge-unavailable">Tidak Tersedia</span></div>` : ''}
      </div>
      <div class="mkt-card-info">
        <div class="mkt-card-title" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</div>
        <div class="mkt-card-meta"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><use href="#ic-gamepad-2"></use></svg> ${p.gamesCount || 0} Game</div>
        <div class="mkt-card-desc">${escapeHtml(p.description || '')}</div>
        <div class="mkt-card-footer">
          ${p.isOwner
            ? `<span class="mkt-card-owned-tag"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><use href="#ic-log-in"></use></svg> Login Akun</span>`
            : (p.hasPendingOrder
              ? `<span class="mkt-card-pending-tag"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><use href="#ic-timer"></use></svg> Diproses</span>`
              : `<span class="mkt-card-price">${rupiah(p.price)}</span>`)}
          <span class="mkt-card-arrow"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><use href="#ic-arrow-right"></use></svg></span>
        </div>
      </div>
    </div>`;
  }

  async function openSteamAccountDetail(productId) {
    document.querySelectorAll('.nav-item[data-page]').forEach(b => b.classList.toggle('active', b.dataset.page === 'marketplace'));
    document.querySelectorAll('.pm-item[data-page]').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.page').forEach(sec => sec.classList.toggle('active', sec.id === 'page-steam-account-detail'));

    const bodyEl = document.getElementById('staDetailBody');
    if (bodyEl) bodyEl.scrollTop = 0;
    showStaDetailSkeleton();

    const cached = _staLastProducts.find(p => p.id === productId);
    if (cached) _openStaProduct = cached;

    try {
      const data = await api(`/api/steam-accounts/${productId}`);
      if (!data?.product) return;
      _openStaProduct = data.product;
      renderStaHero(data.product);
      renderStaHeadline(data.product);
      renderStaSidebar(data.product);
      renderStaGamesSection(data.product);
      renderStaBuyBar(data.product, data.pendingOrder);
      hideStaDetailSkeleton();
    } catch (e) {
      showToast('error', 'Gagal Memuat Akun', e.message || 'Gagal memuat detail akun.');
      closeSteamAccountDetail();
    }
  }

  function closeSteamAccountDetail() {
    _openStaProduct = null;
    setNav('marketplace');
    showMktSection('steam-account');
  }

  function showStaDetailSkeleton() {
    const sk = document.getElementById('staDetailSkeleton');
    const content = document.getElementById('staDetailContent');
    if (sk) sk.style.display = '';
    if (content) content.style.display = 'none';
  }
  function hideStaDetailSkeleton() {
    const sk = document.getElementById('staDetailSkeleton');
    const content = document.getElementById('staDetailContent');
    if (sk) sk.style.display = 'none';
    if (content) content.style.display = 'grid';
  }

  function renderStaHero(p) {
    const wrap = document.getElementById('staHeroWrap');
    if (!wrap) return;
    const img = staProductImage(p);
    if (!img) { wrap.style.backgroundImage = ''; return; }
    const probe = new Image();
    probe.onload = () => { wrap.style.backgroundImage = `url('${img}')`; };
    probe.onerror = () => { wrap.style.backgroundImage = ''; };
    probe.src = img;
  }

  function renderStaHeadline(p) {
    document.getElementById('staDetailTitle').textContent = p.name;
    document.getElementById('staDetailPriceText').textContent = rupiah(p.price);
    const descEl = document.getElementById('staDetailDescription');
    descEl.textContent = (p.description && p.description.trim()) ? p.description.trim() : '-';

    // "Cara Bermain"/"Info Penting" — kategori kosong TIDAK dirender (bukan
    // disembunyikan via CSS kosong), sama prinsip dengan games/bypasses kosong
    // di Marketplace.
    const caraCard = document.getElementById('staCaraBermainCard');
    const caraText = document.getElementById('staCaraBermainText');
    if (p.caraBermain && p.caraBermain.trim()) {
      caraText.textContent = p.caraBermain.trim();
      caraCard.hidden = false;
    } else {
      caraCard.hidden = true;
    }
    const infoCard = document.getElementById('staImportantInfoCard');
    const infoText = document.getElementById('staImportantInfoText');
    if (p.importantInfo && p.importantInfo.trim()) {
      infoText.textContent = p.importantInfo.trim();
      infoCard.hidden = false;
    } else {
      infoCard.hidden = true;
    }
  }

  function renderStaSidebar(p) {
    const statusBadge = document.getElementById('staSideStatusBadge');
    if (p.isOwner) {
      statusBadge.textContent = 'Dimiliki';
      statusBadge.className = 'mkt-badge-status mkt-badge-status--owned';
    } else if (p.hasPendingOrder) {
      statusBadge.textContent = 'Diproses';
      statusBadge.className = 'mkt-badge-status mkt-badge-status--pending';
    } else if (p.status !== 'available') {
      statusBadge.textContent = 'Tidak Tersedia';
      statusBadge.className = 'mkt-badge-status';
    } else {
      statusBadge.textContent = 'Tersedia';
      statusBadge.className = 'mkt-badge-status mkt-badge-status--available';
    }

    const infoRows = document.getElementById('staSideInfoRows');
    const rows = [
      ['Harga', rupiah(p.price)],
      ['Jumlah Game', `${p.gamesCount || 0} Game`],
      ['Status', p.isOwner ? 'Dimiliki' : (p.status === 'available' ? 'Tersedia' : 'Tidak Tersedia')]
    ];
    infoRows.innerHTML = rows.map(([k, v]) => `<div class="mkt-side-row"><span>${escapeHtml(k)}</span><b>${escapeHtml(String(v))}</b></div>`).join('');
  }

  // ── "Daftar Game" — dari product.games (snapshot Steam yang sudah
  // tersimpan Admin, TIDAK fetch Steam API lagi di App). Kategori kosong
  // TIDAK dirender ke DOM sama sekali (sama pola dengan Marketplace). ──
  function renderStaGamesSection(p) {
    const wrap = document.getElementById('staContentSection');
    if (!wrap) return;
    const games = p.games || [];

    let html = `<h3 class="mkt-detail-section-title"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><use href="#ic-gamepad-2"></use></svg> Daftar Game (${games.length})</h3>`;

    if (!games.length) {
      html += `<div class="mkt-content-empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width:28px;height:28px;opacity:.4"><use href="#ic-gamepad-2"></use></svg> Admin belum menambahkan game ke akun ini.</div>`;
      wrap.innerHTML = html;
      return;
    }

    html += `<div class="mkt-content-columns mkt-content-columns--single"><div class="mkt-content-group"><div class="mkt-content-grid">`;
    html += games.map(g => `
      <div class="mkt-content-card" title="${escapeHtml(g.name)}">
        <div class="mkt-content-card-img"${g.headerImage ? ` style="background-image:url('${escapeHtml(g.headerImage)}')"` : ''}></div>
        <div class="mkt-content-card-name">${escapeHtml(g.name)}</div>
      </div>`).join('');
    html += `</div></div></div>`;
    wrap.innerHTML = html;
  }

  // ── Floating Bar — beda dari Marketplace: isOwner -> "LOGIN AKUN" (aksi),
  // BUKAN badge "Sudah Dibeli" pasif, karena akun ini unlimited-user & masih
  // ada aksi lanjutan yang berguna (jalankan Steam). ──
  function renderStaBuyBar(p, pendingOrder) {
    const priceLabelEl = document.getElementById('staFloatPriceLabel');
    const priceValueEl = document.getElementById('staFloatPriceValue');
    const statusEl = document.getElementById('staBuyStatus');
    const btn = document.getElementById('staDetailActionBtn');
    const labelEl = document.getElementById('staDetailActionLabel');
    if (!btn) return;

    if (p.isOwner) {
      priceLabelEl.textContent = 'Akun Dimiliki';
      priceValueEl.textContent = rupiah(p.price);
      statusEl.innerHTML = '<span class="mkt-status-dot"></span> Kamu sudah memiliki akun ini';
      statusEl.className = 'mkt-float-bar-status mkt-float-bar-status--owned';
      btn.disabled = false;
      btn.className = 'mkt-float-bar-btn';
      labelEl.textContent = 'Login Akun';
      btn.onclick = () => openSteamAccountLogin(p.id);
    } else if (p.hasPendingOrder) {
      priceLabelEl.textContent = 'Harga';
      priceValueEl.textContent = rupiah(p.price);
      statusEl.innerHTML = '<span class="mkt-status-dot"></span> Menunggu pembayaran';
      statusEl.className = 'mkt-float-bar-status mkt-float-bar-status--processing';
      btn.disabled = false;
      btn.className = 'mkt-float-bar-btn mkt-float-bar-btn--processing';
      labelEl.textContent = 'Pembayaran Diproses';
      btn.onclick = () => resumeStaPendingOrder(p.id);
    } else if (p.status !== 'available') {
      priceLabelEl.textContent = 'Harga';
      priceValueEl.textContent = rupiah(p.price);
      statusEl.innerHTML = '<span class="mkt-status-dot"></span> Tidak tersedia';
      statusEl.className = 'mkt-float-bar-status';
      btn.disabled = true;
      btn.className = 'mkt-float-bar-btn mkt-float-bar-btn--owned';
      labelEl.textContent = 'Tidak Tersedia';
      btn.onclick = null;
    } else {
      priceLabelEl.textContent = 'Harga';
      priceValueEl.textContent = rupiah(p.price);
      statusEl.innerHTML = '<span class="mkt-status-dot"></span> Tersedia';
      statusEl.className = 'mkt-float-bar-status';
      btn.disabled = false;
      btn.className = 'mkt-float-bar-btn';
      labelEl.textContent = 'Beli Sekarang';
      btn.onclick = () => openStaConfirm();
    }
  }

  async function resumeStaPendingOrder(productId) {
    try {
      const data = await api(`/api/steam-accounts/purchase/pending?productId=${encodeURIComponent(productId)}`);
      if (data?.order) openStaPayModal(data.order);
    } catch (e) {
      showToast('error', 'Gagal Memuat Status', e.message || 'Gagal memuat status pembayaran.');
    }
  }

  function openStaConfirm() {
    if (!_openStaProduct) return;
    if (!_staLastData?.gatewayEnabled || !(_staLastData?.paymentMethods || []).length) {
      showToast('error', 'Payment Gateway Tidak Tersedia', 'Pembayaran sedang tidak tersedia, coba lagi nanti.');
      return;
    }
    document.getElementById('staConfirmProductName').textContent = _openStaProduct.name;
    document.getElementById('staConfirmPrice').textContent = rupiah(_openStaProduct.price);
    document.getElementById('staConfirmTotal').textContent = rupiah(_openStaProduct.price);
    const btn = document.getElementById('staConfirmPayBtn');
    btn.disabled = false;
    btn.textContent = 'Bayar Sekarang';
    document.getElementById('staConfirmModal').classList.add('show');
  }
  function closeStaConfirm() {
    document.getElementById('staConfirmModal').classList.remove('show');
  }

  async function startStaPurchase() {
    if (!_openStaProduct) return;
    const btn = document.getElementById('staConfirmPayBtn');
    btn.disabled = true;
    btn.textContent = 'Memproses...';
    try {
      const res = await api('/api/steam-accounts/purchase', {
        method: 'POST',
        body: JSON.stringify({ productId: _openStaProduct.id, method: 'qris' })
      });
      closeStaConfirm();
      openStaPayModal(res.order);
    } catch (e) {
      if (e?.data?.alreadyOwned) {
        showToast('info', 'Akun Sudah Dimiliki', 'Kamu sudah memiliki akun ini — gunakan tombol LOGIN AKUN.');
        closeStaConfirm();
        loadSteamAccounts();
        if (_openStaProduct) openSteamAccountDetail(_openStaProduct.id);
      } else {
        showToast('error', 'Gagal Membuat Pesanan', e.message || 'Coba lagi sebentar.');
      }
    } finally {
      btn.disabled = false;
      btn.textContent = 'Bayar Sekarang';
    }
  }

  function openStaPayModal(order) {
    _openStaOrder = order;
    renderStaPayModal(order);
    document.getElementById('staPaymentModal').classList.add('show');
    stopStaTimers();
    if (order.status === 'pending') {
      _staCountdownTimer = setInterval(updateStaCountdown, 1000);
      _staPollTimer = setInterval(pollStaPurchaseStatus, 5000);
      updateStaCountdown();
    }
  }
  function closeStaPayModal() {
    document.getElementById('staPaymentModal').classList.remove('show');
    stopStaTimers();
    _openStaOrder = null;
    if (_staLastProducts.length) renderStaGrid(_staLastProducts);
  }
  function stopStaTimers() {
    if (_staCountdownTimer) clearInterval(_staCountdownTimer);
    if (_staPollTimer) clearInterval(_staPollTimer);
    _staCountdownTimer = null;
    _staPollTimer = null;
  }

  function renderStaPayModal(order) {
    if (!order) return;
    document.getElementById('staPayTitle').textContent = order.productName || _openStaProduct?.name || 'Akun Steam';
    document.getElementById('staPayOrderId').textContent = order.orderId;

    const badge = document.getElementById('staPayStatusBadge');
    badge.textContent = STA_STATUS_LABEL[order.status] || order.status;
    badge.dataset.status = order.status;

    const qrWrap = document.getElementById('staPayQrWrap');
    const resultWrap = document.getElementById('staPayResult');
    const cancelBtn = document.getElementById('staPayCancelBtn');
    const closeBtn = document.getElementById('staPayCloseBtn');

    if (order.status === 'pending') {
      qrWrap.hidden = false;
      resultWrap.hidden = true;
      cancelBtn.hidden = false;
      closeBtn.hidden = true;
      document.getElementById('staPayAmount').textContent = rupiah(order.totalPayment || order.amount);

      const qrImg = document.getElementById('staPayQrImg');
      const qrErr = document.getElementById('staPayQrError');
      if (order.qrDataUrl) {
        qrImg.style.display = '';
        qrImg.src = order.qrDataUrl;
        qrErr.hidden = true;
      } else {
        qrImg.style.display = 'none';
        qrErr.hidden = false;
      }
    } else {
      qrWrap.hidden = true;
      resultWrap.hidden = false;
      cancelBtn.hidden = true;
      closeBtn.hidden = false;
      if (order.status === 'completed') {
        resultWrap.className = 'pmc-pay-result pmc-pay-result--success';
        resultWrap.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><use href="#ic-circle-check-big"></use></svg><span>Pembayaran berhasil! Akun sudah bisa dipakai lewat tombol LOGIN AKUN.</span>`;
      } else if (order.status === 'expired') {
        resultWrap.className = 'pmc-pay-result pmc-pay-result--muted';
        resultWrap.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><use href="#ic-timer"></use></svg><span>Waktu pembayaran habis. Silakan buat pesanan baru.</span>`;
      } else {
        resultWrap.className = 'pmc-pay-result pmc-pay-result--danger';
        resultWrap.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><use href="#ic-circle-x"></use></svg><span>Pesanan ${escapeHtml(STA_STATUS_LABEL[order.status] || order.status)}.</span>`;
      }
    }
  }

  function updateStaCountdown() {
    if (!_openStaOrder || _openStaOrder.status !== 'pending') return;
    const remainMs = new Date(_openStaOrder.expiresAt).getTime() - Date.now();
    const el = document.getElementById('staPayCountdown');
    if (remainMs <= 0) { if (el) el.textContent = '00:00'; return; }
    const mm = String(Math.floor(remainMs / 60000)).padStart(2, '0');
    const ss = String(Math.floor((remainMs % 60000) / 1000)).padStart(2, '0');
    if (el) el.textContent = `${mm}:${ss}`;
  }

  async function pollStaPurchaseStatus() {
    if (!_openStaOrder || _openStaOrder.status !== 'pending') { stopStaTimers(); return; }
    try {
      const res = await api(`/api/steam-accounts/purchase/${encodeURIComponent(_openStaOrder.orderId)}`);
      handleStaOrderUpdate(res.order);
    } catch (e) { /* diam-diam, coba lagi 5 detik berikutnya */ }
  }

  function handleStaOrderUpdate(order) {
    if (!order) return;
    if (_openStaOrder && _openStaOrder.orderId === order.orderId) {
      _openStaOrder = order;
      renderStaPayModal(order);
      if (order.status !== 'pending') stopStaTimers();
    }
    if (order.status === 'completed') {
      loadSteamAccounts();
    }
  }

  // ── 'steamAccounts:products:update' — sinyal global (admin ubah produk apa
  // saja) TANPA payload spesifik, jadi cukup refetch listing personalized. ──
  function handleStaProductsSignal() {
    loadSteamAccounts();
    const isDetailOpen = document.getElementById('page-steam-account-detail')?.classList.contains('active');
    if (isDetailOpen && _openStaProduct) {
      api(`/api/steam-accounts/${_openStaProduct.id}`)
        .then((res) => {
          if (!res?.product) return;
          _openStaProduct = res.product;
          renderStaSidebar(res.product);
          renderStaBuyBar(res.product, res.pendingOrder);
        })
        .catch(() => { /* diam-diam, loadSteamAccounts() di atas tetap fallback */ });
    }
  }

  // ── 'steamAccounts:credentialsDm' — status pengiriman DM kredensial Discord
  // setelah pembayaran lunas. Murni notifikasi, TIDAK mempengaruhi tombol
  // LOGIN AKUN di App (yang selalu ambil kredensial langsung via API). ──
  function handleStaCredentialsDm(data) {
    if (!data) return;
    if (data.success) {
      showToast('success', 'Kredensial Terkirim', 'Kredensial akun Steam sudah dikirim ke DM Discord kamu.');
    } else {
      showToast('error', 'Gagal Kirim DM', data.message || 'Gagal mengirim kredensial ke Discord — gunakan tombol LOGIN AKUN di App.');
    }
  }

  async function cancelCurrentStaOrder() {
    if (!_openStaOrder || _openStaOrder.status !== 'pending') return;
    if (!confirm('Batalkan pesanan ini? Kamu bisa beli lagi kapan saja kalau berubah pikiran.')) return;
    const btn = document.getElementById('staPayCancelBtn');
    btn.disabled = true;
    btn.textContent = 'Membatalkan...';
    try {
      const res = await api(`/api/steam-accounts/purchase/${encodeURIComponent(_openStaOrder.orderId)}/cancel`, { method: 'POST' });
      handleStaOrderUpdate(res.order);
      showToast('cancel', 'Pesanan Dibatalkan', 'Pesanan kamu telah dibatalkan.');
    } catch (e) {
      showToast('error', 'Gagal Membatalkan', e.message || '');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Batalkan Pesanan';
    }
  }

  /* ── Tombol "LOGIN AKUN" — ambil kredensial (sekali pakai per klik) dari
     GET /api/steam-accounts/:id/credentials, lalu:
       - Steam terdeteksi (electronAPI.getSteamPath()) -> jalankan IPC
         'steam-account-login' (main.js, SUDAH ADA) & tampilkan progresnya.
       - Steam TIDAK terdeteksi -> fallback modal kredensial manual (bukan
         dianggap error/gagal total, pembeli tetap harus bisa pakai akunnya).
     Kredensial TIDAK PERNAH disimpan ke variabel/izin App yang persisten —
     cuma hidup selama proses login/tampil modal berlangsung. ── */
  async function openSteamAccountLogin(productId) {
    let creds;
    try {
      creds = await api(`/api/steam-accounts/${productId}/credentials`);
    } catch (e) {
      showToast('error', 'Gagal Mengambil Kredensial', e.message || 'Coba lagi sebentar.');
      return;
    }

    const steamPath = (typeof window.electronAPI?.getSteamPath === 'function')
      ? await window.electronAPI.getSteamPath().catch(() => null)
      : null;

    if (!steamPath) {
      openStaCredentialsFallback(creds);
      return;
    }

    openStaLoginProgressModal();
    setStaLoginStage('preparing');

    const onProgress = (data) => setStaLoginStage(data.stage, data.message);
    if (typeof window.electronAPI?.onSteamAccountLoginProgress === 'function') {
      window.electronAPI.onSteamAccountLoginProgress(onProgress);
    }

    try {
      const result = await window.electronAPI.steamAccountLogin({ steamPath, username: creds.username, password: creds.password });
      if (result?.success) {
        setStaLoginStage('done');
      } else {
        setStaLoginStage('error', result?.error || 'Steam gagal login. Silakan coba lagi.');
      }
    } catch (e) {
      setStaLoginStage('error', e.message || 'Steam gagal login. Silakan coba lagi.');
    } finally {
      if (typeof window.electronAPI?.removeSteamAccountLoginProgressListeners === 'function') {
        window.electronAPI.removeSteamAccountLoginProgressListeners();
      }
    }
  }

  function openStaLoginProgressModal() {
    const iconEl = document.getElementById('staLoginIcon');
    const closeBtn = document.getElementById('staLoginCloseBtn');
    iconEl.className = 'sta-login-icon';
    iconEl.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="sta-login-spinner"><use href="#ic-loader-circle"></use></svg>`;
    closeBtn.hidden = true;
    document.getElementById('staLoginProgressModal').classList.add('show');
  }
  function closeStaLoginProgressModal() {
    document.getElementById('staLoginProgressModal').classList.remove('show');
  }

  function setStaLoginStage(stage, message) {
    const iconEl = document.getElementById('staLoginIcon');
    const titleEl = document.getElementById('staLoginTitle');
    const descEl = document.getElementById('staLoginDesc');
    const closeBtn = document.getElementById('staLoginCloseBtn');

    if (stage === 'done') {
      iconEl.className = 'sta-login-icon sta-login-icon--success';
      iconEl.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><use href="#ic-circle-check-big"></use></svg>`;
      titleEl.textContent = 'Steam Berhasil Login';
      descEl.textContent = 'Selamat bermain!';
      closeBtn.hidden = false;
    } else if (stage === 'error') {
      iconEl.className = 'sta-login-icon sta-login-icon--error';
      iconEl.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><use href="#ic-circle-x"></use></svg>`;
      titleEl.textContent = 'Login Gagal';
      descEl.textContent = message || 'Steam gagal login. Silakan coba lagi.';
      closeBtn.hidden = false;
    } else {
      iconEl.className = 'sta-login-icon';
      iconEl.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="sta-login-spinner"><use href="#ic-loader-circle"></use></svg>`;
      titleEl.textContent = STA_LOGIN_STAGE_LABEL[stage] || 'Memproses...';
      descEl.textContent = 'Mohon tunggu, jangan tutup aplikasi ini.';
      closeBtn.hidden = true;
    }
  }

  function openStaCredentialsFallback(creds) {
    document.getElementById('staCredUsername').textContent = creds?.username || '—';
    document.getElementById('staCredPassword').textContent = creds?.password || '—';
    document.getElementById('staCredentialsModal').classList.add('show');
  }
  function closeStaCredentialsFallback() {
    document.getElementById('staCredentialsModal').classList.remove('show');
    // Kredensial cuma tampil sementara di DOM selagi modal terbuka — bersihkan
    // begitu ditutup, jangan dibiarkan nyangkut di layar/DOM.
    document.getElementById('staCredUsername').textContent = '—';
    document.getElementById('staCredPassword').textContent = '—';
  }

  async function copyStaCredential(targetId, btn) {
    const text = document.getElementById(targetId)?.textContent || '';
    if (!text || text === '—') return;
    try {
      await navigator.clipboard.writeText(text);
      btn.classList.add('sta-cred-copy--done');
      setTimeout(() => btn.classList.remove('sta-cred-copy--done'), 1200);
    } catch (e) { /* clipboard API tidak tersedia — diam-diam, user masih bisa select manual */ }
  }

  // Pasang listener tombol statis (dipanggil sekali dari initAppShellDemo()).
  function initSteamAccountPage() {
    const backBtn = document.getElementById('staDetailBackBtn');
    if (backBtn) backBtn.addEventListener('click', closeSteamAccountDetail);

    const confirmCloseBtn = document.getElementById('staConfirmCloseBtn');
    if (confirmCloseBtn) confirmCloseBtn.addEventListener('click', closeStaConfirm);

    const confirmPayBtn = document.getElementById('staConfirmPayBtn');
    if (confirmPayBtn) confirmPayBtn.addEventListener('click', startStaPurchase);

    const cancelBtn = document.getElementById('staPayCancelBtn');
    if (cancelBtn) cancelBtn.addEventListener('click', cancelCurrentStaOrder);

    const closePayBtn = document.getElementById('staPayCloseBtn');
    if (closePayBtn) closePayBtn.addEventListener('click', closeStaPayModal);

    const loginCloseBtn = document.getElementById('staLoginCloseBtn');
    if (loginCloseBtn) loginCloseBtn.addEventListener('click', closeStaLoginProgressModal);

    const credCloseBtn = document.getElementById('staCredCloseBtn');
    if (credCloseBtn) credCloseBtn.addEventListener('click', closeStaCredentialsFallback);

    document.querySelectorAll('.sta-cred-copy[data-copy-target]').forEach(btn => {
      btn.addEventListener('click', () => copyStaCredential(btn.dataset.copyTarget, btn));
    });

    initMktSectionTabs();
  }
  /* ══════════════════════════════════════════════════════════════════════════
     AKHIR BLOK STEAM ACCOUNT
     ══════════════════════════════════════════════════════════════════════════ */


  /* ══════════════════════════════════════════════════════════════════════════
     FITUR A — MODAL "AKSES PAKET DIPERLUKAN" (pkgAccessModal)
     Dipanggil dari renderDetailActions() (blok PHASE 5/6 di atas) SEBELUM
     download/install dimulai — access-check-nya sendiri (hasAccess()/
     isMktGated()/mktOrRoleLocked(), semua reuse, TIDAK diubah) sudah
     dijalankan lebih dulu oleh renderDetailActions(); fungsi ini MURNI
     presentasi (mengganti showToast() teks biasa yang dipakai sebelumnya).
     Data paket user (currentUser.role) & paket yang dibutuhkan (item.role)
     SELALU dari server — tidak ada tulisan Gold/Platinum yang di-hardcode.
     ══════════════════════════════════════════════════════════════════════════ */
  function paintPkgBadgeNow(el, tier) {
    if (!el) return;
    const cfg = PACKAGE_BADGES[tier];
    if (!cfg) return;
    el.dataset.tier = tier;
    el.innerHTML = cfg.icon + '<span class="pkg-badge-label">' + cfg.label + '</span>';
  }

  function openPackageAccessModal({ title, requiredRole, gated, productIds }) {
    const modal = document.getElementById('pkgAccessModal');
    if (!modal) return;
    const iconEl = document.getElementById('pkgAccessIcon');
    const descEl = document.getElementById('pkgAccessDesc');
    const compareEl = modal.querySelector('.pkgacc-compare');
    const currentBadge = document.getElementById('pkgAccessCurrentBadge');
    const requiredBadge = document.getElementById('pkgAccessRequiredBadge');
    const ctaBtn = document.getElementById('pkgAccessCtaBtn');
    const reqCard = document.getElementById('pkgAccessReqCard');
    const reqNameEl = document.getElementById('pkgAccessReqName');

    if (gated) {
      // Item ini konten Marketplace (marketplaceProductIds) — role/paket
      // TIDAK berlaku sama sekali, akses hanya dari pembelian/whitelist
      // Product terkait (lihat hasCatalogAccess() di server.js). Halaman
      // detail Marketplace Product SEKARANG SUDAH ADA (openMarketplaceDetail())
      // jadi CTA-nya diaktifkan lagi (sebelumnya sengaja disembunyikan).
      modal.dataset.accent = 'public';
      iconEl.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><use href="#ic-lock"></use></svg>';
      descEl.textContent = `${title || 'Item ini'} adalah konten Marketplace — beli atau minta whitelist product terkait terlebih dahulu untuk membuka akses.`;
      compareEl.style.display = 'none';

      // Satu item BISA masuk ke lebih dari satu Product (lihat komentar
      // marketplaceProductIds di marketplaceManager.js) — pakai yang PERTAMA
      // sebagai target CTA utama, itu sudah cukup buat mengarahkan user.
      const reqProductId = Array.isArray(productIds) && productIds.length ? productIds[0] : null;

      if (reqProductId) {
        reqCard.style.display = '';
        // Coba ambil nama dari cache Marketplace yang sudah di-load
        // (_mktLastProducts) dulu — instan, tanpa network. Kalau belum ada di
        // cache, fetch sekali ke endpoint detail yang sudah ada, lalu update
        // teksnya begitu responsnya datang (modal tidak perlu nunggu).
        const cached = (typeof _mktLastProducts !== 'undefined' ? _mktLastProducts : []).find(p => p.id === reqProductId);
        reqNameEl.textContent = cached?.name || 'Memuat nama produk...';
        if (!cached) {
          api(`/api/marketplace/products/${reqProductId}`)
            .then(res => { if (res?.product && reqNameEl.isConnected) reqNameEl.textContent = res.product.name; })
            .catch(() => { reqNameEl.textContent = 'Produk Marketplace terkait'; });
        }

        ctaBtn.style.display = '';
        ctaBtn.textContent = 'Lihat Produk';
        ctaBtn.onclick = () => {
          closePackageAccessModal();
          openMarketplaceDetail(reqProductId); // routing existing, productId dari backend
        };
      } else {
        // Fallback aman kalau (secara tidak terduga) productIds kosong —
        // tetap jelaskan kondisinya tanpa CTA yang tidak bisa dituju.
        reqCard.style.display = 'none';
        ctaBtn.style.display = 'none';
      }
    } else {
      reqCard.style.display = 'none';
      const currentRole = (currentUser?.role === 'admin') ? 'platinum' : (currentUser?.role || 'public');
      const reqRole = requiredRole || 'gold';
      const reqLabel = ROLE_DISPLAY_NAME[reqRole] || reqRole;

      modal.dataset.accent = reqRole === 'platinum' ? 'platinum' : (reqRole === 'gold' ? 'gold' : 'public');
      iconEl.innerHTML = reqRole === 'platinum'
        ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><use href="#ic-gem"></use></svg>'
        : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><use href="#ic-crown"></use></svg>';

      // Deskripsi dinamis sesuai kondisi user (requirement A2).
      descEl.textContent = (currentRole === 'public')
        ? `Game ini membutuhkan paket ${reqLabel} untuk dapat di-install. Upgrade paket untuk membuka akses ke game ini.`
        : `Game ini hanya tersedia untuk member ${reqLabel}. Upgrade ke ${reqLabel} untuk membuka akses ke game ini serta seluruh benefit yang tersedia untuk paket ${reqLabel}.`;

      compareEl.style.display = '';
      paintPkgBadgeNow(currentBadge, currentRole);
      paintPkgBadgeNow(requiredBadge, reqRole);

      ctaBtn.style.display = '';
      ctaBtn.textContent = `Upgrade ke ${reqLabel}`;
      ctaBtn.onclick = () => {
        closePackageAccessModal();
        setNav('belipaket');
      };
    }

    modal.classList.add('show');
  }
  function closePackageAccessModal() {
    document.getElementById('pkgAccessModal')?.classList.remove('show');
  }
  function initPackageAccessModal() {
    const modal = document.getElementById('pkgAccessModal');
    const closeBtn = document.getElementById('pkgAccessCloseBtn');
    if (closeBtn) closeBtn.addEventListener('click', closePackageAccessModal);
    if (modal) modal.addEventListener('click', (e) => { if (e.target === modal) closePackageAccessModal(); });
  }
  /* ══════════════════════════════════════════════════════════════════════════
     AKHIR FITUR A
     ══════════════════════════════════════════════════════════════════════════ */

  /* ══════════════════════════════════════════════════════════════════════════
     FITUR B/C — HALAMAN "TRANSAKSI"
     Data SELALU dari GET /api/transactions & GET /api/transactions/:orderId
     (endpoint gabungan yang SUDAH ADA di server.js — menggabungkan
     transactionManager/steamAccountOrderManager/marketplaceOrderManager/
     goldTrialManager — TIDAK ADA backend/endpoint baru dibuat di sini).
     Realtime lewat event WS 'transaction:update' yang SUDAH ADA (dipakai
     bersama dengan handlePkgTransactionUpdate() di blok BELI PAKET) —
     ditangani handleTxPageTransactionUpdate() di bawah, dipanggil dari
     cabang 'transaction:update' di connectRealtime() (lihat blok REALTIME).
     ══════════════════════════════════════════════════════════════════════════ */
  const TX_STATUS_LABEL = {
    completed: 'Berhasil',
    pending: 'Menunggu Pembayaran',
    expired: 'Kedaluwarsa',
    cancelled: 'Dibatalkan',
    failed: 'Gagal',
    active: 'Berhasil' // Gold Trial claim (bukan transaksi KlikQRIS beneran) dianggap "Berhasil" utk tampilan status.
  };
  const TX_STATUS_ICON = {
    completed: '<use href="#ic-circle-check-big"></use>',
    active: '<use href="#ic-circle-check-big"></use>',
    pending: '<use href="#ic-timer"></use>',
    expired: '<use href="#ic-timer"></use>',
    cancelled: '<use href="#ic-circle-x"></use>',
    failed: '<use href="#ic-circle-x"></use>'
  };
  const TX_KIND_LABEL = {
    package: 'Upgrade Paket',
    steam_account: 'Steam Account',
    marketplace: 'Marketplace',
    gold_trial: 'Gold Trial'
  };

  let _txAllItems = [];
  let _txFilter = 'all';

  function txItemName(tx) {
    if (tx.kind === 'package') return `Paket ${PKG_TIER_LABEL[tx.tier] || tx.tier}`;
    if (tx.kind === 'gold_trial') return tx.packageName || 'Gold Trial';
    return tx.productName || TX_KIND_LABEL[tx.kind] || 'Item';
  }
  function txDurationLabel(tx) {
    if (tx.durationLabel) return tx.durationLabel; // Gold Trial (publicGoldTrialClaim) sudah menyediakan label jadi.
    const snap = tx.packageSnapshot || tx.productSnapshot;
    if (snap && snap.durationAmount && snap.durationUnit) {
      const unitLabel = { days: 'Hari', hours: 'Jam', months: 'Bulan' }[snap.durationUnit] || snap.durationUnit;
      return `${snap.durationAmount} ${unitLabel}`;
    }
    return null;
  }
  function txMethodLabel(tx) {
    if (tx.kind === 'gold_trial') return 'Gratis (Trial)';
    return (tx.paymentMethod || tx.provider || 'KlikQRIS').toString().toUpperCase();
  }
  function txStatusLabel(status) { return TX_STATUS_LABEL[status] || status; }
  function txBadgeHtml(status) {
    const icon = TX_STATUS_ICON[status] || TX_STATUS_ICON.pending;
    return `<span class="tx-badge" data-status="${status === 'active' ? 'completed' : status}">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${icon}</svg>
      ${escapeHtml(txStatusLabel(status))}
    </span>`;
  }

  async function loadTransaksiPage() {
    const listEl = document.getElementById('txList');
    const emptyEl = document.getElementById('txEmptyState');
    const filterEmptyEl = document.getElementById('txFilterEmptyState');
    const refreshBtn = document.getElementById('txRefreshBtn');
    if (!listEl) return;
    refreshBtn?.classList.add('spinning');
    try {
      const res = await api('/api/transactions');
      _txAllItems = Array.isArray(res.transactions) ? res.transactions : [];
      renderTxSummary(_txAllItems);
      renderTxList();
    } catch (e) {
      listEl.innerHTML = '';
      emptyEl?.classList.remove('show');
      filterEmptyEl.hidden = false;
      filterEmptyEl.querySelector('.empty-title').textContent = 'Gagal Memuat Transaksi';
      filterEmptyEl.querySelector('.empty-sub').textContent = e.message || 'Coba muat ulang halaman ini.';
      showToast('error', 'Gagal Memuat Transaksi', e.message || '');
    } finally {
      refreshBtn?.classList.remove('spinning');
    }
  }

  function renderTxSummary(items) {
    const total = items.length;
    const success = items.filter(t => t.status === 'completed' || t.status === 'active').length;
    const pending = items.filter(t => t.status === 'pending').length;
    const failed = items.filter(t => t.status === 'failed' || t.status === 'cancelled' || t.status === 'expired').length;
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = String(v); };
    set('txStatTotal', total);
    set('txStatSuccess', success);
    set('txStatPending', pending);
    set('txStatFailed', failed);
  }

  function renderTxList() {
    const listEl = document.getElementById('txList');
    const emptyEl = document.getElementById('txEmptyState');
    const filterEmptyEl = document.getElementById('txFilterEmptyState');
    if (!listEl) return;

    if (_txAllItems.length === 0) {
      listEl.innerHTML = '';
      emptyEl.classList.add('show');
      filterEmptyEl.hidden = true;
      return;
    }
    emptyEl.classList.remove('show');

    const normStatus = (s) => (s === 'active' ? 'completed' : s);
    const filtered = _txFilter === 'all' ? _txAllItems : _txAllItems.filter(t => normStatus(t.status) === _txFilter);
    if (filtered.length === 0) {
      listEl.innerHTML = '';
      filterEmptyEl.hidden = false;
      return;
    }
    filterEmptyEl.hidden = true;

    listEl.innerHTML = filtered.map(tx => {
      const name = escapeHtml(txItemName(tx));
      const dur = txDurationLabel(tx);
      const price = rupiah(tx.totalPayment || tx.amount);
      const dateStr = formatHistoryDate(tx.createdAt);
      const method = txMethodLabel(tx);
      const tier = tx.kind === 'package' ? tx.tier : '';
      const canContinue = tx.kind === 'package' && tx.status === 'pending';
      return `
        <div class="tx-card" data-order-id="${escapeHtml(tx.orderId || '')}" data-tier="${escapeHtml(tier)}">
          <span class="tx-card-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><use href="#ic-receipt"></use></svg>
          </span>
          <div class="tx-card-main">
            <div class="tx-card-title-row">
              <span class="tx-card-name">${name}</span>
              ${txBadgeHtml(tx.status)}
            </div>
            ${dur ? `<span class="tx-card-sub">${escapeHtml(TX_KIND_LABEL[tx.kind] || '')} • ${escapeHtml(dur)}</span>` : `<span class="tx-card-sub">${escapeHtml(TX_KIND_LABEL[tx.kind] || '')}</span>`}
            <div class="tx-card-meta">
              <span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><use href="#ic-wallet"></use></svg>${escapeHtml(method)}</span>
              <span>${escapeHtml(dateStr)}</span>
            </div>
          </div>
          <span class="tx-card-price">${price}</span>
          <div class="tx-card-actions">
            <button type="button" class="tx-card-btn" onclick="openTxDetail('${escapeHtml(tx.orderId || '')}')">Lihat Detail</button>
            ${canContinue ? `<button type="button" class="tx-card-btn tx-card-btn--primary" onclick="continueTxPayment('${escapeHtml(tx.orderId || '')}')">Lanjutkan Pembayaran</button>` : ''}
          </div>
        </div>`;
    }).join('');
  }

  function initTxFilterTabs() {
    const group = document.getElementById('txFilterGroup');
    if (!group) return;
    group.querySelectorAll('.filter-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        group.querySelectorAll('.filter-tab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        _txFilter = btn.dataset.value;
        renderTxList();
      });
    });
    const refreshBtn = document.getElementById('txRefreshBtn');
    if (refreshBtn) refreshBtn.addEventListener('click', loadTransaksiPage);
  }

  // Dipanggil klik tombol "Lihat Detail" tiap kartu — data dari
  // GET /api/transactions/:orderId (TIDAK menampilkan secret/API key/webhook
  // secret, lihat publicTransaction()/publicOrder() di backend yang memang
  // sudah membuang field sensitif).
  async function openTxDetail(orderId) {
    const modal = document.getElementById('txDetailModal');
    if (!modal || !orderId) return;
    try {
      const res = await api(`/api/transactions/${encodeURIComponent(orderId)}`);
      const tx = res.transaction;
      renderTxDetail(tx);
      modal.classList.add('show');
    } catch (e) {
      showToast('error', 'Gagal Memuat Detail', e.message || '');
    }
  }
  window.openTxDetail = openTxDetail;

  function renderTxDetail(tx) {
    if (!tx) return;
    const badge = document.getElementById('txDetailStatusBadge');
    badge.textContent = txStatusLabel(tx.status);
    badge.dataset.status = tx.status === 'active' ? 'completed' : tx.status;

    document.getElementById('txDetailOrderId').textContent = tx.orderId || tx.id || '—';
    document.getElementById('txDetailItem').textContent = txItemName(tx);
    document.getElementById('txDetailPrice').textContent = rupiah(tx.totalPayment || tx.amount);
    document.getElementById('txDetailMethod').textContent = txMethodLabel(tx);
    document.getElementById('txDetailDate').textContent = tx.createdAt ? formatHistoryDate(tx.createdAt) : '—';

    const durRow = document.getElementById('txDetailDurationRow');
    const dur = txDurationLabel(tx);
    if (dur) { durRow.hidden = false; document.getElementById('txDetailDuration').textContent = dur; }
    else { durRow.hidden = true; }

    const activeRow = document.getElementById('txDetailActiveRow');
    const activeUntil = tx.grantedActiveUntil || tx.activeUntil;
    if (activeUntil && (tx.status === 'completed' || tx.status === 'active')) {
      activeRow.hidden = false;
      document.getElementById('txDetailActiveUntil').textContent = formatHistoryDate(activeUntil);
    } else {
      activeRow.hidden = true;
    }

    const noteEl = document.getElementById('txDetailNote');
    if (tx.status === 'completed' || tx.status === 'active') {
      noteEl.hidden = false;
      noteEl.textContent = 'Paket berhasil diaktifkan.';
    } else if (tx.status === 'pending') {
      noteEl.hidden = false;
      noteEl.textContent = 'Menunggu pembayaran — selesaikan pembayaran QRIS sebelum waktu habis.';
    } else {
      noteEl.hidden = true;
    }

    const continueBtn = document.getElementById('txDetailContinueBtn');
    if (tx.kind === 'package' && tx.status === 'pending') {
      continueBtn.hidden = false;
      continueBtn.onclick = () => { closeTxDetail(); continueTxPayment(tx.orderId); };
    } else {
      continueBtn.hidden = true;
    }
  }
  function closeTxDetail() {
    document.getElementById('txDetailModal')?.classList.remove('show');
  }

  // "Lanjutkan Pembayaran" — REUSE 100% modal QRIS Beli Paket yang sudah ada
  // (openPkgPayment(), lihat blok BELI PAKET) supaya TIDAK ADA payment flow
  // baru. Hanya berlaku utk transaksi kind:'package' yang masih pending.
  async function continueTxPayment(orderId) {
    try {
      const res = await api(`/api/packages/purchase/${encodeURIComponent(orderId)}`);
      openPkgPayment(res.transaction);
    } catch (e) {
      showToast('error', 'Gagal Membuka Pembayaran', e.message || '');
    }
  }
  window.continueTxPayment = continueTxPayment;

  // Dipicu WS 'transaction:update' (lihat cabang di connectRealtime(), blok
  // REALTIME) — kalau halaman Transaksi lagi kebuka, list & summary
  // di-refresh dari data terbaru supaya status berubah TANPA reload/refresh
  // manual (requirement L — Realtime Transaction Update).
  function handleTxPageTransactionUpdate(tx) {
    if (!tx || !tx.orderId) return;
    const page = document.getElementById('page-transaksi');
    if (!page || !page.classList.contains('active')) return; // hemat kerja kalau halaman lagi tidak dibuka
    loadTransaksiPage();
  }

  function initTransaksiPage() {
    initTxFilterTabs();
    const closeBtn = document.getElementById('txDetailCloseBtn');
    if (closeBtn) closeBtn.addEventListener('click', closeTxDetail);
    const modal = document.getElementById('txDetailModal');
    if (modal) modal.addEventListener('click', (e) => { if (e.target === modal) closeTxDetail(); });
  }
  /* ══════════════════════════════════════════════════════════════════════════
     AKHIR FITUR B/C
     ══════════════════════════════════════════════════════════════════════════ */

  /* ══════════════════════════════════════════════════════════════════════════
     TUTORIAL — halaman baru (#page-tutorial / #page-tutorial-detail).
     Data 100% dari sistem Tutorial EXISTING:
       GET  /api/tutorials        -> daftar published (App)
       WS   'tutorials:update'    -> broadcast realtime tiap Admin Web
                                      Tambah/Edit/Hapus/ubah status
     (lihat blok TUTORIAL di server.js — backend TIDAK diubah/dibuat baru
     sama sekali). Search & filter kategori dikerjakan di client terhadap
     data yang sudah ada di memori — pola SAMA PERSIS dengan Games/Bypass
     (loadGames/applyFilters), instan walau tutorial-nya banyak.
     ══════════════════════════════════════════════════════════════════════════ */
  let allTutorials = [];
  let currentTutorialNavList = []; // daftar tutorial yang sedang tampil (dipakai untuk refresh detail saat realtime update masuk)
  let currentTutorialIndex = -1;
  let _tutorialFirstLoadDone = false;

  async function loadTutorials() {
    try {
      const tutorials = await api('/api/tutorials');
      _tutorialFirstLoadDone = true;
      applyTutorialsUpdate(tutorials);
    } catch (e) {
      _tutorialFirstLoadDone = true;
    }
  }

  function hideEl(el){ if (el) el.hidden = true; }
  function showEl(el){ if (el) el.hidden = false; }

  // Dipanggil dari GET /api/tutorials (loadTutorials) MAUPUN dari event WS
  // 'tutorials:update' — satu sumber render supaya list dari REST & realtime
  // selalu konsisten. Payload dari server SUDAH difilter status:'published'
  // (lihat broadcastPublishedTutorials()/GET /api/tutorials di server.js).
  function applyTutorialsUpdate(tutorials) {
    allTutorials = Array.isArray(tutorials) ? tutorials : [];

    renderTutorialLatest();

    // Kalau halaman detail Tutorial lagi terbuka pas update realtime masuk
    // (mis. admin edit judul/isi tutorial yang sedang dibaca user), refresh
    // kontennya di tempat TANPA nge-lempar user balik ke daftar — dan kalau
    // tutorial itu baru saja dihapus/di-draft-kan (jadi hilang dari
    // `tutorials`), otomatis kembali ke daftar Tutorial.
    const detailPage = document.getElementById('page-tutorial-detail');
    if (detailPage && detailPage.classList.contains('active') && currentTutorialIndex >= 0) {
      const openId = currentTutorialNavList[currentTutorialIndex]?._id;
      const stillExists = allTutorials.find(t => t._id === openId);
      if (stillExists) {
        currentTutorialNavList = allTutorials;
        currentTutorialIndex = allTutorials.findIndex(t => t._id === openId);
        renderTutorialDetail(stillExists);
      } else {
        closeTutorialDetail();
      }
    }
  }

  // "Semua Tutorial" — 6 tutorial published paling baru (data sudah
  // terurut createdAt desc dari server, lihat GET /api/tutorials). Section
  // disembunyikan total kalau belum ada tutorial sama sekali (bukan
  // ditampilkan kosong).
  function renderTutorialLatest() {
    const section = document.getElementById('tutorialLatestSection');
    const row = document.getElementById('tutorialLatestRow');
    if (!section || !row) return;
    const latest = allTutorials.slice(0, 6);
    section.hidden = latest.length === 0;
    row.innerHTML = latest.map(t => renderTutorialCardHtml(t)).join('');
    wireTutorialCardClicks(row, latest);
  }

  function tutorialThumbStyle(item) {
    const src = item.thumbnailData || item.thumbnailUrl;
    return src ? ` style="background-image:url('${src.replace(/"/g, '&quot;')}')"` : '';
  }

  function renderTutorialCardHtml(item) {
    const hasVideo = !!(item.videoId || item.youtubeId);
    return `
    <div class="tut-card" data-id="${item._id}">
      <div class="tut-card-thumb"${tutorialThumbStyle(item)}>
        <svg class="tut-card-thumb-fallback" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><use href="#ic-book-open"></use></svg>
        <span class="tut-card-badge">${escapeHtml(item.category || 'Umum')}</span>
        ${hasVideo ? '<span class="tut-card-play"><svg viewBox="0 0 24 24" fill="currentColor"><use href="#ic-play"></use></svg></span>' : ''}
      </div>
      <div class="tut-card-body">
        <h4 class="tut-card-title">${escapeHtml(item.title)}</h4>
        <p class="tut-card-desc">${escapeHtml(item.description || '')}</p>
        <span class="tut-card-cta"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><use href="#ic-book-open"></use></svg> Baca Tutorial</span>
      </div>
    </div>`;
  }

  function wireTutorialCardClicks(container, navList) {
    container.querySelectorAll('.tut-card').forEach(card => {
      card.addEventListener('click', () => {
        const tutorial = navList.find(t => t._id === card.dataset.id) || allTutorials.find(t => t._id === card.dataset.id);
        if (tutorial) openTutorialDetail(tutorial, navList);
      });
    });
  }

  // Buka halaman baca Tutorial. `navList` = daftar tutorial yang sedang
  // tampil di kartu yang diklik (Terbaru ATAU hasil filter/search saat itu)
  // — jadi Sebelumnya/Selanjutnya jalan sesuai konteks tempat user klik,
  // bukan selalu urutan semua data.
  function openTutorialDetail(tutorial, navList) {
    currentTutorialNavList = navList && navList.length ? navList : allTutorials;
    currentTutorialIndex = currentTutorialNavList.findIndex(t => t._id === tutorial._id);

    document.querySelectorAll('.nav-item[data-page]').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.pm-item[data-page]').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.page').forEach(sec => sec.classList.toggle('active', sec.id === 'page-tutorial-detail'));

    renderTutorialDetail(tutorial);
    const body = document.querySelector('#page-tutorial-detail .detail-body');
    if (body) body.scrollTop = 0;
  }

  function closeTutorialDetail() {
    currentTutorialNavList = [];
    currentTutorialIndex = -1;
    // Hentikan video (kalau lagi diputar) begitu keluar dari halaman detail,
    // supaya audio tidak lanjut terdengar di background di halaman lain.
    const webview = document.getElementById('tutorialDetailVideo');
    if (webview) webview.src = '';
    setNav('tutorial');
  }

  // Referer video (YouTube/TikTok) di-set ke domain produksi sendiri
  // (SERVER_URL, SUDAH ADA & dipakai di seluruh app.js ini) — BUKAN
  // file://, BUKAN juga youtube.com — supaya YouTube melihat origin pihak
  // ketiga yang valid & masuk akal, tanpa kontradiksi (histori debug Error
  // 152/153 lengkap ada di main.js, TIDAK diulang di sini). <webview> +
  // spoofed User-Agent SUDAH dikonfigurasi di main.js khusus untuk ini.
  const TUTORIAL_EMBED_REFERER = SERVER_URL + '/';

  function renderTutorialDetail(tutorial) {
    const categoryEl = document.getElementById('tutorialDetailCategory');
    const titleEl = document.getElementById('tutorialDetailTitle');
    const descEl = document.getElementById('tutorialDetailDesc');
    const imageWrap = document.getElementById('tutorialDetailImageWrap');
    const imageEl = document.getElementById('tutorialDetailImage');
    const contentEl = document.getElementById('tutorialDetailContent');
    const videoWrap = document.getElementById('tutorialDetailVideoWrap');
    const webview = document.getElementById('tutorialDetailVideo');

    if (categoryEl) categoryEl.textContent = tutorial.category || 'Umum';
    if (titleEl) titleEl.textContent = tutorial.title || '';

    if (descEl) {
      if (tutorial.description) { descEl.textContent = tutorial.description; descEl.hidden = false; }
      else { descEl.hidden = true; }
    }

    const imgSrc = tutorial.imageData || tutorial.imageUrl;
    if (imageWrap && imageEl) {
      if (imgSrc) { imageEl.src = imgSrc; imageWrap.hidden = false; }
      else { imageEl.src = ''; imageWrap.hidden = true; }
    }

    // `content` sudah disanitasi KETAT di server (sanitizeTutorialContent,
    // lihat server.js — <script>/<iframe>/<img> dibuang total di sana)
    // sebelum pernah disimpan ke DB, jadi aman dirender sebagai HTML di sini.
    if (contentEl) contentEl.innerHTML = tutorial.content || '';

    if (videoWrap && webview) {
      // videoPlatform/videoId = field baru (support YouTube & TikTok).
      // Fallback ke youtubeId lama supaya tutorial yang disimpan sebelum
      // update itu tetap tampil videonya.
      const platform = tutorial.videoPlatform || (tutorial.youtubeId ? 'youtube' : '');
      const videoId = tutorial.videoId || tutorial.youtubeId || '';

      let embedSrc = '';
      if (platform === 'youtube' && videoId) {
        embedSrc = `https://www.youtube-nocookie.com/embed/${videoId}?origin=${encodeURIComponent(SERVER_URL)}`;
      } else if (platform === 'tiktok' && videoId) {
        embedSrc = `https://www.tiktok.com/embed/v2/${videoId}`;
      }

      if (embedSrc) {
        // httpreferrer WAJIB di-set SEBELUM src diubah, supaya navigasi
        // pertama ke YouTube/TikTok langsung bawa Referer yang benar.
        webview.setAttribute('httpreferrer', TUTORIAL_EMBED_REFERER);
        webview.src = embedSrc;
        videoWrap.hidden = false;
      } else {
        webview.src = '';
        videoWrap.hidden = true;
      }
    }

  }

  function wireTutorialDetailNav() {
    const backBtn = document.getElementById('tutorialDetailBackBtn');
    if (backBtn) backBtn.addEventListener('click', closeTutorialDetail);
  }

  function initTutorialPage() {
    wireTutorialDetailNav();
  }
  /* ══════════════════════════════════════════════════════════════════════════
     AKHIR TUTORIAL
     ══════════════════════════════════════════════════════════════════════════ */

  /* ══════════════════════════════════════════════════════════════════════════
     APP UPDATE — MIGRASI DARI APP LAMA (bukan sistem baru).
     Backend (appUpdateManager.js, GET/PUT /api/app-update, broadcast WS
     'app-update:config') dan IPC Electron (preload.js: getAppVersion,
     checkPendingUpdateResult, downloadAppUpdate, cancelAppUpdateDownload,
     installAppUpdate, onAppUpdateProgress — semua di main.js) SUDAH ADA
     PERSIS SAMA seperti APP LAMA, TIDAK ada yang ditambah/diubah di sisi
     itu. Yang dipasang di sini HANYA UI + integrasinya di App DEMO ini
     (overlay #appUpdateOverlay di index.html, checkAppUpdate() dipanggil
     dari titik masuk App di bawah, dan cabang WS 'app-update:config' di
     blok REALTIME di atas).

     Cek versi terbaru dari GitHub Release (lewat backend, /api/app-update)
     setiap App dibuka (checkAppUpdate — initial check), dan realtime lewat
     WS existing (event 'app-update:config') selama App sedang berjalan,
     jadi kalau App sedang terbuka ketika Admin publish versi baru, popup
     update langsung muncul TANPA restart/refresh/logout-login.
     ══════════════════════════════════════════════════════════════════════════ */
  let _appUpdateCurrentVersion = null;
  let _appUpdateConfigCache = null;
  let _appUpdatePollTimer = null;
  let _appUpdateDownloading = false;
  let _appUpdateLastFailedTarget = null; // versi yang gagal diterapkan otomatis di percobaan sebelumnya

  function compareAppVersions(a, b) {
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

  function formatBytesAU(bytes) {
    if (!bytes || bytes <= 0) return '0 KB';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0, n = bytes;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
  }

  function formatEtaAU(sec) {
    if (sec === null || sec === undefined || !isFinite(sec)) return '—';
    if (sec < 60) return `${Math.max(1, Math.round(sec))} detik`;
    const m = Math.floor(sec / 60), s = Math.round(sec % 60);
    return `${m} menit ${s} detik`;
  }

  async function getCurrentAppVersion() {
    if (_appUpdateCurrentVersion) return _appUpdateCurrentVersion;
    try {
      if (window.electronAPI?.getAppVersion) {
        _appUpdateCurrentVersion = await window.electronAPI.getAppVersion();
      }
    } catch (e) { /* noop */ }
    return _appUpdateCurrentVersion || '0.0.0';
  }

  async function fetchAppUpdateConfig() {
    try {
      const res = await fetch(SERVER_URL + '/api/app-update');
      if (!res.ok) return null;
      return await res.json();
    } catch (e) {
      return null;
    }
  }

  // Titik masuk utama — dipanggil paling awal dari titik masuk App (lihat
  // paling bawah file ini), SEBELUM tryAutoLogin(), supaya kalau Force
  // Update aktif, overlay sudah terpasang duluan mengunci layar sebelum
  // user sempat interaksi apapun (termasuk sebelum login, sama seperti
  // APP LAMA).
  async function checkAppUpdate() {
    // Cek dulu hasil auto-update SEBELUMNYA (kalau ada) — supaya kalau
    // ternyata gagal diterapkan otomatis, App kasih pesan yang jelas ke
    // user alih-alih diam-diam masuk ke alur silent yang sama lagi
    // berulang-ulang ("loop"). Kalau berhasil, ini juga yang memastikan
    // marker-nya dibersihkan sehingga popup update TIDAK muncul lagi
    // setelah versi baru benar-benar aktif.
    try {
      const pending = await window.electronAPI?.checkPendingUpdateResult?.();
      if (pending?.status === 'failed') {
        _appUpdateLastFailedTarget = pending.targetVersion || null;
      }
    } catch (e) { /* noop */ }

    const cfg = await fetchAppUpdateConfig();
    if (!cfg) return; // server/DB belum siap — jangan blokir app cuma karena network hiccup
    _appUpdateConfigCache = cfg;
    await applyAppUpdateConfig(cfg);

    // Poll berkala (di luar WS, supaya tetap jalan walau user belum login /
    // WS belum konek) — cukup jarang karena perubahan lewat WS realtime
    // saat user sudah login (lihat cabang 'app-update:config' di blok
    // REALTIME).
    clearInterval(_appUpdatePollTimer);
    _appUpdatePollTimer = setInterval(async () => {
      // Jangan re-render overlay kalau lagi download/install — kalau tidak,
      // progress bar & tombol "Memasang..." bisa ke-reset di tengah proses
      // cuma karena poll ini kebetulan nembak di saat yang sama.
      if (_appUpdateDownloading) return;
      const fresh = await fetchAppUpdateConfig();
      if (fresh) { _appUpdateConfigCache = fresh; applyAppUpdateConfig(fresh); }
    }, 5 * 60 * 1000);
  }

  async function applyAppUpdateConfig(cfg) {
    if (!cfg) return;
    // Lagi download/install → jangan sentuh overlay sama sekali (dari sumber
    // manapun: polling, WS realtime admin, dst) supaya progress bar/tombol
    // tidak ke-reset di tengah proses yang sedang berjalan.
    if (_appUpdateDownloading) return;
    const currentVersion = await getCurrentAppVersion();
    const isNewer = compareAppVersions(cfg.latestVersion, currentVersion) > 0;

    if (!isNewer) { hideAppUpdateOverlay(); return; }

    const previousAttemptFailed = _appUpdateLastFailedTarget && compareAppVersions(_appUpdateLastFailedTarget, currentVersion) <= 0;

    if (cfg.forceUpdateEnabled) {
      renderAppUpdateOverlay(cfg, currentVersion, { blocking: true, previousAttemptFailed });
    } else if (cfg.autoUpdateEnabled) {
      // Update tersedia tapi tidak dipaksa — tetap tampilkan halaman update,
      // namun TIDAK blocking — user tetap bisa lanjut pakai App lewat
      // tombol "Nanti Saja" di overlay ini sendiri.
      renderAppUpdateOverlay(cfg, currentVersion, { blocking: false, previousAttemptFailed });
    } else {
      hideAppUpdateOverlay();
    }
  }

  function hideAppUpdateOverlay() {
    const el = document.getElementById('appUpdateOverlay');
    if (!el) return;
    el.style.display = 'none';
    el.classList.remove('au-blocking');
    el.innerHTML = '';
  }

  function escapeHtmlAU(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }

  // Notification premium (bukan browser alert) — dark surface, subtle
  // border, soft shadow, aksen 31 Tools, icon SVG, tanpa emoji, mengikuti
  // design system App DEMO ini (lihat .app-update-overlay/.au-* di
  // styles.css). NAV/Profile/Avatar/Sidebar TIDAK pernah tertutup karena
  // posisinya full-screen-center, sama seperti confirm-overlay/at-req-box
  // lain di App ini.
  function renderAppUpdateOverlay(cfg, currentVersion, { blocking, previousAttemptFailed }) {
    const el = document.getElementById('appUpdateOverlay');
    if (!el) return;

    const sizeLabel = cfg.fileSizeLabel || (cfg.fileSize ? formatBytesAU(cfg.fileSize) : null);
    const changelogHtml = cfg.changelog
      ? escapeHtmlAU(cfg.changelog)
      : 'Tidak ada catatan perubahan untuk versi ini.';

    const failedNoticeHtml = previousAttemptFailed ? `
        <div class="au-error-box au-show" style="position:static;margin-bottom:14px;">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink:0;margin-top:1px;"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>
          <span>Update otomatis sebelumnya tidak berhasil diterapkan. Kamu bisa coba lagi, atau download &amp; install manual dari tombol di bawah.</span>
        </div>` : '';

    el.innerHTML = `
      <div class="au-card">
        <div class="au-icon-wrap">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17V3"/><path d="m6 11 6 6 6-6"/><path d="M19 21H5"/></svg>
        </div>
        <div class="au-title">${blocking ? 'Update Wajib Tersedia' : 'Update Tersedia'}</div>
        <div class="au-msg" id="auMsg">${escapeHtmlAU(cfg.forceUpdateMessage || 'Ada versi baru aplikasi. Silakan update untuk melanjutkan.')}</div>
        <div class="au-versions">
          <span>Versi kamu: <span class="au-version-pill">${escapeHtmlAU(currentVersion)}</span></span>
          <span>→</span>
          <span>Terbaru: <span class="au-version-pill au-latest">${escapeHtmlAU(cfg.latestVersion)}</span></span>
        </div>
        ${sizeLabel ? `<div class="au-meta-row"><span>Ukuran file</span><span>${escapeHtmlAU(sizeLabel)}</span></div>` : ''}
        ${failedNoticeHtml}
        <div class="au-changelog">${changelogHtml}</div>

        <div class="au-error-box" id="auErrorBox"></div>

        <div class="au-progress-wrap" id="auProgressWrap">
          <div class="au-progress-bar-track"><div class="au-progress-bar-fill" id="auProgressFill"></div></div>
          <div class="au-progress-stats">
            <span id="auProgressPercent">0%</span>
            <span id="auProgressSpeed">—</span>
            <span id="auProgressEta">—</span>
          </div>
        </div>

        <div class="au-actions">
          ${!blocking ? `<button class="au-btn" id="auSkipBtn" style="background:rgba(255,255,255,0.08);color:var(--text-secondary);flex:0 0 auto;padding:12px 18px;">Nanti Saja</button>` : ''}
          ${previousAttemptFailed && cfg.releaseUrl ? `<button class="au-btn" id="auManualBtn" style="background:rgba(255,255,255,0.08);color:var(--text-secondary);flex:0 0 auto;padding:12px 18px;">Download Manual</button>` : ''}
          <button class="au-btn au-btn-primary" id="auUpdateBtn">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17V3"/><path d="m6 11 6 6 6-6"/><path d="M19 21H5"/></svg>
            Update Sekarang
          </button>
        </div>
      </div>
    `;
    el.style.display = 'flex';
    el.classList.toggle('au-blocking', !!blocking);

    document.getElementById('auSkipBtn')?.addEventListener('click', () => {
      if (_appUpdateDownloading) return;
      hideAppUpdateOverlay();
    });
    document.getElementById('auManualBtn')?.addEventListener('click', () => {
      window.electronAPI?.openExternal?.(cfg.releaseUrl);
    });
    document.getElementById('auUpdateBtn')?.addEventListener('click', () => startAppUpdateDownload(cfg, blocking));
  }

  async function startAppUpdateDownload(cfg, blocking) {
    if (_appUpdateDownloading) return;
    if (!window.electronAPI?.downloadAppUpdate) {
      showAppUpdateError('Update otomatis hanya tersedia di aplikasi desktop.');
      return;
    }
    if (!cfg.downloadUrl) {
      showAppUpdateError('Link download update belum diatur oleh admin.');
      return;
    }

    _appUpdateDownloading = true;
    const updateBtn = document.getElementById('auUpdateBtn');
    const skipBtn = document.getElementById('auSkipBtn');
    if (updateBtn) { updateBtn.disabled = true; updateBtn.innerHTML = 'Mendownload...'; }
    if (skipBtn) skipBtn.style.display = 'none';
    hideAppUpdateError();

    const progressWrap = document.getElementById('auProgressWrap');
    progressWrap?.classList.add('au-active');

    // Progress REALTIME dari proses download sebenarnya (event IPC
    // 'app-update-progress' dari main.js, lihat handler
    // ipcMain.handle('download-app-update', ...)) — BUKAN timer/progress
    // palsu.
    const onProgress = (data) => {
      const fill = document.getElementById('auProgressFill');
      const percentEl = document.getElementById('auProgressPercent');
      const speedEl = document.getElementById('auProgressSpeed');
      const etaEl = document.getElementById('auProgressEta');
      const percent = data.percent ?? (data.total ? Math.round((data.downloaded / data.total) * 100) : 0);
      if (fill) fill.style.width = `${percent}%`;
      if (percentEl) percentEl.textContent = `${percent}% (${formatBytesAU(data.downloaded)}${data.total ? ' / ' + formatBytesAU(data.total) : ''})`;
      if (speedEl) speedEl.textContent = `${formatBytesAU(data.speedBps || 0)}/s`;
      if (etaEl) etaEl.textContent = data.etaSec != null ? `Sisa ${formatEtaAU(data.etaSec)}` : '';
    };
    window.electronAPI.removeAppUpdateProgressListeners?.();
    window.electronAPI.onAppUpdateProgress?.(onProgress);

    try {
      const result = await window.electronAPI.downloadAppUpdate({ url: cfg.downloadUrl, fileSize: cfg.fileSize || 0 });
      if (!result?.success) {
        throw new Error(result?.error || 'Download update gagal.');
      }

      if (updateBtn) updateBtn.innerHTML = 'Memasang & menutup aplikasi...';
      const installResult = await window.electronAPI.installAppUpdate({ installerPath: result.installerPath, targetVersion: cfg.latestVersion });
      if (!installResult?.success) {
        throw new Error(installResult?.error || 'Gagal menjalankan installer.');
      }
      // App akan menutup diri sendiri dari sisi main process (setelah
      // installer ter-spawn) lalu installer yang otomatis membuka lagi
      // App versi baru (mekanisme restart existing, TIDAK ada restart
      // mechanism baru).
    } catch (e) {
      _appUpdateDownloading = false;
      if (updateBtn) { updateBtn.disabled = false; updateBtn.innerHTML = 'Coba Lagi'; }
      if (skipBtn && !blocking) skipBtn.style.display = '';
      progressWrap?.classList.remove('au-active');
      showAppUpdateError(e.message || 'Update gagal. Silakan coba lagi.');
    }
  }

  function showAppUpdateError(msg) {
    const box = document.getElementById('auErrorBox');
    if (!box) return;
    box.innerHTML = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink:0;margin-top:1px;"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg><span>${escapeHtmlAU(msg)}</span>`;
    box.classList.add('au-show');
  }

  function hideAppUpdateError() {
    const box = document.getElementById('auErrorBox');
    if (!box) return;
    box.classList.remove('au-show');
    box.innerHTML = '';
  }
  /* ══════════════════════════════════════════════════════════════════════════
     AKHIR APP UPDATE
     ══════════════════════════════════════════════════════════════════════════ */

  /* ══════════════════════════════════════════════════════════════════════════
     MAINTENANCE MODE — terhubung ke sistem existing (backend
     maintenanceManager.js + endpoint GET /api/maintenance-status (publik,
     tidak wajib login) + PUT/GET /api/admin/maintenance (Admin Web) + WS
     event 'maintenance:config', SEMUA SUDAH ADA, TIDAK ada backend/Socket.IO
     baru dibuat di sini). Yang ditambahkan HANYA UI + integrasinya di App
     DEMO ini (overlay #maintenanceOverlay di index.html, checkMaintenanceStatus()
     dipanggil paling awal dari titik masuk App di bawah — bahkan sebelum
     tryAutoLogin(), supaya Maintenance sudah mengunci layar duluan sebelum
     user sempat login sama sekali — dan cabang WS 'maintenance:config' +
     resync reconnect di blok REALTIME di atas).

     Priority: Maintenance adalah state GLOBAL dengan prioritas visual
     TERTINGGI di App ini (lihat .maintenance-overlay di styles.css,
     z-index 20000 — lebih tinggi dari App Update/Welcome Popup/Gold Trial/
     toast/notification manapun) sehingga TIDAK PERNAH bisa tertutup atau
     bertabrakan dengan popup/notification lain — TANPA perlu mengubah
     notification/popup manager existing sama sekali.
     ══════════════════════════════════════════════════════════════════════════ */
  let _maintenanceActive = false; // dipakai gate download/install di bawah (handleInstall)
  let _maintenanceCache = null;

  async function fetchMaintenanceStatus() {
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(SERVER_URL + '/api/maintenance-status', {
        headers: token ? { Authorization: `Bearer ${token}` } : {}
      });
      if (!res.ok) return null;
      return await res.json();
    } catch (e) {
      return null;
    }
  }

  // Titik masuk utama — dipanggil paling awal dari titik masuk App (lihat
  // paling bawah file ini), bahkan SEBELUM checkAppUpdate()/tryAutoLogin(),
  // supaya kalau Maintenance aktif, overlay sudah terpasang duluan mengunci
  // layar sebelum user sempat interaksi apapun (termasuk sebelum login).
  // Juga dipanggil ulang dari enterApp() (dengan token akun yang baru login)
  // supaya status `bypass` (whitelist/role admin) dievaluasi ulang dengan
  // identitas user yang benar, dan dari onopen() connectRealtime() tiap
  // Socket.IO reconnect (lihat blok REALTIME) karena event WS bersifat
  // fire-and-forget dan bisa hilang selagi App disconnect.
  async function checkMaintenanceStatus() {
    const cfg = await fetchMaintenanceStatus();
    if (!cfg) return; // server/DB belum siap — jangan blokir app cuma karena network hiccup
    applyMaintenanceStatus(cfg);
  }

  function applyMaintenanceStatus(cfg) {
    if (!cfg) return;
    _maintenanceCache = cfg;
    _maintenanceActive = !!cfg.enabled && !cfg.bypass;
    if (_maintenanceActive) {
      renderMaintenanceOverlay(cfg);
    } else {
      hideMaintenanceOverlay();
    }
  }

  function escapeHtmlMnt(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }

  // Format waktu perkiraan selesai dari data existing (ISO datetime) —
  // TIDAK ada countdown palsu, murni tampilan waktu statis. Kalau tanggalnya
  // sama dengan hari ini cukup "HH:MM WIB", kalau beda hari ikut tanggalnya
  // juga supaya tidak ambigu.
  function formatMaintenanceEta(isoString) {
    if (!isoString) return null;
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return null;
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const timePart = d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jakarta' }) + ' WIB';
    if (sameDay) return timePart;
    const datePart = d.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', timeZone: 'Asia/Jakarta' });
    return `${datePart}, ${timePart}`;
  }

  function hideMaintenanceOverlay() {
    const el = document.getElementById('maintenanceOverlay');
    if (!el) return;
    el.style.display = 'none';
    el.innerHTML = '';
  }

  function renderMaintenanceOverlay(cfg) {
    const el = document.getElementById('maintenanceOverlay');
    if (!el) return;

    const title = escapeHtmlMnt(cfg.title || 'Sedang Maintenance');
    const description = cfg.description ? `<p class="mnt-msg">${escapeHtmlMnt(cfg.description)}</p>` : '';
    const message = cfg.message ? `<p class="mnt-msg">${escapeHtmlMnt(cfg.message)}</p>` : '';
    // Jangan hardcode: field estimasi cuma ditampilkan kalau data existing
    // (cfg.estimatedCompletion) memang tersedia — sama sekali tidak ada
    // countdown/waktu buatan sendiri di sini.
    const etaLabel = formatMaintenanceEta(cfg.estimatedCompletion);
    const etaHtml = etaLabel ? `
        <div class="mnt-divider"></div>
        <div class="mnt-eta">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
          <div class="mnt-eta-text">
            <div class="mnt-eta-label">Perkiraan selesai</div>
            <div class="mnt-eta-value">${escapeHtmlMnt(etaLabel)}</div>
          </div>
        </div>` : '';

    el.innerHTML = `
      <div class="mnt-card">
        <div class="mnt-icon-wrap">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>
        </div>
        <div class="mnt-eyebrow">31 Tools</div>
        <div class="mnt-title">${title}</div>
        ${description}
        ${message || (!description ? '<p class="mnt-msg">Kami sedang melakukan maintenance untuk meningkatkan performa dan kualitas layanan.</p>' : '')}
        ${etaHtml}
        <div class="mnt-footnote">Halaman ini akan otomatis tertutup begitu maintenance selesai.</div>
      </div>
    `;
    el.style.display = 'flex';
  }
  /* ══════════════════════════════════════════════════════════════════════════
     AKHIR MAINTENANCE MODE
     ══════════════════════════════════════════════════════════════════════════ */

  // Inisialisasi shell UI APP DEMO (Dashboard/Games/Bypass/Histori) — dulu
  // jalan otomatis begitu app.js dimuat. Sekarang dipanggil dari enterApp()
  // SETELAH login berhasil (lihat blok AUTH/LOGIN di atas), supaya app tetap
  // selalu mendarat di layar Login dulu seperti APP LAMA, bukan langsung ke
  // shell dengan data dummy.
  function initAppShellDemo() {
    document.querySelectorAll('.page').forEach(page=>{
      if(page.querySelector('.grid')) initGameListPage(page);
    });
    renderPackageBadges();
    renderStatusBadges();
    initHistoryPage();
    initCardClickToDetail();
    populateDashboardNewGames();
    initBeliPaketPage();
    initPackageAccessModal();
    initMktLockedModal();
    initTransaksiPage();
    initTutorialPage();
    initMarketplacePage();
    loadMarketplaceProducts();
    initSteamAccountPage();
    loadSteamAccounts();
    initBackgroundSettings();
  }

  // ── TITIK MASUK APP ──
  // Selalu mendarat di layar Login dulu (showLogin(), dipanggil lewat
  // tryAutoLogin()) — persis seperti APP LAMA. Shell APP DEMO di atas
  // (initAppShellDemo) baru dijalankan dari dalam enterApp() setelah login
  // sukses.
  //
  // FIX (App Customization background bug — Login tidak ikut berubah):
  // loadAppCustomization() DULU cuma dipanggil dari dalam enterApp(), yaitu
  // SETELAH login berhasil — jadi selama App masih di layar Login (termasuk
  // tiap kali App baru dibuka/reload/restart, karena App SELALU mendarat di
  // Login dulu), config App Customization tidak pernah di-fetch/di-terapkan
  // sama sekali. Dipanggil juga di sini, di titik paling awal, supaya
  // #appBgLayer (global, lihat index.html/styles.css) langsung memakai
  // config tersimpan (cache) begitu App dibuka lalu diganti config terbaru
  // dari server — SEBELUM login sekalipun. Panggilan yang sudah ada di
  // enterApp() TETAP dibiarkan (aman dipanggil 2x, cuma refetch ulang
  // begitu masuk App).
  loadAppCustomization();

  // AUTO DARK READING OVERLAY — `.page` sudah ada di DOM sejak awal (index.html),
  // jadi observer bisa dipasang dari titik masuk paling awal ini juga, sebelum
  // login sekalipun (tidak akan aktif sampai memang ada .page.active yang masuk
  // daftar READING_OVERLAY_PAGE_IDS).
  initReadingOverlay();

  // MAINTENANCE MODE — cek status PALING AWAL dari SEMUA titik masuk App
  // (bahkan sebelum checkAppUpdate()), supaya kalau Maintenance aktif,
  // overlay #maintenanceOverlay sudah mengunci layar duluan sebelum user
  // sempat interaksi apapun (termasuk sebelum login sekalipun) — lihat blok
  // "MAINTENANCE MODE" di atas. Tidak blocking kalau server/DB belum siap —
  // App tetap lanjut normal ke layar Login.
  checkMaintenanceStatus();

  // APP UPDATE — cek versi terbaru PALING AWAL, sebelum tryAutoLogin(),
  // supaya kalau Force Update aktif, overlay #appUpdateOverlay sudah
  // mengunci layar duluan sebelum user sempat interaksi apapun (lihat blok
  // "APP UPDATE" di atas). Tidak blocking kalau server/DB belum siap —
  // App tetap lanjut normal ke layar Login.
  checkAppUpdate();

  tryAutoLogin();