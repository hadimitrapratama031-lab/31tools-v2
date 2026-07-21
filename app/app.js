// ══════════════════════════════════════════════════════════════════════════
// NOVA LAUNCHER — RENDERER (app.js)
// ══════════════════════════════════════════════════════════════════════════
const SERVER_URL = 'https://31tools-v2-production.up.railway.app';
const WS_URL = SERVER_URL.replace(/^http/, 'ws') + '/ws';

// ── HELPER ──
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

  // Simpan token baru kalau server refresh otomatis (X-New-Token header)
  const newTokenFromHeader = res.headers.get('X-New-Token');
  if (newTokenFromHeader) localStorage.setItem('token', newTokenFromHeader);

  // Kalau masih 401 → coba refresh manual lalu retry
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

  // Simpan newToken dari body /api/me kalau ada
  if (data.newToken) localStorage.setItem('token', data.newToken);

  if (!res.ok) throw new Error(data.error || 'Terjadi kesalahan.');
  return data;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

function timeAgo(dateStr) {
  const diffSec = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (diffSec < 60) return 'Baru saja';
  if (diffSec < 3600) return Math.floor(diffSec / 60) + ' menit lalu';
  if (diffSec < 86400) return Math.floor(diffSec / 3600) + ' jam lalu';
  return Math.floor(diffSec / 86400) + ' hari lalu';
}

// ── TITLEBAR (minimize / fullscreen / close) ──
function wireTitlebar() {
  document.getElementById('btnMinimize')?.addEventListener('click', () => window.electronAPI?.minimize());
  document.getElementById('btnMaximize')?.addEventListener('click', () => window.electronAPI?.maximize());
  document.getElementById('btnClose')?.addEventListener('click', () => window.electronAPI?.close());
}

// ── AMBIL REFERENSI ELEMEN ──
const els = {};
function grabElements() {
  els.app          = document.querySelector('.app');
  els.profileImg   = document.querySelector('.sidebar .profile img');
  els.profileName  = document.querySelector('.sidebar .profile .name');
  els.profileRole  = document.querySelector('.sidebar .profile .role');
  els.navLinks     = Array.from(document.querySelectorAll('nav.menu a[data-page]'));
  els.gamesNavLink = document.querySelector('nav.menu a[data-page="games"]');
  els.bypassesNavLink = document.querySelector('nav.menu a[data-page="bypasses"]');
  els.logoutLink   = document.getElementById('navLogout');
  els.topbarH2     = document.querySelector('.topbar h2');
  els.searchInput  = document.querySelector('.search input');

  els.dashSaleGrid   = document.getElementById('dashSaleGrid');
  els.dashNewGrid    = document.getElementById('dashNewGrid');
  els.gamesOnlyGrid  = document.getElementById('gamesOnlyGrid');
  els.bypassesGrid   = document.getElementById('bypassesGrid');
  els.historiListPage = document.getElementById('historiListPage');
  els.historiStats    = document.getElementById('historiStats');
  els.gamesRoleFilter = document.getElementById('gamesRoleFilter');
  els.bypassesRoleFilter = document.getElementById('bypassesRoleFilter');
  els.dashCategoryFilters = document.getElementById('dashCategoryFilters');

  els.tutorialLatestGrid  = document.getElementById('tutorialLatestGrid');
  els.tutorialGrid        = document.getElementById('tutorialGrid');
  els.tutorialCategoryFilter = document.getElementById('tutorialCategoryFilter');
  els.tutorialSearchInput = document.getElementById('tutorialSearchInput');
  els.tutorialDetailCategory = document.getElementById('tutorialDetailCategory');
  els.tutorialDetailTitle   = document.getElementById('tutorialDetailTitle');
  els.tutorialDetailImageWrap = document.getElementById('tutorialDetailImageWrap');
  els.tutorialDetailImage   = document.getElementById('tutorialDetailImage');
  els.tutorialDetailContent = document.getElementById('tutorialDetailContent');
  els.tutorialDetailVideoWrap = document.getElementById('tutorialDetailVideoWrap');
  els.tutorialDetailVideo   = document.getElementById('tutorialDetailVideo');
  els.tutorialPrevBtn = document.getElementById('tutorialPrevBtn');
  els.tutorialNextBtn = document.getElementById('tutorialNextBtn');
  els.tutorialDetailBackBtn = document.getElementById('tutorialDetailBackBtn');
}

// ── FILTER KATEGORI DI DASHBOARD ("New Games") ──
// Kategori diambil dari /api/categories (data asli database, admin bisa
// tambah/hapus kategori dari Kelola Game). Filter kerja 100% di sisi client
// terhadap data `allGames` yang sudah ada di memori — TIDAK fetch ulang ke
// server tiap kali kategori diganti, jadi instan & tetap ringan walau jumlah
// game ada ratusan/ribuan.
let allCategories = [];
let activeDashCategoryFilter = 'all';

async function loadCategories() {
  try {
    allCategories = await api('/api/categories');
    renderDashCategoryFilters();
  } catch (e) {
    // Diam-diam gagal — tombol "All Games" tetap ada, filter kategori lain cuma gak nongol
  }
}

function renderDashCategoryFilters() {
  if (!els.dashCategoryFilters) return;
  const chips = [{ slug: 'all', name: 'All Games' }, ...allCategories.map(c => ({ slug: c.slug, name: c.name }))];
  els.dashCategoryFilters.innerHTML = chips.map(c => `
    <span data-category="${escapeHtml(c.slug)}" class="${c.slug === activeDashCategoryFilter ? 'active' : ''}">${escapeHtml(c.name)}</span>
  `).join('');
}

function applyDashCategoryFilter() {
  if (!els.dashNewGrid) return;
  const q = els.searchInput ? els.searchInput.value.trim().toLowerCase() : '';
  let filtered = q ? allGames.filter(g => g.name.toLowerCase().includes(q)) : allGames;
  if (activeDashCategoryFilter !== 'all') {
    filtered = filtered.filter(g => g.category === activeDashCategoryFilter);
  }
  renderDashGamesGrid(filtered);
}

// Render khusus grid "New Games" di Dashboard — beda dari renderGrid() biasa
// karena butuh animasi fade/slide halus tiap ganti kategori, dan empty state
// yang lebih ramah ("Belum ada game pada kategori ini.") dibanding pesan generik.
function renderDashGamesGrid(games) {
  if (!els.dashNewGrid) return;
  els.dashNewGrid.classList.remove('cards-fade-in');
  // Force reflow supaya animasi bisa di-retrigger tiap kali grid diisi ulang
  void els.dashNewGrid.offsetWidth;

  if (!games.length) {
    els.dashNewGrid.innerHTML = `
      <div class="dash-empty-placeholder">
        <div class="dash-empty-placeholder__icon">🎮</div>
        <div class="dash-empty-placeholder__title">Belum ada game pada kategori ini.</div>
        <div class="dash-empty-placeholder__text">Coba pilih kategori lain atau cek lagi nanti.</div>
      </div>`;
  } else {
    els.dashNewGrid.innerHTML = games.map((g, i) => renderGameCard(g, i)).join('');
    els.dashNewGrid.querySelectorAll('.game-card').forEach(card => {
      card.addEventListener('click', () => openDetailPage(games[+card.dataset.idx], 'game'));
    });
  }
  els.dashNewGrid.classList.add('cards-fade-in');
}

function wireDashCategoryFilter() {
  if (!els.dashCategoryFilters) return;
  els.dashCategoryFilters.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-category]');
    if (!chip) return;
    els.dashCategoryFilters.querySelectorAll('[data-category]').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    activeDashCategoryFilter = chip.dataset.category;
    applyDashCategoryFilter();
  });
}

// ── FILTER ROLE DI HALAMAN GAMES ──
let activeGamesRoleFilter = 'all';

function applyGamesRoleFilter() {
  const filtered = activeGamesRoleFilter === 'all'
    ? allGames
    : allGames.filter(g => g.role === activeGamesRoleFilter);
  renderGrid(els.gamesOnlyGrid, filtered);
}

function wireGamesRoleFilter() {
  if (!els.gamesRoleFilter) return;
  els.gamesRoleFilter.addEventListener('click', (e) => {
    const btn = e.target.closest('.role-filter-tab');
    if (!btn) return;
    els.gamesRoleFilter.querySelectorAll('.role-filter-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeGamesRoleFilter = btn.dataset.role;
    applyGamesRoleFilter();
  });
}

// ── FILTER ROLE DI HALAMAN BYPASS ──
let activeBypassesRoleFilter = 'all';

function applyBypassesRoleFilter() {
  const filtered = activeBypassesRoleFilter === 'all'
    ? allBypasses
    : allBypasses.filter(b => b.role === activeBypassesRoleFilter);
  renderBypassGrid(els.bypassesGrid, filtered);
}

function wireBypassesRoleFilter() {
  if (!els.bypassesRoleFilter) return;
  els.bypassesRoleFilter.addEventListener('click', (e) => {
    const btn = e.target.closest('.role-filter-tab');
    if (!btn) return;
    els.bypassesRoleFilter.querySelectorAll('.role-filter-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeBypassesRoleFilter = btn.dataset.role;
    applyBypassesRoleFilter();
  });
}

// ── NAVIGASI ANTAR HALAMAN ──
const PAGE_IDS = {
  dashboard: 'pageDashboard',
  games: 'pageGames',
  bypasses: 'pageBypasses',
  store: 'pageStore',
  histori: 'pageHistori',
  setting: 'pageSetting',
  gameDetail: 'pageGameDetail',
  tutorial: 'pageTutorial',
  tutorialDetail: 'pageTutorialDetail'
};

function showPage(pageName) {
  Object.values(PAGE_IDS).forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
  const target = document.getElementById(PAGE_IDS[pageName]);
  if (target) target.style.display = '';

  els.navLinks.forEach(a => a.classList.toggle('active', a.dataset.page === pageName));

  if (pageName === 'games') applyGamesRoleFilter();
  if (pageName === 'bypasses') applyBypassesRoleFilter();
  if (pageName === 'histori') { loadHistori(); }
  if (pageName === 'tutorial') applyTutorialFilter();
}

function wireNavigation() {
  els.navLinks.forEach(a => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      showPage(a.dataset.page);
    });
  });
  if (els.logoutLink) {
    els.logoutLink.addEventListener('click', (e) => {
      e.preventDefault();
      if (_autoRefreshTimer) clearInterval(_autoRefreshTimer);
      // Best-effort — catat event Logout ke audit trail (halaman Logs Admin Web).
      // Tidak menunggu response & tidak boleh menghambat proses logout kalau gagal.
      api('/api/logout', { method: 'POST' }).catch(() => {});
      localStorage.removeItem('token');
      localStorage.removeItem('_savedUser');
      location.reload();
    });
  }
}

// ── LOGIN OVERLAY (dibuat lewat JS, tema disamakan) ──
let loginStatusEl, pollTimer = null;

function showLogin(errorMsg = '') {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (!document.getElementById('nvLoginOverlay')) buildLoginOverlay();
  const overlay = document.getElementById('nvLoginOverlay');
  if (overlay) overlay.style.display = 'flex';
  if (els.app) els.app.style.display = 'none';
  if (errorMsg && loginStatusEl) {
    loginStatusEl.textContent = errorMsg;
    loginStatusEl.style.color = '#ff7eb3';
  }
}

