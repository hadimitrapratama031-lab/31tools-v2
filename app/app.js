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

async function api(path, options = {}) {
  const token = localStorage.getItem('token');
  const res = await fetch(SERVER_URL + path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {})
    }
  });
  const data = await res.json().catch(() => ({}));
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
  els.logoutLink   = document.getElementById('navLogout');
  els.topbarH2     = document.querySelector('.topbar h2');
  els.searchInput  = document.querySelector('.search input');

  els.dashSaleGrid   = document.getElementById('dashSaleGrid');
  els.dashNewGrid    = document.getElementById('dashNewGrid');
  els.gamesOnlyGrid  = document.getElementById('gamesOnlyGrid');
  els.historiListPage = document.getElementById('historiListPage');
  els.gamesRoleFilter = document.getElementById('gamesRoleFilter');
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

// ── NAVIGASI ANTAR HALAMAN ──
const PAGE_IDS = {
  dashboard: 'pageDashboard',
  games: 'pageGames',
  favorites: 'pageFavorites',
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
      localStorage.removeItem('token');
      location.reload();
    });
  }
}

// ── LOGIN OVERLAY (dibuat lewat JS, tema disamakan) ──
let loginStatusEl, pollTimer = null;

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

function showLogin() {
  if (els.app) els.app.style.display = 'none';
  if (!document.getElementById('nvLoginOverlay')) buildLoginOverlay();
}

function hideLogin() {
  const overlay = document.getElementById('nvLoginOverlay');
  if (overlay) overlay.remove();
  if (els.app) els.app.style.display = '';
}

function startLogin() {
  const deviceId = getOrCreateDeviceId();
  const openExternal = window.electronAPI?.openExternal || (url => window.open(url, '_blank'));
  openExternal(`${SERVER_URL}/auth/discord?state=${encodeURIComponent(deviceId)}`);
  if (loginStatusEl) loginStatusEl.textContent = 'Menunggu login di browser...';
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    try {
      const res = await fetch(`${SERVER_URL}/auth/poll?state=${encodeURIComponent(deviceId)}`);
      const data = await res.json();
      if (data.ready) {
        clearInterval(pollTimer);
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
    const user = await api('/api/me'); // akun otomatis "terdeteksi" kalau token masih valid
    hideLogin();
    enterApp(user);
  } catch (e) {
    localStorage.removeItem('token');
    showLogin();
  }
}

// ── MASUK APP ──
let currentUser = null;
let allGames = [];

function enterApp(user) {
  currentUser = user;

  if (els.profileImg) els.profileImg.src = user.avatarUrl;
  if (els.profileName) els.profileName.textContent = user.username;
  if (els.profileRole) els.profileRole.textContent = user.role;

  if (els.topbarH2) els.topbarH2.textContent = `Have a good time ${user.username}!`;

  showPage('dashboard'); // halaman utama selalu yang pertama muncul
  loadGames();
}

const ROLE_BADGE_ICON = { public: '🌐', gold: '🥇', platinum: '💎' };
function roleBadgeHtml(role, inline = false) {
  const icon = ROLE_BADGE_ICON[role] || '🌐';
  const cls = inline ? 'role-pill-inline' : 'role-pill';
  return `<span class="${cls} ${role}">${icon} ${escapeHtml(role)}</span>`;
}

// ── RENDER KARTU GAME ──
function renderGameCard(item) {
  const art = item.imageUrl
    ? `background-image:url('${item.imageUrl}');background-size:cover;background-position:center;`
    : '';
  return `
    <div class="game-card">
      <div class="game-art" style="${art}">
        ${roleBadgeHtml(item.role)}
      </div>
      <div class="game-info">
        <h4 title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</h4>
        <div class="game-meta">
          ${roleBadgeHtml(item.role, true)}
          <button class="dl-btn" data-id="${item._id}" data-name="${escapeHtml(item.name)}">Download</button>
        </div>
      </div>
    </div>`;
}

function renderGrid(container, games) {
  if (!container) return;
  container.innerHTML = games.length
    ? games.map(renderGameCard).join('')
    : `<div style="color:#8577a3;font-size:13px;padding:10px 4px;">Belum ada game yang tersedia untuk paket kamu.</div>`;
  container.querySelectorAll('.dl-btn').forEach(btn => {
    btn.addEventListener('click', () => handleInstall('game', btn.dataset.id, btn.dataset.name));
  });
}

async function loadGames() {
  try {
    const games = await api('/api/games'); // list game 100% ikut role & isi database server
    allGames = games;

    if (els.gamesNavLink) {
      const badge = els.gamesNavLink.querySelector('.badge');
      if (badge) badge.textContent = games.length;
    }

    renderGrid(els.dashNewGrid, games);
    renderGrid(els.dashSaleGrid, [...games].reverse());

    // Kalau lagi buka halaman Games, refresh juga isinya (tetap ikut filter role yang lagi aktif)
    if (document.getElementById(PAGE_IDS.games)?.style.display !== 'none') {
      applyGamesRoleFilter();
    }
  } catch (e) {
    const msg = `<div style="color:#ff6b81;font-size:13px;">Gagal memuat game: ${escapeHtml(e.message)}</div>`;
    if (els.dashNewGrid) els.dashNewGrid.innerHTML = msg;
  }
}

// ── SEARCH ──
function wireSearch() {
  if (!els.searchInput) return;
  els.searchInput.addEventListener('input', () => {
    const q = els.searchInput.value.trim().toLowerCase();
    const filtered = q ? allGames.filter(g => g.name.toLowerCase().includes(q)) : allGames;
    renderGrid(els.dashNewGrid, filtered);
    if (document.getElementById(PAGE_IDS.games)?.style.display !== 'none') {
      const roleFiltered = activeGamesRoleFilter === 'all' ? filtered : filtered.filter(g => g.role === activeGamesRoleFilter);
      renderGrid(els.gamesOnlyGrid, roleFiltered);
    }
  });
}

// ── INSTALL -> catat ke histori ──
async function handleInstall(itemType, itemId, itemName) {
  try {
    await api('/api/history', { method: 'POST', body: JSON.stringify({ itemType, itemId }) });
  } catch (e) {
    alert('Gagal mencatat histori: ' + e.message);
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
  loadConfig();
  tryAutoLogin();
});