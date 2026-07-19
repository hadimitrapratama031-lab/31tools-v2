// ══════════════════════════════════════════════════════════════════════════
// NOVA LAUNCHER — RENDERER (app.js)
// ══════════════════════════════════════════════════════════════════════════
const SERVER_URL = 'https://31tools-v2-production.up.railway.app';

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
  els.gamesRoleFilter = document.getElementById('gamesRoleFilter');
  els.bypassesRoleFilter = document.getElementById('bypassesRoleFilter');
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
  setting: 'pageSetting'
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
      localStorage.removeItem('token');
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

  card.innerHTML = `
    <div style="font-size:42px;margin-bottom:10px;">🎮</div>
    <h2 id="nvLoginAppName" style="font-family:'Poppins',sans-serif;color:#f3eefc;margin:0 0 8px;font-size:20px;">GameDash</h2>
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
  return overlay;
}

function hideLogin() {
  const overlay = document.getElementById('nvLoginOverlay');
  if (overlay) overlay.style.display = 'none';
  if (els.app) els.app.style.display = '';
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

function startLogin() {
  const deviceId = getOrCreateDeviceId();
  const openExternal = window.electronAPI?.openExternal || (url => window.open(url, '_blank'));
  openExternal(`${SERVER_URL}/auth/discord?state=${encodeURIComponent(deviceId)}`);
  if (loginStatusEl) {
    loginStatusEl.textContent = 'Menunggu login di browser...';
    loginStatusEl.style.color = '#8f8ab0';
  }
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  pollTimer = setInterval(async () => {
    try {
      const res = await fetch(`${SERVER_URL}/auth/poll?state=${encodeURIComponent(deviceId)}`);
      const data = await res.json();
      if (data.ready) {
        clearInterval(pollTimer);
        pollTimer = null;
        localStorage.setItem('token', data.token);
        hideLogin();
        enterApp(data.user);
      }
    } catch (e) {}
  }, 2000);
}

async function tryAutoLogin() {
  const token = localStorage.getItem('token');
  if (!token) { showLogin(); return; }

  try {
    // Coba /api/me — server otomatis refresh token kalau expired
    const user = await api('/api/me');
    hideLogin();
    enterApp(user);
  } catch (e) {
    // Cek apakah error karena network (server offline) bukan karena token invalid
    const isNetworkError = e.message.includes('fetch') || e.message.includes('network') ||
                           e.message.includes('Failed to fetch') || e.message.includes('NetworkError');
    if (isNetworkError) {
      // Server offline — tetap show login tapi kasih info
      showLogin('Server tidak bisa dihubungi. Periksa koneksi internet.');
      return;
    }
    // Token benar-benar tidak valid — hapus dan minta login ulang
    localStorage.removeItem('token');
    showLogin();
  }
}

// ── MASUK APP ──
let currentUser = null;
let allGames = [];
let allBypasses = [];

function enterApp(user) {
  currentUser = user;

  if (els.profileImg) els.profileImg.src = user.avatarUrl;
  if (els.profileName) els.profileName.textContent = user.username;
  if (els.profileRole) els.profileRole.textContent = user.role;

  if (els.topbarH2) els.topbarH2.textContent = `Have a good time ${user.username}!`;

  showPage('dashboard'); // halaman utama selalu yang pertama muncul
  loadGames();
  loadBypasses();
  startAutoRefresh(); // ← polling berkala supaya game/bypass baru dari admin langsung muncul
}

// ── AUTO REFRESH — supaya game/bypass yang baru ditambahkan admin langsung
// muncul di app TANPA perlu restart. Poll setiap 15 detik + refresh instan
// begitu window app di-fokus lagi (misal user habis buka admin panel lalu balik).
let _autoRefreshTimer = null;
function startAutoRefresh() {
  if (_autoRefreshTimer) clearInterval(_autoRefreshTimer);
  _autoRefreshTimer = setInterval(async () => {
    if (!currentUser) return;
    await loadGames();
    await loadBypasses();
    applySearchAndFilters(); // supaya search/filter yang lagi aktif tidak ke-reset
  }, 15000); // tiap 15 detik

  // Refresh instan begitu app kembali difokuskan (alt-tab balik ke app)
  window.addEventListener('focus', async () => {
    if (!currentUser) return;
    await loadGames();
    await loadBypasses();
    applySearchAndFilters();
  });
}

const ROLE_BADGE_ICON = { public: '🌐', gold: '🥇', platinum: '💎' };
function roleBadgeHtml(role, inline = false) {
  const icon = ROLE_BADGE_ICON[role] || '🌐';
  const cls = inline ? 'role-pill-inline' : 'role-pill';
  return `<span class="${cls} ${role}">${icon} ${escapeHtml(role)}</span>`;
}

// ── Cek apakah role user cukup buat akses item ini ──
const CLIENT_ROLE_LEVEL = { public: 0, gold: 1, platinum: 2, admin: 3 };
function hasAccess(itemRole) {
  const myLevel   = CLIENT_ROLE_LEVEL[currentUser?.role] ?? 0;
  const itemLevel = CLIENT_ROLE_LEVEL[itemRole] ?? 0;
  return myLevel >= itemLevel;
}

// ── RENDER KARTU GAME ──
function renderGameCard(item) {
  const art = item.imageUrl
    ? `background-image:url('${item.imageUrl}');background-size:cover;background-position:center;`
    : '';
  const locked = !hasAccess(item.role);
  return `
    <div class="game-card${locked ? ' locked' : ''}">
      <div class="game-art" style="${art}">
        ${roleBadgeHtml(item.role)}
        ${locked ? `<div class="lock-overlay">🔒</div>` : ''}
      </div>
      <div class="game-info">
        <h4 title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</h4>
        <div class="game-meta">
          ${roleBadgeHtml(item.role, true)}
          ${locked
            ? `<button class="dl-btn locked-btn" disabled title="Butuh paket ${escapeHtml(item.role)}">🔒 Upgrade ke ${escapeHtml(item.role)}</button>`
            : `<button class="dl-btn" data-id="${item._id}" data-name="${escapeHtml(item.name)}">Download</button>`
          }
        </div>
      </div>
    </div>`;
}

function renderGrid(container, games) {
  if (!container) return;
  container.innerHTML = games.length
    ? games.map(renderGameCard).join('')
    : `<div style="color:#8577a3;font-size:13px;padding:10px 4px;">Belum ada game.</div>`;
  container.querySelectorAll('.dl-btn:not(.locked-btn)').forEach(btn => {
    btn.addEventListener('click', () => handleInstall('game', btn.dataset.id, btn.dataset.name));
  });
}

// ── RENDER KARTU BYPASS ──
function renderBypassCard(item) {
  const art = item.imageUrl
    ? `background-image:url('${item.imageUrl}');background-size:cover;background-position:center;`
    : '';
  const locked = !hasAccess(item.role);
  return `
    <div class="game-card${locked ? ' locked' : ''}">
      <div class="game-art" style="${art}">
        ${roleBadgeHtml(item.role)}
        ${locked ? `<div class="lock-overlay">🔒</div>` : ''}
      </div>
      <div class="game-info">
        <h4 title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</h4>
        <div class="game-meta">
          ${roleBadgeHtml(item.role, true)}
          ${locked
            ? `<button class="dl-btn locked-btn" disabled title="Butuh paket ${escapeHtml(item.role)}">🔒 Upgrade ke ${escapeHtml(item.role)}</button>`
            : `<button class="dl-btn" data-id="${item._id}" data-name="${escapeHtml(item.name)}">Install</button>`
          }
        </div>
      </div>
    </div>`;
}

function renderBypassGrid(container, bypasses) {
  if (!container) return;
  container.innerHTML = bypasses.length
    ? bypasses.map(renderBypassCard).join('')
    : `<div style="color:#8577a3;font-size:13px;padding:10px 4px;">Belum ada bypass.</div>`;
  // Bypass diinstall dengan cara yang SAMA seperti game — download lewat proxy server
  // (handleInstall), auto-detect folder game via App ID, lalu extract ke folder tersebut.
  // TIDAK ADA lagi tombol "Buka Link" / shell.openExternal ke link mentah.
  container.querySelectorAll('.dl-btn:not(.locked-btn)').forEach(btn => {
    btn.addEventListener('click', () => handleInstall('bypass', btn.dataset.id, btn.dataset.name));
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

    // Render ke dashboard grid
    renderGrid(els.dashNewGrid, games);
    renderGrid(els.dashSaleGrid, [...games].reverse());

    // Selalu render ke gamesOnlyGrid juga (bukan cuma cek display) supaya
    // grid sudah terisi walau user belum pernah buka halaman Games
    applyGamesRoleFilter();

  } catch (e) {
    const msg = `<div style="color:#ff6b81;font-size:13px;">Gagal memuat game: ${escapeHtml(e.message)}</div>`;
    if (els.dashNewGrid) els.dashNewGrid.innerHTML = msg;
    if (els.gamesOnlyGrid) els.gamesOnlyGrid.innerHTML = msg;
  }
}

// ── SEARCH ──
function applySearchAndFilters() {
  if (!els.searchInput) return;
  const q = els.searchInput.value.trim().toLowerCase();
  const filtered = q ? allGames.filter(g => g.name.toLowerCase().includes(q)) : allGames;
  renderGrid(els.dashNewGrid, filtered);
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
      await api('/api/history', {
        method: 'POST',
        body: JSON.stringify({ itemType, itemId, extractedFiles: result.extractedFiles || [], steamPath })
      });

      dlSetSuccess(
        'Inject berhasil!',
        `${result.extractedFiles?.length || 0} file berhasil dipasang.