function buildLoginOverlay() {
  const overlay = document.createElement('div');
  overlay.id = 'nvLoginOverlay';
  Object.assign(overlay.style, {
    position: 'fixed', inset: '0', zIndex: '9999',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'radial-gradient(circle at 15% 10%, #7a3fae 0%, transparent 45%),radial-gradient(circle at 90% 0%, #c4409a 0%, transparent 40%),radial-gradient(circle at 100% 100%, #4a2f8f 0%, transparent 45%),linear-gradient(135deg, #2b1c4e 0%, #3a2166 40%, #5c2a7a 70%, #7a3a8f 100%)',
    fontFamily: "'Manrope', sans-serif"
  });

  const card = document.createElement('div');
  Object.assign(card.style, {
    width: '360px', maxWidth: '90vw', padding: '38px 32px', textAlign: 'center',
    borderRadius: '22px', background: 'rgba(18,12,32,0.55)',
    border: '1px solid rgba(255,255,255,0.08)', backdropFilter: 'blur(30px)',
    boxShadow: '0 40px 80px rgba(10,5,25,0.45)'
  });

  // Cek apakah ada sesi tersimpan
  const savedToken  = localStorage.getItem('token');
  const savedUser   = _getSavedUser();
  const isReturning = !!(savedToken && savedUser);

  if (isReturning) {
    // ── RETURNING USER — tombol masuk langsung tanpa Discord ──
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
        ⚡ Masuk Sekarang
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

    // Tombol masuk langsung
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
          btn.innerHTML = '⚡ Masuk Sekarang';
          localStorage.removeItem('token');
          localStorage.removeItem('_savedUser');
          overlay.remove();
          _installModalEl = null;
          buildLoginOverlay();
          showLogin(deviceCheck.message);
          return;
        }

        hideLogin();
        enterApp(user);
      } catch (e) {
        btn.disabled = false;
        btn.innerHTML = '⚡ Masuk Sekarang';
        // Bedakan error jaringan (server offline/tidak bisa dihubungi) dari token yang
        // BENAR-BENAR tidak valid. Kalau cuma masalah jaringan, jangan hapus sesi —
        // biarkan user coba lagi begitu koneksi/server sudah normal.
        const isNetworkError = /fetch|network/i.test(e.message || '');
        if (isNetworkError) {
          if (loginStatusEl) {
            loginStatusEl.textContent = 'Server tidak bisa dihubungi. Cek koneksi internet lalu coba lagi.';
            loginStatusEl.style.color = '#ff7eb3';
          }
          return;
        }
        // Token benar-benar tidak valid/akun tidak ditemukan → wajib login Discord ulang
        localStorage.removeItem('token');
        localStorage.removeItem('_savedUser');
        overlay.remove();
        _installModalEl = null;
        buildLoginOverlay();
        showLogin('Sesi kamu sudah berakhir, login ulang dengan Discord.');
      }
    });

    // Tombol ganti akun
    card.querySelector('#nvBtnSwitchAccount').addEventListener('click', () => {
      localStorage.removeItem('token');
      localStorage.removeItem('_savedUser');
      overlay.remove();
      buildLoginOverlay();
    });

  } else {
    // ── FRESH LOGIN — tombol Discord ──
    card.innerHTML = `
      <div style="font-size:42px;margin-bottom:10px;">🎮</div>
      <h2 id="nvLoginAppName" style="font-family:'Poppins',sans-serif;color:#f3eefc;margin:0 0 8px;font-size:20px;">31 Tools</h2>
      <p style="color:#b6a9d1;font-size:13px;line-height:1.6;margin:0 0 24px;">
        Login pakai Discord untuk masuk. Akun kamu akan otomatis terdeteksi
        setelah verifikasi berhasil.
      </p>
      <button id="nvBtnLoginDiscord" style="width:100%;border:none;padding:13px;border-radius:12px;
        background:linear-gradient(90deg,#5865F2,#7c5cff);color:#fff;font-weight:700;font-size:14px;
        cursor:pointer;box-shadow:0 10px 25px rgba(92,102,255,0.4);display:flex;align-items:center;
        justify-content:center;gap:8px;">
        💬 Login dengan Discord
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

// Simpan & ambil data user dari localStorage supaya nama+avatar bisa ditampilkan di login
function _getSavedUser() {
  try { return JSON.parse(localStorage.getItem('_savedUser') || 'null'); } catch(e) { return null; }
}
function _saveUser(user) {
  try { localStorage.setItem('_savedUser', JSON.stringify({ username: user.username, avatarUrl: user.avatarUrl, role: user.role })); } catch(e) {}
}

function hideLogin() {
  const overlay = document.getElementById('nvLoginOverlay');
  if (overlay) overlay.style.display = 'none';
  if (els.app) els.app.style.display = '';
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

// ── DEVICE LOCK — dipanggil SEKALI tiap sesi login (baru atau "Masuk Sekarang"),
// SEBELUM masuk dashboard. Kumpulkan info hardware lewat main process (IPC), lalu
// minta server cocokkan dengan perangkat yang terikat ke akun ini. Kalau server
// tidak bisa dihubungi sama sekali (jaringan), fail-open (jangan blokir user gara-gara
// koneksi) — tapi kalau server BALIKIN penolakan eksplisit (403 device beda), blokir.
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

function startLogin() {
  const deviceId = getOrCreateDeviceId();
  const openExternal = window.electronAPI?.openExternal || (url => window.open(url, '_blank'));
  openExternal(`${SERVER_URL}/auth/discord?state=${encodeURIComponent(deviceId)}`);

  const discordBtn = document.getElementById('nvBtnLoginDiscord');
  if (discordBtn) { discordBtn.disabled = true; discordBtn.innerHTML = '⏳ Menunggu login di browser...'; }

  if (loginStatusEl) {
    loginStatusEl.innerHTML = 'Selesaikan login di jendela browser yang baru terbuka. <a href="#" id="nvCancelLogin" style="color:#a78bfa;text-decoration:underline;">Batal</a>';
    loginStatusEl.style.color = '#8f8ab0';
    const cancelLink = loginStatusEl.querySelector('#nvCancelLogin');
    if (cancelLink) cancelLink.addEventListener('click', (e) => { e.preventDefault(); resetLoginButton('Dibatalkan. Silakan coba lagi.'); });
  }

  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }

  // Timeout — kalau setelah 5 menit belum juga berhasil (misal tab browser
  // ditutup tanpa menyelesaikan login, atau lupa/gagal join Discord), berhenti
  // polling dan kembalikan tombol ke keadaan semula supaya user bisa coba lagi,
  // daripada polling diam-diam tanpa batas waktu selamanya.
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

// Kembalikan tombol "Login dengan Discord" ke keadaan semula (dipakai saat dibatalkan/timeout)
function resetLoginButton(message) {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  const discordBtn = document.getElementById('nvBtnLoginDiscord');
  if (discordBtn) { discordBtn.disabled = false; discordBtn.innerHTML = '💬 Login dengan Discord'; }
  if (loginStatusEl) {
    loginStatusEl.textContent = message || '';
    loginStatusEl.style.color = '#ff7eb3';
  }
}

async function tryAutoLogin() {
  // PENTING: jangan pernah auto-masuk ke dashboard di sini. App harus SELALU mendarat
  // di halaman login dulu setiap kali dibuka (termasuk setelah ditutup lalu dibuka lagi).
  // Kalau ada sesi tersimpan (token + _savedUser di localStorage), buildLoginOverlay()
  // akan otomatis menampilkan cabang "Selamat datang kembali" dengan tombol
  // "⚡ Masuk Sekarang" — user tinggal 1x klik TANPA perlu login Discord ulang.
  // Verifikasi token yang sebenarnya (valid/expired/akun masih ada) baru dilakukan
  // server-side saat tombol itu ditekan (lewat /api/me), bukan otomatis di sini.
  showLogin();
}

// ── MASUK APP ──
let currentUser = null;
let allGames = [];
let allBypasses = [];

function enterApp(user) {
  currentUser = user;
  _saveUser(user); // simpan untuk halaman "Selamat datang kembali"

  if (els.profileImg) els.profileImg.src = user.avatarUrl;
  if (els.profileName) els.profileName.textContent = user.username;
  if (els.profileRole) els.profileRole.textContent = user.role;

  if (els.topbarH2) els.topbarH2.textContent = `Have a good time ${user.username}!`;

  renderPackageCard(user);
  connectRealtime();
  loadNotifications();

  showPage('dashboard'); // halaman utama selalu yang pertama muncul
  loadCategories();
  loadGames();
  loadBypasses();
  loadBanners();
  loadLeaderboard();
  loadTutorials();
  flushPendingHistory().catch(() => {}); // coba kirim ulang histori yang sempat gagal tersimpan sesi sebelumnya
  startAutoRefresh(); // ← polling berkala supaya game/bypass baru dari admin langsung muncul
  checkPendingPremiumCleanups(); // ← "kalau app tidak dibuka, pengecekan dilakukan saat app dibuka kembali"
}

// ── AUTO REFRESH — supaya game/bypass yang baru ditambahkan admin langsung
// muncul di app TANPA perlu restart. Poll setiap 15 detik + refresh instan
// begitu window app di-fokus lagi (misal user habis buka admin panel lalu balik).
let _autoRefreshTimer  = null;
let _roleCheckTimer    = null; // polling cepat KHUSUS untuk deteksi perubahan role

function startAutoRefresh() {
  if (_autoRefreshTimer) clearInterval(_autoRefreshTimer);
  if (_roleCheckTimer)   clearInterval(_roleCheckTimer);

  // Poll ringan setiap 3 detik KHUSUS untuk cek role — endpoint /api/me/role-check
  // hanya return { role, roleUpdatedAt } sehingga overhead-nya sangat kecil.
  // Kalau terdeteksi berubah, baru load ulang data lengkap via /api/me.
  _roleCheckTimer = setInterval(async () => {
    if (!currentUser) return;
    await _checkRoleRealtime();
  }, 3000);

  // Poll konten (games/bypasses) tiap 15 detik — tidak perlu secepat role check
  _autoRefreshTimer = setInterval(async () => {
    if (!currentUser) return;
    await loadGames();
    await loadBypasses();
    applySearchAndFilters();
  }, 15000);

  // Refresh instan begitu app kembali difokuskan (alt-tab balik ke app)
  window.addEventListener('focus', async () => {
    if (!currentUser) return;
    await _checkRoleRealtime();
    await loadGames();
    await loadBypasses();
    applySearchAndFilters();
  });
}

// ── Polling cepat role: pakai /api/me/role-check (ringan), baru hit /api/me lengkap
// kalau terdeteksi role ATAU roleUpdatedAt berubah.
let _lastKnownRoleUpdatedAt = null;
async function _checkRoleRealtime() {
  try {
    const check = await api('/api/me/role-check');
    const updatedAtChanged = check.roleUpdatedAt && check.roleUpdatedAt !== _lastKnownRoleUpdatedAt;
    const roleChanged = check.role && currentUser && check.role !== currentUser.role;

    if (!roleChanged && !updatedAtChanged) return; // tidak ada perubahan, selesai

    _lastKnownRoleUpdatedAt = check.roleUpdatedAt;
    await refreshCurrentUserRole(); // load data lengkap + tampilkan toast
  } catch (e) {} // jangan ganggu app kalau network sesaat terganggu
}

// ── Cek apakah role user berubah (misal admin "set paket" baru, atau role
// Discord user disinkron otomatis ke app) → update tampilan + kasih toast.
// Dipanggil berkala dari startAutoRefresh(), BUKAN endpoint baru — cukup numpang
// lewat /api/me yang memang sudah dipanggil tiap login, sekarang dipanggil ulang
// secara berkala juga supaya perubahan dari luar (admin panel / Discord) kelihatan
// tanpa user perlu logout-login manual.
async function refreshCurrentUserRole() {
  try {
    const fresh = await api('/api/me');
    if (!currentUser || !fresh || fresh.role === currentUser.role) {
      if (fresh) currentUser = { ...currentUser, ...fresh };
      return;
    }

    const oldRole = currentUser.role;
    currentUser = { ...currentUser, ...fresh };
    _saveUser(currentUser);

    if (els.profileRole) els.profileRole.textContent = currentUser.role;
    showRoleUpdateToast(oldRole, currentUser.role);

    // Role berubah bisa berarti akses ke game/bypass tertentu ikut berubah (naik/turun paket)
    await loadGames();
    await loadBypasses();
    applySearchAndFilters();
  } catch (e) {} // jangan ganggu app kalau cuma gagal cek role sekali (misal lagi no-internet sebentar)
}

const ROLE_BADGE_ICON = { public: '🌐', gold: '🥇', platinum: '💎', admin: '👑' };
function roleBadgeHtml(role) {
  const icon = ROLE_BADGE_ICON[role] || '🌐';
  return `<span class="role-pill ${role}"><span class="rp-icon">${icon}</span>${escapeHtml(role)}</span>`;
}

// Badge Online/Offline di pojok kanan-atas kartu game/bypass — dari field isOnline
// yang diatur admin (default online kalau field-nya belum pernah di-set sama sekali).
function onlineBadgeHtml(isOnline) {
  const online = isOnline !== false;
  return `<span class="online-pill ${online ? 'online' : 'offline'}">
    <span class="op-dot"></span>${online ? 'Online Mode' : 'Offline Mode'}
  </span>`;
}

// ── Cek apakah role user cukup buat akses item ini ──
const CLIENT_ROLE_LEVEL = { public: 0, gold: 1, platinum: 2, admin: 3 };
function hasAccess(itemRole) {
  const myLevel   = CLIENT_ROLE_LEVEL[currentUser?.role] ?? 0;
  const itemLevel = CLIENT_ROLE_LEVEL[itemRole] ?? 0;
  return myLevel >= itemLevel;
}

// ── Cari Bypass yang berkaitan dengan Game ini (buat tombol "Install Bypass" kedua) ──
// Prioritas: bypass yang gameId-nya cocok (dibuat via "Sekalian jadi Bypass" di admin),
// fallback: bypass yang App ID Steam-nya sama persis dengan game ini.
function findLinkedBypass(gameItem) {
  const gid = String(gameItem._id);
  let match = allBypasses.find(b => b.gameId && String(b.gameId) === gid);
  if (!match && gameItem.appId) {
    match = allBypasses.find(b => b.appId && String(b.appId) === String(gameItem.appId));
  }
  return match || null;
}

// ── HALAMAN DETAIL GAME/BYPASS ──
// Dibuka saat kartu game/bypass diklik. Data dasar (nama, role, deskripsi, cover)
// langsung ditampilkan dari data yang sudah ada, lalu detail LENGKAP & ASLI
// (release date, metacritic, developer, publisher, tag, system requirements)
// di-fetch dari Steam Store API (lewat proxy server) berdasarkan App ID game itu —
// BUKAN data fiksi/hardcode.
let _prevPageBeforeDetail = 'dashboard';
let _detailFetchToken = 0; // biar response fetch yang telat/kebalap gak nimpa detail yang lagi dibuka

function openDetailPage(item, itemType) {
  const activeLink = els.navLinks.find(a => a.classList.contains('active'));
  _prevPageBeforeDetail = activeLink ? activeLink.dataset.page : 'dashboard';
  const myFetchToken = ++_detailFetchToken;

  const locked = !hasAccess(item.role);

  // ── Isi cepat pakai data yang sudah ada (tanpa nunggu network) ──
  const coverEl = document.getElementById('detailCover');
  if (item.imageUrl) {
    coverEl.style.backgroundImage = `url('${item.imageUrl}')`;
    coverEl.className = 'detail-cover';
  } else {
    coverEl.style.backgroundImage = '';
    coverEl.className = 'detail-cover ' + artClassForId(item._id || item.name || '');
  }

  document.getElementById('detailTitle').textContent = item.name || '—';
  document.getElementById('detailDescription').textContent =
    item.description?.trim() || 'Memuat deskripsi dari Steam...';

  const steamIdRow = document.getElementById('detailSteamId');
  if (item.appId) {
    steamIdRow.style.display = 'block';
    document.getElementById('detailSteamIdVal').textContent = item.appId;
  } else {
    steamIdRow.style.display = 'none';
  }

  // Info grid — skeleton dulu sambil nunggu data Steam asli
  const setInfoBox = (id, val, isSkel) => {
    const el = document.getElementById(id);
    el.textContent = val;
    el.classList.toggle('detail-skel', !!isSkel);
  };
  const hasAppId = !!item.appId;
  setInfoBox('dibRelease', hasAppId ? '' : '—', hasAppId);
  setInfoBox('dibMetacritic', hasAppId ? '' : '—', hasAppId);
  setInfoBox('dibDeveloper', hasAppId ? '' : '—', hasAppId);
  setInfoBox('dibPublisher', hasAppId ? '' : '—', hasAppId);

  document.getElementById('detailTags').innerHTML =
    `<span class="detail-tag plain">${itemType === 'game' ? '🎮 Game' : '🛡️ Bypass'}</span>` +
    (item.sizeLabel ? `<span class="detail-tag plain">💾 ${escapeHtml(item.sizeLabel)}</span>` : '');

  renderOnlineBanner(item, itemType);

  document.getElementById('detailReqsWrap').style.display = 'none';

  const installBtn = document.getElementById('detailInstallBtn');
  if (locked) {
    installBtn.disabled  = true;
    installBtn.className = 'detail-install-btn locked';
    installBtn.textContent = `🔒 Butuh paket ${item.role} — Upgrade dulu`;
    installBtn.onclick = null;
  } else {
    installBtn.disabled  = false;
    installBtn.className = 'detail-install-btn';
    installBtn.textContent = itemType === 'game' ? '⚡ Install Game' : '🛡️ Aktifkan Bypass';
    installBtn.onclick = () => handleInstall(itemType, item._id, item.name);
  }

  // ── Tombol "Install Bypass" kedua — cuma muncul di halaman detail GAME,
  // dan cuma kalau memang ada Bypass yang terhubung ke game ini ──
  const bypassBtn = document.getElementById('detailInstallBypassBtn');
  const linkedBypass = itemType === 'game' ? findLinkedBypass(item) : null;
  if (linkedBypass) {
    bypassBtn.style.display = '';
    const bypassLocked = !hasAccess(linkedBypass.role);
    if (bypassLocked) {
      bypassBtn.disabled  = true;
      bypassBtn.className = 'detail-install-bypass-btn locked';
      bypassBtn.textContent = `🔒 Bypass butuh paket ${linkedBypass.role}`;
      bypassBtn.onclick = null;
    } else {
      bypassBtn.disabled  = false;
      bypassBtn.className = 'detail-install-bypass-btn';
      bypassBtn.textContent = '🛡️ Install Bypass';
      bypassBtn.onclick = () => handleInstall('bypass', linkedBypass._id, linkedBypass.name);
    }
  } else {
    bypassBtn.style.display = 'none';
  }

  showPage('gameDetail');
  const mainEl = document.querySelector('.main');
  if (mainEl) mainEl.scrollTop = 0;

  // ── Ambil detail ASLI dari Steam (App ID) lewat server, lalu lengkapi tampilan ──
  if (item.appId) {
    const endpoint = itemType === 'game' ? `/api/games/${item._id}/steam-details` : `/api/bypasses/${item._id}/steam-details`;
    api(endpoint)
      .then(d => {
        if (myFetchToken !== _detailFetchToken) return; // user udah pindah ke item lain, buang hasil ini
        applySteamDetails(d, item, itemType);
      })
      .catch(() => {
        if (myFetchToken !== _detailFetchToken) return;
        setInfoBox('dibRelease', '—', false);
        setInfoBox('dibMetacritic', '—', false);
        setInfoBox('dibDeveloper', '—', false);
        setInfoBox('dibPublisher', '—', false);
      });
  }
}
window.openDetailPage = openDetailPage;

// ── Banner "Online Multiplayer" / "Single Player" di halaman detail ──
// Beberapa varian teks online biar gak monoton kalau dibuka bolak-balik — dipilih
// konsisten per item (pakai hash nama/ID-nya), bukan acak tiap render.
const ONLINE_BANNER_COPIES = [
  {
    title: '🌐 Bisa Dimainkan Online Multiplayer',
    text: 'Game ini mendukung mode online — ajak teman satu squad atau ketemu pemain baru dari seluruh dunia, dan rasakan serunya main bareng secara real-time, bukan cuma sendirian.'
  },
  {
    title: '🌐 Online Multiplayer Ready',
    text: 'Nggak cuma seru dimainkan sendiri — game ini siap dimainkan online bareng teman. Gaskeun mabar, koordinasi strategi, dan taklukkan tantangannya bareng-bareng.'
  },
  {
    title: '🌐 Mendukung Mode Online',
    text: 'Koneksikan diri kamu ke server online dan mainkan bareng pemain lain kapan saja. Cocok buat kamu yang suka kompetisi seru atau kerja sama tim secara real-time.'
  }
];
const OFFLINE_BANNER_COPY = {
  title: '📴 Single Player / Offline',
  text: 'Game ini didesain untuk dimainkan sendirian tanpa perlu koneksi online — cocok buat kamu yang mau fokus menikmati cerita dan gameplay-nya dengan tenang, kapan saja.'
};

function renderOnlineBanner(item, itemType) {
  const banner = document.getElementById('detailOnlineBanner');
  if (!banner) return;
  const isOnline = item.isOnline !== false;

  banner.style.display = 'flex';
  banner.className = 'detail-online-banner ' + (isOnline ? 'is-online' : 'is-offline');

  let copy;
  if (isOnline) {
    let hash = 0;
    const seed = String(item._id || item.name || '');
    for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
    copy = ONLINE_BANNER_COPIES[hash % ONLINE_BANNER_COPIES.length];
  } else {
    copy = OFFLINE_BANNER_COPY;
  }

  document.getElementById('detailOnlineBannerIcon').textContent = isOnline ? '🌐' : '📴';
  document.getElementById('detailOnlineBannerTitle').textContent = copy.title;
  document.getElementById('detailOnlineBannerText').textContent = copy.text;
}

function applySteamDetails(d, item, itemType) {
  if (d.headerImage) {
    const coverEl = document.getElementById('detailCover');
    coverEl.style.backgroundImage = `url('${d.headerImage}')`;
    coverEl.className = 'detail-cover';
  }

  if (d.shortDescription) document.getElementById('detailDescription').textContent = d.shortDescription;

  const setInfoBox = (id, val) => {
    const el = document.getElementById(id);
    el.textContent = val;
    el.classList.remove('detail-skel');
  };
  setInfoBox('dibRelease', d.releaseDate || (d.comingSoon ? 'Coming Soon' : 'Tidak diketahui'));
  setInfoBox('dibMetacritic', d.metacritic != null ? `${d.metacritic} (Meta)` : 'Tidak ada skor');
  setInfoBox('dibDeveloper', d.developers?.length ? d.developers.join(', ') : 'Tidak diketahui');
  setInfoBox('dibPublisher', d.publishers?.length ? d.publishers.join(', ') : 'Tidak diketahui');

  const tagsHtml = [
    `<span class="detail-tag plain">${itemType === 'bypass' ? '🛡️ Bypass' : '🎮 Game'}</span>`,
    ...(d.categories || []).map(c => `<span class="detail-tag">${escapeHtml(c)}</span>`),
    ...(d.genres || []).map(g => `<span class="detail-tag plain">${escapeHtml(g)}</span>`)
  ].join('');
  document.getElementById('detailTags').innerHTML = tagsHtml;

  const reqsWrap = document.getElementById('detailReqsWrap');
  const hasReqs = (d.requirementsMin?.length || d.requirementsRec?.length);
  if (hasReqs) {
    reqsWrap.style.display = 'block';
    const renderReqs = list => list.map(r =>
      `<div class="drb-row">${r.label ? `<b>${escapeHtml(r.label)}:</b> ` : ''}${escapeHtml(r.value)}</div>`
    ).join('') || '<div class="drb-row">Tidak ada data.</div>';
    document.getElementById('detailReqsMin').innerHTML = renderReqs(d.requirementsMin || []);
    document.getElementById('detailReqsRec').innerHTML = renderReqs(d.requirementsRec || []);
  } else {
    reqsWrap.style.display = 'none';
  }
}

function artClassForId(seed) {
  const classes = ['a', 'b', 'c', 'd', 'e', 'f'];
  let hash = 0;
  for (let i = 0; i < String(seed).length; i++) hash = (hash * 31 + String(seed).charCodeAt(i)) >>> 0;
  return classes[hash % classes.length];
}

function wireDetailPage() {
  const backBtn = document.getElementById('detailBackBtn');
  if (backBtn) backBtn.addEventListener('click', () => showPage(_prevPageBeforeDetail));
}

// ── RENDER KARTU GAME ──
function renderGameCard(item, idx) {
  const art = item.imageUrl
    ? `background-image:url('${item.imageUrl}');background-size:cover;background-position:center;`
    : '';
  const locked = !hasAccess(item.role);
  return `
    <div class="game-card${locked ? ' locked' : ''}" data-idx="${idx}">
      <div class="game-art${item.imageUrl ? '' : ' ' + artClassForId(item._id || item.name)}" style="${art}">
        <div class="badge-slot">${roleBadgeHtml(item.role)}</div>
        <div class="online-badge-slot">${onlineBadgeHtml(item.isOnline)}</div>
        ${locked ? `<div class="lock-overlay">🔒</div>` : ''}
      </div>
      <div class="game-info">
        <h4 title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</h4>
        <div class="game-meta">
          <span class="game-meta-hint">${locked ? '🔒 Terkunci' : 'Lihat Detail'}</span>
          <span class="game-meta-arrow">›</span>
        </div>
      </div>
    </div>`;
}

function renderGrid(container, games) {
  if (!container) return;
  container.innerHTML = games.length
    ? games.map((g, i) => renderGameCard(g, i)).join('')
    : `<div style="color:#8577a3;font-size:13px;padding:10px 4px;">Belum ada game.</div>`;
  container.querySelectorAll('.game-card').forEach(card => {
    card.addEventListener('click', () => openDetailPage(games[+card.dataset.idx], 'game'));
  });
}

// ── RENDER KARTU BYPASS ──
function renderBypassCard(item, idx) {
  const art = item.imageUrl
    ? `background-image:url('${item.imageUrl}');background-size:cover;background-position:center;`
    : '';
  const locked = !hasAccess(item.role);
  return `
    <div class="game-card${locked ? ' locked' : ''}" data-idx="${idx}">
      <div class="game-art${item.imageUrl ? '' : ' ' + artClassForId(item._id || item.name)}" style="${art}">
        <div class="badge-slot">${roleBadgeHtml(item.role)}</div>
        <div class="online-badge-slot">${onlineBadgeHtml(item.isOnline)}</div>
        ${locked ? `<div class="lock-overlay">🔒</div>` : ''}
      </div>
      <div class="game-info">
        <h4 title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</h4>
        <div class="game-meta">
          <span class="game-meta-hint">${locked ? '🔒 Terkunci' : 'Lihat Detail'}</span>
          <span class="game-meta-arrow">›</span>
        </div>
      </div>
    </div>`;
}

function renderBypassGrid(container, bypasses) {
  if (!container) return;
  container.innerHTML = bypasses.length
    ? bypasses.map((b, i) => renderBypassCard(b, i)).join('')
    : `<div style="color:#8577a3;font-size:13px;padding:10px 4px;">Belum ada bypass.</div>`;
  container.querySelectorAll('.game-card').forEach(card => {
    card.addEventListener('click', () => openDetailPage(bypasses[+card.dataset.idx], 'bypass'));
  });
}

async function loadBypasses() {
  try {
    const bypasses = await api('/api/bypasses'); // list bypass 100% ikut role & isi database server
    allBypasses = bypasses;

    if (els.bypassesNavLink) {
      const badge = els.bypassesNavLink.querySelector('.badge');
      if (badge) badge.textContent = bypasses.length;
    }

    // Kalau lagi buka halaman Bypass, refresh juga isinya (tetap ikut filter role yang lagi aktif)
    // Selalu apply filter supaya bypassesGrid terisi sejak awal
    applyBypassesRoleFilter();
  } catch (e) {
    const msg = `<div style="color:#ff6b81;font-size:13px;">Gagal memuat bypass: ${escapeHtml(e.message)}</div>`;
    if (els.bypassesGrid) els.bypassesGrid.innerHTML = msg;
  }
}

async function loadGames() {
  try {
    const games = await api('/api/games'); // list game 100% ikut role & isi database server
    allGames = games;

    if (els.gamesNavLink) {
      const badge = els.gamesNavLink.querySelector('.badge');
      if (badge) badge.textContent = games.length;
    }

    // Render ke dashboard grid — ikut filter kategori & search yang lagi aktif
    applyDashCategoryFilter();
    // "Games On Sale" itu fitur beda yang belum ada datanya sendiri — sebelumnya
    // cuma nampilin game yang sama (dibalik urutannya) jadi keliatan dobel sama
    // New Games. Untuk sekarang dikosongin dulu + kasih placeholder, biar gak
    // menyesatkan sampai fitur diskon/sale-nya beneran dibikin.
    if (els.dashSaleGrid) {
      els.dashSaleGrid.innerHTML = `
        <div class="dash-empty-placeholder">
          <div class="dash-empty-placeholder__icon">🏷️</div>
          <div class="dash-empty-placeholder__title">Segera Hadir</div>
          <div class="dash-empty-placeholder__text">Fitur diskon game belum tersedia.</div>
        </div>`;
    }

    // Selalu render ke gamesOnlyGrid juga (bukan cuma cek display) supaya
    // grid sudah terisi walau user belum pernah buka halaman Games
    applyGamesRoleFilter();

  } catch (e) {
    const msg = `<div style="color:#ff6b81;font-size:13px;">Gagal memuat game: ${escapeHtml(e.message)}</div>`;
    if (els.dashNewGrid) els.dashNewGrid.innerHTML = msg;
    if (els.gamesOnlyGrid) els.gamesOnlyGrid.innerHTML = msg;
  }
}

// ══════════════════════════════════════════════════════════════════════════
// BANNER CAROUSEL — halaman utama. Data 100% dari /api/banners (dikelola dari
// Admin Web), auto-slide, next/prev, dot indicator, update realtime lewat
// WebSocket ('banners:update') tanpa perlu reload app sama sekali.
// ══════════════════════════════════════════════════════════════════════════
let bannerSlides = [];
let bannerIndex = 0;
let bannerAutoTimer = null;
const BANNER_AUTO_MS = 6000; // auto-slide tiap 6 detik (dalam rentang 5-7 detik yang diminta)
const BANNER_CODE_LOAD_TIMEOUT_MS = 5000; // kalau Code Banner ga kirim tanda "siap" dalam 5 detik -> fallback

async function loadBanners() {
  try {
    const banners = await api('/api/banners');
    renderBannerCarousel(banners);
  } catch (e) {
    renderBannerCarousel([]); // gagal load → tampilkan empty state, bukan data palsu
  }
}

// Bikin dokumen HTML lengkap buat di-taruh di `srcdoc` iframe sandbox milik
// Code Banner. SATU-SATUNYA tempat HTML/CSS/JS banner custom dijalankan —
// iframe-nya pakai sandbox="allow-scripts" TANPA "allow-same-origin", jadi
// origin iframe ini SELALU opaque/unik: dia tidak akan pernah bisa membaca
// atau menyentuh window/localStorage/cookie/token app utama sama sekali,
// walau JS di dalamnya mencoba. Itu proteksi utamanya — bukan sanitasi teks.
//
// PENTING kalau diubah: fungsi identik ada juga di public/admin.js (dipakai
// buat Live Preview di editor) — keduanya sengaja disamakan persis supaya
// preview di Admin Web = tampilan asli di App. Ubah dua-duanya sekaligus.
function buildBannerSandboxDoc({ html, css, js }) {
  // Cegah `</script` mentah di dalam kode JS custom motong tag <script> pembungkus
  // lebih awal (trik XSS klasik) — aman diubah jadi `<\/script` karena di JS itu
  // tetap berarti karakter yang sama persis saat dieksekusi.
  const escJs = (js || '').replace(/<\/script/gi, '<\\/script');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:transparent;
font-family:'Poppins','Sora',sans-serif;color:#fff;box-sizing:border-box;}
*{box-sizing:border-box;}
${css || ''}
</style></head><body>
${html || ''}
<script>
(function(){
  function reportError(){ try { parent.postMessage({ __banner: 'error' }, '*'); } catch(_) {} }
  window.addEventListener('error', reportError);
  window.addEventListener('unhandledrejection', reportError);
  try {
    ${escJs}
  } catch (e) { reportError(); }
  try { parent.postMessage({ __banner: 'ready' }, '*'); } catch(_) {}
})();
<\/script>
</body></html>`;
}

// Dengar sinyal 'ready'/'error' dari iframe Code Banner manapun yang lagi
// nampil, lalu terapkan fallback (gradient + judul/deskripsi biasa, TANPA
// bikin app crash) kalau kode-nya error atau ga pernah kirim sinyal apa-apa.
window.addEventListener('message', (e) => {
  const data = e.data;
  if (!data || typeof data !== 'object' || !('__banner' in data)) return;
  const frame = [...document.querySelectorAll('#hcTrack .hc-code-frame')].find(f => f.contentWindow === e.source);
  if (!frame) return;
  const idx = Number(frame.dataset.idx);
  if (data.__banner === 'error') applyBannerFallback(idx);
  else if (data.__banner === 'ready') clearTimeout(frame._loadTimeout);
});

function applyBannerFallback(idx) {
  const slide = document.querySelector(`#hcTrack .hc-slide[data-idx="${idx}"]`);
  const b = bannerSlides[idx];
  if (!slide || !b || slide.dataset.fallbackApplied) return;
  slide.dataset.fallbackApplied = '1';
  slide.style.background = `linear-gradient(135deg, ${escapeHtml(b.gradientFrom || '#7b5cff')}, ${escapeHtml(b.gradientTo || '#241a3d')})`;
  slide.innerHTML = `
    <div class="hc-body">
      <span class="hc-icon">⚠️</span>
      <h1 class="hc-title">${escapeHtml(b.title || 'Banner')}</h1>
      ${b.description ? `<p class="hc-desc">${escapeHtml(b.description)}</p>` : ''}
    </div>`;
}