⚠️ Restart Steam agar perubahan aktif.`
      );

    } else {
      // ── BYPASS INSTALL (sistem persis project lama — download langsung dari link admin) ──
      dlSetStage('Mengambil link bypass...', 1);
      const linkData = await api(`/api/bypasses/${itemId}/download-link`);
      if (!linkData.directUrl) throw new Error(linkData.error || 'Link bypass tidak ditemukan. Pastikan admin sudah mengisi link file bypass.');

      const appId = linkData.steamAppId || linkData.appId;
      if (!appId) throw new Error('App ID belum diisi admin pada bypass ini. Hubungi admin.');

      dlSetStage('Mendeteksi Steam...', 1);
      const steamPath = await window.electronAPI.getSteamPath();
      if (!steamPath) throw new Error('Steam tidak ditemukan. Pastikan Steam sudah terinstall.');

      dlSetStage(`Mencari folder game (App ID: ${appId})...`, 2);
      const folderResult = await window.electronAPI.findGameFolderByAppId({ steamPath, appId: String(appId) });
      if (!folderResult.found) throw new Error(folderResult.error || `Game dengan App ID ${appId} belum terinstall di Steam. Install gamenya dulu lalu coba lagi.`);

      dlSetStage('Mengunduh bypass...', 2);
      result = await window.electronAPI.installBypass({
        folderPath:  folderResult.folderPath,
        driveUrl:    linkData.directUrl,
        userId:      currentUser?.discordId || currentUser?.userId || '',
        deviceId:    getOrCreateDeviceId(),
        gameId:      itemId,
        gameName:    itemName,
        steamAppId:  String(appId),
      });
      if (result.cancelled) { dlModalHide(); return; }
      if (!result.success)  throw new Error(result.error || 'Install bypass gagal tanpa keterangan.');

      dlSetStage('Menyimpan ke histori...', 3);
      await api('/api/history', {
        method: 'POST',
        body: JSON.stringify({
          itemType, itemId,
          extractedFiles: result.extractedFiles || [],
          folderPath: result.folderPath || null
        })
      });

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
  }
}

// ── HALAMAN HISTORI ──
async function loadHistori() {
  if (!els.historiListPage) return;
  els.historiListPage.innerHTML = `<div style="color:#8577a3;font-size:13px;">Memuat histori...</div>`;
  try {
    const rows = await api('/api/history');
    renderHistoriPage(rows);
  } catch (e) {
    els.historiListPage.innerHTML = `<div style="color:#ff6b81;font-size:13px;">Gagal memuat histori: ${escapeHtml(e.message)}</div>`;
  }
}

function renderHistoriPage(rows) {
  if (!els.historiListPage) return;
  els.historiListPage.innerHTML = rows.length ? rows.map(h => `
    <div class="histori-row">
      <div class="hicon">${h.itemType === 'game' ? '🎮' : '🛡️'}</div>
      <div class="hinfo">
        <div class="hname">${escapeHtml(h.itemName)}</div>
        <div class="htime">${timeAgo(h.createdAt)}</div>
      </div>
      <button class="huninstall" data-id="${h._id}">Uninstall</button>
    </div>
  `).join('') : `<div style="color:#8577a3;font-size:13px;">Belum ada histori.</div>`;

  els.historiListPage.querySelectorAll('.huninstall').forEach(btn => {
    btn.addEventListener('click', async () => {
      try {
        await api('/api/history/' + btn.dataset.id, { method: 'DELETE' });
        loadHistori();
      } catch (e) {
        alert('Gagal uninstall: ' + e.message);
      }
    });
  });
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
  loadConfig();
  tryAutoLogin();
});