function renderBannerCarousel(banners) {
  const track = document.getElementById('hcTrack');
  const dotsWrap = document.getElementById('hcDots');
  if (!track || !dotsWrap) return;

  bannerSlides = Array.isArray(banners) ? banners : [];
  clearInterval(bannerAutoTimer);

  if (bannerSlides.length === 0) {
    track.innerHTML = `
      <div class="hc-slide hc-empty active">
        <div class="hc-body" style="max-width:100%;text-align:center;">
          <div class="hc-icon">🗂️</div>
          <div class="hc-title" style="font-size:18px;">Belum ada banner</div>
          <div class="hc-desc" style="margin:0 auto;">Admin belum menambahkan banner promosi.</div>
        </div>
      </div>`;
    dotsWrap.innerHTML = '';
    return;
  }

  track.innerHTML = bannerSlides.map((b, i) => {
    if (b.bannerType === 'code' && b.codeHtml) {
      // Placeholder dulu — srcdoc di-set lewat property JS di bawah (bukan
      // ditulis sebagai atribut string) biar ga perlu mikirin escaping quote
      // yang ribet & rawan salah dalam template string.
      return `<div class="hc-slide${i === 0 ? ' active' : ''} hc-code-slide" data-idx="${i}">
        <iframe class="hc-code-frame" data-idx="${i}" sandbox="allow-scripts" loading="lazy"></iframe>
      </div>`;
    }
    const bgImage = b.imageData || b.imageUrl || null;
    const bgStyle = bgImage
      ? `background-image:linear-gradient(90deg, rgba(10,6,16,.82) 0%, rgba(10,6,16,.42) 55%, rgba(10,6,16,.15) 100%), url('${escapeHtml(bgImage).replace(/'/g, "%27")}'); background-size:cover; background-position:center;`
      : `background:linear-gradient(135deg, ${escapeHtml(b.gradientFrom || '#7b5cff')}, ${escapeHtml(b.gradientTo || '#241a3d')});`;
    return `
    <div class="hc-slide${i === 0 ? ' active' : ''}" data-idx="${i}" style="${bgStyle}">
      <div class="hc-body">
        ${b.icon ? `<span class="hc-icon">${escapeHtml(b.icon)}</span>` : ''}
        <h1 class="hc-title">${escapeHtml(b.title)}</h1>
        ${b.subtitle ? `<div class="hc-subtitle">${escapeHtml(b.subtitle)}</div>` : ''}
        ${b.description ? `<p class="hc-desc">${escapeHtml(b.description)}</p>` : ''}
        ${b.ctaText ? `<button class="hc-cta" data-link="${escapeHtml(b.ctaLink || '')}">${escapeHtml(b.ctaText)}</button>` : ''}
      </div>
    </div>
  `;
  }).join('');

  // Isi srcdoc tiap iframe Code Banner SETELAH elemen benar-benar ada di DOM,
  // + pasang timeout fallback kalau iframe-nya ga pernah kirim sinyal 'ready'
  // (mis. kena error parsing sebelum listener sempat kepasang).
  bannerSlides.forEach((b, i) => {
    if (b.bannerType !== 'code' || !b.codeHtml) return;
    const frame = track.querySelector(`.hc-code-frame[data-idx="${i}"]`);
    if (!frame) return;
    try {
      frame.srcdoc = buildBannerSandboxDoc({ html: b.codeHtml, css: b.codeCss, js: b.codeJs });
    } catch (e) {
      applyBannerFallback(i);
      return;
    }
    frame._loadTimeout = setTimeout(() => applyBannerFallback(i), BANNER_CODE_LOAD_TIMEOUT_MS);
    frame.addEventListener('error', () => applyBannerFallback(i));
  });

  dotsWrap.innerHTML = bannerSlides.map((_, i) =>
    `<span class="hc-dot${i === 0 ? ' active' : ''}" data-idx="${i}"></span>`
  ).join('');

  bannerIndex = 0;
  goToBannerSlide(0, false);

  if (bannerSlides.length > 1) startBannerAutoplay();
}

function goToBannerSlide(idx, restartAutoplay = true) {
  if (bannerSlides.length === 0) return;
  const n = bannerSlides.length;
  bannerIndex = ((idx % n) + n) % n;

  document.querySelectorAll('#hcTrack .hc-slide').forEach(el => {
    el.classList.toggle('active', Number(el.dataset.idx) === bannerIndex);
  });
  document.querySelectorAll('#hcDots .hc-dot').forEach(el => {
    el.classList.toggle('active', Number(el.dataset.idx) === bannerIndex);
  });

  if (restartAutoplay && bannerSlides.length > 1) startBannerAutoplay();
}

function startBannerAutoplay() {
  clearInterval(bannerAutoTimer);
  bannerAutoTimer = setInterval(() => goToBannerSlide(bannerIndex + 1, false), BANNER_AUTO_MS);
}

// Klik prev/next/dot/CTA — event delegation, jadi tetap jalan walau slide-nya
// baru saja diganti/dirender ulang lewat realtime update.
document.getElementById('hcPrev')?.addEventListener('click', () => goToBannerSlide(bannerIndex - 1));
document.getElementById('hcNext')?.addEventListener('click', () => goToBannerSlide(bannerIndex + 1));
document.getElementById('hcDots')?.addEventListener('click', (e) => {
  const dot = e.target.closest('.hc-dot');
  if (dot) goToBannerSlide(Number(dot.dataset.idx));
});
document.getElementById('hcTrack')?.addEventListener('click', (e) => {
  const btn = e.target.closest('.hc-cta');
  if (!btn) return;
  const link = btn.dataset.link;
  if (!link) return;
  // Link internal (mis. "#store", "#games") pindah halaman di app; link http(s)
  // dibuka lewat browser default kalau ada API shell (Electron), fallback window.open.
  if (link.startsWith('#')) {
    const page = link.slice(1);
    if (document.getElementById('page' + page.charAt(0).toUpperCase() + page.slice(1))) {
      showPage(page);
    }
  } else if (window.electronAPI?.openExternal) {
    window.electronAPI.openExternal(link);
  } else {
    window.open(link, '_blank');
  }
});

// ══════════════════════════════════════════════════════════════════════════
// TUTORIAL — daftar tutorial 100% dari /api/tutorials (dikelola dari Admin Web
// di halaman "Kelola Tutorial"), update realtime lewat WebSocket
// ('tutorials:update') tanpa perlu update launcher ataupun restart app sama sekali.
// Search & filter kategori dikerjakan di client terhadap data yang sudah ada di
// memori (sama seperti Games/Bypass) — instan walau jumlah tutorial banyak.
// ══════════════════════════════════════════════════════════════════════════
let allTutorials = [];
let activeTutorialCategory = 'all';
let currentTutorialNavList = []; // daftar tutorial yang sedang tampil (ikut filter aktif) — dipakai Next/Previous
let currentTutorialIndex = -1;
let _prevPageBeforeTutorialDetail = 'tutorial';

async function loadTutorials() {
  try {
    allTutorials = await api('/api/tutorials');
    renderTutorialCategoryFilters();
    renderTutorialLatest();
    applyTutorialFilter();
  } catch (e) {
    if (els.tutorialGrid) {
      els.tutorialGrid.innerHTML = `<div style="color:#8577a3;font-size:13px;padding:10px 4px;">Gagal memuat tutorial: ${escapeHtml(e.message)}</div>`;
    }
  }
}

// Chip kategori dibangun dari kategori yang benar-benar ada di data tutorial saat
// ini (bukan dari koleksi terpisah) — otomatis update begitu admin menambah
// kategori baru lewat tutorial pertamanya di kategori itu.
function renderTutorialCategoryFilters() {
  if (!els.tutorialCategoryFilter) return;
  const categories = Array.from(new Set(allTutorials.map(t => t.category || 'Umum'))).sort();
  const chips = [{ slug: 'all', name: 'Semua Kategori' }, ...categories.map(c => ({ slug: c, name: c }))];

  if (!categories.includes(activeTutorialCategory) && activeTutorialCategory !== 'all') {
    activeTutorialCategory = 'all';
  }

  els.tutorialCategoryFilter.innerHTML = chips.map(c => `
    <button class="role-filter-tab${c.slug === activeTutorialCategory ? ' active' : ''}" data-category="${escapeHtml(c.slug)}">${escapeHtml(c.name)}</button>
  `).join('');
}

function wireTutorialCategoryFilter() {
  if (!els.tutorialCategoryFilter) return;
  els.tutorialCategoryFilter.addEventListener('click', (e) => {
    const btn = e.target.closest('.role-filter-tab');
    if (!btn) return;
    els.tutorialCategoryFilter.querySelectorAll('.role-filter-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeTutorialCategory = btn.dataset.category;
    applyTutorialFilter();
  });
}

function wireTutorialSearch() {
  if (!els.tutorialSearchInput) return;
  els.tutorialSearchInput.addEventListener('input', () => applyTutorialFilter());
}

function applyTutorialFilter() {
  if (!els.tutorialGrid) return;
  const q = els.tutorialSearchInput ? els.tutorialSearchInput.value.trim().toLowerCase() : '';
  let filtered = allTutorials;
  if (activeTutorialCategory !== 'all') {
    filtered = filtered.filter(t => (t.category || 'Umum') === activeTutorialCategory);
  }
  if (q) {
    filtered = filtered.filter(t =>
      t.title.toLowerCase().includes(q) || (t.description || '').toLowerCase().includes(q)
    );
  }
  renderTutorialGrid(els.tutorialGrid, filtered);
}

// "Tutorial Terbaru" — 6 tutorial paling baru (data sudah terurut createdAt desc dari server)
function renderTutorialLatest() {
  if (!els.tutorialLatestGrid) return;
  renderTutorialGrid(els.tutorialLatestGrid, allTutorials.slice(0, 6));
}

function tutorialThumbStyle(item) {
  const src = item.thumbnailData || item.thumbnailUrl;
  return src ? `background-image:url('${src}');background-size:cover;background-position:center;` : '';
}

function renderTutorialCard(item) {
  return `
    <div class="tutorial-card" data-id="${item._id}">
      <div class="tutorial-card__thumb" style="${tutorialThumbStyle(item)}">
        <span class="tutorial-card__category">${escapeHtml(item.category || 'Umum')}</span>
      </div>
      <div class="tutorial-card__body">
        <h4 class="tutorial-card__title" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</h4>
        <p class="tutorial-card__desc">${escapeHtml(item.description || '')}</p>
        <span class="tutorial-card__btn">📖 Baca Tutorial</span>
      </div>
    </div>`;
}

function renderTutorialGrid(container, tutorials) {
  if (!container) return;
  container.innerHTML = tutorials.length
    ? tutorials.map(t => renderTutorialCard(t)).join('')
    : `<div style="color:#8577a3;font-size:13px;padding:10px 4px;">Belum ada tutorial.</div>`;
  container.querySelectorAll('.tutorial-card').forEach(card => {
    card.addEventListener('click', () => {
      const tutorial = tutorials.find(t => t._id === card.dataset.id);
      if (tutorial) openTutorialDetail(tutorial, tutorials);
    });
  });
}

// Buka halaman baca tutorial. `navList` = daftar tutorial yang sedang tampil di
// kartu yang diklik (Terbaru ATAU hasil filter/search) — jadi Next/Previous
// jalan sesuai konteks tempat user meng-klik, bukan selalu urutan semua data.
function openTutorialDetail(tutorial, navList) {
  currentTutorialNavList = navList || allTutorials;
  currentTutorialIndex = currentTutorialNavList.findIndex(t => t._id === tutorial._id);
  _prevPageBeforeTutorialDetail = els.navLinks.find(a => a.classList.contains('active'))?.dataset.page || 'tutorial';
  renderTutorialDetail(tutorial);
  showPage('tutorialDetail');
}

function renderTutorialDetail(tutorial) {
  if (els.tutorialDetailCategory) els.tutorialDetailCategory.textContent = tutorial.category || 'Umum';
  if (els.tutorialDetailTitle) els.tutorialDetailTitle.textContent = tutorial.title;

  const imgSrc = tutorial.imageData || tutorial.imageUrl;
  if (els.tutorialDetailImageWrap && els.tutorialDetailImage) {
    if (imgSrc) {
      els.tutorialDetailImage.src = imgSrc;
      els.tutorialDetailImageWrap.style.display = '';
    } else {
      els.tutorialDetailImageWrap.style.display = 'none';
    }
  }

  // `content` sudah disanitasi ketat di server (lihat sanitizeTutorialContent di
  // server.js — tag berbahaya seperti <script>/<iframe>/<img> sudah dibuang di
  // sana) sebelum pernah disimpan ke DB, jadi aman dirender sebagai HTML di sini.
  if (els.tutorialDetailContent) els.tutorialDetailContent.innerHTML = tutorial.content || '';

  if (els.tutorialDetailVideoWrap && els.tutorialDetailVideo) {
    if (tutorial.youtubeId) {
      els.tutorialDetailVideo.src = `https://www.youtube-nocookie.com/embed/${tutorial.youtubeId}`;
      els.tutorialDetailVideoWrap.style.display = '';
    } else {
      els.tutorialDetailVideo.src = '';
      els.tutorialDetailVideoWrap.style.display = 'none';
    }
  }

  if (els.tutorialPrevBtn) els.tutorialPrevBtn.disabled = currentTutorialIndex <= 0;
  if (els.tutorialNextBtn) els.tutorialNextBtn.disabled = currentTutorialIndex < 0 || currentTutorialIndex >= currentTutorialNavList.length - 1;

  const scrollEl = document.querySelector('#pageTutorialDetail .detail-scroll');
  if (scrollEl) scrollEl.scrollTop = 0;
}

function wireTutorialDetailNav() {
  if (els.tutorialDetailBackBtn) {
    els.tutorialDetailBackBtn.addEventListener('click', () => showPage(_prevPageBeforeTutorialDetail));
  }
  if (els.tutorialPrevBtn) {
    els.tutorialPrevBtn.addEventListener('click', () => {
      if (currentTutorialIndex > 0) {
        currentTutorialIndex--;
        renderTutorialDetail(currentTutorialNavList[currentTutorialIndex]);
      }
    });
  }
  if (els.tutorialNextBtn) {
    els.tutorialNextBtn.addEventListener('click', () => {
      if (currentTutorialIndex >= 0 && currentTutorialIndex < currentTutorialNavList.length - 1) {
        currentTutorialIndex++;
        renderTutorialDetail(currentTutorialNavList[currentTutorialIndex]);
      }
    });
  }
}

// ══════════════════════════════════════════════════════════════════════════
// TOP INSTALLER MINGGUAN — leaderboard realtime dari /api/leaderboard, dihitung
// server dari data histori install asli (bukan dummy), update otomatis lewat
// WebSocket ('leaderboard:update') setiap ada install baru dari user manapun.
// ══════════════════════════════════════════════════════════════════════════
const LB_ROLE_LABEL = { public: 'Public', gold: 'Gold', platinum: 'Platinum', admin: 'Admin' };
const LB_RANK_BADGE = { 1: '🥇', 2: '🥈', 3: '🥉' };

async function loadLeaderboard() {
  try {
    const data = await api('/api/leaderboard');
    renderLeaderboard(data);
  } catch (e) {
    renderLeaderboard({ entries: [] });
  }
}

function formatInstallCount(n) {
  if (n >= 1000) return (n / 1000).toFixed(n % 1000 === 0 ? 0 : 1) + ' K';
  return String(n);
}

function renderLeaderboard(data) {
  const list = document.getElementById('lbList');
  if (!list) return;
  const entries = (data && Array.isArray(data.entries)) ? data.entries : [];

  if (entries.length === 0) {
    list.innerHTML = `
      <div class="lb-empty">
        <div class="lb-empty-icon">🏆</div>
        <div>Belum ada install minggu ini.<br>Jadilah yang pertama!</div>
      </div>`;
    return;
  }

  list.innerHTML = entries.map((u, i) => {
    const rank = i + 1;
    const roleClass = u.role || 'public';
    const avatar = u.avatarUrl || 'https://cdn.discordapp.com/embed/avatars/0.png';
    return `
      <div class="lb-row rank-${rank}">
        <div class="lb-rank">${LB_RANK_BADGE[rank] || rank}</div>
        <div class="lb-avatar-wrap">
          <img src="${escapeHtml(avatar)}" alt="" onerror="this.src='https://cdn.discordapp.com/embed/avatars/0.png'">
          ${rank <= 3 ? `<span class="lb-badge">${LB_RANK_BADGE[rank]}</span>` : ''}
        </div>
        <div class="lb-info">
          <div class="name">
            ${escapeHtml(u.username || 'Unknown')}
            <span class="lb-role-tag ${roleClass}">${LB_ROLE_LABEL[roleClass] || roleClass}</span>
          </div>
        </div>
        <div class="score"><span class="flame">🔥</span> ${formatInstallCount(u.installs || 0)}</div>
      </div>`;
  }).join('');
}

// ── SEARCH ──
function applySearchAndFilters() {
  if (!els.searchInput) return;
  const q = els.searchInput.value.trim().toLowerCase();
  const filtered = q ? allGames.filter(g => g.name.toLowerCase().includes(q)) : allGames;
  applyDashCategoryFilter();
  if (document.getElementById(PAGE_IDS.games)?.style.display !== 'none') {
    const roleFiltered = activeGamesRoleFilter === 'all' ? filtered : filtered.filter(g => g.role === activeGamesRoleFilter);
    renderGrid(els.gamesOnlyGrid, roleFiltered);
  }
  if (document.getElementById(PAGE_IDS.bypasses)?.style.display !== 'none') {
    const filteredBypasses = q ? allBypasses.filter(b => b.name.toLowerCase().includes(q)) : allBypasses;
    const roleFilteredBypasses = activeBypassesRoleFilter === 'all' ? filteredBypasses : filteredBypasses.filter(b => b.role === activeBypassesRoleFilter);
    renderBypassGrid(els.bypassesGrid, roleFilteredBypasses);
  }
}

function wireSearch() {
  if (!els.searchInput) return;
  els.searchInput.addEventListener('input', applySearchAndFilters);
}

// ══════════════════════════════════════════════════════════════
// PROGRESS MODAL — download + install UI
// ══════════════════════════════════════════════════════════════

let _dlModal = null;
let _dlLastInstallArgs = null; // untuk retry

function getDlModal() {
  if (_dlModal) return _dlModal;

  const overlay = document.createElement('div');
  overlay.className = 'dl-overlay';
  overlay.id = 'dlOverlay';
  overlay.innerHTML = `
    <div class="dl-card">
      <div class="dl-header">
        <div class="dl-icon" id="dlIcon">⬇️</div>
        <div>
          <div class="dl-title" id="dlTitle">Mengunduh...</div>
          <div class="dl-subtitle" id="dlSubtitle">Mohon tunggu sebentar</div>
        </div>
      </div>

      <!-- Step indicators: 1=Koneksi 2=Download 3=Ekstrak 4=Install -->
      <div class="dl-steps">
        <div class="dl-step" id="dlStep1"></div>
        <div class="dl-step" id="dlStep2"></div>
        <div class="dl-step" id="dlStep3"></div>
        <div class="dl-step" id="dlStep4"></div>
      </div>

      <div class="dl-stage">
        <span class="dl-stage-dot" id="dlStageDot"></span>
        <span id="dlStageText">Menginisialisasi...</span>
      </div>

      <div class="dl-bar-track">
        <div class="dl-bar-fill indeterminate" id="dlBarFill"></div>
      </div>

      <div class="dl-stats">
        <div id="dlStatsLeft">—</div>
        <div id="dlStatsRight">—</div>
      </div>

      <div class="dl-error-box" id="dlErrorBox">
        <div class="dl-error-title">⚠️ Terjadi Kesalahan</div>
        <div id="dlErrorMsg"></div>
      </div>

      <div class="dl-success-box" id="dlSuccessBox">
        <div id="dlSuccessMsg"></div>
      </div>

      <div class="dl-actions">
        <button class="dl-btn dl-btn-cancel" id="dlBtnCancel">Batalkan</button>
        <button class="dl-btn dl-btn-retry" id="dlBtnRetry">↺ Coba Lagi</button>
        <button class="dl-btn dl-btn-primary" id="dlBtnClose">✓ Selesai</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  document.getElementById('dlBtnCancel').addEventListener('click', async () => {
    await window.electronAPI.cancelDownload().catch(() => {});
    dlModalHide();
  });
  document.getElementById('dlBtnClose').addEventListener('click', dlModalHide);
  document.getElementById('dlBtnRetry').addEventListener('click', () => {
    if (_dlLastInstallArgs) {
      dlModalHide();
      setTimeout(() => handleInstall(..._dlLastInstallArgs), 180);
    }
  });

  _dlModal = {
    overlay,
    icon:        overlay.querySelector('#dlIcon'),
    title:       overlay.querySelector('#dlTitle'),
    subtitle:    overlay.querySelector('#dlSubtitle'),
    stageDot:    overlay.querySelector('#dlStageDot'),
    stageText:   overlay.querySelector('#dlStageText'),
    barFill:     overlay.querySelector('#dlBarFill'),
    statsLeft:   overlay.querySelector('#dlStatsLeft'),
    statsRight:  overlay.querySelector('#dlStatsRight'),
    errorBox:    overlay.querySelector('#dlErrorBox'),
    errorMsg:    overlay.querySelector('#dlErrorMsg'),
    successBox:  overlay.querySelector('#dlSuccessBox'),
    successMsg:  overlay.querySelector('#dlSuccessMsg'),
    btnCancel:   overlay.querySelector('#dlBtnCancel'),
    btnRetry:    overlay.querySelector('#dlBtnRetry'),
    btnClose:    overlay.querySelector('#dlBtnClose'),
    steps:       [1,2,3,4].map(i => overlay.querySelector(`#dlStep${i}`)),
  };
  return _dlModal;
}

function dlModalShow(title, subtitle = 'Mohon tunggu sebentar', icon = '⬇️') {
  const m = getDlModal();
  m.title.textContent    = title;
  m.subtitle.textContent = subtitle;
  m.icon.textContent     = icon;
  m.icon.className       = 'dl-icon';
  m.stageDot.className   = 'dl-stage-dot';
  m.barFill.className    = 'dl-bar-fill indeterminate';
  m.barFill.style.width  = '0%';
  m.errorBox.className   = 'dl-error-box';
  m.successBox.className = 'dl-success-box';
  m.btnRetry.className   = 'dl-btn dl-btn-retry';
  m.btnClose.className   = 'dl-btn dl-btn-primary';
  m.btnCancel.style.display = 'inline-block';
  m.statsLeft.textContent   = '—';
  m.statsRight.textContent  = '—';
  m.steps.forEach(s => s.className = 'dl-step');
  m.overlay.classList.add('show');
}

function dlModalHide() {
  const m = getDlModal();
  m.overlay.classList.remove('show');
}

function dlSetStage(text, stepDone = 0, isError = false) {
  const m = getDlModal();
  m.stageText.textContent = text;
  m.stageDot.className = 'dl-stage-dot' + (isError ? ' fail' : stepDone >= 4 ? ' done' : '');
  m.steps.forEach((s, i) => {
    if (i < stepDone) s.className = 'dl-step done';
    else if (i === stepDone && !isError) s.className = 'dl-step active';
    else if (i === stepDone && isError) s.className = 'dl-step error';
  });
}

function dlSetProgress(downloaded, total) {
  const m = getDlModal();
  if (total > 0) {
    const pct = Math.min(100, Math.round((downloaded / total) * 100));
    m.barFill.className   = 'dl-bar-fill';
    m.barFill.style.width = pct + '%';
    m.statsLeft.textContent  = `${pct}%`;
    m.statsRight.textContent = `${fmtBytes(downloaded)} / ${fmtBytes(total)}`;
  } else {
    m.barFill.className = 'dl-bar-fill indeterminate';
    m.statsLeft.textContent  = fmtBytes(downloaded);
    m.statsRight.textContent = 'Ukuran tidak diketahui';
  }
}

function dlSetSuccess(msg, detailMsg = '') {
  const m = getDlModal();
  m.icon.textContent   = '✅';
  m.icon.className     = 'dl-icon success';
  m.subtitle.textContent = 'Proses selesai';
  m.barFill.className  = 'dl-bar-fill success';
  m.barFill.style.width = '100%';
  m.stageDot.className = 'dl-stage-dot done';
  m.steps.forEach(s => s.className = 'dl-step done');
  m.stageText.textContent = msg;
  m.statsLeft.textContent  = '100%';
  m.btnCancel.style.display = 'none';
  m.btnClose.className = 'dl-btn dl-btn-primary show';
  if (detailMsg) {
    m.successBox.className = 'dl-success-box show';
    m.successMsg.textContent = detailMsg;
  }
}

function dlSetError(errMsg) {
  const m = getDlModal();
  m.icon.textContent    = '❌';
  m.icon.className      = 'dl-icon error';
  m.subtitle.textContent = 'Proses gagal';
  m.barFill.className   = 'dl-bar-fill error';
  m.stageDot.className  = 'dl-stage-dot fail';
  m.stageText.textContent = 'Gagal';
  // Sembunyikan tombol cancel, tampilkan Retry DAN Close
  m.btnCancel.style.display = 'none';
  m.btnRetry.className  = 'dl-btn dl-btn-retry show';
  m.btnClose.className  = 'dl-btn dl-btn-primary show'; // ← tombol close selalu muncul saat error
  m.errorBox.className  = 'dl-error-box show';
  m.errorMsg.textContent = errMsg;
}

function fmtBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// ── Daftarkan listener progress dari main process (sekali saja) ──
let _progressListenerSet = false;
function ensureProgressListener() {
  if (_progressListenerSet) return;
  _progressListenerSet = true;
  // Dukung kedua nama event (download-progress dari main.js baru, inject-download-progress dari lama)
  const handler = ({ downloaded, total }) => dlSetProgress(downloaded, total);
  window.electronAPI.onDownloadProgress(handler);
  // Kalau ada onInjectDownloadProgress juga, daftarkan (kompatibilitas project lama)
  if (typeof window.electronAPI.onInjectDownloadProgress === 'function') {
    window.electronAPI.onInjectDownloadProgress(handler);
  }
}

// ── META INSTALL LOKAL (localStorage) — dipakai uninstall ──
// Sama seperti project lama: begitu install berhasil, extractedFiles/steamPath/folderPath
// langsung disimpan di localStorage PC ini juga (dikunci per history _id dari server),
// supaya uninstall punya sumber data yang PASTI ada & akurat, tidak cuma bergantung ke
// hasil GET /api/history yang datang dari round-trip server.
function getLocalInstallMeta() {
  try { return JSON.parse(localStorage.getItem('installMeta') || '{}'); } catch (e) { return {}; }
}
function saveLocalInstallMeta(historyId, meta) {
  if (!historyId) return;
  const map = getLocalInstallMeta();
  map[String(historyId)] = meta;
  localStorage.setItem('installMeta', JSON.stringify(map));
}
function removeLocalInstallMeta(historyId) {
  const map = getLocalInstallMeta();
  delete map[String(historyId)];
  localStorage.setItem('installMeta', JSON.stringify(map));
}

// ── HISTORI: kirim ke server dengan retry + antrian offline biar histori TIDAK PERNAH HILANG ──
// BUG SEBELUMNYA: kalau POST /api/history gagal (network blip sesaat, server 500,
// token mepet expired, dll) PADAHAL inject/install-nya sendiri sudah SUKSES di PC user,
// histori itu langsung hilang selamanya — gak ada retry, gak ada catatan apapun, dan
// error-nya malah bikin seluruh proses install kelihatan "gagal" padahal filenya udah kepasang.
// SEKARANG: coba beberapa kali dulu (dengan jeda), kalau masih gagal juga, payload-nya
// diantrikan ke localStorage & otomatis dicoba kirim ulang tiap kali app/hal. Histori dibuka.
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
        console.warn('[Histori] Gagal simpan ke server setelah beberapa percobaan, diantrikan buat dicoba lagi nanti:', e.message);
        return null;
      }
      await new Promise(r => setTimeout(r, 700 * (i + 1))); // backoff singkat sebelum retry
    }
  }
}

// Dicoba tiap kali halaman Histori dibuka / app baru masuk — kirim ulang antrian yang tertunda
async function flushPendingHistory() {
  const queue = _getPendingHistoryQueue();
  if (!queue.length) return false;
  const stillPending = [];
  let anySucceeded = false;
  for (const entry of queue) {
    try {
      await api('/api/history', { method: 'POST', body: JSON.stringify(entry.payload) });
      anySucceeded = true;
    } catch (e) {
      stillPending.push(entry);
    }
  }
  _setPendingHistoryQueue(stillPending);
  return anySucceeded;
}

// ── INSTALL -> catat ke histori ──
async function handleInstall(itemType, itemId, itemName) {
  _dlLastInstallArgs = [itemType, itemId, itemName];
  ensureProgressListener();

  const isGame = itemType === 'game';
  dlModalShow(
    itemName,
    isGame ? 'Inject game ke Steam' : 'Install bypass ke folder game',
    isGame ? '🎮' : '🛡️'
  );
  dlSetStage('Menghubungkan ke server...', 0);

  try {
    let result;

    if (isGame) {
      // ── GAME INJECT (pakai HubCap lewat proxy server, tidak berubah) ──
      const data = await api(`/api/games/${itemId}/download`);
      if (!data.streamPath) throw new Error(data.error || 'Server tidak memberikan link download. Pastikan admin sudah mengisi data game.');
      dlSetStage('URL diterima, mendeteksi Steam...', 1);

      const token = localStorage.getItem('token') || '';
      const zipUrl = `${SERVER_URL}${data.streamPath}`;
      const streamAuthHeaders = { Authorization: `Bearer ${token}` };

      const steamPath = await window.electronAPI.getSteamPath();
      if (!steamPath) throw new Error('Steam tidak ditemukan di PC ini. Pastikan Steam sudah terinstall dan pernah dijalankan.');

      dlSetStage('Mengunduh & meng-inject file...', 1);
      result = await window.electronAPI.injectGame({
        steamPath,
        zipUrl,
        extraHeaders: streamAuthHeaders
      });

      if (result.cancelled) { dlModalHide(); return; }
      if (!result.success) throw new Error(result.error || 'Inject game gagal tanpa keterangan.');

      dlSetStage('Menyimpan ke histori...', 3);
      const gameMeta = allGames.find(g => String(g._id) === String(itemId));
      const histResp = await saveHistoryWithRetry({
        itemType, itemId, itemName,
        itemImage: gameMeta?.imageUrl || null, // fallback kalau game-nya sempat dihapus/diedit admin sebelum histori tersimpan
        extractedFiles: result.extractedFiles || [], steamPath
      });
      saveLocalInstallMeta(histResp?._id, { type: 'game', extractedFiles: result.extractedFiles || [], steamPath });

      dlSetSuccess(
        'Inject berhasil!',
        `${result.extractedFiles?.length || 0} file berhasil dipasang.
⚠️ Restart Steam agar perubahan aktif.`
      );

    } else {
      // ── BYPASS INSTALL ──
      // Bisa datang dalam 2 bentuk dari server:
      //  • directUrl  → link biasa (GitHub/GDrive/CDN lain), didownload langsung, tanpa auth.
      //  • streamPath → link Ryuu Generator, WAJIB lewat proxy server sendiri (server yang
      //    nempelin RYUU_API_KEY), makanya butuh Authorization Bearer token kita ke streamPath-nya.
      // Sebelumnya cuma directUrl yang ditangani, jadi bypass dari Ryuu (streamPath) selalu
      // gagal dengan error auth dari Ryuu itu sendiri.
      dlSetStage('Mengambil link bypass...', 1);
      const linkData = await api(`/api/bypasses/${itemId}/download-link`);
      if (!linkData.directUrl && !linkData.streamPath) {
        throw new Error(linkData.error || 'Link bypass tidak ditemukan. Pastikan admin sudah mengisi link file bypass.');
      }

      const appId = linkData.steamAppId || linkData.appId;
      if (!appId) throw new Error('App ID belum diisi admin pada bypass ini. Hubungi admin.');

      dlSetStage('Mendeteksi Steam...', 1);
      const steamPath = await window.electronAPI.getSteamPath();
      if (!steamPath) throw new Error('Steam tidak ditemukan. Pastikan Steam sudah terinstall.');

      dlSetStage(`Mencari folder game (App ID: ${appId})...`, 2);
      const folderResult = await window.electronAPI.findGameFolderByAppId({ steamPath, appId: String(appId) });
      if (!folderResult.found) throw new Error(folderResult.error || `Game dengan App ID ${appId} belum terinstall di Steam. Install gamenya dulu lalu coba lagi.`);

      dlSetStage('Mengunduh bypass...', 2);
      const bypassToken = localStorage.getItem('token') || '';
      const bypassDriveUrl = linkData.streamPath ? `${SERVER_URL}${linkData.streamPath}` : linkData.directUrl;
      const bypassExtraHeaders = linkData.streamPath ? { Authorization: `Bearer ${bypassToken}` } : {};

      result = await window.electronAPI.installBypass({
        folderPath:   folderResult.folderPath,
        driveUrl:     bypassDriveUrl,
        extraHeaders: bypassExtraHeaders,
        userId:       currentUser?.discordId || currentUser?.userId || '',
        deviceId:     getOrCreateDeviceId(),
        gameId:       itemId,
        gameName:     itemName,
        steamAppId:   String(appId),
      });
      if (result.cancelled) { dlModalHide(); return; }
      if (!result.success)  throw new Error(result.error || 'Install bypass gagal tanpa keterangan.');

      dlSetStage('Menyimpan ke histori...', 3);
      const bypassMeta = allBypasses.find(b => String(b._id) === String(itemId));
      const histResp = await saveHistoryWithRetry({
        itemType, itemId, itemName,
        itemImage: bypassMeta?.imageUrl || null, // fallback kalau bypass-nya sempat dihapus/diedit admin sebelum histori tersimpan
        extractedFiles: result.extractedFiles || [],
        folderPath: result.folderPath || null
      });
      saveLocalInstallMeta(histResp?._id, { type: 'bypass', extractedFiles: result.extractedFiles || [], folderPath: result.folderPath || null });

      dlSetSuccess(
        'Bypass berhasil dipasang!',
        `📁 Diekstrak ke:
${result.folderPath || '—'}

${result.extractedFiles?.length || 0} file berhasil dipasang.`
      );
    }

    loadHistori();

  } catch (e) {
    dlSetError(e.message);
    // Laporkan kegagalan ke server supaya user dapat notifikasi (in-app + realtime),
    // best-effort — jangan sampai gagalnya laporan ini menutupi error aslinya.
    const failedMeta = isGame
      ? allGames.find(g => String(g._id) === String(itemId))
      : allBypasses.find(b => String(b._id) === String(itemId));
    api('/api/downloads/failed', {
      method: 'POST',
      body: JSON.stringify({ itemType, itemName, itemImage: failedMeta?.imageUrl || null, reason: e.message })
    }).catch(() => {});
  }
}

// ── HALAMAN HISTORI ──
let _allHistori = [];
let _historiFilter = 'all'; // all | game | bypass

async function loadHistori() {
  if (!els.historiListPage) return;
  renderHistoriSkeleton();
  try {
    await flushPendingHistory(); // coba kirim ulang histori yang sempat gagal tersimpan sebelumnya
    const rows = await api('/api/history');
    _allHistori = rows;
    renderHistoriStats(rows);
    applyHistoriFilter();
  } catch (e) {
    if (els.historiStats) els.historiStats.innerHTML = '';
    els.historiListPage.innerHTML = `
      <div class="histori-error-state">
        <div class="her-icon">⚠️</div>
        <div class="her-title">Gagal Memuat Histori</div>
        <div class="her-msg">${escapeHtml(e.message)}</div>
        <button class="her-retry" id="btnHistoriRetry">Coba Lagi</button>
      </div>`;
    document.getElementById('btnHistoriRetry')?.addEventListener('click', loadHistori);
  }
}

function renderHistoriSkeleton() {
  if (els.historiStats) {
    els.historiStats.innerHTML = [1, 2, 3].map(() => `
      <div class="hstat-card">
        <div class="hstat-icon-wrap skel-pulse hstat-skel-icon"></div>
        <div style="flex:1;">
          <div class="skel-pulse hstat-skel-num" style="margin-bottom:7px;"></div>
          <div class="skel-pulse hstat-skel-label"></div>
        </div>
      </div>`).join('');
  }
  els.historiListPage.innerHTML = `<div class="histori-skel-list">${[1, 2, 3, 4].map(() => `<div class="skel-pulse hsk-row"></div>`).join('')}</div>`;
}

function renderHistoriStats(rows) {
  if (!els.historiStats) return;
  const totalGame = rows.filter(r => r.itemType === 'game').length;
  const totalBypass = rows.filter(r => r.itemType === 'bypass').length;
  const stats = [
    { icon: '📦', color: '#7c5cff', num: rows.length, label: 'Total Histori' },
    { icon: '🎮', color: '#8b5cf6', num: totalGame,   label: 'Game Diinstall' },
    { icon: '🛡️', color: '#0ea5e9', num: totalBypass, label: 'Bypass Dipakai' },
  ];
  els.historiStats.innerHTML = stats.map(s => `
    <div class="hstat-card" style="--hic:${s.color};">
      <div class="hstat-icon-wrap">${s.icon}</div>
      <div>
        <div class="hstat-num" style="color:${s.color};">${s.num}</div>
        <div class="hstat-label">${s.label}</div>
      </div>
    </div>`).join('');

  // Update angka di tab filter (sebelumnya selalu nampil "0" karena tidak pernah diisi)
  const setCount = (id, n) => { const el = document.getElementById(id); if (el) el.textContent = n; };
  setCount('htabCountAll', rows.length);
  setCount('htabCountGame', totalGame);
  setCount('htabCountBypass', totalBypass);
}

function wireHistoriTabs() {
  document.querySelectorAll('#historiTabs .htab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#historiTabs .htab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _historiFilter = btn.dataset.filter;
      applyHistoriFilter();
    });
  });
}

function applyHistoriFilter() {
  const rows = _historiFilter === 'all' ? _allHistori : _allHistori.filter(r => r.itemType === _historiFilter);
  renderHistoriCards(rows);
}

// Label grup tanggal: "Hari Ini" / "Kemarin" / "12 Juli 2026"
function historiDateLabel(dateStr) {
  const d = new Date(dateStr);
  const now = new Date();
  const startOfDay = dt => new Date(dt.getFullYear(), dt.getMonth(), dt.getDate()).getTime();
  const diffDays = Math.round((startOfDay(now) - startOfDay(d)) / 86400000);
  if (diffDays === 0) return 'Hari Ini';
  if (diffDays === 1) return 'Kemarin';
  return d.toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
}

function renderHistoriCards(rows) {
  if (!els.historiListPage) return;

  if (!rows.length) {
    const empty = _historiFilter === 'all'
      ? { icon: '🕒', title: 'Belum Ada Histori', sub: 'Game atau bypass yang kamu install akan muncul di sini.' }
      : { icon: _historiFilter === 'game' ? '🎮' : '🛡️', title: `Belum Ada Histori ${_historiFilter === 'game' ? 'Game' : 'Bypass'}`, sub: `Kamu belum pernah install ${_historiFilter === 'game' ? 'game' : 'bypass'} apapun.` };
    els.historiListPage.innerHTML = `
      <div class="histori-empty">
        <div class="histori-empty-icon">${empty.icon}</div>
        <div class="histori-empty-title">${empty.title}</div>
        <div class="histori-empty-sub">${empty.sub}</div>
      </div>`;
    return;
  }

  // Kelompokkan per tanggal (Hari Ini / Kemarin / tanggal lengkap), urutan sudah
  // terbaru dulu karena /api/history sudah di-sort createdAt:-1 dari server.
  const groups = [];
  let currentLabel = null, currentGroup = null;
  rows.forEach(h => {
    const label = historiDateLabel(h.createdAt);
    if (label !== currentLabel) {
      currentLabel = label;
      currentGroup = { label, items: [] };
      groups.push(currentGroup);
    }
    currentGroup.items.push(h);
  });

  els.historiListPage.innerHTML = `
    <div class="histori-groups">
      ${groups.map(g => `
        <div class="histori-group">
          <div class="histori-group-date">
            <span class="histori-date-label">${escapeHtml(g.label)}</span>
            <span class="histori-date-line"></span>
            <span class="histori-date-count">${g.items.length} item</span>
          </div>
          <div class="histori-cards">
            ${g.items.map(renderHistoriCard).join('')}
          </div>
        </div>`).join('')}
    </div>`;

  wireHistoriCardActions();
}

function renderHistoriCard(h) {
  const isGame = h.itemType === 'game';
  // Ambil role TERKINI item ini (kalau masih ada di daftar games/bypasses yang aktif) —
  // supaya badge role tetap akurat walau role item berubah setelah di-install.
  const list = isGame ? allGames : allBypasses;
  const liveItem = list.find(x => String(x._id) === String(h.itemId));
  const role = liveItem?.role || null;
  const d = new Date(h.createdAt);
  const fullDate = d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' }) + ' • ' + d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });

  return `
    <div class="histori-card" data-hid="${h._id}">
      <div class="hcard-cover">
        ${h.itemImage
          ? `<img src="${escapeHtml(h.itemImage)}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex';">
             <div class="hcard-cover-fallback" style="display:none;">${isGame ? '🎮' : '🛡️'}</div>`
          : `<div class="hcard-cover-fallback">${isGame ? '🎮' : '🛡️'}</div>`
        }
        <span class="hcard-type-badge ${isGame ? 'hcard-type-game' : 'hcard-type-bypass'}">${isGame ? '🎮 Game' : '🛡️ Bypass'}</span>
        <button class="hcard-uninstall" data-id="${h._id}" title="Hapus dari histori">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6m5 0V4a2 2 0 012-2h0a2 2 0 012 2v2"/></svg>
        </button>
      </div>
      <div class="hcard-body">
        <div class="hcard-name" title="${escapeHtml(h.itemName)}">${escapeHtml(h.itemName)}</div>
        <div class="hcard-footer">
          <div class="hcard-meta-row">
            <span class="hcard-time">🕒 ${timeAgo(h.createdAt)}</span>
            ${role ? `<span class="hcard-role ${role}">${escapeHtml(role)}</span>` : ''}
          </div>
          <div class="hcard-date-full">${fullDate}</div>
        </div>
      </div>
    </div>`;
}

// Uninstall pakai konfirmasi 2 langkah (klik pertama jadi warning, klik kedua baru
// benar-benar hapus) — supaya tidak kehapus tidak sengaja, tanpa perlu popup alert().
async function wireHistoriCardActions() {
  els.historiListPage.querySelectorAll('.hcard-uninstall').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!btn.classList.contains('confirm')) {
        btn.classList.add('confirm');
        btn.title = 'Klik lagi untuk konfirmasi hapus';
        setTimeout(() => btn.classList.remove('confirm'), 3000); // batal otomatis kalau tidak jadi diklik
        return;
      }
      const card = btn.closest('.histori-card');
      const historiId = btn.dataset.id;
      const row = _allHistori.find(h => String(h._id) === String(historiId));

      // PENTING: utamakan data dari localStorage (installMeta) — ini disimpan LANGSUNG
      // di PC ini tepat saat install barusan berhasil, jadi dijamin ada & akurat (persis
      // pola project lama yang uninstall-nya sudah terbukti jalan). Data dari server
      // (row.extractedFiles/dst) cuma dipakai sebagai fallback kalau localStorage-nya
      // kosong (misal histori disinkron dari device lain, atau data dari sebelum fix ini).
      const localMeta = getLocalInstallMeta()[String(historiId)];
      const itemType     = localMeta?.type        ?? row?.itemType;
      const extractedFiles = (localMeta?.extractedFiles ?? row?.extractedFiles) || [];
      const steamPathMeta  = localMeta?.steamPath  ?? row?.steamPath  ?? null;
      const folderPathMeta = localMeta?.folderPath ?? row?.folderPath ?? null;

      btn.disabled = true;
      try {
        let fileWarning = '';
        let needRestartSteam = false;

        // BUG FIX: sebelumnya di sini cuma langsung DELETE ke /api/history tanpa
        // pernah menyentuh file di PC user sama sekali — jadi "uninstall" cuma
        // menghilangkan catatannya, file .lua/.manifest (game) atau file bypass di
        // folder game tetap ada. Sekarang panggil removeGame/removeBypass dulu.
        if (itemType === 'game') {
          if (extractedFiles.length) {
            // steamPath mungkin tidak tersimpan (histori lama sebelum fix ini) —
            // fallback ke deteksi ulang steamPath di PC ini kalau tidak ada.
            const steamPath = steamPathMeta || await window.electronAPI.getSteamPath();
            if (steamPath) {
              const rmResult = await window.electronAPI.removeGame({ steamPath, extractedFiles });
              if (!rmResult?.success) fileWarning = ` (file di PC gagal dihapus: ${rmResult?.error || 'tidak diketahui'})`;
              else needRestartSteam = true; // file sudah kehapus, tapi Steam masih baca cache lama sampai di-restart
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

        card?.classList.add('removing');
        await api('/api/history/' + historiId, { method: 'DELETE' });
        removeLocalInstallMeta(historiId);

        if (needRestartSteam) {
          // PENTING: file .lua/.manifest yang baru dihapus BARU benar-benar hilang dari
          // Steam (unlock game hilang) setelah Steam di-restart — kalau tidak, Steam masih
          // pakai cache lama dan kelihatan seperti "uninstall tidak berfungsi" padahal
          // filenya sudah beneran terhapus dari PC.
          showHistoriRestartToast();
        } else {
          showHistoriToast('Berhasil dihapus dari histori' + fileWarning);
        }
        setTimeout(() => loadHistori(), 220);
      } catch (err) {
        btn.disabled = false;
        card?.classList.remove('removing');
        showHistoriToast('Gagal hapus: ' + err.message);
      }
    });
  });
}

// ══════════════════════════════════════════════════════════════════════════
// TOAST AUTO-HIDE — SEMUA toast di app ini (notif realtime, histori, role
// diperbarui, dst) pakai helper YANG SAMA supaya konsisten: selalu hilang
// otomatis TEPAT 4 detik setelah muncul terakhir kali.
//
// BUG FIX: sebelumnya tiap toast punya timer sendiri-sendiri dan cuma
// diandalkan dari setTimeout biasa — begitu window app di-minimize/di-hidden
// lama, browser (Electron/Chromium) suka nge-throttle setTimeout di
// background, jadi toast yang harusnya sudah ilang malah nyangkut sampai
// window aktif lagi ("notif suka ga ilang-ilang"). Sekarang tiap kali toast
// ditampilkan, waktu seharusnya-hilang (hideAt) dicatat, DAN begitu window
// balik jadi visible, semua toast yang harusnya udah lewat waktunya langsung
// dipaksa ketutup — jadi dijamin tidak akan nyangkut lagi.
// ══════════════════════════════════════════════════════════════════════════
const TOAST_AUTO_HIDE_MS = 4000;
const _activeToastTimers = new Map(); // el -> { timer, hideAt, showClass }

function scheduleToastAutoHide(el, showClass = 'show', ms = TOAST_AUTO_HIDE_MS) {
  const existing = _activeToastTimers.get(el);
  if (existing) clearTimeout(existing.timer);
  const hideAt = Date.now() + ms;
  const timer = setTimeout(() => {
    el.classList.remove(showClass);
    _activeToastTimers.delete(el);
  }, ms);
  _activeToastTimers.set(el, { timer, hideAt, showClass });
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  const now = Date.now();
  for (const [el, info] of _activeToastTimers) {
    if (now >= info.hideAt) {
      el.classList.remove(info.showClass);
      clearTimeout(info.timer);
      _activeToastTimers.delete(el);
    }
  }
});

// Toast khusus uninstall game — kasih tombol "Restart Steam Sekarang" langsung di toastnya,
// karena tanpa restart, perubahan (game/DLC hilang dari Steam) belum akan kelihatan.
function showHistoriRestartToast() {
  let toastEl = document.querySelector('.histori-toast');
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.className = 'histori-toast';
    document.body.appendChild(toastEl);
  }
  toastEl.innerHTML = `File berhasil dihapus. ⚠️ Restart Steam agar perubahan aktif —
    <a href="#" id="historiRestartSteamBtn" style="color:#a78bfa;text-decoration:underline;font-weight:700;">Restart Sekarang</a>`;
  toastEl.classList.add('show');
  scheduleToastAutoHide(toastEl, 'show');
  document.getElementById('historiRestartSteamBtn')?.addEventListener('click', async (e) => {
    e.preventDefault();
    toastEl.classList.remove('show');
    const steamPath = await window.electronAPI.getSteamPath();
    if (steamPath) await window.electronAPI.restartSteam(steamPath);
  });
}

function showHistoriToast(msg) {
  let toastEl = document.querySelector('.histori-toast');
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.className = 'histori-toast';
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  scheduleToastAutoHide(toastEl, 'show');
}

// ── Toast khusus notif "role/paket kamu diperbarui" — dipanggil dari
// refreshCurrentUserRole() begitu terdeteksi role berubah.
const ROLE_TOAST_LABEL = { public: 'Public', gold: 'Gold', platinum: 'Platinum', admin: 'Admin' };
const ROLE_TOAST_DESC  = {
  public:   'Akses kamu kembali ke mode Public.',
  gold:     'Kamu sekarang bisa akses semua konten Gold! 🎉',
  platinum: 'Akses UNLIMITED ke semua konten aktif! 🚀',
};
// ══════════════════════════════════════════════════════════════════════════
// REALTIME — WebSocket (download limit, masa aktif, status akun, notifikasi)
// Semua perubahan dari admin (role, masa aktif, reset kuota) & event server (limit
// abis, paket abis, download sukses/gagal) langsung sampai ke sini TANPA perlu
// refresh/restart/login ulang. Polling (_roleCheckTimer dkk) tetap jalan sebagai
// fallback kalau koneksi WS lagi putus (mis. jaringan tidak stabil).
// ══════════════════════════════════════════════════════════════════════════
let _ws = null;
let _wsReconnectTimer = null;
let _wsReconnectDelay = 2000;

function connectRealtime() {
  const token = localStorage.getItem('token');
  if (!token || !currentUser) return;
  try { _ws?.close(); } catch (e) {}

  _ws = new WebSocket(`${WS_URL}?token=${encodeURIComponent(token)}`);

  _ws.onopen = () => { _wsReconnectDelay = 2000; };

  _ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (!msg || !msg.event) return;

    if (msg.event === 'account:update') {
      handleAccountUpdate(msg.data);
    } else if (msg.event === 'notification') {
      handleIncomingNotification(msg.data);
    } else if (msg.event === 'notification:unread-count') {
      setNotifUnreadCount(msg.data.unread);
    } else if (msg.event === 'device:reset') {
      handleDeviceReset();
    } else if (msg.event === 'banners:update') {
      renderBannerCarousel(msg.data);
    } else if (msg.event === 'tutorials:update') {
      allTutorials = msg.data;
      renderTutorialCategoryFilters();
      renderTutorialLatest();
      applyTutorialFilter();
    } else if (msg.event === 'leaderboard:update') {
      renderLeaderboard(msg.data);
    } else if (msg.event === 'premium:cleanup') {
      handlePremiumCleanup(msg.data);
    }
  };

  _ws.onclose = () => {
    if (!currentUser) return; // sudah logout, tidak perlu reconnect
    clearTimeout(_wsReconnectTimer);
    _wsReconnectTimer = setTimeout(connectRealtime, _wsReconnectDelay);
    _wsReconnectDelay = Math.min(_wsReconnectDelay * 1.5, 30000);
  };
  _ws.onerror = () => { try { _ws.close(); } catch (e) {} };
}

function disconnectRealtime() {
  clearTimeout(_wsReconnectTimer);
  try { _ws?.close(); } catch (e) {}
  _ws = null;
}

// Dipanggil setiap kali server push perubahan role / masa aktif / limit download.
function handleAccountUpdate(freshUser) {
  if (!currentUser || !freshUser) return;
  const oldRole = currentUser.role;
  currentUser = { ...currentUser, ...freshUser };
  _saveUser(currentUser);

  if (els.profileRole) els.profileRole.textContent = currentUser.role;
  renderPackageCard(currentUser);

  if (oldRole && freshUser.role && oldRole !== freshUser.role) {
    showRoleUpdateToast(oldRole, freshUser.role);
    loadGames();
    loadBypasses();
  }
}

// Dipanggil kalau admin menekan "Reset Device" saat app ini sedang aktif — paksa
// logout sekarang juga (tanpa perlu restart app), user tinggal login ulang dan
// perangkat ini otomatis didaftarkan lagi sebagai perangkat baru.
function handleDeviceReset() {
  disconnectRealtime();
  localStorage.removeItem('token');
  localStorage.removeItem('_savedUser');
  currentUser = null;
  location.reload();
}

// ══════════════════════════════════════════════════════════════════════════
// AUTO REMOVE INSTALLED PREMIUM CONTENT
// Dipicu server (event WS 'premium:cleanup') begitu masa aktif Gold/Platinum
// habis — realtime kalau app lagi kebuka, atau lewat checkPendingPremiumCleanups()
// begitu app dibuka lagi kalau tadi sempat tertutup. TIDAK ADA cara bagi user
// biasa untuk membatalkan proses ini (tidak ada tombol skip/cancel di modal-nya).
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

  // SILENT untuk manual (dipicu admin dari 🧹/Hapus Manual) — sesuai permintaan
  // eksplisit, TIDAK ADA popup/notifikasi apapun yang ditampilkan ke user, file
  // tetap dihapus di background seperti biasa. Auto-delete setelah paket Gold/
  // Platinum expired TETAP tampilkan modal peringatan seperti biasa.
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

    if (removed) removeLocalInstallMeta(item.historyId);
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

  // Refresh tampilan supaya konten yang barusan dihapus langsung hilang dari Histori/Games
  setTimeout(() => {
    loadHistori().catch(() => {});
    loadGames().catch(() => {});
    loadBypasses().catch(() => {});
  }, 300);
}

// ── Modal Auto Remove — 2 state: 'start' (peringatan sebelum hapus, tanpa tombol
// tutup — proses tidak bisa dibatalkan) dan 'done' (hasil akhir + tombol Perpanjang/Beli). ──
function showPremiumCleanupModal(state, job, resultData) {
  let overlay = document.getElementById('premiumCleanupOverlay');
  if (!overlay) return;
  overlay.style.display = 'flex';
  const roleLabel = String(job.role || '').toUpperCase();

  if (state === 'start') {
    const isManual = job.reason === 'manual';
    overlay.innerHTML = `
      <div class="pcm-modal">
        <div class="pcm-icon pcm-icon--warn">${isManual ? '🧹' : '⏰'}</div>
        <div class="pcm-title">${isManual ? 'Admin Menghapus Konten Kamu' : `Paket ${escapeHtml(roleLabel)} Kamu Telah Berakhir`}</div>
        <div class="pcm-desc">
          Seluruh <b>${job.gameCount || 0} game</b> dan <b>${job.bypassCount || 0} bypass</b>${isManual ? '' : ' premium'} yang kamu install
          akan otomatis dihapus dari PC ini sekarang. Proses ini tidak bisa dibatalkan.
        </div>
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

  overlay.innerHTML = `
    <div class="pcm-modal">
      <div class="pcm-icon ${ok ? 'pcm-icon--ok' : 'pcm-icon--partial'}">${ok ? '✅' : '⚠️'}</div>
      <div class="pcm-title">${ok ? (isManualDone ? 'Konten Berhasil Dihapus' : 'Konten Premium Berhasil Dihapus') : 'Penghapusan Selesai (Sebagian Gagal)'}</div>
      <div class="pcm-desc">
        <b>${removedGames.length}</b> game dan <b>${removedBypass.length}</b> bypass${isManualDone ? '' : ' premium'} sudah dihapus dari PC ini.
        ${failed.length ? `<br><span style="color:#ffb4b4;">${failed.length} item gagal dihapus otomatis — cek folder Steam/game secara manual kalau perlu.</span>` : ''}
      </div>
      <div class="pcm-actions">
        ${resultData?.needRestartSteam ? `<button class="pcm-btn pcm-btn--ghost" id="pcmRestartSteamBtn">🔄 Restart Steam</button>` : ''}
        <button class="pcm-btn pcm-btn--primary" id="pcmUpgradeBtn">🛒 Perpanjang / Beli Paket</button>
      </div>
      <button class="pcm-close" id="pcmCloseBtn">Tutup</button>
    </div>`;

  document.getElementById('pcmUpgradeBtn')?.addEventListener('click', () => {
    closePremiumCleanupModal();
    showPage('store');
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


const PKG_UNIT_LABEL = { minutes: 'menit', hours: 'jam', days: 'hari' };
function renderPackageCard(user) {
  const status = user?.accountStatus;
  const badgeEl = document.getElementById('pkgBadge');
  const badgeTextEl = document.getElementById('pkgBadgeText');
  const periodBlock = document.getElementById('pkgPeriodBlock');
  const numEl = document.getElementById('pkgPeriodNumber');
  const unitEl = document.getElementById('pkgPeriodUnit');
  const untilEl = document.getElementById('pkgPeriodUntil');
  const fillEl = document.getElementById('pkgProgressFill');
  const upgradeBtn = document.getElementById('pkgUpgradeBtn');
  if (!badgeEl || !status) return;

  const ROLE_LABEL = { public: 'Public', gold: 'Gold Aktif', platinum: 'Platinum Aktif', admin: 'Admin' };
  badgeEl.className = `pkg-badge ${user.role}`;
  badgeTextEl.textContent = ROLE_LABEL[user.role] || user.role;

  if (status.hasActivePeriod) {
    periodBlock.style.display = '';
    if (status.activeUntil) {
      const msLeft = Math.max(0, new Date(status.activeUntil).getTime() - Date.now());
      const daysLeft = msLeft / 86400000;
      let value, unit;
      if (daysLeft >= 1) { value = Math.ceil(daysLeft); unit = 'hari'; }
      else if (msLeft >= 3600000) { value = Math.ceil(msLeft / 3600000); unit = 'jam'; }
      else { value = Math.max(0, Math.ceil(msLeft / 60000)); unit = 'menit'; }

      numEl.textContent = value;
      unitEl.textContent = unit;
      untilEl.textContent = 'aktif s/d ' + new Date(status.activeUntil).toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' });

      // Progress bar: dianggap penuh di 30 hari, makin sedikit makin merah
      const pct = Math.max(4, Math.min(100, Math.round((msLeft / (30 * 86400000)) * 100)));
      fillEl.style.width = pct + '%';
      fillEl.className = 'pkg-progress-fill' + (daysLeft <= 1 ? ' danger' : daysLeft <= 3 ? ' warn' : '');
    } else {
      numEl.textContent = '∞'; unitEl.textContent = ''; untilEl.textContent = 'Belum ada batas waktu';
      fillEl.style.width = '100%'; fillEl.className = 'pkg-progress-fill';
    }
  } else {
    periodBlock.style.display = 'none';
  }

  const setQuota = (elId, q) => {
    const el = document.getElementById(elId);
    if (!el) return;
    if (!q || q.unlimited) { el.textContent = 'Unlimited'; el.className = 'pkg-quota-value unlimited'; return; }
    el.textContent = `${q.remaining}/${q.limit}`;
    el.className = 'pkg-quota-value' + (q.remaining === 0 ? ' empty' : q.remaining <= 1 ? ' low' : '');
  };
  setQuota('pkgQuotaGame', status.download?.game);
  setQuota('pkgQuotaBypass', status.download?.bypass);

  if (upgradeBtn) {
    upgradeBtn.style.display = (user.role === 'platinum') ? 'none' : '';
  }
}

function wirePackageCard() {
  document.getElementById('pkgUpgradeBtn')?.addEventListener('click', () => {
    showPage('store');
  });
}

// ── NOTIFICATION BELL ──
let _notifUnread = 0;
function setNotifUnreadCount(n) {
  _notifUnread = n || 0;
  const dot = document.getElementById('notifDot');
  if (!dot) return;
  if (_notifUnread <= 0) { dot.style.display = 'none'; return; }
  dot.style.display = 'flex';
  dot.className = 'dot count';
  dot.textContent = _notifUnread > 9 ? '9+' : String(_notifUnread);
}

async function loadNotifications() {
  const listEl = document.getElementById('notifList');
  if (!listEl) return;
  try {
    const data = await api('/api/notifications?limit=30');
    setNotifUnreadCount(data.unread);
    if (!data.items || data.items.length === 0) {
      listEl.innerHTML = '<div class="notif-empty">Belum ada notifikasi.</div>';
      return;
    }
    listEl.innerHTML = data.items.map(notifItemHtml).join('');
    listEl.querySelectorAll('.notif-item').forEach(itemEl => {
      itemEl.addEventListener('click', async () => {
        const id = itemEl.dataset.id;
        if (itemEl.classList.contains('unread')) {
          itemEl.classList.remove('unread');
          try { await api(`/api/notifications/${id}/read`, { method: 'PUT' }); } catch (e) {}
          setNotifUnreadCount(Math.max(0, _notifUnread - 1));
        }
      });
    });
  } catch (e) {
    listEl.innerHTML = '<div class="notif-empty">Gagal memuat notifikasi.</div>';
  }
}

const NOTIF_ICON = {
  download_success: '✅', download_failed: '❌', quota_low: '⚠️',
  quota_empty: '⛔', period_low: '⏳', period_expired: '🚫',
  renewal: '🔄', announcement: '📢'
};
function notifItemHtml(n) {
  const icon = NOTIF_ICON[n.type] || '🔔';
  return `<div class="notif-item ${n.read ? '' : 'unread'}" data-id="${n._id}">
    <span class="ni-icon">${icon}</span>
    <div>
      <div class="ni-title">${escapeHtml(n.title)}</div>
      <div class="ni-msg">${escapeHtml(n.message)}</div>
      <div class="ni-time">${timeAgo(n.createdAt)}</div>
    </div>
  </div>`;
}

function wireNotifBell() {
  const bell = document.getElementById('notifBell');
  const dropdown = document.getElementById('notifDropdown');
  if (!bell || !dropdown) return;

  bell.addEventListener('click', (e) => {
    e.stopPropagation();
    const willOpen = !dropdown.classList.contains('open');
    dropdown.classList.toggle('open', willOpen);
    if (willOpen) loadNotifications();
  });
  document.addEventListener('click', (e) => {
    if (!bell.contains(e.target)) dropdown.classList.remove('open');
  });
  document.getElementById('notifMarkAllRead')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    try { await api('/api/notifications/read-all', { method: 'PUT' }); } catch (er) {}
    setNotifUnreadCount(0);
    document.querySelectorAll('.notif-item.unread').forEach(el => el.classList.remove('unread'));
  });
}

// Notifikasi baru dari WS: update badge, refresh list kalau dropdown lagi kebuka,
// dan tampilkan toast kecil di pojok kanan-atas.
function handleIncomingNotification(n) {
  _notifUnread += 1;
  setNotifUnreadCount(_notifUnread);
  const dropdown = document.getElementById('notifDropdown');
  if (dropdown?.classList.contains('open')) loadNotifications();
  showAppNotifToast(n);

  // Notifikasi terkait limit/masa aktif langsung dampaknya ke kartu paket —
  // minta data akun terbaru biar kartu ikut ter-update tanpa nunggu polling.
  if (['quota_low', 'quota_empty', 'period_low', 'period_expired'].includes(n.type)) {
    api('/api/me').then(fresh => { if (fresh) { currentUser = { ...currentUser, ...fresh }; renderPackageCard(currentUser); } }).catch(() => {});
  }
}

function showAppNotifToast(n) {
  let el = document.querySelector('.app-notif-toast');
  if (!el) { el = document.createElement('div'); el.className = 'app-notif-toast'; document.body.appendChild(el); }
  const icon = NOTIF_ICON[n.type] || '🔔';
  el.innerHTML = `<span class="ant-icon">${icon}</span><div><div class="ant-title">${escapeHtml(n.title)}</div><div class="ant-msg">${escapeHtml(n.message)}</div></div>`;

  el.classList.remove('show');
  // Buang & paksa reflow dulu sebelum nambah 'show' lagi, supaya kalau toast
  // sebelumnya baru saja ditutup (atau masih kebuka), animasi slide-in-nya tetap
  // jalan bersih dari awal, bukan cuma diem di posisi lama.
  void el.offsetWidth;
  requestAnimationFrame(() => el.classList.add('show'));

  // Selalu hilang otomatis tepat 4 detik setelah muncul (lihat scheduleToastAutoHide).
  scheduleToastAutoHide(el, 'show');
}

function showRoleUpdateToast(oldRole, newRole) {
  let toastEl = document.querySelector('.role-update-toast');
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.className = 'role-update-toast';
    document.body.appendChild(toastEl);
  }

  const icon      = ROLE_BADGE_ICON[newRole] || '🌐';
  const upgraded  = (CLIENT_ROLE_LEVEL[newRole] ?? 0) > (CLIENT_ROLE_LEVEL[oldRole] ?? 0);
  const downgraded = (CLIENT_ROLE_LEVEL[newRole] ?? 0) < (CLIENT_ROLE_LEVEL[oldRole] ?? 0);
  const headerIcon = upgraded ? '🎉' : downgraded ? '📦' : '🔄';
  const oldIcon   = ROLE_BADGE_ICON[oldRole] || '🌐';

  toastEl.className = `role-update-toast show ${newRole}`;
  toastEl.innerHTML = `
    <div class="rut-header">
      <span class="rut-header-icon">${headerIcon}</span>
      <span class="rut-header-title">Paket Diperbarui!</span>
      <button class="rut-close" onclick="this.closest('.role-update-toast').classList.remove('show')">×</button>
    </div>
    <div class="rut-body">
      <div class="rut-change-row">
        <span class="rut-role-old">${oldIcon} ${ROLE_TOAST_LABEL[oldRole] || oldRole}</span>
        <span class="rut-arrow">→</span>
        <span class="rut-role-new ${newRole}">${icon} ${ROLE_TOAST_LABEL[newRole] || newRole}</span>
      </div>
      <div class="rut-desc">${ROLE_TOAST_DESC[newRole] || ''}</div>
    </div>
  `;
  scheduleToastAutoHide(toastEl, 'show');
}

// ── CONFIG ──
async function loadConfig() {
  try {
    const res = await fetch(SERVER_URL + '/api/config');
    const cfg = await res.json();
    document.title = cfg.appName;
    const nameEl = document.getElementById('nvLoginAppName');
    if (nameEl) nameEl.textContent = cfg.appName;
    const tbTitle = document.querySelector('.titlebar-title');
    if (tbTitle) tbTitle.textContent = cfg.appName;
  } catch (e) {}
}

// ── START ──
document.addEventListener('DOMContentLoaded', () => {
  grabElements();
  wireTitlebar();
  wireNavigation();
  wireSearch();
  wireGamesRoleFilter();
  wireBypassesRoleFilter();
  wireDashCategoryFilter();
  wireDetailPage();
  wireTutorialCategoryFilter();
  wireTutorialSearch();
  wireTutorialDetailNav();
  wireHistoriTabs();
  wirePackageCard();
  wireNotifBell();
  loadConfig();
  tryAutoLogin();
});