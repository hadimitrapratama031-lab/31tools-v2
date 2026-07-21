const SERVER_URL = '';

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

const ROLE_TAG_ICON = { public: '🌐', gold: '🥇', platinum: '💎', admin: '👑' };
function roleTagHtml(role) {
  const icon = ROLE_TAG_ICON[role] || '';
  return `<span class="tag ${role}">${icon} ${escapeHtml(role)}</span>`;
}

async function api(path, options = {}) {
  const token = localStorage.getItem('adminToken');
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

// ─── TOAST ───
function showToast(msg, type = 'default') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  const icon = type === 'success' ? '✓' : type === 'error' ? '✕' : 'ℹ';
  const color = type === 'success' ? '#4ade80' : type === 'error' ? '#f87171' : '#a78bfa';
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span style="color:${color};font-size:15px;">${icon}</span> ${escapeHtml(msg)}`;
  container.appendChild(toast);
  setTimeout(() => { toast.style.opacity = '0'; toast.style.transform = 'translateY(10px)'; toast.style.transition = 'all .3s'; setTimeout(() => toast.remove(), 300); }, 3000);
}

// ─── LOGIN ───
document.getElementById('btnAdminLogin').addEventListener('click', doLogin);
document.getElementById('adminPassword').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });

async function doLogin() {
  const password = document.getElementById('adminPassword').value;
  const errEl = document.getElementById('loginError');
  const btn = document.getElementById('btnAdminLogin');
  errEl.textContent = '';
  btn.textContent = 'Masuk...';
  btn.disabled = true;
  try {
    const data = await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ password }) });
    localStorage.setItem('adminToken', data.token);
    showShell();
  } catch (e) {
    errEl.textContent = e.message;
    btn.textContent = 'Masuk';
    btn.disabled = false;
  }
}

document.getElementById('btnAdminLogout').addEventListener('click', () => {
  api('/api/admin/logout', { method: 'POST' }).catch(() => {});
  localStorage.removeItem('adminToken');
  if (_adminWs) { try { _adminWs.onclose = null; _adminWs.close(); } catch {} }
  location.reload();
});

// ─── LOGIN VIA DISCORD (Admin) ───
// Alurnya sama persis kayak login di app Electron (lihat main.js): buka tab baru ke
// /auth/discord?state=..., lalu polling /auth/poll?state=... tiap 2 detik sampai
// token siap. Bedanya di sini: begitu token didapat, kita cek dulu ke
// /api/admin/verify-discord-token — token Discord CUMA disimpan sebagai adminToken
// kalau role user itu di database memang 'admin' (lihat requireAdmin di server.js).
document.getElementById('btnAdminLoginDiscord').addEventListener('click', doDiscordAdminLogin);

let _discordLoginPollTimer = null;
async function doDiscordAdminLogin() {
  const btn = document.getElementById('btnAdminLoginDiscord');
  const statusEl = document.getElementById('loginDiscordStatus');
  const errEl = document.getElementById('loginError');
  errEl.textContent = '';
  statusEl.className = 'login-hint';
  statusEl.textContent = '';

  const state = 'admin_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  const authWindow = window.open(`${SERVER_URL}/auth/discord?state=${encodeURIComponent(state)}`, '_blank', 'width=480,height=760');
  if (!authWindow) {
    statusEl.className = 'login-hint error';
    statusEl.textContent = 'Popup diblokir browser. Izinkan popup untuk halaman ini, lalu klik tombol sekali lagi.';
    return;
  }

  const originalText = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = 'Menunggu login di tab Discord...';
  statusEl.className = 'login-hint';
  statusEl.textContent = 'Selesaikan login di tab yang baru terbuka — halaman ini otomatis lanjut begitu login berhasil.';

  const deadline = Date.now() + 3 * 60 * 1000; // 3 menit timeout, cukup buat login manual
  clearInterval(_discordLoginPollTimer);

  const stop = (msg, isError) => {
    clearInterval(_discordLoginPollTimer);
    btn.disabled = false;
    btn.innerHTML = originalText;
    statusEl.className = isError ? 'login-hint error' : 'login-hint';
    statusEl.textContent = msg || '';
  };

  _discordLoginPollTimer = setInterval(async () => {
    if (Date.now() > deadline) return stop('Waktu login habis. Coba lagi.', true);
    if (authWindow.closed) return stop('Tab Discord ditutup sebelum login selesai. Coba lagi.', true);

    try {
      const res = await fetch(`${SERVER_URL}/auth/poll?state=${encodeURIComponent(state)}`);
      const data = await res.json();
      if (!data.ready) return; // masih nunggu user login di tab satunya

      clearInterval(_discordLoginPollTimer);

      // Login Discord berhasil — sekarang pastikan akun ini benar admin sebelum dipakai.
      try {
        const check = await fetch(`${SERVER_URL}/api/admin/verify-discord-token`, {
          headers: { Authorization: `Bearer ${data.token}` }
        });
        const checkData = await check.json().catch(() => ({}));
        if (!check.ok) return stop(checkData.error || 'Akun ini belum punya akses admin.', true);

        localStorage.setItem('adminToken', data.token);
        btn.disabled = false;
        btn.innerHTML = originalText;
        statusEl.className = 'login-hint success';
        statusEl.textContent = `✓ Login sebagai ${checkData.admin?.username || 'Admin'}.`;
        showShell();
      } catch (e2) {
        stop('Gagal memverifikasi akses admin: ' + e2.message, true);
      }
    } catch (e) {
      // hiccup jaringan sesaat — biarkan interval berikutnya coba lagi
    }
  }, 2000);
}

function showShell() {
  document.getElementById('loginWrap').style.display = 'none';
  document.getElementById('shell').style.display = 'flex';
  loadAdminCategories();
  loadPage('games');
  connectAdminWS();
}

// ── Cek sesi saat halaman di-refresh/dibuka ──
// SEBELUMNYA: langsung showShell() kalau ada token di localStorage, TANPA verifikasi
// ke server dulu. Kalau tokennya sudah expired/invalid, shell tetap muncul tapi SEMUA
// data gagal load (401 di setiap request) — kelihatan "stuck", dan satu-satunya jalan
// keluar cuma logout manual lalu login lagi.
// SEKARANG: verifikasi dulu ke /api/admin/verify. Valid → showShell(). Tidak valid →
// hapus token & tetap di layar login (bersih, tidak nyangkut setengah-jalan).
async function restoreSession() {
  const token = localStorage.getItem('adminToken');
  if (!token) return; // tidak ada token, tetap di layar login (default)

  const loginWrap = document.getElementById('loginWrap');
  const errEl = document.getElementById('loginError');
  loginWrap.style.opacity = '0.5'; // kasih tanda lagi mengecek sesi

  try {
    await api('/api/admin/verify');
    loginWrap.style.opacity = '';
    showShell();
  } catch (e) {
    localStorage.removeItem('adminToken');
    loginWrap.style.opacity = '';
    if (errEl) errEl.textContent = 'Sesi kamu berakhir, silakan login lagi.';
  }
}
restoreSession();

// ─── NAVIGASI ───
const PAGE_META = {
  dashboard: { title: 'Dashboard',  breadcrumb: 'Pages / Dashboard' },
  games:     { title: 'Game',       breadcrumb: 'Pages / Game' },
  bypasses:  { title: 'Bypass',     breadcrumb: 'Pages / Bypass' },
  banners:   { title: 'Banner',     breadcrumb: 'Pages / Banner' },
  tutorial:  { title: 'Kelola Tutorial', breadcrumb: 'Pages / Tutorial' },
  leaderboard:{ title: 'Top Installer', breadcrumb: 'Pages / Top Installer' },
  users:     { title: 'Users',      breadcrumb: 'Pages / Users' },
  history:   { title: 'Histori',    breadcrumb: 'Pages / Histori' },
  logs:      { title: 'Logs',       breadcrumb: 'Pages / Logs' },
  verifyrole:{ title: 'Verify Role',breadcrumb: 'Pages / Verify Role' },
  webhooks:  { title: 'Webhook Settings', breadcrumb: 'Pages / Webhook Settings' },
  hubcap:    { title: 'Hubcap API', breadcrumb: 'Pages / Hubcap API' },
  paket:     { title: 'Paket', breadcrumb: 'Pages / Paket' },
};
let currentPage = 'games';

document.querySelectorAll('.nav-item').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    loadPage(btn.dataset.page);
  });
});

function loadPage(page) {
  currentPage = page;
  const meta = PAGE_META[page] || { title: page, breadcrumb: 'Pages / ' + page };
  document.getElementById('pageTitle').textContent = meta.title;
  document.getElementById('topbarBreadcrumb').textContent = meta.breadcrumb;
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const pageEl = document.getElementById('page' + page.charAt(0).toUpperCase() + page.slice(1));
  if (pageEl) pageEl.classList.add('active');

  // Update active nav
  document.querySelectorAll('.nav-item').forEach(b => {
    b.classList.toggle('active', b.dataset.page === page);
  });

  const addBtn = document.getElementById('btnAddItem');
  addBtn.style.display = (page === 'games' || page === 'bypasses') ? 'inline-flex' : 'none';

  if (page === 'dashboard') renderDashboard();
  else if (page === 'games') renderTable('games');
  else if (page === 'bypasses') renderTable('bypasses');
  else if (page === 'banners') renderBannerAdmin();
  else if (page === 'tutorial') renderTutorialAdmin();
  else if (page === 'leaderboard') renderLeaderboardAdmin();
  else if (page === 'users') renderUsers();
  else if (page === 'history') renderHistory();
  else if (page === 'logs') renderLogs();
  else if (page === 'verifyrole') renderVerifyRole();
  else if (page === 'webhooks') renderWebhookSettings();
  else if (page === 'hubcap') renderHubcapPage();
  else if (page === 'paket') renderPaketSettings();
}

document.getElementById('btnAddItem').addEventListener('click', () => openItemModal(currentPage, null));

// ─── DASHBOARD ───
let _dashboardLoaded = false;

function setDashLoading(isLoading) {
  document.querySelectorAll('#pageDashboard .stat-card-value, #pageDashboard .mini-stat-value').forEach(el => {
    el.classList.toggle('skeleton', isLoading && el.textContent === '—');
  });
}

async function renderDashboard() {
  setDashLoading(true);
  try {
    const d = await api('/api/admin/dashboard');
    applyDashboardData(d);
    _dashboardLoaded = true;
  } catch(e) {
    showToast('Gagal memuat dashboard: ' + e.message, 'error');
  } finally {
    setDashLoading(false);
  }
}

function bump(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.remove('stat-bump');
  void el.offsetWidth; // restart animasi
  el.classList.add('stat-bump');
}

function applyDashboardData(d) {
  // Welcome panel
  if (d.admin) {
    setText('welcomeAdminName', d.admin.username || 'Admin');
    setText('welcomeAdminRole', d.admin.role || '—');
    setText('welcomeLastLogin', d.admin.lastLoginAt ? timeAgo(d.admin.lastLoginAt) : 'Sesi ini');
    const sideName = document.querySelector('.sidebar-user-name');
    const sideRole = document.querySelector('.sidebar-user-role');
    if (sideName) sideName.textContent = d.admin.username || 'Administrator';
    if (sideRole) sideRole.textContent = d.admin.role || 'Super Admin';
  }

  // Total Users
  setText('dashStatUsers',     d.totalUsers    ?? '—');
  setText('dashStatLogins',    d.loginsToday   ?? '—');
  setText('dashStatUsersToday', d.usersToday   ?? '—');
  setText('dashStatUsersWeek',  d.usersWeek    ?? '—');

  // Total Game
  setText('dashStatGames',           d.totalGames    ?? '—');
  setText('dashStatBypasses',        d.totalBypasses ?? '—');
  setText('dashStatGamesActive',     d.gamesActive   ?? '—');
  setText('dashStatGamesInactive',   d.gamesInactive ?? '—');
  setText('dashStatGamesWithBypass', d.gamesWithBypass ?? '—');

  // Gold Aktif
  setText('dashStatGold',     d.activeGold    ?? '—');
  setText('dashStatPlat',     d.activePlatinum ?? '—');
  setText('dashStatPublic',   d.totalPublic   ?? '—');
  setText('dashStatPctGold',  d.pctGold       ?? '—');
  setText('dashStatPctPlat',  d.pctPlatinum   ?? '—');

  // Total Install
  setText('dashStatInstalls',      d.totalInstalls  ?? '—');
  setText('dashStatWeek',          d.installsWeek   ?? '—');
  setText('dashStatInstallsToday', d.installsToday  ?? '—');
  setText('dashStatInstallsMonth', d.installsMonth  ?? '—');

  // Mini stats (Statistik Bawah)
  setText('miniActivePackage', d.premiumTotal ?? '—');
  setText('miniPubCount',  d.totalPublic    ?? '—');
  setText('miniGoldCount', d.activeGold     ?? '—');
  setText('miniPlatCount', d.activePlatinum ?? '—');

  setText('miniInstallTotal', d.totalInstalls ?? '—');
  setText('miniInstallToday', d.installsToday ?? '—');
  setText('miniInstallWeek',  d.installsWeek  ?? '—');
  setText('miniInstallMonth', d.installsMonth ?? '—');

  setText('miniTotalGames',    d.totalGames    ?? '—');
  setText('miniGamesActive',   d.gamesActive   ?? '—');
  setText('miniGamesInactive', d.gamesInactive ?? '—');

  setText('miniTotalBypasses',   d.totalBypasses    ?? '—');
  setText('miniBypassActive',    d.bypassesActive   ?? '—');
  setText('miniBypassInactive',  d.bypassesInactive ?? '—');

  // Donut — Distribusi Role
  const totalU = (d.totalUsers ?? 0) || 1;
  const gold   = d.activeGold ?? 0;
  const plat   = d.activePlatinum ?? 0;
  const pub    = d.totalPublic ?? Math.max(0, totalU - gold - plat);
  const CIRC   = 2 * Math.PI * 48; // ~301.6
  setDonut('donutPublic', (pub  / totalU) * CIRC, 0);
  setDonut('donutGold',   (gold / totalU) * CIRC, (pub / totalU) * CIRC);
  setDonut('donutPlat',   (plat / totalU) * CIRC, ((pub + gold) / totalU) * CIRC);
  setText('donutPct', totalU > 0 ? Math.round(((gold + plat) / totalU) * 100) + '%' : '—');
  setText('donutLegPublic', pub);
  setText('donutLegGold',   gold);
  setText('donutLegPlat',   plat);

  // Chart subtitle + grafik login
  document.getElementById('dashChartSub').textContent = `Total login: ${d.loginsWeek ?? '—'} minggu ini` +
    (typeof d.loginsPrevWeek === 'number' ? ` (minggu lalu: ${d.loginsPrevWeek})` : '');
  if (d.loginTrend) drawLoginChart(d.loginTrend);

  // Aktivitas Terbaru
  renderActivity(d.recentActivity || []);
}

function setText(id, val) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.remove('skeleton');
  if (el.textContent !== String(val)) { el.textContent = val; bump(id); }
}

function setDonut(id, dash, offset) {
  const el = document.getElementById(id);
  if (!el) return;
  const CIRC = 301.6;
  el.style.strokeDasharray  = `${dash} ${CIRC - dash}`;
  el.style.strokeDashoffset = -offset;
}

const ACTIVITY_ICON_FALLBACK = {
  login: '🔑', logout: '🚪', install: '⬇️', download_failed: '⚠️',
  purchase: '💳', renewal: '🔄', request_game: '🎯',
  admin_add_game: '➕', admin_edit_game: '✏️', admin_delete_game: '🗑️',
  admin_add_bypass: '➕', admin_edit_bypass: '✏️', admin_delete_bypass: '🗑️',
  admin_reset_quota: '♻️', announcement: '📢', system_error: '🚨', account_status: '🛡️'
};

function activityItemHtml(item) {
  const icon = item.icon || ACTIVITY_ICON_FALLBACK[item.type] || 'ℹ️';
  const desc = escapeHtml(item.description || item.type || '');
  const when = escapeHtml(timeAgo(item.createdAt));
  const isError = item.type === 'system_error' || item.type === 'download_failed';
  return `<div class="activity-item${isError ? ' activity-item-error' : ''}" data-id="${item._id || ''}">
    <span class="activity-icon">${icon}</span>
    <span class="activity-text">${desc}</span>
    <span class="activity-time" data-created="${escapeHtml(item.createdAt || '')}">${when}</span>
  </div>`;
}

function renderActivity(data) {
  const el = document.getElementById('dashActivity');
  if (!el) return;
  if (!data || !data.length) {
    el.innerHTML = '<div class="activity-item"><span style="color:var(--text-faint);font-size:12.5px;">Belum ada aktivitas.</span></div>';
    return;
  }
  el.innerHTML = data.slice(0, 20).map(activityItemHtml).join('');
}

// Sisipkan satu aktivitas baru secara realtime (dipanggil dari event WebSocket),
// tanpa perlu nge-fetch ulang seluruh daftar aktivitas dari server.
function prependActivity(item) {
  const el = document.getElementById('dashActivity');
  if (!el) return;
  const empty = el.querySelector('.activity-item:only-child');
  if (empty && !el.querySelector('[data-id]')) el.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.innerHTML = activityItemHtml(item);
  const node = wrap.firstElementChild;
  node.classList.add('activity-item-new');
  el.insertBefore(node, el.firstChild);
  // Batasi 20 aktivitas terbaru yang ditampilkan
  while (el.children.length > 20) el.removeChild(el.lastElementChild);
}

// Refresh label "x menit yang lalu" tiap 30 detik biar tetap akurat tanpa refetch.
setInterval(() => {
  document.querySelectorAll('#dashActivity .activity-time[data-created]').forEach(elTime => {
    const created = elTime.getAttribute('data-created');
    if (created) elTime.textContent = timeAgo(created);
  });
}, 30000);

// ─── QUICK ACTIONS (panel Selamat Datang) ───
function quickActionBroadcast() {
  loadPage('users');
  setTimeout(() => {
    if (typeof openSendNotifModal === 'function') openSendNotifModal(null, null);
  }, 150);
}

// Catatan: "Request Game" belum jadi fitur tersendiri di aplikasi ini (belum ada
// alur user mengajukan game ke admin) — tombol ini sengaja jujur soal itu,
// bukan pura-pura membuka halaman yang tidak ada.
function quickActionRequestGame() {
  showToast('Fitur "Request Game" belum tersedia di aplikasi ini — beri tahu saya kalau kamu mau ini dibangun.', 'default');
}

// ─── REALTIME — WebSocket Dashboard Admin ───
let _adminWs = null;
let _adminWsRetry = 0;
function connectAdminWS() {
  const token = localStorage.getItem('adminToken');
  if (!token) return;
  try {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    _adminWs = new WebSocket(`${proto}//${location.host}/ws?admin=1&token=${encodeURIComponent(token)}`);
    _adminWs.onopen = () => { _adminWsRetry = 0; };
    _adminWs.onmessage = (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.event === 'activity') {
        if (currentPage === 'dashboard') {
          prependActivity(msg.data);
          refreshDashboardStatsDebounced();
        }
        if (currentPage === 'logs') {
          handleRealtimeLog(msg.data);
        }
      } else if (msg.event === 'user:update') {
        if (typeof mergeUserUpdate === 'function') mergeUserUpdate(msg.data);
      } else if (msg.event === 'hubcap:update') {
        _hcSnapshot = msg.data;
        if (currentPage === 'hubcap') {
          renderHcGlobalBadge(msg.data);
          renderHcKeysList(msg.data);
          renderHcMonitor(msg.data);
        }
      } else if (msg.event === 'ryu:update') {
        _rySnapshot = msg.data;
        if (currentPage === 'hubcap' && _hcActiveTab === 'ryu') {
          renderRyKeysList(msg.data);
        }
      }
      if (msg.event === 'activity' && currentPage === 'hubcap' && _hcActiveTab === 'logs' && (msg.data?.category === 'hubcap' || msg.data?.category === 'ryu')) {
        loadHcLogs();
      }
    };
    _adminWs.onclose = () => {
      _adminWsRetry = Math.min(_adminWsRetry + 1, 6);
      setTimeout(connectAdminWS, 1000 * _adminWsRetry);
    };
    _adminWs.onerror = () => { try { _adminWs.close(); } catch {} };
  } catch (e) { /* biarkan, akan dicoba lagi dari onclose */ }
}

// Debounce re-fetch angka statistik (bukan activity feed, yang sudah realtime
// lewat prependActivity) supaya banyak event beruntun tidak menembak API berkali-kali.
let _dashRefreshTimer = null;
function refreshDashboardStatsDebounced() {
  clearTimeout(_dashRefreshTimer);
  _dashRefreshTimer = setTimeout(() => {
    api('/api/admin/dashboard').then(applyDashboardData).catch(() => {});
  }, 1200);
}

function drawLoginChart(trend) {
  const canvas = document.getElementById('dashLoginChart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 400, h = 130;
  canvas.width = w * dpr; canvas.height = h * dpr;
  ctx.scale(dpr, dpr);

  // Build 7 days
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    const found = Array.isArray(trend) ? trend.find(t => (t._id || t.date) === key) : null;
    days.push({ label: d.toLocaleDateString('id-ID', { weekday: 'short' }), count: found ? (found.count || 0) : 0 });
  }

  const max = Math.max(...days.map(d => d.count), 1);
  const padL = 30, padB = 24, padT = 12;
  const chartW = w - padL - 14, chartH = h - padB - padT;
  const stepX = chartW / Math.max(days.length - 1, 1);

  ctx.clearRect(0, 0, w, h);

  // Grid
  ctx.strokeStyle = 'rgba(255,255,255,.07)'; ctx.lineWidth = 1;
  for (let i = 0; i <= 3; i++) {
    const y = padT + (chartH / 3) * i;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - 14, y); ctx.stroke();
  }

  // Gradient fill
  const grad = ctx.createLinearGradient(0, padT, 0, padT + chartH);
  grad.addColorStop(0, 'rgba(123,92,255,.28)');
  grad.addColorStop(0.6, 'rgba(230,75,184,.10)');
  grad.addColorStop(1, 'rgba(123,92,255,0)');

  ctx.beginPath();
  days.forEach((d, i) => {
    const x = padL + stepX * i;
    const y = padT + chartH - (d.count / max) * chartH;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  const lastX = padL + stepX * (days.length - 1);
  ctx.lineTo(lastX, padT + chartH);
  ctx.lineTo(padL, padT + chartH);
  ctx.closePath();
  ctx.fillStyle = grad; ctx.fill();

  // Line — violet to pink gradient stroke
  const lineGrad = ctx.createLinearGradient(padL, 0, lastX, 0);
  lineGrad.addColorStop(0, '#7b5cff');
  lineGrad.addColorStop(1, '#e64bb8');
  ctx.beginPath();
  days.forEach((d, i) => {
    const x = padL + stepX * i;
    const y = padT + chartH - (d.count / max) * chartH;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = lineGrad; ctx.lineWidth = 2.5; ctx.lineJoin = 'round'; ctx.stroke();

  // Dots
  days.forEach((d, i) => {
    const x = padL + stepX * i;
    const y = padT + chartH - (d.count / max) * chartH;
    ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fillStyle = '#0b0e1a'; ctx.fill();
    ctx.strokeStyle = '#7b5cff'; ctx.lineWidth = 2; ctx.stroke();
    ctx.fillStyle = 'rgba(163,152,210,.7)'; ctx.font = '10px Inter'; ctx.textAlign = 'center';
    ctx.fillText(d.label, x, h - 5);
  });
}

// ─── HELPERS UMUM ───
function timeAgo(dateStr) {
  if (!dateStr) return '';
  const diffSec = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (diffSec < 60) return 'Baru saja';
  if (diffSec < 3600) return Math.floor(diffSec / 60) + ' menit lalu';
  if (diffSec < 86400) return Math.floor(diffSec / 3600) + ' jam lalu';
  if (diffSec < 2592000) return Math.floor(diffSec / 86400) + ' hari lalu';
  return new Date(dateStr).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
}

function roleCounts(rows) {
  const c = { total: rows.length, public: 0, gold: 0, platinum: 0, admin: 0 };
  rows.forEach(r => { if (c[r.role] === undefined) c[r.role] = 0; c[r.role]++; });
  return c;
}

function renderPageStats(containerId, counts, labels, opts = {}) {
  const el = document.getElementById(containerId);
  if (!el) return;
  const items = [
    { key: 'total',    icon: '📦', color: 'rgba(123,92,255,.16)', value: counts.total,    label: labels.total || 'Total' },
    { key: 'public',   icon: '🌐', color: 'rgba(255,255,255,.08)', value: counts.public,   label: 'Public' },
    { key: 'gold',     icon: '🥇', color: 'rgba(255,215,106,.16)', value: counts.gold,     label: 'Gold' },
    { key: 'platinum', icon: '💎', color: 'rgba(167,139,250,.16)', value: counts.platinum, label: 'Platinum' },
  ];
  // Pil "Admin" cuma relevan di halaman Users (game/bypass gak butuh paket Admin).
  if (opts.showAdmin) items.push({ key: 'admin', icon: '👑', color: 'rgba(74,222,128,.16)', value: counts.admin || 0, label: 'Admin' });
  el.innerHTML = items.map(it => `
    <div class="page-stat-pill">
      <div class="page-stat-pill-icon" style="background:${it.color};">${it.icon}</div>
      <div>
        <div class="page-stat-pill-value">${it.value}</div>
        <div class="page-stat-pill-label">${it.label}</div>
      </div>
    </div>
  `).join('');
}

function renderRoleChips(containerId, counts, activeRole, onSelect, opts = {}) {
  const el = document.getElementById(containerId);
  if (!el) return;
  const chips = [
    { key: 'all',      label: 'Semua',    count: counts.total },
    { key: 'public',   label: '🌐 Public',   count: counts.public },
    { key: 'gold',     label: '🥇 Gold',     count: counts.gold },
    { key: 'platinum', label: '💎 Platinum', count: counts.platinum },
  ];
  if (opts.showAdmin) chips.push({ key: 'admin', label: '👑 Admin', count: counts.admin || 0 });
  el.innerHTML = chips.map(c => `
    <button class="filter-chip ${activeRole === c.key ? 'active' : ''}" data-role="${c.key}">
      ${c.label} <span class="count">${c.count}</span>
    </button>
  `).join('');
  el.querySelectorAll('.filter-chip').forEach(btn => {
    btn.addEventListener('click', () => onSelect(btn.dataset.role));
  });
}

function renderPagination(containerId, total, page, perPage, onPageChange) {
  const el = document.getElementById(containerId);
  if (!el) return;
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  if (totalPages <= 1) { el.style.display = 'none'; return; }
  el.style.display = 'flex';

  const start = (page - 1) * perPage + 1;
  const end = Math.min(page * perPage, total);

  let pageBtns = '';
  const windowSize = 5;
  let from = Math.max(1, page - Math.floor(windowSize / 2));
  let to = Math.min(totalPages, from + windowSize - 1);
  from = Math.max(1, to - windowSize + 1);
  for (let p = from; p <= to; p++) {
    pageBtns += `<button class="pagination-btn ${p === page ? 'active' : ''}" data-page="${p}">${p}</button>`;
  }

  el.innerHTML = `
    <div class="pagination-info">Menampilkan ${start}–${end} dari ${total}</div>
    <div class="pagination-controls">
      <button class="pagination-btn" data-page="${page - 1}" ${page === 1 ? 'disabled' : ''}>‹</button>
      ${pageBtns}
      <button class="pagination-btn" data-page="${page + 1}" ${page === totalPages ? 'disabled' : ''}>›</button>
    </div>
  `;
  el.querySelectorAll('.pagination-btn[data-page]').forEach(btn => {
    btn.addEventListener('click', () => {
      const p = parseInt(btn.dataset.page, 10);
      if (p >= 1 && p <= totalPages) onPageChange(p);
    });
  });
}

// ─── TABEL GAME & BYPASS ───
let tableDataCache = {};
const tableUiState = {
  games:    { role: 'all', search: '', page: 1 },
  bypasses: { role: 'all', search: '', page: 1 },
};
const PER_PAGE = 8;

function _setTableMsg(type, icon, msg) {
  const tableId = type === 'games' ? 'tableGames' : 'tableBypasses';
  const table   = document.getElementById(tableId);
  table.style.display = 'none';
  const wrapper = table.closest('.table-wrap');
  let grid = wrapper.querySelector('.item-card-grid');
  if (!grid) {
    grid = document.createElement('div');
    grid.className = 'item-card-grid';
    table.parentNode.insertBefore(grid, table);
  }
  grid.innerHTML = `<div class="item-grid-empty"><span class="empty-icon">${icon}</span><div>${msg}</div></div>`;
}

async function renderTable(type) {
  _setTableMsg(type, '⏳', 'Memuat data...');
  try {
    const rows = await api(`/api/admin/${type}`);
    tableDataCache[type] = rows;
    tableUiState[type].page = 1;
    applyTableFilters(type);

    const searchEl = document.getElementById(type === 'games' ? 'searchGames' : 'searchBypasses');
    if (searchEl) {
      searchEl.value = tableUiState[type].search;
      searchEl.oninput = (e) => {
        tableUiState[type].search = e.target.value;
        tableUiState[type].page = 1;
        applyTableFilters(type);
      };
    }
  } catch (e) {
    _setTableMsg(type, '⚠️', `Gagal memuat: ${escapeHtml(e.message)}`);
  }
}

function applyTableFilters(type) {
  const rows = tableDataCache[type] || [];
  const state = tableUiState[type];

  // Stat pills & filter chips selalu dihitung dari SEMUA data (bukan hasil filter),
  // supaya angkanya tetap jadi acuan total yang benar.
  const counts = roleCounts(rows);
  renderPageStats(type === 'games' ? 'gamesStats' : 'bypassesStats', counts, { total: 'Total ' + (type === 'games' ? 'Game' : 'Bypass') });
  renderRoleChips(type === 'games' ? 'gamesRoleFilter' : 'bypassesRoleFilter', counts, state.role, (role) => {
    state.role = role;
    state.page = 1;
    applyTableFilters(type);
  });

  let filtered = state.role === 'all' ? rows : rows.filter(r => r.role === state.role);
  if (state.search.trim()) {
    const q = state.search.trim().toLowerCase();
    filtered = filtered.filter(r => (r.name || '').toLowerCase().includes(q));
  }

  const start = (state.page - 1) * PER_PAGE;
  const pageRows = filtered.slice(start, start + PER_PAGE);
  renderTableRows(type, pageRows, filtered.length === 0 && (state.search || state.role !== 'all'));

  renderPagination(type === 'games' ? 'gamesPagination' : 'bypassesPagination', filtered.length, state.page, PER_PAGE, (p) => {
    state.page = p;
    applyTableFilters(type);
  });
}

function filterTable(type, q) {
  tableUiState[type].search = q;
  tableUiState[type].page = 1;
  applyTableFilters(type);
}
window.filterTable = filterTable;

function renderTableRows(type, rows, isFilteredEmpty) {
  const tableId = type === 'games' ? 'tableGames' : 'tableBypasses';
  const table = document.getElementById(tableId);

  if (!rows.length) {
    // Render empty state tetap pakai wrapper div (bukan tr/td) karena kita ganti jadi div grid
    table.innerHTML = '';
    table.insertAdjacentHTML('afterend', ''); // safety
    const emptyHtml = `<div class="item-grid-empty">
      <span class="empty-icon">${isFilteredEmpty ? '🔍' : '📭'}</span>
      <div>${isFilteredEmpty ? 'Tidak ada hasil yang cocok dengan filter/pencarian.' : 'Belum ada data. Klik "＋ Tambah" untuk menambahkan.'}</div>
    </div>`;
    // Ganti table dgn div sementara
    const wrapper = table.closest('.table-wrap');
    let grid = wrapper.querySelector('.item-card-grid');
    if (!grid) {
      grid = document.createElement('div');
      grid.className = 'item-card-grid';
      table.parentNode.insertBefore(grid, table);
      table.style.display = 'none';
    }
    grid.innerHTML = emptyHtml;
    return;
  }

  // Gunakan div grid — sembunyikan table asli
  const wrapper = table.closest('.table-wrap');
  let grid = wrapper.querySelector('.item-card-grid');
  if (!grid) {
    grid = document.createElement('div');
    grid.className = 'item-card-grid';
    table.parentNode.insertBefore(grid, table);
    table.style.display = 'none';
  }
  table.style.display = 'none';

  const editSvg = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H6a2 2 0 00-2 2v14a2 2 0 002 2h12a2 2 0 002-2v-5M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;
  const trashSvg = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6m5 0V4a2 2 0 012-2h0a2 2 0 012 2v2"/></svg>`;
  const linkSvg  = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg>`;
  const idSvg    = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 3H8a2 2 0 00-2 2v2h12V5a2 2 0 00-2-2z"/></svg>`;
  const sizeSvg  = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;
  const clockSvg = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`;
  const isGame   = type === 'games';

  grid.innerHTML = rows.map(item => {
    const roleClass  = item.role || 'public';
    const roleLabel  = roleClass === 'platinum' ? '💠 Platinum' : roleClass === 'gold' ? '⭐ Gold' : '🌐 Public';
    const hasLink    = !!(item.zipUrl || item.link || item.manifestUrl);
    const placeholderIcon = isGame ? '🎮' : '🛡️';
    const isOnline   = item.isOnline !== false;

    return `<div class="item-card item-card--${roleClass}">
      <!-- Cover -->
      <div class="item-card__cover">
        ${item.imageUrl
          ? `<img src="${escapeHtml(item.imageUrl)}" alt="${escapeHtml(item.name)}" onerror="this.parentElement.innerHTML='<span class=item-card__cover-fallback>${placeholderIcon}</span>'">`
          : `<span class="item-card__cover-fallback">${placeholderIcon}</span>`}
        <div class="item-card__role-badge item-card__role-badge--${roleClass}">${roleLabel}</div>
        ${hasLink ? `<div class="item-card__link-dot" title="File tersedia">${linkSvg}</div>` : ''}
        <div class="item-card__online-badge item-card__online-badge--${isOnline ? 'online' : 'offline'}">
          <span class="item-card__online-badge-dot"></span>${isOnline ? 'Online' : 'Offline'}
        </div>
      </div>

      <!-- Body -->
      <div class="item-card__body">
        <div class="item-card__name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</div>
        ${item.description ? `<div class="item-card__desc">${escapeHtml(item.description)}</div>` : ''}

        <div class="item-card__meta">
          ${isGame && item.category ? `<span class="item-card__meta-chip">🏷️ ${escapeHtml((adminCategories.find(c => c.slug === item.category) || {}).name || item.category)}</span>` : ''}
          ${item.appId     ? `<span class="item-card__meta-chip">${idSvg} ${escapeHtml(item.appId)}</span>` : ''}
          ${item.sizeLabel ? `<span class="item-card__meta-chip">${sizeSvg} ${escapeHtml(item.sizeLabel)}</span>` : ''}
          ${item.createdAt ? `<span class="item-card__meta-chip item-card__meta-chip--time">${clockSvg} ${timeAgo(item.createdAt)}</span>` : ''}
        </div>
      </div>

      <!-- Actions -->
      <div class="item-card__actions">
        <button class="item-card__btn item-card__btn--edit"
          title="Edit"
          onclick='openItemModal("${type}", ${JSON.stringify(item).replace(/'/g, "&#39;")})'>
          ${editSvg} Edit
        </button>
        <button class="item-card__btn item-card__btn--delete"
          title="Hapus"
          onclick="deleteItem('${type}','${item._id}')">
          ${trashSvg}
        </button>
      </div>
    </div>`;
  }).join('');
}

async function deleteItem(type, id) {
  if (!confirm('Yakin mau hapus item ini? Tindakan ini tidak bisa dibatalkan.')) return;
  try {
    await api(`/api/admin/${type}/${id}`, { method: 'DELETE' });
    showToast('Item berhasil dihapus.', 'success');
    renderTable(type);
  } catch (e) {
    showToast('Gagal menghapus: ' + e.message, 'error');
  }
}
window.deleteItem = deleteItem;

// ─── KATEGORI GAME (dipakai buat filter kategori Dashboard di app client) ───
let adminCategories = [];

async function loadAdminCategories() {
  try {
    adminCategories = await api('/api/admin/categories');
    renderCategorySelect();
  } catch (e) {
    // gagal diam-diam — select kategori tetap ada, cuma kosong sampai reload berhasil
  }
}

function renderCategorySelect(selectedSlug) {
  const sel = document.getElementById('itemCategory');
  if (!sel) return;
  const current = selectedSlug !== undefined ? selectedSlug : sel.value;
  sel.innerHTML = adminCategories.length
    ? adminCategories.map(c => `<option value="${escapeHtml(c.slug)}">${escapeHtml(c.name)}</option>`).join('')
    : `<option value="">— belum ada kategori —</option>`;
  if (current && adminCategories.some(c => c.slug === current)) sel.value = current;
}

document.getElementById('btnAddCategory').addEventListener('click', async () => {
  const name = prompt('Nama kategori baru (contoh: Racing, Horror, dll):');
  if (!name || !name.trim()) return;
  const statusEl = document.getElementById('categoryStatus');
  try {
    const created = await api('/api/admin/categories', { method: 'POST', body: JSON.stringify({ name: name.trim() }) });
    await loadAdminCategories();
    renderCategorySelect(created.slug);
    statusEl.textContent = `✓ Kategori "${created.name}" ditambahkan.`;
    statusEl.style.color = 'var(--green, #4ade80)';
    showToast('Kategori berhasil ditambahkan.', 'success');
  } catch (e) {
    statusEl.textContent = e.message;
    statusEl.style.color = 'var(--red)';
    showToast('Gagal menambah kategori: ' + e.message, 'error');
  }
});

document.getElementById('btnDeleteCategory').addEventListener('click', async () => {
  const sel = document.getElementById('itemCategory');
  const slug = sel.value;
  const cat = adminCategories.find(c => c.slug === slug);
  if (!cat) return;
  if (!confirm(`Hapus kategori "${cat.name}"? Kategori hanya bisa dihapus kalau tidak ada game yang memakainya.`)) return;
  const statusEl = document.getElementById('categoryStatus');
  try {
    await api(`/api/admin/categories/${cat._id}`, { method: 'DELETE' });
    await loadAdminCategories();
    statusEl.textContent = `✓ Kategori "${cat.name}" dihapus.`;
    statusEl.style.color = 'var(--green, #4ade80)';
    showToast('Kategori berhasil dihapus.', 'success');
  } catch (e) {
    statusEl.textContent = e.message;
    statusEl.style.color = 'var(--red)';
    showToast('Gagal menghapus kategori: ' + e.message, 'error');
  }
});

// ─── MODAL ───
let editingContext = null;

let lookupData = null; // hasil terakhir dari /api/admin/appid-lookup, dipakai pas Simpan
let selectedProvider = 'hubcap'; // provider yang lagi dipilih di App ID lookup (Game): 'hubcap' | 'ryu'

function openItemModal(type, item) {
  editingContext = item ? { type, id: item._id } : { type, id: null };
  lookupData = null;
  const label = type === 'games' ? 'Game' : 'Bypass';
  document.getElementById('itemModalTitle').textContent = item ? `Edit ${label}` : `Tambah ${label}`;
  document.getElementById('itemModalSubtitle').textContent = type === 'games'
    ? 'Cari lewat App ID Steam, atau isi manual di bawah.'
    : 'Isi manual — link bypass selalu dari kamu sendiri, hubcapmanifest cuma dipakai di halaman Game.';

  document.getElementById('itemName').value = item?.name || '';
  document.getElementById('itemDescription').value = item?.description || '';
  setSegmentValue(roleSegmentEl, roleHiddenEl, 'role', item?.role || 'public');
  setSegmentValue(onlineSegmentEl, onlineHiddenEl, 'online', item?.isOnline === false ? 'false' : 'true');
  document.getElementById('itemOnlineHint').textContent = '';
  document.getElementById('itemOnlineHint').className = 'segmented-hint';
  document.getElementById('itemImageUrl').value = item?.imageUrl || '';
  document.getElementById('itemSizeLabel').value = item?.sizeLabel || '';
  document.getElementById('itemAppId').value = item?.appId || '';
  document.getElementById('itemManifestUrl').value = item?.manifestUrl || '';
  document.getElementById('coverResults').innerHTML = '';
  document.getElementById('appIdStatus').innerHTML = '';
  document.getElementById('appIdPreview').style.display = 'none';
  setProviderToggle(item?.provider === 'ryu' ? 'ryu' : 'hubcap');

  // hubcapmanifest (App ID search + link manifest) CUMA relevan di halaman Game — di Bypass, link selalu manual.
  const appIdSection = document.getElementById('appIdSection');
  appIdSection.style.display = (type === 'games') ? 'block' : 'none';
  const manifestUrlRow = document.getElementById('manifestUrlRow');
  manifestUrlRow.style.display = (type === 'games' && item?.manifestUrl) ? 'block' : 'none';
  document.getElementById('btnOpenManifestUrl').href = item?.manifestUrl || '#';

  // Checkbox "sekalian jadi Bypass" cuma relevan pas nambah GAME BARU (bukan edit, bukan pas di halaman Bypass)
  const alsoBypassRow = document.getElementById('alsoBypassRow');
  const alsoBypassCheckbox = document.getElementById('itemAlsoBypass');
  const bypassContentRow = document.getElementById('bypassContentRow');
  const showAlsoBypass = (type === 'games' && !item);
  alsoBypassRow.style.display = showAlsoBypass ? 'block' : 'none';
  alsoBypassCheckbox.checked = false;
  bypassContentRow.style.display = 'none';
  document.getElementById('itemBypassContent').value = '';

  // Field "Link Bypass" kalau nambah/edit item LANGSUNG di halaman Bypass — SELALU diisi manual
  const bypassOnlyRow = document.getElementById('bypassOnlyContentRow');
  bypassOnlyRow.style.display = (type === 'bypasses') ? 'block' : 'none';
  document.getElementById('itemBypassOnlyContent').value = item?.zipUrl || item?.link || '';
  document.getElementById('itemBypassAppId').value = item?.appId || '';
  document.getElementById('bypassAppIdStatus').innerHTML = '';
  const prevEl = document.getElementById('bypassAppIdPreview');
  if (prevEl) prevEl.style.display = 'none';
  // Pre-fill preview kalau edit bypass yang sudah punya data
  if (type === 'bypasses' && item?.appId && item?.imageUrl) {
    showBypassPreview(item.name, item.imageUrl, item.appId);
  }

  // Kategori cuma relevan buat Game (dipakai filter kategori Dashboard) — Bypass tidak punya kategori.
  const categoryFieldRow = document.getElementById('categoryFieldRow');
  categoryFieldRow.style.display = (type === 'games') ? 'flex' : 'none';
  if (type === 'games') {
    renderCategorySelect(item?.category || (adminCategories[0]?.slug || ''));
  }
  document.getElementById('categoryStatus').textContent = '';

  document.getElementById('itemModalBackdrop').style.display = 'flex';
}
window.openItemModal = openItemModal;

document.getElementById('itemAlsoBypass').addEventListener('change', (e) => {
  document.getElementById('bypassContentRow').style.display = e.target.checked ? 'block' : 'none';
});

// ─── SEGMENTED PICKER: Role Minimum & Tipe Game (Online/Offline) ───
// Pengganti <select> polos — lebih enak diklik & langsung kelihatan pilihannya tanpa dropdown.
function setSegmentValue(segmentEl, hiddenInputEl, datasetKey, value) {
  segmentEl.dataset.value = value;
  hiddenInputEl.value = value;
  segmentEl.querySelectorAll('.segmented-opt').forEach(btn => {
    btn.classList.toggle('active', btn.dataset[datasetKey] === String(value));
  });
}

const roleSegmentEl = document.getElementById('itemRoleSegment');
const roleHiddenEl  = document.getElementById('itemRole');
roleSegmentEl.querySelectorAll('.segmented-opt').forEach(btn => {
  btn.addEventListener('click', () => setSegmentValue(roleSegmentEl, roleHiddenEl, 'role', btn.dataset.role));
});

const onlineSegmentEl = document.getElementById('itemOnlineSegment');
const onlineHiddenEl  = document.getElementById('itemIsOnline');
onlineSegmentEl.querySelectorAll('.segmented-opt').forEach(btn => {
  btn.addEventListener('click', () => {
    setSegmentValue(onlineSegmentEl, onlineHiddenEl, 'online', btn.dataset.online);
    document.getElementById('itemOnlineHint').textContent = '';
    document.getElementById('itemOnlineHint').className = 'segmented-hint';
  });
});

function closeModal() {
  document.getElementById('itemModalBackdrop').style.display = 'none';
}

document.getElementById('btnModalClose').addEventListener('click', closeModal);
document.getElementById('btnCancelItem').addEventListener('click', closeModal);
document.getElementById('itemModalBackdrop').addEventListener('click', e => {
  if (e.target === document.getElementById('itemModalBackdrop')) closeModal();
});

// ─── APP ID LOOKUP (hubcapmanifest + Ryu + Steam) — HANYA dipakai di halaman Game ───
function setProviderToggle(provider) {
  selectedProvider = provider === 'ryu' ? 'ryu' : 'hubcap';
  document.querySelectorAll('#providerToggle .provider-toggle-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.provider === selectedProvider);
  });
  const label = document.getElementById('manifestUrlProviderLabel');
  if (label) label.textContent = selectedProvider === 'ryu' ? '(Ryu API)' : '(hubcapmanifest)';
}
document.querySelectorAll('#providerToggle .provider-toggle-btn').forEach(btn => {
  btn.addEventListener('click', () => setProviderToggle(btn.dataset.provider));
});

document.getElementById('btnLookupAppId').addEventListener('click', doAppIdLookup);
document.getElementById('itemAppId').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); doAppIdLookup(); } });

async function doAppIdLookup() {
  const appId = document.getElementById('itemAppId').value.trim();
  const statusEl = document.getElementById('appIdStatus');
  const previewEl = document.getElementById('appIdPreview');
  const manifestUrlRow = document.getElementById('manifestUrlRow');
  if (!appId) { showToast('Isi App ID dulu.', 'error'); return; }

  const btn = document.getElementById('btnLookupAppId');
  btn.textContent = 'Mencari...'; btn.disabled = true;
  statusEl.innerHTML = `<span style="color:var(--text-dim);">🔎 Mengambil data dari Steam &amp; ${selectedProvider === 'ryu' ? 'Ryu API' : 'hubcapmanifest'}...</span>`;
  previewEl.style.display = 'none';
  manifestUrlRow.style.display = 'none';

  try {
    const data = await api(`/api/admin/appid-lookup/${encodeURIComponent(appId)}?provider=${selectedProvider}`);
    lookupData = data;

    // Auto-isi form (tetap bisa diedit manual setelahnya)
    if (data.name) document.getElementById('itemName').value = data.name;
    if (data.description) document.getElementById('itemDescription').value = data.description;
    if (data.imageUrl) document.getElementById('itemImageUrl').value = data.imageUrl;
    if (data.sizeLabel) document.getElementById('itemSizeLabel').value = data.sizeLabel;

    // Link manifest — otomatis muncul kalau ADA di provider yang dipilih, biar bisa dicek/dibuka manual
    if (data.manifestUrl) {
      document.getElementById('itemManifestUrl').value = data.manifestUrl;
      document.getElementById('btnOpenManifestUrl').href = data.manifestUrl;
      manifestUrlRow.style.display = 'block';
      const label = document.getElementById('manifestUrlProviderLabel');
      if (label) label.textContent = data.provider === 'ryu' ? '(Ryu API)' : '(hubcapmanifest)';
    } else {
      document.getElementById('itemManifestUrl').value = '';
    }

    // Preview card
    if (data.name || data.imageUrl) {
      previewEl.style.display = 'flex';
      document.getElementById('appIdPreviewImg').src = data.imageUrl || '';
      document.getElementById('appIdPreviewImg').style.display = data.imageUrl ? 'block' : 'none';
      document.getElementById('appIdPreviewName').textContent = data.name || `App ID ${appId}`;
      document.getElementById('appIdPreviewSize').textContent = 'Ukuran: ' + (data.sizeLabel || 'tidak diketahui');
      const manifestText = data.hasManifest === true ? '✅ Tersedia' : data.hasManifest === false ? '❌ Belum tersedia' : '❔ Tidak diketahui';
      document.getElementById('appIdPreviewManifest').textContent = 'Manifest: ' + manifestText;
      document.getElementById('appIdPreviewManifest').className = 'chip ' + (data.hasManifest === true ? 'chip-ok' : data.hasManifest === false ? 'chip-bad' : '');
      document.getElementById('appIdPreviewLink').href = data.storeUrl || '#';

      // Chip tipe game (Online/Offline) — hasil deteksi otomatis dari kategori Steam
      const onlineChip = document.getElementById('appIdPreviewOnline');
      if (data.isOnlineSuggested !== null && data.isOnlineSuggested !== undefined) {
        onlineChip.style.display = 'inline-block';
        onlineChip.textContent = 'Tipe: ' + (data.isOnlineSuggested ? '🌐 Online Multiplayer' : '📴 Offline / Singleplayer');
        onlineChip.className = 'chip ' + (data.isOnlineSuggested ? 'chip-ok' : '');
      } else {
        onlineChip.style.display = 'none';
      }
    }

    // Auto-set toggle Online/Offline sesuai hasil deteksi kategori Steam — admin tetap
    // bebas ubah manual sesudahnya kalau deteksinya kurang tepat.
    if (data.isOnlineSuggested !== null && data.isOnlineSuggested !== undefined) {
      setSegmentValue(onlineSegmentEl, onlineHiddenEl, 'online', data.isOnlineSuggested ? 'true' : 'false');
      const hintEl = document.getElementById('itemOnlineHint');
      hintEl.textContent = `💡 Terdeteksi otomatis dari kategori Steam${data.categories?.length ? ' (' + data.categories.slice(0, 3).join(', ') + (data.categories.length > 3 ? ', ...' : '') + ')' : ''} — ubah manual kalau kurang tepat.`;
      hintEl.className = 'segmented-hint is-suggested';
    }

    statusEl.innerHTML = data.warnings?.length
      ? `<span style="color:var(--yellow,#ffd76a);">⚠️ ${escapeHtml(data.warnings.join(' · '))}</span>`
      : `<span style="color:var(--green,#4ade80);">✓ Data ditemukan &amp; berhasil diisi otomatis.</span>`;
  } catch (e) {
    statusEl.innerHTML = `<span style="color:var(--red);">✕ ${escapeHtml(e.message)}</span>`;
  } finally {
    btn.textContent = '🔎 Search'; btn.disabled = false;
  }
}

document.getElementById('btnSaveItem').addEventListener('click', async () => {
  const { type, id } = editingContext;
  const appId = type === 'games' ? (document.getElementById('itemAppId').value.trim() || null) : null;

  const body = {
    name:        document.getElementById('itemName').value.trim(),
    description: document.getElementById('itemDescription').value.trim(),
    role:        document.getElementById('itemRole').value,
    isOnline:    document.getElementById('itemIsOnline').value === 'true',
    imageUrl:    document.getElementById('itemImageUrl').value.trim() || null,
    sizeLabel:   document.getElementById('itemSizeLabel').value.trim() || null
  };
  if (!body.name) { showToast('Nama wajib diisi.', 'error'); return; }

  if (type === 'games') {
    body.category = document.getElementById('itemCategory').value;
    if (!body.category) { showToast('Kategori wajib dipilih.', 'error'); return; }
    body.appId = appId;
    body.storeUrl = appId ? (lookupData?.storeUrl || `https://store.steampowered.com/app/${appId}/`) : null;
    body.manifestUrl = document.getElementById('itemManifestUrl').value.trim() || null;
    body.sizeBytes = lookupData?.sizeBytes ?? null;
    // Provider ('hubcap'/'ryu') dari hasil Search terakhir kalau ada — kalau admin isi
    // manifestUrl manual tanpa pernah klik Search, ikut toggle yang lagi aktif.
    body.provider = body.manifestUrl ? (lookupData?.provider || selectedProvider) : null;
  } else {
    // Halaman Bypass: link SELALU manual dari admin, tidak ada urusan sama hubcap/App ID.
    body.zipUrl = document.getElementById('itemBypassOnlyContent').value.trim() || null;
    body.link   = body.zipUrl; // backward compat
    body.appId  = document.getElementById('itemBypassAppId').value.trim() || null;
  }

  const alsoBypass = document.getElementById('itemAlsoBypass').checked;
  const btn = document.getElementById('btnSaveItem');
  btn.textContent = 'Menyimpan...'; btn.disabled = true;
  try {
    let savedGame = null;
    if (id) {
      await api(`/api/admin/${type}/${id}`, { method: 'PUT', body: JSON.stringify(body) });
    } else {
      savedGame = await api(`/api/admin/${type}`, { method: 'POST', body: JSON.stringify(body) });
    }

    // Kalau checkbox "sekalian jadi Bypass" dicentang, bikin entri Bypass juga.
    // Role, nama, deskripsi & cover SAMA PERSIS dengan Game di atas (jadi otomatis ikut role Game),
    // tapi LINK bypass-nya tetap dari input "Link Bypass" yang admin isi sendiri (bukan dari hubcap).
    if (!id && type === 'games' && alsoBypass) {
      await api('/api/admin/bypasses', {
        method: 'POST',
        body: JSON.stringify({
          name:        body.name,
          description: body.description,
          role:        body.role,
          isOnline:    body.isOnline,
          imageUrl:    body.imageUrl,
          // App ID otomatis ikut dari game — ini yang menentukan folder extract di PC user
          appId:       body.appId || null,
          steamAppId:  body.appId || null,
          // Link ZIP bypass dari input khusus — bisa kosong kalau pakai HubCap via appId
          zipUrl: document.getElementById('itemBypassContent').value.trim() || null,
          link:   document.getElementById('itemBypassContent').value.trim() || null,
          gameId: savedGame?._id || null
        })
      });
    }

    closeModal();
    showToast(alsoBypass && !id ? 'Game & Bypass berhasil disimpan!' : 'Berhasil disimpan!', 'success');
    renderTable(type);
  } catch (e) {
    showToast('Gagal menyimpan: ' + e.message, 'error');
  } finally {
    btn.textContent = 'Simpan'; btn.disabled = false;
  }
});

// ─── COVER SEARCH ───
document.getElementById('btnSearchCover').addEventListener('click', async () => {
  const q = document.getElementById('itemName').value.trim();
  if (!q) { showToast('Isi nama game dulu.', 'error'); return; }
  const resultsEl = document.getElementById('coverResults');
  resultsEl.innerHTML = '<span style="font-size:12px;color:var(--text-dim);">Mencari...</span>';
  try {
    const data = await api(`/api/admin/steamgriddb-search?q=${encodeURIComponent(q)}`);
    if (!data.results?.length) {
      resultsEl.innerHTML = '<span style="font-size:12px;color:var(--text-faint);">Tidak ada hasil.</span>';
      return;
    }
    resultsEl.innerHTML = data.results.map(r =>
      `<img src="${escapeHtml(r.thumb)}" data-full="${escapeHtml(r.url)}" title="Klik untuk pilih">`
    ).join('');
    resultsEl.querySelectorAll('img').forEach(img => {
      img.addEventListener('click', () => {
        resultsEl.querySelectorAll('img').forEach(i => i.classList.remove('selected'));
        img.classList.add('selected');
        document.getElementById('itemImageUrl').value = img.dataset.full;
      });
    });
  } catch (e) {
    resultsEl.innerHTML = `<span style="font-size:12px;color:var(--red);">${escapeHtml(e.message)}</span>`;
  }
});

// ─── USERS ───
const usersUiState = { role: 'all', status: 'all', search: '', page: 1 };
let usersDataCache = [];

async function renderUsers() {
  const grid = document.getElementById('tableUsers');
  grid.innerHTML = `<div class="empty-cell empty-cell--grid"><span class="empty-icon">⏳</span>Memuat data...</div>`;
  try {
    const rows = await api('/api/admin/users');
    usersDataCache = rows;
    usersUiState.page = 1;
    applyUsersFilters();

    const searchEl = document.getElementById('searchUsers');
    if (searchEl) {
      searchEl.value = usersUiState.search;
      searchEl.oninput = (e) => {
        usersUiState.search = e.target.value;
        usersUiState.page = 1;
        applyUsersFilters();
      };
    }
  } catch (e) {
    grid.innerHTML = `<div class="empty-cell empty-cell--grid"><span class="empty-icon">⚠️</span>Gagal memuat: ${escapeHtml(e.message)}</div>`;
  }
}

// Pil filter Status Akun (Aktif / Suspend / Banned) — terpisah dari pil filter Role
// yang sudah ada, biar admin bisa gabung dua filter sekaligus (mis. "Gold" + "Suspend").
const STATUS_CHIP_LABEL = { all: 'Semua Status', active: '✅ Aktif', suspended: '⏸️ Suspend', banned: '⛔ Banned' };
function renderStatusChips(containerId, rows, activeStatus, onSelect) {
  const el = document.getElementById(containerId);
  if (!el) return;
  const counts = { all: rows.length, active: 0, suspended: 0, banned: 0 };
  rows.forEach(r => { const s = r.status || 'active'; if (counts[s] !== undefined) counts[s]++; });
  el.innerHTML = ['all', 'active', 'suspended', 'banned'].map(key => `
    <button class="filter-chip ${activeStatus === key ? 'active' : ''}" data-status="${key}">
      ${STATUS_CHIP_LABEL[key]} <span class="count">${counts[key]}</span>
    </button>
  `).join('');
  el.querySelectorAll('.filter-chip').forEach(btn => {
    btn.addEventListener('click', () => onSelect(btn.dataset.status));
  });
}

function applyUsersFilters() {
  const rows = usersDataCache;
  const counts = roleCounts(rows);
  renderPageStats('usersStats', counts, { total: 'Total User' }, { showAdmin: true });
  renderRoleChips('usersRoleFilter', counts, usersUiState.role, (role) => {
    usersUiState.role = role;
    usersUiState.page = 1;
    applyUsersFilters();
  }, { showAdmin: true });
  renderStatusChips('usersStatusFilter', rows, usersUiState.status, (status) => {
    usersUiState.status = status;
    usersUiState.page = 1;
    applyUsersFilters();
  });

  let filtered = usersUiState.role === 'all' ? rows : rows.filter(r => r.role === usersUiState.role);
  if (usersUiState.status !== 'all') filtered = filtered.filter(r => (r.status || 'active') === usersUiState.status);
  if (usersUiState.search.trim()) {
    const q = usersUiState.search.trim().toLowerCase();
    filtered = filtered.filter(u =>
      (u.username || '').toLowerCase().includes(q) ||
      (u.discordId || '').includes(q) ||
      (u.role || '').toLowerCase().includes(q)
    );
  }

  const start = (usersUiState.page - 1) * PER_PAGE;
  const pageRows = filtered.slice(start, start + PER_PAGE);
  renderUsersRows(pageRows, filtered.length === 0 && (usersUiState.search || usersUiState.role !== 'all' || usersUiState.status !== 'all'));

  renderPagination('usersPagination', filtered.length, usersUiState.page, PER_PAGE, (p) => {
    usersUiState.page = p;
    applyUsersFilters();
  });
}

// Manajemen Users ditampilkan sebagai GRID KARTU (bukan tabel baris) — sebelumnya
// tabelnya kepaksa pakai lebar kolom fixed 88px yang aslinya didesain buat kolom
// cover Game/Bypass, jadi avatar+nama+Discord ID user ikut kepotong & tumpuk.
// Kartu per-user kasih tiap info (avatar, nama, Discord ID, paket, aksi) ruang
// sendiri-sendiri, jadi gak akan nabrak walau nama/ID-nya panjang.
// Format tanggal singkat gaya Indonesia, dipakai buat nampilin Masa Aktif di kartu user.
function fmtDateShort(dateStr) {
  if (!dateStr) return '';
  return new Date(dateStr).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
}

const STATUS_TAG_LABEL = { active: '✅ Aktif', suspended: '⏸️ Suspend', banned: '⛔ Banned' };
function statusTagHtml(status) {
  const s = status || 'active';
  return `<span class="status-tag ${s}">${STATUS_TAG_LABEL[s] || s}</span>`;
}

// Blok "Masa Aktif" + "Limit Download" di tiap kartu user — supaya admin bisa langsung
// lihat sisa kuota & sisa masa aktif tiap user tanpa buka modal Set Paket dulu.
function accountStatusHtml(status) {
  if (!status) return '';

  const activeRow = !status.hasActivePeriod
    ? `<div class="user-card-status-row"><span class="user-card-status-label">⏳ Masa Aktif</span><span class="user-card-status-value unlimited">Unlimited</span></div>`
    : status.activeUntil
      ? `<div class="user-card-status-row"><span class="user-card-status-label">⏳ Masa Aktif</span><span class="user-card-status-value ${status.isExpired ? 'expired' : 'ok'}">${escapeHtml(fmtDateShort(status.activeUntil))}${status.isExpired ? ' · Habis' : ''}</span></div>`
      : `<div class="user-card-status-row"><span class="user-card-status-label">⏳ Masa Aktif</span><span class="user-card-status-value">Belum diatur</span></div>`;

  const quotaRow = (label, q) => {
    if (!q) return '';
    const valueHtml = q.unlimited
      ? `<span class="user-card-status-value unlimited">Unlimited</span>`
      : `<span class="user-card-status-value ${q.remaining === 0 ? 'expired' : ''}">${q.used}/${q.limit} hari ini</span>`;
    return `<div class="user-card-status-row"><span class="user-card-status-label">${label}</span>${valueHtml}</div>`;
  };

  return `<div class="user-card-status">
    ${activeRow}
    ${quotaRow('🎮 Limit Game', status.download && status.download.game)}
    ${quotaRow('🛡️ Limit Bypass', status.download && status.download.bypass)}
  </div>`;
}

function renderUsersRows(rows, isFilteredEmpty) {
  const grid = document.getElementById('tableUsers');
  if (!rows.length) {
    grid.innerHTML = isFilteredEmpty
      ? `<div class="empty-cell empty-cell--grid"><span class="empty-icon">🔍</span>Tidak ada user yang cocok.</div>`
      : `<div class="empty-cell empty-cell--grid"><span class="empty-icon">👤</span>Belum ada user yang login.</div>`;
    return;
  }
  grid.innerHTML = rows.map(u => `
    <div class="user-card row-role-accent ${escapeHtml(u.role)} status-${escapeHtml(u.status || 'active')}" data-discord-id="${escapeHtml(u.discordId)}">
      <div class="user-card-top">
        ${u.avatarUrl
          ? `<img class="user-card-avatar" src="${escapeHtml(u.avatarUrl)}" alt="">`
          : `<div class="user-card-avatar user-card-avatar--fallback">${escapeHtml((u.username || '?')[0].toUpperCase())}</div>`}
        <div class="user-card-headtext">
          <div class="user-card-name" title="${escapeHtml(u.username)}">${escapeHtml(u.username)}</div>
          <div class="cell-time">🕓 Login terakhir ${u.lastLoginAt ? timeAgo(u.lastLoginAt) : '—'}</div>
        </div>
        <div class="user-card-badges">
          <div class="user-card-role">${roleTagHtml(u.role)}</div>
          ${statusTagHtml(u.status)}
        </div>
      </div>
      <div class="user-card-id" title="${escapeHtml(u.discordId)}">
        <svg width="12" height="12" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" style="flex-shrink:0;"><rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 3.5V7M16 3.5V7"/></svg>
        <span>${escapeHtml(u.discordId)}</span>
      </div>
      ${accountStatusHtml(u.accountStatus)}
      <div class="user-card-stats">
        <div class="user-card-stat-box"><div class="v">${(u.stats && u.stats.downloads) || 0}</div><div class="l">🎮 Download</div></div>
        <div class="user-card-stat-box"><div class="v">${(u.stats && u.stats.installs) || 0}</div><div class="l">🛡️ Install</div></div>
      </div>
      <div class="user-card-actions">
        <button class="btn btn-sm btn-primary user-card-action-main" onclick="openSetRoleModal('${escapeHtml(u.discordId)}','${escapeHtml(u.username)}','${escapeHtml(u.role)}')">
          🔎 Lihat Detail
        </button>
        <div class="user-card-actions-icons">
          <button class="icon-btn" title="Reset limit download harian" onclick="doResetQuota('${escapeHtml(u.discordId)}','${escapeHtml(u.username)}')">♻️</button>
          <button class="icon-btn" title="Kirim notifikasi ke user ini" onclick="openSendNotifModal('${escapeHtml(u.discordId)}','${escapeHtml(u.username)}')">📢</button>
          <button class="icon-btn" title="Hapus manual seluruh game/bypass user ini (berlaku semua role, termasuk Public)" onclick="doManualPremiumCleanup('${escapeHtml(u.discordId)}','${escapeHtml(u.username)}')">🧹</button>
        </div>
      </div>
    </div>
  `).join('');
}

async function doResetQuota(discordId, username) {
  if (!confirm(`Reset limit download harian untuk ${username}?`)) return;
  try {
    await api(`/api/admin/users/${discordId}/reset-quota`, { method: 'PUT' });
    const cached = usersDataCache.find(x => x.discordId === discordId);
    if (cached?.accountStatus?.download) {
      ['game', 'bypass'].forEach(k => {
        if (cached.accountStatus.download[k] && !cached.accountStatus.download[k].unlimited) {
          cached.accountStatus.download[k].used = 0;
          cached.accountStatus.download[k].remaining = cached.accountStatus.download[k].limit;
        }
      });
    }
    applyUsersFilters();
    showToast(`✅ Limit download ${username} sudah direset.`, 'success');
  } catch (e) {
    showToast('Gagal reset limit: ' + e.message, 'error');
  }
}
window.doResetQuota = doResetQuota;

async function doManualPremiumCleanup(discordId, username) {
  if (!confirm(`Hapus MANUAL seluruh game & bypass milik ${username} sekarang? Berlaku untuk role apapun (Public/Gold/Platinum).\nProses ini langsung dijalankan begitu app user connect/dibuka.`)) return;
  try {
    const result = await api(`/api/admin/users/${discordId}/premium-cleanup`, { method: 'POST' });
    if (!result.scheduled) {
      showToast(`ℹ️ ${username} tidak punya game/bypass yang terpasang.`, 'info');
    } else {
      showToast(`🧹 Dijadwalkan: ${result.gameCount} game & ${result.bypassCount} bypass ${username} akan dihapus.`, 'success');
    }
  } catch (e) {
    showToast('Gagal memicu hapus manual: ' + e.message, 'error');
  }
}
window.doManualPremiumCleanup = doManualPremiumCleanup;

// ─── Kirim notifikasi manual (In-App + opsional Discord DM/Webhook) ───
let _sendNotifTarget = null; // discordId, atau null = broadcast ke semua
function openSendNotifModal(discordId, username) {
  _sendNotifTarget = discordId || null;
  const title = discordId ? `Kirim Notifikasi ke ${username}` : 'Kirim Pengumuman ke Semua User';
  const t = prompt(`${title}\n\nJudul notifikasi:`);
  if (!t) return;
  const m = prompt('Isi pesan:');
  if (!m) return;
  const sendDm = confirm('Kirim juga sebagai DM Discord? (OK = ya, Cancel = tidak)');
  api('/api/admin/notifications/send', {
    method: 'POST',
    body: JSON.stringify({ target: discordId || 'all', title: t, message: m, dm: sendDm, webhook: true })
  }).then(res => {
    showToast(`✅ Notifikasi terkirim ke ${res.sentTo} user.`, 'success');
  }).catch(e => showToast('Gagal kirim notifikasi: ' + e.message, 'error'));
}
window.openSendNotifModal = openSendNotifModal;

// ─── MODAL KELOLA USER — dengan Discord ID search + ringkasan + aksi lengkap ───
let _setRoleTarget = null; // { discordId, username, currentRole, accountStatus, status, statusReason, stats, lastLoginAt }

// Cuma Gold & Platinum yang punya Masa Aktif — Public & Admin selalu unlimited waktu.
function _srToggleActivePeriodGroup(role) {
  const group = document.getElementById('srActivePeriodGroup');
  if (!group) return;
  group.style.display = (role === 'gold' || role === 'platinum') ? 'block' : 'none';
}

function _formatActiveUntil(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  const label = d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  return d.getTime() <= Date.now() ? `⏳ Sudah habis (${label})` : `✅ Aktif sampai ${label}`;
}

// Ringkasan lengkap user di bagian atas modal — login terakhir, bergabung sejak,
// total download/install, sisa limit — biar admin gak perlu buka beberapa halaman
// buat lihat gambaran lengkap satu user ("Lihat Detail").
function _renderUserSummary(u) {
  const el = document.getElementById('srUserSummary');
  if (!el) return;
  if (!u) { el.innerHTML = ''; return; }
  const as = u.accountStatus || {};
  const gameQ = as.download?.game, bypassQ = as.download?.bypass;
  const quotaText = (q) => !q ? '—' : q.unlimited ? 'Unlimited' : `${q.used}/${q.limit} hari ini`;
  el.innerHTML = `
    <div class="user-summary-grid">
      <div class="user-summary-item"><span class="l">Login Terakhir</span><span class="v">${u.lastLoginAt ? timeAgo(u.lastLoginAt) : '—'}</span></div>
      <div class="user-summary-item"><span class="l">Bergabung Sejak</span><span class="v">${u.createdAt ? fmtDateShort(u.createdAt) : '—'}</span></div>
      <div class="user-summary-item"><span class="l">Total Download</span><span class="v">${(u.stats && u.stats.downloads) || 0}x</span></div>
      <div class="user-summary-item"><span class="l">Total Install</span><span class="v">${(u.stats && u.stats.installs) || 0}x</span></div>
      <div class="user-summary-item"><span class="l">Sisa Limit Game</span><span class="v ${gameQ?.unlimited ? 'unlimited' : gameQ?.remaining === 0 ? 'expired' : ''}">${quotaText(gameQ)}</span></div>
      <div class="user-summary-item"><span class="l">Sisa Limit Bypass</span><span class="v ${bypassQ?.unlimited ? 'unlimited' : bypassQ?.remaining === 0 ? 'expired' : ''}">${quotaText(bypassQ)}</span></div>
    </div>`;
}

function _renderStatusCurrent(u) {
  const el = document.getElementById('srStatusCurrent');
  if (!el) return;
  if (!u) { el.innerHTML = ''; return; }
  const s = u.status || 'active';
  el.innerHTML = `Status saat ini: ${statusTagHtml(s)}${u.statusReason ? ` — <span style="color:var(--text-faint);">${escapeHtml(u.statusReason)}</span>` : ''}`;
}

function _fillSetRoleModal(u) {
  const discordId = u?.discordId || '';
  const username = u?.username || '';
  const currentRole = u?.role || 'public';

  document.getElementById('srDiscordId').value = discordId;
  document.getElementById('srUserPreview').innerHTML = discordId
    ? `<div class="sr-preview-filled">
         <div class="sr-preview-name">${escapeHtml(username || discordId)}</div>
         <div class="sr-preview-id">${escapeHtml(discordId)}</div>
         <div class="sr-preview-current">Paket saat ini: ${roleTagHtml(currentRole)}</div>
       </div>`
    : '';
  const roleEl = document.getElementById('srRole');
  if (roleEl) roleEl.value = currentRole;

  document.querySelectorAll('#srRoleSegment .segmented-opt').forEach(b => {
    b.classList.toggle('active', b.dataset.role === currentRole);
  });
  _srToggleActivePeriodGroup(currentRole);

  const daysInput = document.getElementById('srActiveDays');
  if (daysInput) daysInput.value = '';
  const infoEl = document.getElementById('srActiveCurrentInfo');
  if (infoEl) {
    const accountStatus = u?.accountStatus;
    const label = accountStatus?.hasActivePeriod ? _formatActiveUntil(accountStatus.activeUntil) : null;
    infoEl.textContent = label ? `Masa aktif saat ini: ${label.replace(/^(✅|⏳)\s*/, '')}` : 'Masa aktif saat ini: belum diatur (unlimited waktu).';
  }

  document.getElementById('srStatus').innerHTML = '';
  document.getElementById('qtyGameAmount').value = '';
  document.getElementById('qtyBypassAmount').value = '';
  document.getElementById('srStatusReason').value = '';
  document.getElementById('srMsgTitle').value = '';
  document.getElementById('srMsgBody').value = '';

  _renderUserSummary(u);
  _renderStatusCurrent(u);
  _renderDeviceSection(discordId);
}

function openSetRoleModal(discordId, username, currentRole) {
  // Ambil data lengkap dari cache Users (sudah dimuat renderUsers) kalau ada, biar
  // info masa aktif/status/stats yang ditampilkan akurat tanpa perlu fetch ulang.
  const cached = discordId ? usersDataCache.find(u => u.discordId === discordId) : null;
  const u = cached || (discordId ? { discordId, username, role: currentRole } : null);
  _setRoleTarget = u;
  _fillSetRoleModal(u);
  document.getElementById('setRoleModalBackdrop').style.display = 'flex';
}
window.openSetRoleModal = openSetRoleModal;

function closeSetRoleModal() {
  document.getElementById('setRoleModalBackdrop').style.display = 'none';
  _setRoleTarget = null;
}
window.closeSetRoleModal = closeSetRoleModal;

async function searchUserByDiscordId() {
  const discordId = document.getElementById('srDiscordId').value.trim();
  const previewEl = document.getElementById('srUserPreview');
  const statusEl  = document.getElementById('srStatus');
  if (!discordId) { showToast('Masukkan Discord ID dulu.', 'error'); return; }

  const btn = document.getElementById('btnSrSearch');
  btn.textContent = 'Mencari...'; btn.disabled = true;
  previewEl.innerHTML = '';
  statusEl.innerHTML = '';

  try {
    const rows = await api('/api/admin/users');
    usersDataCache = rows;
    const found = rows.find(u => u.discordId === discordId || u.username?.toLowerCase() === discordId.toLowerCase());
    if (!found) {
      previewEl.innerHTML = `<div class="sr-preview-empty">⚠️ User dengan Discord ID <code>${escapeHtml(discordId)}</code> belum pernah login ke app.</div>`;
      _setRoleTarget = null;
      document.getElementById('srUserSummary').innerHTML = '';
      document.getElementById('srStatusCurrent').innerHTML = '';
      return;
    }
    _setRoleTarget = found;
    _fillSetRoleModal(found);
    statusEl.innerHTML = `<span style="color:var(--green);">✓ User ditemukan.</span>`;
  } catch (e) {
    statusEl.innerHTML = `<span style="color:var(--red);">✕ ${escapeHtml(e.message)}</span>`;
  } finally {
    btn.textContent = '🔍 Cari'; btn.disabled = false;
  }
}
window.searchUserByDiscordId = searchUserByDiscordId;

async function doSetRole() {
  if (!_setRoleTarget) { showToast('Cari user dulu.', 'error'); return; }
  const role    = document.getElementById('srRole').value;
  const btn     = document.getElementById('btnSrSave');
  const statusEl = document.getElementById('srStatus');
  if (!role) { showToast('Pilih paket dulu.', 'error'); return; }

  const body = { role };
  let unitLabel = 'hari';
  if (role === 'gold' || role === 'platinum') {
    const daysRaw = document.getElementById('srActiveDays')?.value?.trim();
    const unit = document.getElementById('srActiveUnit')?.value || 'days';
    unitLabel = unit === 'minutes' ? 'menit' : unit === 'hours' ? 'jam' : 'hari';
    if (daysRaw) { body.activeAmount = Number(daysRaw); body.activeUnit = unit; }
  }

  btn.textContent = 'Menyimpan...'; btn.disabled = true;
  statusEl.innerHTML = '';

  try {
    const result = await api(`/api/admin/users/${_setRoleTarget.discordId}/role`, {
      method: 'PUT', body: JSON.stringify(body)
    });

    // Update cache
    const cached = usersDataCache.find(x => x.discordId === _setRoleTarget.discordId);
    if (cached) {
      cached.role = role;
      if (cached.accountStatus) {
        cached.accountStatus.activeUntil = result.activeUntil || null;
        cached.accountStatus.hasActivePeriod = (role === 'gold' || role === 'platinum');
        cached.accountStatus.hasExpiry = !!result.activeUntil;
      }
      _setRoleTarget = cached;
    }
    applyUsersFilters();
    _fillSetRoleModal(_setRoleTarget);

    const ds = result?.discordSync;
    const activeInfo = body.activeAmount ? ` — masa aktif ${body.activeAmount} ${unitLabel}.` : '';
    if (!ds || ds.ok) {
      showToast(`✅ Paket ${_setRoleTarget.username} diubah ke ${role}${activeInfo}${ds?.ok ? ' Discord disinkron ✓' : ''}.`, 'success');
    } else if (ds.reason === 'not_configured') {
      showToast(`Paket diubah ke ${role}${activeInfo} Mapping Discord belum diatur.`, 'default');
    } else if (ds.reason === 'not_member') {
      showToast(`Paket diubah ke ${role}${activeInfo} User bukan member Discord.`, 'default');
    } else {
      showToast(`Paket diubah ke ${role}${activeInfo} sync Discord gagal: ${ds.reason}`, 'error');
    }
  } catch (e) {
    statusEl.innerHTML = `<span style="color:var(--red);">✕ ${escapeHtml(e.message)}</span>`;
    showToast('Gagal mengubah paket: ' + e.message, 'error');
  } finally {
    btn.textContent = '💾 Simpan Paket'; btn.disabled = false;
  }
}
window.doSetRole = doSetRole;

// ─── Atur Limit Download (Tambah / Kurangi / Reset) — Game & Bypass terpisah ───
async function doAdjustQuota(type, action) {
  if (!_setRoleTarget) { showToast('Cari user dulu.', 'error'); return; }
  const amountInput = document.getElementById(type === 'game' ? 'qtyGameAmount' : 'qtyBypassAmount');
  const amount = amountInput ? Number(amountInput.value) : null;
  if (action !== 'reset' && (!amount || amount <= 0)) { showToast('Isi jumlah dulu.', 'error'); return; }
  if (action !== 'reset' && !confirm(`${action === 'add' ? 'Tambah' : 'Kurangi'} limit ${type === 'game' ? 'Game' : 'Bypass'} sebanyak ${amount} untuk ${_setRoleTarget.username}?`)) return;
  if (action === 'reset' && !confirm(`Reset limit ${type === 'game' ? 'Game' : 'Bypass'} untuk ${_setRoleTarget.username}?`)) return;

  try {
    const result = await api(`/api/admin/users/${_setRoleTarget.discordId}/quota`, {
      method: 'PUT', body: JSON.stringify({ type, action, amount: amount || undefined })
    });
    const cached = usersDataCache.find(x => x.discordId === _setRoleTarget.discordId);
    if (cached?.accountStatus?.download?.[type]) {
      cached.accountStatus.download[type].used = result.used;
      cached.accountStatus.download[type].remaining = result.remaining;
      _setRoleTarget = cached;
    }
    if (amountInput) amountInput.value = '';
    applyUsersFilters();
    _renderUserSummary(_setRoleTarget);
    showToast(`✅ Limit ${type === 'game' ? 'Game' : 'Bypass'} diperbarui — sisa ${result.remaining}/${result.limit}.`, 'success');
  } catch (e) {
    showToast('Gagal atur limit: ' + e.message, 'error');
  }
}
window.doAdjustQuota = doAdjustQuota;

// ─── Status Akun (Aktifkan / Suspend / Ban) ───
async function doSetStatus(status) {
  if (!_setRoleTarget) { showToast('Cari user dulu.', 'error'); return; }
  const label = { active: 'mengaktifkan', suspended: 'men-suspend', banned: 'mem-banned' }[status];
  if (!confirm(`Yakin ingin ${label} akun ${_setRoleTarget.username}?`)) return;
  const reason = document.getElementById('srStatusReason')?.value?.trim() || '';

  try {
    await api(`/api/admin/users/${_setRoleTarget.discordId}/status`, {
      method: 'PUT', body: JSON.stringify({ status, reason: reason || undefined })
    });
    const cached = usersDataCache.find(x => x.discordId === _setRoleTarget.discordId);
    if (cached) { cached.status = status; cached.statusReason = reason || null; _setRoleTarget = cached; }
    applyUsersFilters();
    _renderStatusCurrent(_setRoleTarget);
    showToast(`✅ Status ${_setRoleTarget.username} diubah ke ${STATUS_TAG_LABEL[status]}.`, 'success');
  } catch (e) {
    showToast('Gagal ubah status: ' + e.message, 'error');
  }
}
window.doSetStatus = doSetStatus;

// ─── Kirim pesan langsung dari modal Kelola User (In-App + opsional DM Discord) ───
async function doSendUserMessage() {
  if (!_setRoleTarget) { showToast('Cari user dulu.', 'error'); return; }
  const title = document.getElementById('srMsgTitle')?.value?.trim();
  const message = document.getElementById('srMsgBody')?.value?.trim();
  const dm = document.getElementById('srMsgDm')?.checked;
  if (!title || !message) { showToast('Judul & pesan wajib diisi.', 'error'); return; }

  try {
    await api('/api/admin/notifications/send', {
      method: 'POST',
      body: JSON.stringify({ target: _setRoleTarget.discordId, title, message, dm: !!dm, webhook: true })
    });
    document.getElementById('srMsgTitle').value = '';
    document.getElementById('srMsgBody').value = '';
    showToast(`✅ Pesan terkirim ke ${_setRoleTarget.username}.`, 'success');
  } catch (e) {
    showToast('Gagal kirim pesan: ' + e.message, 'error');
  }
}
window.doSendUserMessage = doSendUserMessage;

// Highlight segmented button di modal Set Role + toggle input Masa Aktif
function _srSetRole(btn, role) {
  document.getElementById('srRole').value = role;
  document.querySelectorAll('#srRoleSegment .segmented-opt').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  _srToggleActivePeriodGroup(role);
}
window._srSetRole = _srSetRole;

// ─── REALTIME — merge event 'user:update' dari WebSocket admin ke cache Users, tanpa
// perlu refetch/refresh halaman sama sekali (role, status, limit, login terakhir, dll).
function mergeUserUpdate(u) {
  if (!u || !u.discordId) return;
  const idx = usersDataCache.findIndex(x => x.discordId === u.discordId);
  if (idx >= 0) usersDataCache[idx] = u; else usersDataCache.unshift(u);
  if (currentPage === 'users') applyUsersFilters();
  if (_setRoleTarget && _setRoleTarget.discordId === u.discordId) {
    _setRoleTarget = u;
    _renderUserSummary(u);
    _renderStatusCurrent(u);
  }
}
window.mergeUserUpdate = mergeUserUpdate;

// ─── HISTORY ───
// REDESIGN: sekarang full server-driven (search/filter/sort/pagination semuanya
// dieksekusi di MongoDB lewat /api/admin/history), bukan lagi ambil sampai 300 baris
// lalu difilter di browser — jadi SEMUA data histori tetap bisa dijelajah (gak ada lagi
// batas 300 yang bikin data lama "hilang"), dan tabelnya tetap cepat walau datanya banyak.
const historyUiState = { page: 1, perPage: 20, search: '', type: 'all', sort: 'newest' };
let historySearchTimeout = null;
let _historyToolbarWired = false;

async function renderHistory() {
  const tbody = document.getElementById('tableHistory');
  if (!tbody) return;
  tbody.innerHTML = `<tr><td class="hist-td-empty" colspan="5"><span class="empty-icon">⏳</span>Memuat data...</td></tr>`;

  wireHistoryToolbarOnce();

  try {
    const params = new URLSearchParams({
      page: historyUiState.page,
      perPage: historyUiState.perPage,
      search: historyUiState.search,
      type: historyUiState.type,
      sort: historyUiState.sort
    });
    const data = await api(`/api/admin/history?${params.toString()}`);
    renderHistoryStats(data.stats || {});
    renderHistoryTypeChips(data.stats || {});
    renderHistoryRows(data.rows || [], (data.total || 0) === 0 && !!(historyUiState.search || historyUiState.type !== 'all'));
    renderPagination('historyPagination', data.total || 0, data.page || 1, data.perPage || historyUiState.perPage, (p) => {
      historyUiState.page = p;
      renderHistory();
    });
  } catch (e) {
    tbody.innerHTML = `<tr><td class="hist-td-empty" colspan="5"><span class="empty-icon">⚠️</span>Gagal memuat: ${escapeHtml(e.message)}</td></tr>`;
  }
}

function renderHistoryStats(stats) {
  const statsEl = document.getElementById('historyStats');
  if (!statsEl) return;
  statsEl.innerHTML = `
    <div class="page-stat-pill">
      <div class="page-stat-pill-icon" style="background:rgba(123,92,255,.16);">📜</div>
      <div><div class="page-stat-pill-value">${stats.all ?? 0}</div><div class="page-stat-pill-label">Total Aktivitas</div></div>
    </div>
    <div class="page-stat-pill">
      <div class="page-stat-pill-icon" style="background:rgba(74,222,128,.16);">📅</div>
      <div><div class="page-stat-pill-value">${stats.today ?? 0}</div><div class="page-stat-pill-label">Hari Ini</div></div>
    </div>
    <div class="page-stat-pill">
      <div class="page-stat-pill-icon" style="background:rgba(123,92,255,.16);">🎮</div>
      <div><div class="page-stat-pill-value">${stats.game ?? 0}</div><div class="page-stat-pill-label">Inject Game</div></div>
    </div>
    <div class="page-stat-pill">
      <div class="page-stat-pill-icon" style="background:rgba(61,217,245,.16);">🛡️</div>
      <div><div class="page-stat-pill-value">${stats.bypass ?? 0}</div><div class="page-stat-pill-label">Bypass</div></div>
    </div>
  `;
}

function renderHistoryTypeChips(stats) {
  const chipsEl = document.getElementById('historyTypeFilter');
  if (!chipsEl) return;
  const chips = [
    { key: 'all',    label: 'Semua',      count: stats.all ?? 0 },
    { key: 'game',   label: '🎮 Game',    count: stats.game ?? 0 },
    { key: 'bypass', label: '🛡️ Bypass',  count: stats.bypass ?? 0 },
  ];
  chipsEl.innerHTML = chips.map(c => `
    <button class="filter-chip ${historyUiState.type === c.key ? 'active' : ''}" data-type="${c.key}">
      ${c.label} <span class="count">${c.count}</span>
    </button>
  `).join('');
  chipsEl.querySelectorAll('.filter-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      if (historyUiState.type === btn.dataset.type) return;
      historyUiState.type = btn.dataset.type;
      historyUiState.page = 1;
      renderHistory();
    });
  });
}

function wireHistoryToolbarOnce() {
  if (_historyToolbarWired) return;
  _historyToolbarWired = true;

  const searchEl = document.getElementById('searchHistory');
  if (searchEl) {
    searchEl.value = historyUiState.search;
    searchEl.addEventListener('input', (e) => {
      clearTimeout(historySearchTimeout);
      const val = e.target.value;
      historySearchTimeout = setTimeout(() => {
        historyUiState.search = val;
        historyUiState.page = 1;
        renderHistory();
      }, 350); // debounce biar gak nembak request tiap ketikan
    });
  }

  const sortEl = document.getElementById('historySort');
  if (sortEl) {
    sortEl.addEventListener('change', (e) => {
      historyUiState.sort = e.target.value;
      historyUiState.page = 1;
      renderHistory();
    });
  }

  const perPageEl = document.getElementById('historyPerPage');
  if (perPageEl) {
    perPageEl.addEventListener('change', (e) => {
      historyUiState.perPage = parseInt(e.target.value, 10) || 20;
      historyUiState.page = 1;
      renderHistory();
    });
  }
}

function renderHistoryRows(rows, isFilteredEmpty) {
  const tbody = document.getElementById('tableHistory');
  if (!tbody) return;

  if (!rows.length) {
    tbody.innerHTML = `<tr><td class="hist-td-empty" colspan="5">
      <div class="hist-empty">
        <span class="hist-empty__icon">${isFilteredEmpty ? '🔍' : '📜'}</span>
        <div class="hist-empty__text">${isFilteredEmpty ? 'Tidak ada histori yang cocok dengan filter.' : 'Belum ada histori aktivitas.'}</div>
      </div>
    </td></tr>`;
    return;
  }

  const gameSvg   = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M12 12h.01M8 12h.01M16 12h.01M12 8v8"/></svg>`;
  const bypassSvg = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>`;

  tbody.innerHTML = rows.map(h => {
    const isGame    = h.itemType === 'game';
    const initials  = (h.username || '?').slice(0, 2).toUpperCase();
    const dateObj   = new Date(h.createdAt);
    const dateStr   = dateObj.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' });
    const timeStr   = dateObj.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
    const fileCount = Array.isArray(h.extractedFiles) ? h.extractedFiles.length : 0;

    return `
      <tr class="hist-row">
        <td>
          <div class="hist-user-cell">
            <div class="hist-avatar">${initials}</div>
            <div class="hist-user-name" title="${escapeHtml(h.username || '')}">${escapeHtml(h.username || 'Tidak diketahui')}</div>
          </div>
        </td>
        <td>
          <div class="hist-item-cell">
            ${h.itemImage ? `<img class="hist-item-thumb" src="${escapeHtml(h.itemImage)}" alt="">` : `<div class="hist-item-thumb hist-item-thumb--empty">${isGame ? gameSvg : bypassSvg}</div>`}
            <div class="hist-item-name" title="${escapeHtml(h.itemName || '')}">${escapeHtml(h.itemName || 'Item tidak dikenal')}</div>
          </div>
        </td>
        <td><span class="hist-badge hist-badge--${h.itemType}">${isGame ? gameSvg : bypassSvg} ${isGame ? 'Game' : 'Bypass'}</span></td>
        <td><span class="hist-file-count">${fileCount} file</span></td>
        <td>
          <div class="hist-time-cell">
            <div class="hist-time-abs">${dateStr}, ${timeStr}</div>
            <div class="hist-time-rel">${timeAgo(h.createdAt)}</div>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

// ─── LOGS — Pusat Riwayat Aktivitas Sistem (Audit Log) ───
// Full server-driven (search/filter/sort/pagination dieksekusi di MongoDB lewat
// /api/admin/logs) — tetap cepat walau datanya ratusan ribu/jutaan baris.
// Realtime lewat event WebSocket 'activity' yang sama dipakai Dashboard.
const LOG_STATUS_LABEL = { success: 'Sukses', warning: 'Warning', error: 'Error', info: 'Info' };
const LOG_CATEGORY_LABEL = {
  auth: 'Autentikasi', app: 'Aplikasi', billing: 'Paket & Billing',
  moderation: 'Moderasi User', comms: 'Komunikasi', catalog: 'Katalog Konten', system: 'Sistem'
};
let logsCatalog = null; // diisi dari response server (LOG_CATALOG)
const logsUiState = { page: 1, perPage: 25, search: '', type: 'all', status: 'all', role: 'all', sort: 'newest', dateFrom: '', dateTo: '' };
let logsSearchTimeout = null;
let _logsToolbarWired = false;

function logSkeletonRows(n = 8) {
  let html = '';
  for (let i = 0; i < n; i++) {
    html += `<tr class="log-skel-row">
      <td><div style="display:flex;align-items:center;gap:8px;"><div class="log-skel log-skel--icon"></div><div class="log-skel log-skel--sm" style="width:90px;"></div></div></td>
      <td><div class="log-skel log-skel--sm"></div></td>
      <td><div class="log-skel log-skel--sm" style="width:70px;"></div></td>
      <td><div class="log-skel log-skel--md"></div></td>
      <td><div class="log-skel log-skel--sm" style="width:50px;"></div></td>
      <td><div class="log-skel log-skel--sm" style="width:60px;"></div></td>
      <td><div class="log-skel log-skel--sm" style="width:80px;"></div></td>
      <td><div class="log-skel log-skel--sm" style="width:70px;margin-left:auto;"></div></td>
    </tr>`;
  }
  return html;
}

async function renderLogs() {
  const tbody = document.getElementById('tableLogs');
  if (!tbody) return;
  tbody.innerHTML = logSkeletonRows();

  wireLogsToolbarOnce();

  try {
    const params = new URLSearchParams({
      page: logsUiState.page,
      perPage: logsUiState.perPage,
      search: logsUiState.search,
      type: logsUiState.type,
      status: logsUiState.status,
      role: logsUiState.role,
      sort: logsUiState.sort,
      dateFrom: logsUiState.dateFrom,
      dateTo: logsUiState.dateTo
    });
    const data = await api(`/api/admin/logs?${params.toString()}`);
    logsCatalog = data.catalog || logsCatalog;
    renderLogsStats(data.stats || {});
    renderLogsStatusChips(data.stats || {});
    renderLogsTypeFilterOptions(data.byType || {});
    renderLogsRows(data.rows || [], (data.total || 0) === 0 && hasActiveLogFilters());
    renderPagination('logsPagination', data.total || 0, data.page || 1, data.perPage || logsUiState.perPage, (p) => {
      logsUiState.page = p;
      renderLogs();
    });
  } catch (e) {
    tbody.innerHTML = `<tr><td class="hist-td-empty" colspan="8"><span class="empty-icon">⚠️</span>Gagal memuat: ${escapeHtml(e.message)}</td></tr>`;
  }
}

function hasActiveLogFilters() {
  const s = logsUiState;
  return !!(s.search || s.type !== 'all' || s.status !== 'all' || s.role !== 'all' || s.dateFrom || s.dateTo);
}

function renderLogsStats(stats) {
  const el = document.getElementById('logsStats');
  if (!el) return;
  el.innerHTML = `
    <div class="page-stat-pill">
      <div class="page-stat-pill-icon" style="background:rgba(123,92,255,.16);">🧾</div>
      <div><div class="page-stat-pill-value">${stats.all ?? 0}</div><div class="page-stat-pill-label">Total Log</div></div>
    </div>
    <div class="page-stat-pill">
      <div class="page-stat-pill-icon" style="background:rgba(61,217,245,.16);">📅</div>
      <div><div class="page-stat-pill-value">${stats.today ?? 0}</div><div class="page-stat-pill-label">Hari Ini</div></div>
    </div>
    <div class="page-stat-pill">
      <div class="page-stat-pill-icon" style="background:rgba(74,222,128,.16);">✅</div>
      <div><div class="page-stat-pill-value">${stats.success ?? 0}</div><div class="page-stat-pill-label">Sukses</div></div>
    </div>
    <div class="page-stat-pill">
      <div class="page-stat-pill-icon" style="background:rgba(255,215,106,.16);">⚠️</div>
      <div><div class="page-stat-pill-value">${stats.warning ?? 0}</div><div class="page-stat-pill-label">Warning</div></div>
    </div>
    <div class="page-stat-pill">
      <div class="page-stat-pill-icon" style="background:rgba(248,113,113,.16);">🚨</div>
      <div><div class="page-stat-pill-value">${stats.error ?? 0}</div><div class="page-stat-pill-label">Error</div></div>
    </div>
  `;
}

function renderLogsStatusChips(stats) {
  const el = document.getElementById('logsStatusFilter');
  if (!el) return;
  const chips = [
    { key: 'all',     label: 'Semua',    count: stats.all ?? 0 },
    { key: 'success', label: '✅ Sukses', count: stats.success ?? 0 },
    { key: 'warning', label: '⚠️ Warning', count: stats.warning ?? 0 },
    { key: 'error',   label: '🚨 Error',  count: stats.error ?? 0 },
    { key: 'info',    label: 'ℹ️ Info',   count: stats.info ?? 0 },
  ];
  el.innerHTML = chips.map(c => `
    <button class="filter-chip ${logsUiState.status === c.key ? 'active' : ''}" data-status="${c.key}">
      ${c.label} <span class="count">${c.count}</span>
    </button>
  `).join('');
  el.querySelectorAll('.filter-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      if (logsUiState.status === btn.dataset.status) return;
      logsUiState.status = btn.dataset.status;
      logsUiState.page = 1;
      renderLogs();
    });
  });
}

function renderLogsTypeFilterOptions(byType) {
  const sel = document.getElementById('logsTypeFilter');
  if (!sel || !logsCatalog) return;
  if (sel.dataset.built === '1') {
    // Sudah dibangun sekali — cuma sinkronkan value yg lagi aktif, hindari rebuild
    // tiap fetch (biar dropdown gak "berkedip"/reset scroll pas user lagi milih).
    sel.value = logsUiState.type;
    return;
  }
  // Kelompokkan per kategori biar dropdown panjang tetap gampang ditelusuri.
  const byCategory = {};
  Object.entries(logsCatalog).forEach(([key, meta]) => {
    if (!byCategory[meta.category]) byCategory[meta.category] = [];
    byCategory[meta.category].push({ key, ...meta });
  });
  let html = `<option value="all">Semua Jenis Log</option>`;
  Object.entries(byCategory).forEach(([cat, items]) => {
    html += `<optgroup label="${escapeHtml(LOG_CATEGORY_LABEL[cat] || cat)}">`;
    items.forEach(item => {
      const count = byType[item.key] || 0;
      html += `<option value="${item.key}">${item.icon} ${escapeHtml(item.label)}${item.reserved ? ' (belum tersedia)' : ''} — ${count}</option>`;
    });
    html += `</optgroup>`;
  });
  sel.innerHTML = html;
  sel.dataset.built = '1';
  sel.value = logsUiState.type;
}

function wireLogsToolbarOnce() {
  if (_logsToolbarWired) return;
  _logsToolbarWired = true;

  const searchEl = document.getElementById('searchLogs');
  if (searchEl) {
    searchEl.value = logsUiState.search;
    searchEl.addEventListener('input', (e) => {
      clearTimeout(logsSearchTimeout);
      const val = e.target.value;
      logsSearchTimeout = setTimeout(() => {
        logsUiState.search = val;
        logsUiState.page = 1;
        renderLogs();
      }, 350);
    });
  }

  const typeEl = document.getElementById('logsTypeFilter');
  if (typeEl) {
    typeEl.addEventListener('change', (e) => {
      logsUiState.type = e.target.value;
      logsUiState.page = 1;
      renderLogs();
    });
  }

  const roleEl = document.getElementById('logsRoleFilter');
  if (roleEl) {
    roleEl.addEventListener('change', (e) => {
      logsUiState.role = e.target.value;
      logsUiState.page = 1;
      renderLogs();
    });
  }

  const dateFromEl = document.getElementById('logsDateFrom');
  const dateToEl = document.getElementById('logsDateTo');
  if (dateFromEl) {
    dateFromEl.addEventListener('change', (e) => {
      logsUiState.dateFrom = e.target.value;
      logsUiState.page = 1;
      renderLogs();
    });
  }
  if (dateToEl) {
    dateToEl.addEventListener('change', (e) => {
      logsUiState.dateTo = e.target.value;
      logsUiState.page = 1;
      renderLogs();
    });
  }

  const sortEl = document.getElementById('logsSort');
  if (sortEl) {
    sortEl.addEventListener('change', (e) => {
      logsUiState.sort = e.target.value;
      logsUiState.page = 1;
      renderLogs();
    });
  }

  const perPageEl = document.getElementById('logsPerPage');
  if (perPageEl) {
    perPageEl.addEventListener('change', (e) => {
      logsUiState.perPage = parseInt(e.target.value, 10) || 25;
      logsUiState.page = 1;
      renderLogs();
    });
  }

  const refreshBtn = document.getElementById('btnLogsRefresh');
  if (refreshBtn) refreshBtn.addEventListener('click', () => renderLogs());
}

// Cache baris log yang lagi ditampilkan (dipakai modal detail biar buka instan
// tanpa fetch ulang, kecuali user buka dari sumber lain / link langsung).
let logsRowsCache = {};

function logInitials(str) {
  return (str || '?').slice(0, 2).toUpperCase();
}

function logBadgeHtml(status) {
  const s = status || 'info';
  return `<span class="log-badge log-badge--${s}">${LOG_STATUS_LABEL[s] || s}</span>`;
}

function logRoleChipHtml(role) {
  if (!role) return `<span class="log-cell-muted">—</span>`;
  const icon = ROLE_TAG_ICON[role] || '';
  return `<span class="log-role-chip ${role}">${icon} ${escapeHtml(role)}</span>`;
}

function logRowHtml(item) {
  const meta = (logsCatalog && logsCatalog[item.type]) || { icon: item.icon || 'ℹ️', label: item.label || item.type, category: item.category || 'system' };
  const dateObj = new Date(item.createdAt);
  const dateStr = dateObj.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' });
  const timeStr = dateObj.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
  const deviceShort = item.device ? String(item.device).slice(0, 28) + (String(item.device).length > 28 ? '…' : '') : null;

  return `
    <tr class="log-row" data-id="${item._id || ''}">
      <td>
        <div class="log-type-cell">
          <div class="log-type-icon cat-${meta.category}">${meta.icon}</div>
          <div>
            <div class="log-type-label">${escapeHtml(meta.label)}</div>
            <div class="log-type-cat">${escapeHtml(LOG_CATEGORY_LABEL[meta.category] || meta.category || '')}</div>
          </div>
        </div>
      </td>
      <td>
        ${item.username ? `
          <div class="log-user-cell">
            <div class="log-user-avatar">${logInitials(item.username)}</div>
            <div>
              <div class="log-user-name" title="${escapeHtml(item.username)}">${escapeHtml(item.username)}</div>
              ${item.discordId ? `<div class="log-user-sub">${escapeHtml(item.discordId)}</div>` : ''}
            </div>
          </div>` : `<span class="log-cell-muted">—</span>`}
      </td>
      <td>${item.admin ? `<span class="log-admin-name">👤 ${escapeHtml(item.admin)}</span>` : `<span class="log-cell-muted">—</span>`}</td>
      <td><div class="log-desc-cell">${escapeHtml(item.description || '')}</div></td>
      <td>${logRoleChipHtml(item.role)}</td>
      <td>${logBadgeHtml(item.status)}</td>
      <td>
        <div class="log-meta-cell">
          ${item.ip ? `<span class="ip">🌐 ${escapeHtml(item.ip)}</span>` : '<span>—</span>'}
          ${deviceShort ? `<span class="dev" title="${escapeHtml(item.device)}">🖥️ ${escapeHtml(deviceShort)}</span>` : ''}
        </div>
      </td>
      <td>
        <div class="log-time-cell">
          <div class="hist-time-abs">${dateStr}, ${timeStr}</div>
          <div class="hist-time-rel">${timeAgo(item.createdAt)}</div>
        </div>
      </td>
    </tr>
  `;
}

function renderLogsRows(rows, isFilteredEmpty) {
  const tbody = document.getElementById('tableLogs');
  if (!tbody) return;
  logsRowsCache = {};
  rows.forEach(r => { if (r._id) logsRowsCache[r._id] = r; });

  if (!rows.length) {
    tbody.innerHTML = `<tr><td class="hist-td-empty" colspan="8">
      <div class="hist-empty">
        <span class="hist-empty__icon">${isFilteredEmpty ? '🔍' : '🧾'}</span>
        <div class="hist-empty__text">${isFilteredEmpty ? 'Tidak ada log yang cocok dengan filter.' : 'Belum ada aktivitas yang tercatat.'}</div>
      </div>
    </td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map(logRowHtml).join('');
  tbody.querySelectorAll('.log-row[data-id]').forEach(tr => {
    tr.addEventListener('click', () => openLogDetailModal(tr.dataset.id));
  });
}

// ── Detail Log (modal) ──
async function openLogDetailModal(id) {
  const backdrop = document.getElementById('logDetailModalBackdrop');
  const body = document.getElementById('logDetailBody');
  const titleEl = document.getElementById('logDetailTitle');
  const subEl = document.getElementById('logDetailSubtitle');
  if (!backdrop || !body) return;

  backdrop.style.display = 'flex';
  titleEl.textContent = 'Detail Log';
  subEl.textContent = 'Memuat...';
  body.innerHTML = `<div class="hist-empty" style="padding:24px 0;"><span class="empty-icon">⏳</span>Memuat detail...</div>`;

  let item = logsRowsCache[id];
  try {
    if (!item) item = await api(`/api/admin/logs/${id}`);
    else {
      // Tetap refresh dari server biar detail selalu representasi TERBARU (mis.
      // kalau dibuka lama setelah baris di-cache), tapi gagal-diam kalau offline.
      api(`/api/admin/logs/${id}`).then(fresh => { item = fresh; renderLogDetailBody(item); }).catch(() => {});
    }
    renderLogDetailBody(item);
  } catch (e) {
    body.innerHTML = `<div class="hist-empty" style="padding:24px 0;"><span class="empty-icon">⚠️</span>Gagal memuat detail: ${escapeHtml(e.message)}</div>`;
  }
}

function renderLogDetailBody(item) {
  const body = document.getElementById('logDetailBody');
  const titleEl = document.getElementById('logDetailTitle');
  const subEl = document.getElementById('logDetailSubtitle');
  if (!item) return;

  const meta = (logsCatalog && logsCatalog[item.type]) || { icon: item.icon || 'ℹ️', label: item.label || item.type, category: item.category || 'system' };
  const dateObj = new Date(item.createdAt);
  const fullDate = dateObj.toLocaleString('id-ID', { dateStyle: 'full', timeStyle: 'medium' });

  titleEl.textContent = meta.label;
  subEl.textContent = `${LOG_CATEGORY_LABEL[meta.category] || meta.category} · ${fullDate}`;

  let html = `
    <div class="log-detail-head">
      <div class="log-detail-icon cat-${meta.category}" style="background:rgba(123,92,255,.16);">${meta.icon}</div>
      <div>
        <div class="log-detail-desc">${escapeHtml(item.description || '—')}</div>
        <div style="margin-top:6px;">${logBadgeHtml(item.status)}</div>
      </div>
    </div>
    <div class="log-detail-grid">
      <div class="log-detail-item"><span class="l">Username</span><span class="v">${item.username ? escapeHtml(item.username) : '—'}</span></div>
      <div class="log-detail-item"><span class="l">Discord ID</span><span class="v mono">${item.discordId ? escapeHtml(item.discordId) : '—'}</span></div>
      <div class="log-detail-item"><span class="l">Role User</span><span class="v">${item.role ? logRoleChipHtml(item.role) : '—'}</span></div>
      <div class="log-detail-item"><span class="l">Admin Terkait</span><span class="v">${item.admin ? escapeHtml(item.admin) : '—'}</span></div>
      <div class="log-detail-item"><span class="l">IP Address</span><span class="v mono">${item.ip ? escapeHtml(item.ip) : '—'}</span></div>
      <div class="log-detail-item"><span class="l">Device / PC</span><span class="v mono" style="word-break:break-all;">${item.device ? escapeHtml(item.device) : '—'}</span></div>
      <div class="log-detail-item"><span class="l">Tanggal &amp; Waktu</span><span class="v">${fullDate}</span></div>
      <div class="log-detail-item"><span class="l">ID Log</span><span class="v mono">${escapeHtml(item._id || '—')}</span></div>
    </div>
  `;

  if (item.changes && (item.changes.before !== null || item.changes.after !== null)) {
    const fmt = (v) => v === null || v === undefined ? '(kosong)' : (typeof v === 'object' ? JSON.stringify(v) : String(v));
    html += `
      <div class="log-detail-section-title">🔀 Detail Perubahan (Before → After)</div>
      <div class="log-detail-changes">
        <div class="before">${escapeHtml(fmt(item.changes.before))}</div>
        <div class="arrow">→</div>
        <div class="after">${escapeHtml(fmt(item.changes.after))}</div>
      </div>
    `;
  }

  if (item.meta && Object.keys(item.meta).length) {
    html += `
      <div class="log-detail-section-title">🗂️ Data Tambahan</div>
      <div class="log-detail-json">${escapeHtml(JSON.stringify(item.meta, null, 2))}</div>
    `;
  }

  body.innerHTML = html;
}

function closeLogDetailModal() {
  const backdrop = document.getElementById('logDetailModalBackdrop');
  if (backdrop) backdrop.style.display = 'none';
}
window.closeLogDetailModal = closeLogDetailModal;

// ── Realtime — event 'activity' dari WebSocket admin, langsung tampil di
// halaman Logs TANPA refresh, selama baris barunya cocok dengan filter yang
// lagi aktif & kita lagi di halaman pertama (urutan terbaru dulu). Kalau tidak
// cocok, cukup refresh angka statistik ringkasan supaya tetap akurat.
let _logsStatsRefreshTimer = null;
function handleRealtimeLog(item) {
  const st = logsUiState;
  const matchesFilter =
    st.page === 1 && st.sort !== 'oldest' &&
    (st.type === 'all' || st.type === item.type) &&
    (st.status === 'all' || st.status === item.status) &&
    (st.role === 'all' || st.role === item.role) &&
    (!st.search || `${item.username||''} ${item.discordId||''} ${item.admin||''} ${item.description||''}`.toLowerCase().includes(st.search.toLowerCase()));

  if (matchesFilter) {
    const tbody = document.getElementById('tableLogs');
    if (tbody) {
      const emptyRow = tbody.querySelector('.hist-td-empty');
      if (emptyRow) tbody.innerHTML = '';
      if (item._id) logsRowsCache[item._id] = item;
      const wrap = document.createElement('tbody');
      wrap.innerHTML = logRowHtml(item);
      const node = wrap.firstElementChild;
      node.classList.add('log-row-new');
      node.addEventListener('click', () => openLogDetailModal(node.dataset.id));
      tbody.insertBefore(node, tbody.firstChild);
      // Jaga jumlah baris tetap sesuai perPage biar tidak melar tanpa batas.
      while (tbody.children.length > logsUiState.perPage) tbody.removeChild(tbody.lastElementChild);
    }
  }

  // Debounce refresh kartu ringkasan & chip status/jenis (angka total, hari ini, dst)
  clearTimeout(_logsStatsRefreshTimer);
  _logsStatsRefreshTimer = setTimeout(() => {
    if (currentPage !== 'logs') return;
    const params = new URLSearchParams({ page: 1, perPage: 1, search: '', type: 'all', status: 'all', role: 'all', sort: 'newest' });
    api(`/api/admin/logs?${params.toString()}`).then(data => {
      renderLogsStats(data.stats || {});
    }).catch(() => {});
  }, 1500);
}

// ─── BYPASS: App ID auto-search (nama + cover dari Steam, tanpa hubcap manifest) ───

let _bypassLookupTimeout = null;

// Dipanggil saat admin ketik di field App ID bypass (debounce 800ms)
function onBypassAppIdInput() {
  clearTimeout(_bypassLookupTimeout);
  const appId = (document.getElementById('itemBypassAppId')?.value || '').trim();
  if (/^\d{4,}$/.test(appId)) {
    _bypassLookupTimeout = setTimeout(() => lookupBypassAppId(), 800);
  }
}

// Auto-fill nama game + cover dari Steam menggunakan App ID — tanpa manifest/HubCap
async function lookupBypassAppId() {
  const appIdEl  = document.getElementById('itemBypassAppId');
  const statusEl = document.getElementById('bypassAppIdStatus');
  const appId    = (appIdEl?.value || '').trim();

  if (!appId) { showToast('Isi App ID dulu.', 'error'); return; }
  if (!/^\d+$/.test(appId)) { showToast('App ID harus berupa angka.', 'error'); return; }

  statusEl.innerHTML = '<span style="color:var(--text-dim);">🔎 Mengambil info dari Steam...</span>';

  try {
    // Pakai endpoint appid-lookup yang sudah ada — kita abaikan bagian manifest-nya,
    // yang kita pakai cuma name + imageUrl dari Steam Store.
    const data = await api(`/api/admin/appid-lookup/${encodeURIComponent(appId)}`);

    if (!data.name) {
      statusEl.innerHTML = '<span style="color:var(--danger);">⚠️ App ID tidak ditemukan di Steam.</span>';
      return;
    }

    statusEl.innerHTML = `<span style="color:var(--success);">✅ ${escapeHtml(data.name)}</span>`;

    // Auto-fill nama kalau field nama masih kosong (tidak overwrite kalau sudah diisi)
    const nameEl = document.getElementById('itemName');
    if (nameEl && !nameEl.value.trim()) nameEl.value = data.name;

    // Auto-fill cover kalau field imageUrl masih kosong
    const imgEl = document.getElementById('itemImageUrl');
    if (imgEl && !imgEl.value.trim() && data.imageUrl) imgEl.value = data.imageUrl;

    showBypassPreview(data.name, data.imageUrl, appId, data.storeUrl);
  } catch (e) {
    statusEl.innerHTML = `<span style="color:var(--danger);">❌ ${escapeHtml(e.message)}</span>`;
  }
}

function showBypassPreview(name, imageUrl, appId, storeUrl) {
  const previewEl = document.getElementById('bypassAppIdPreview');
  if (!previewEl) return;
  const imgEl  = document.getElementById('bypassAppIdPreviewImg');
  const nameEl = document.getElementById('bypassAppIdPreviewName');
  const linkEl = document.getElementById('bypassAppIdPreviewLink');

  if (imgEl)  { imgEl.src = imageUrl || ''; imgEl.style.display = imageUrl ? 'block' : 'none'; }
  if (nameEl) nameEl.textContent = name || `App ID ${appId}`;
  if (linkEl) { linkEl.href = storeUrl || `https://store.steampowered.com/app/${appId}/`; }

  previewEl.style.display = 'flex';
}

// ══════════════════════════════════════════════════════════════════════════
// VERIFY ROLE — mapping role Discord, webhook, resync, log sinkronisasi
// ══════════════════════════════════════════════════════════════════════════
const ROLE_SOURCE_LABEL = {
  admin: '🛠️ Admin',
  discord: '💬 Discord',
  left_guild: '🚪 Keluar Server',
  resync: '🔄 Resync',
  expired: '⏳ Masa Aktif Habis'
};

async function renderVerifyRole() {
  await Promise.all([loadRoleSyncSettings(), loadRoleSyncLogs()]);
  wireVerifyRoleButtons();
}

async function loadRoleSyncSettings() {
  const pubSel  = document.getElementById('vrRolePublic');
  const goldSel = document.getElementById('vrRoleGold');
  const platSel = document.getElementById('vrRolePlatinum');
  const adminSel = document.getElementById('vrRoleAdmin');
  const webhookInput = document.getElementById('vrWebhookUrl');
  const autoSyncEl = document.getElementById('vrAutoSync');
  const resetOnLeaveEl = document.getElementById('vrResetOnLeave');
  const badge = document.getElementById('vrGatewayBadge');

  try {
    const [settings, discordRoles] = await Promise.all([
      api('/api/admin/role-sync/settings'),
      api('/api/admin/role-sync/discord-roles').catch(() => [])
    ]);

    const optionsHtml = ['<option value="">— pilih role Discord —</option>']
      .concat(discordRoles.map(r => `<option value="${escapeHtml(r.id)}">${escapeHtml(r.name)}</option>`))
      .join('');
    if (pubSel)  { pubSel.innerHTML  = optionsHtml; pubSel.value  = settings.discordRoleMap?.public   || ''; }
    goldSel.innerHTML = optionsHtml;
    platSel.innerHTML = optionsHtml;
    goldSel.value = settings.discordRoleMap?.gold     || '';
    platSel.value = settings.discordRoleMap?.platinum || '';
    if (adminSel) { adminSel.innerHTML = optionsHtml; adminSel.value = settings.discordRoleMap?.admin || ''; }
    webhookInput.value = settings.webhookUrl || '';
    autoSyncEl.checked = settings.autoSyncFromDiscord !== false;
    resetOnLeaveEl.checked = settings.resetRoleOnLeave !== false;

    const gw = settings.gateway || {};
    if (gw.connected) {
      badge.className = 'vr-gateway-badge ok';
      badge.textContent = `🟢 Bot terhubung${gw.guildName ? ' — ' + gw.guildName : ''}`;
    } else if (gw.error) {
      badge.className = 'vr-gateway-badge error';
      badge.textContent = '🔴 Bot belum terhubung';
      badge.title = gw.error;
    } else {
      badge.className = 'vr-gateway-badge';
      badge.textContent = '🟡 Menunggu koneksi bot...';
    }
  } catch (e) {
    badge.className = 'vr-gateway-badge error';
    badge.textContent = '⚠️ Gagal memuat pengaturan';
    showToast('Gagal memuat pengaturan Verify Role: ' + e.message, 'error');
  }
}

let _vrButtonsWired = false;
function wireVerifyRoleButtons() {
  if (_vrButtonsWired) return; // event listener cukup dipasang sekali, gak numpuk tiap buka halaman
  _vrButtonsWired = true;

  document.getElementById('btnSaveRoleMap').addEventListener('click', async () => {
    const btn = document.getElementById('btnSaveRoleMap');
    const publicRole = (document.getElementById('vrRolePublic')?.value || '').trim() || null;
    const gold = document.getElementById('vrRoleGold').value;
    const platinum = document.getElementById('vrRolePlatinum').value;
    const admin = (document.getElementById('vrRoleAdmin')?.value || '').trim() || null;
    const autoSyncFromDiscord = document.getElementById('vrAutoSync').checked;
    const resetRoleOnLeave = document.getElementById('vrResetOnLeave').checked;
    btn.disabled = true; btn.textContent = 'Menyimpan...';
    try {
      await api('/api/admin/role-sync/settings', {
        method: 'PUT',
        body: JSON.stringify({ discordRoleMap: { public: publicRole, gold, platinum, admin }, autoSyncFromDiscord, resetRoleOnLeave })
      });
      showToast('Mapping role berhasil disimpan.', 'success');
    } catch (e) {
      showToast('Gagal menyimpan: ' + e.message, 'error');
    } finally {
      btn.disabled = false; btn.textContent = '💾 Simpan Mapping';
    }
  });

  document.getElementById('btnSaveWebhook').addEventListener('click', async () => {
    const btn = document.getElementById('btnSaveWebhook');
    const webhookUrl = document.getElementById('vrWebhookUrl').value.trim();
    btn.disabled = true; btn.textContent = 'Menyimpan...';
    try {
      await api('/api/admin/role-sync/settings', { method: 'PUT', body: JSON.stringify({ webhookUrl }) });
      showToast('Webhook berhasil disimpan.', 'success');
    } catch (e) {
      showToast('Gagal menyimpan: ' + e.message, 'error');
    } finally {
      btn.disabled = false; btn.textContent = '💾 Simpan Webhook';
    }
  });

  document.getElementById('btnTestWebhook').addEventListener('click', async () => {
    const btn = document.getElementById('btnTestWebhook');
    btn.disabled = true; btn.textContent = 'Mengirim...';
    try {
      // Simpan dulu URL yang lagi diketik biar test-nya pakai URL terbaru, bukan yang tersimpan lama
      const webhookUrl = document.getElementById('vrWebhookUrl').value.trim();
      if (webhookUrl) await api('/api/admin/role-sync/settings', { method: 'PUT', body: JSON.stringify({ webhookUrl }) });
      await api('/api/admin/role-sync/test-webhook', { method: 'POST' });
      showToast('Test webhook terkirim, cek channel Discord kamu.', 'success');
    } catch (e) {
      showToast('Gagal kirim test webhook: ' + e.message, 'error');
    } finally {
      btn.disabled = false; btn.textContent = '📨 Kirim Test';
    }
  });

  document.getElementById('btnResyncToDiscord').addEventListener('click', () => runResync('app_to_discord'));
  document.getElementById('btnResyncToApp').addEventListener('click', () => runResync('discord_to_app'));
}

async function runResync(direction) {
  const label = direction === 'app_to_discord' ? 'App → Discord' : 'Discord → App';
  if (!confirm(`Jalankan full resync ${label} untuk SEMUA user sekarang?`)) return;

  const btnId = direction === 'app_to_discord' ? 'btnResyncToDiscord' : 'btnResyncToApp';
  const btn = document.getElementById(btnId);
  const resultEl = document.getElementById('vrResyncResult');
  btn.disabled = true; btn.textContent = 'Memproses...';
  resultEl.className = 'vr-resync-result show';
  resultEl.textContent = `⏳ Sedang menjalankan resync ${label}, mohon tunggu (bisa beberapa menit tergantung jumlah user)...`;

  try {
    const summary = await api('/api/admin/role-sync/resync', { method: 'POST', body: JSON.stringify({ direction }) });
    resultEl.innerHTML = `
      ✅ Resync ${label} selesai.<br>
      Total diproses: <b>${summary.total}</b> ·
      Diperbarui: <b style="color:var(--green);">${summary.updated}</b> ·
      Dilewati: <b>${summary.skipped}</b> ·
      Gagal: <b style="color:${summary.failed ? 'var(--red)' : 'inherit'};">${summary.failed}</b>
      ${summary.details?.length ? `<br><span style="color:var(--text-faint);">${summary.details.slice(0,5).map(d => escapeHtml(d.username + ': ' + (d.reason||'error'))).join(', ')}</span>` : ''}
    `;
    showToast('Resync selesai.', 'success');
    loadRoleSyncLogs();
    if (currentPage === 'users') renderUsers();
  } catch (e) {
    resultEl.textContent = '❌ Resync gagal: ' + e.message;
    showToast('Resync gagal: ' + e.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = 'Jalankan';
  }
}

async function loadRoleSyncLogs() {
  const table = document.getElementById('tableRoleLogs');
  table.innerHTML = `<tr><td class="empty-cell" colspan="4"><span class="empty-icon">⏳</span>Memuat log...</td></tr>`;
  try {
    const rows = await api('/api/admin/role-sync/logs');
    if (!rows.length) {
      table.innerHTML = `<tr><td class="empty-cell" colspan="4"><span class="empty-icon">📜</span>Belum ada perubahan role yang tercatat.</td></tr>`;
      return;
    }
    table.innerHTML = `
      <thead><tr>
        <th>User</th>
        <th>Perubahan</th>
        <th style="width:130px;">Sumber</th>
        <th style="width:140px;">Waktu</th>
      </tr></thead>
      <tbody>
      ${rows.map(r => `
        <tr>
          <td>
            <div class="cell-name" style="max-width:200px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${escapeHtml(r.username || r.discordId)}">${escapeHtml(r.username || r.discordId)}</div>
            <div style="color:var(--text-faint);font-size:11.5px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHtml(r.discordId)}">${escapeHtml(r.discordId)}</div>
          </td>
          <td>
            <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">${roleTagHtml(r.oldRole || 'public')} → ${roleTagHtml(r.newRole)}</div>
            ${r.discordSynced === false ? `<div style="color:var(--red);font-size:11px;margin-top:4px;">⚠️ Sync Discord gagal${r.discordSyncReason ? ' ('+escapeHtml(r.discordSyncReason)+')' : ''}</div>` : ''}
          </td>
          <td><span class="tag source-${r.source}">${ROLE_SOURCE_LABEL[r.source] || r.source}</span></td>
          <td style="white-space:nowrap;">
            <div style="font-size:12.5px;color:var(--text);">${timeAgo(r.createdAt)}</div>
            <div style="font-size:11px;color:var(--text-faint);margin-top:2px;">${r.createdAt ? new Date(r.createdAt).toLocaleDateString('id-ID',{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}) : '—'}</div>
          </td>
        </tr>
      `).join('')}
      </tbody>
    `;
  } catch (e) {
    table.innerHTML = `<tr><td class="empty-cell" colspan="4"><span class="empty-icon">⚠️</span>Gagal memuat: ${escapeHtml(e.message)}</td></tr>`;
  }
}
// ─── WEBHOOK SETTINGS ───
// Satu card berisi N baris (satu per kategori notifikasi). Setiap baris render
// dinamis dari data /api/admin/webhooks (bukan di-hardcode di HTML) supaya kalau
// suatu saat nambah kategori baru di webhookManager.js, panel ini otomatis ikut
// menampilkannya tanpa perlu ubah admin.html.
const WH_STATUS_LABEL = { valid: '🟢 Valid', invalid: '🔴 Invalid', unknown: '⚪ Belum diuji' };

function whRowHtml(row) {
  const statusClass = row.status === 'valid' ? 'valid' : row.status === 'invalid' ? 'invalid' : 'unknown';
  const statusLabel = WH_STATUS_LABEL[row.status] || WH_STATUS_LABEL.unknown;
  return `
    <div class="wh-row" data-category="${escapeHtml(row.key)}">
      <div class="wh-row-head">
        <div>
          <div class="wh-row-title">
            ${row.icon || '🔔'} ${escapeHtml(row.label)}
            ${row.optional ? '<span class="wh-optional-tag">Opsional</span>' : ''}
          </div>
          <div class="wh-row-desc">${escapeHtml(row.description || '')}</div>
        </div>
        <span class="wh-status ${statusClass}" data-wh-status title="${row.lastError ? escapeHtml(row.lastError) : ''}">${statusLabel}</span>
      </div>
      <div class="wh-row-body">
        <input class="form-input" type="text" data-wh-url placeholder="https://discord.com/api/webhooks/..." value="${escapeHtml(row.url || '')}">
        <label class="wh-toggle">
          <input type="checkbox" data-wh-enabled ${row.enabled ? 'checked' : ''}>
          Aktif
        </label>
        <button class="btn btn-secondary btn-sm" data-wh-test>📨 Test</button>
        <button class="btn btn-primary btn-sm" data-wh-save>💾 Simpan</button>
      </div>
    </div>
  `;
}

// ─── PAKET — Auto Remove Installed Premium Content ───
let _paketWired = false;
async function renderPaketSettings() {
  try {
    const settings = await api('/api/admin/settings/auto-remove');
    document.getElementById('arEnabled').checked = settings.enabled !== false;
    document.getElementById('arDelay').value = settings.delay || 'immediate';
  } catch (e) {
    showToast('Gagal memuat pengaturan Auto Remove: ' + e.message, 'error');
  }
  wirePaketPageOnce();
}

function wirePaketPageOnce() {
  if (_paketWired) return;
  _paketWired = true;

  document.getElementById('btnSaveAutoRemove')?.addEventListener('click', async () => {
    const statusEl = document.getElementById('arSaveStatus');
    const btn = document.getElementById('btnSaveAutoRemove');
    const enabled = document.getElementById('arEnabled').checked;
    const delay = document.getElementById('arDelay').value;
    btn.disabled = true;
    statusEl.textContent = 'Menyimpan...';
    try {
      await api('/api/admin/settings/auto-remove', { method: 'PUT', body: JSON.stringify({ enabled, delay }) });
      statusEl.textContent = `✅ Tersimpan — Auto Remove ${enabled ? 'AKTIF' : 'NONAKTIF'}, berlaku ${delay === 'immediate' ? 'langsung' : delay === '1h' ? 'setelah 1 jam' : 'setelah 24 jam'}.`;
      showToast('Pengaturan Auto Remove berhasil disimpan.', 'success');
    } catch (e) {
      statusEl.textContent = '⚠️ Gagal menyimpan: ' + e.message;
      showToast('Gagal menyimpan pengaturan: ' + e.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById('btnManualCleanup')?.addEventListener('click', async () => {
    const input = document.getElementById('arManualDiscordId');
    const statusEl = document.getElementById('arManualStatus');
    const discordId = input.value.trim();
    if (!discordId) { statusEl.textContent = 'Isi Discord ID dulu.'; return; }
    if (!confirm(`Hapus MANUAL seluruh game & bypass milik Discord ID ${discordId}? Berlaku untuk role apapun (Public/Gold/Platinum).`)) return;
    const btn = document.getElementById('btnManualCleanup');
    btn.disabled = true;
    statusEl.textContent = 'Memproses...';
    try {
      const result = await api(`/api/admin/users/${encodeURIComponent(discordId)}/premium-cleanup`, { method: 'POST' });
      statusEl.textContent = result.scheduled
        ? `✅ Dijadwalkan: ${result.gameCount} game & ${result.bypassCount} bypass akan dihapus.`
        : `ℹ️ ${result.message || 'Tidak ada game/bypass yang terpasang untuk user ini.'}`;
      showToast(statusEl.textContent, result.scheduled ? 'success' : 'info');
    } catch (e) {
      statusEl.textContent = '⚠️ Gagal: ' + e.message;
      showToast('Gagal memicu hapus manual: ' + e.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });
}

async function renderWebhookSettings() {
  const container = document.getElementById('whList');
  container.innerHTML = `<div class="empty-cell"><span class="empty-icon">⏳</span>Memuat pengaturan webhook...</div>`;
  try {
    const rows = await api('/api/admin/webhooks');
    container.innerHTML = rows.map(whRowHtml).join('');
    wireWebhookSettingsButtons();
  } catch (e) {
    container.innerHTML = `<div class="empty-cell"><span class="empty-icon">⚠️</span>Gagal memuat pengaturan webhook: ${escapeHtml(e.message)}</div>`;
  }
}

let _whButtonsWired = false;
function wireWebhookSettingsButtons() {
  if (_whButtonsWired) return; // event delegation di container — cukup dipasang sekali, gak numpuk tiap render ulang
  _whButtonsWired = true;
  const container = document.getElementById('whList');

  container.addEventListener('click', async (e) => {
    const rowEl = e.target.closest('.wh-row');
    if (!rowEl) return;
    const category = rowEl.dataset.category;
    const urlInput = rowEl.querySelector('[data-wh-url]');
    const enabledInput = rowEl.querySelector('[data-wh-enabled]');
    const statusEl = rowEl.querySelector('[data-wh-status]');

    if (e.target.matches('[data-wh-save]')) {
      const btn = e.target;
      const originalText = btn.textContent;
      btn.disabled = true; btn.textContent = 'Menyimpan...';
      try {
        const updated = await api(`/api/admin/webhooks/${encodeURIComponent(category)}`, {
          method: 'PUT',
          body: JSON.stringify({ url: urlInput.value.trim(), enabled: enabledInput.checked })
        });
        const cls = updated.status === 'valid' ? 'valid' : updated.status === 'invalid' ? 'invalid' : 'unknown';
        statusEl.className = `wh-status ${cls}`;
        statusEl.textContent = WH_STATUS_LABEL[updated.status] || WH_STATUS_LABEL.unknown;
        statusEl.title = updated.lastError || '';
        showToast(`Webhook "${updated.label}" berhasil disimpan.`, 'success');
      } catch (err) {
        showToast('Gagal menyimpan: ' + err.message, 'error');
      } finally {
        btn.disabled = false; btn.textContent = originalText;
      }
    }

    if (e.target.matches('[data-wh-test]')) {
      const btn = e.target;
      const originalText = btn.textContent;
      const url = urlInput.value.trim();
      if (!url) { showToast('Isi URL webhook dulu sebelum mengirim test.', 'error'); return; }
      btn.disabled = true; btn.textContent = 'Mengirim...';
      try {
        await api(`/api/admin/webhooks/${encodeURIComponent(category)}/test`, {
          method: 'POST',
          body: JSON.stringify({ url })
        });
        statusEl.className = 'wh-status valid';
        statusEl.textContent = WH_STATUS_LABEL.valid;
        statusEl.title = '';
        showToast('Test webhook terkirim, cek channel Discord kamu.', 'success');
      } catch (err) {
        statusEl.className = 'wh-status invalid';
        statusEl.textContent = WH_STATUS_LABEL.invalid;
        statusEl.title = err.message;
        showToast('Gagal kirim test webhook: ' + err.message, 'error');
      } finally {
        btn.disabled = false; btn.textContent = originalText;
      }
    }
  });
}
// ─── DEVICE MANAGEMENT (Device Lock) — bagian dari modal Kelola User ───
let _dmCurrentDiscordId = null; // discordId yang lagi ditampilkan di section device
let _dmCurrentDevice = null;    // cache device doc terakhir yang di-fetch (buat modal spesifikasi/copy ID)

function fmtBytes(bytes) {
  if (!bytes || !Number.isFinite(Number(bytes))) return '—';
  const gb = Number(bytes) / (1024 ** 3);
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(Number(bytes) / (1024 ** 2)).toFixed(0)} MB`;
}

const DM_STATUS_LABEL = { bound: '🟢 Terikat', unbound: '⚪ Belum Terikat', pending_change: '🟡 Menunggu Ganti Device' };
const DM_LOG_ICON = {
  device_registered: '🆕', login_rejected: '⛔', minor_change_tolerated: '🔧',
  device_reset: '♻️', device_change_allowed: '🔓', device_change_used: '🔄'
};
const DM_LOG_LABEL = {
  device_registered: 'Perangkat baru didaftarkan', login_rejected: 'Login ditolak (perangkat berbeda)',
  minor_change_tolerated: 'Perubahan kecil hardware ditoleransi', device_reset: 'Device direset oleh Admin',
  device_change_allowed: 'Admin mengizinkan ganti device', device_change_used: 'Perangkat baru didaftarkan (ganti device)'
};

async function _renderDeviceSection(discordId) {
  _dmCurrentDiscordId = discordId || null;
  const el = document.getElementById('dmSection');
  if (!el) return;

  if (!discordId) {
    el.innerHTML = `<div class="dm-empty">Cari user dulu untuk melihat status perangkatnya.</div>`;
    return;
  }

  el.innerHTML = `<div class="empty-cell"><span class="empty-icon">⏳</span>Memuat info perangkat...</div>`;
  try {
    const res = await api(`/api/admin/users/${encodeURIComponent(discordId)}/device`);
    _dmCurrentDevice = res.device;
    el.innerHTML = _dmCardHtml(res.status, res.device);
  } catch (e) {
    el.innerHTML = `<div class="dm-empty">⚠️ Gagal memuat info perangkat: ${escapeHtml(e.message)}</div>`;
  }
}

function _dmCardHtml(status, device) {
  const badge = `<span class="dm-status-badge ${status}">${DM_STATUS_LABEL[status] || status}</span>`;

  if (status === 'unbound' || !device) {
    return `
      <div class="dm-card">
        <div class="dm-card-head">
          <div class="dm-pc-name">🔒 Belum ada perangkat terikat</div>
          ${badge}
        </div>
        <div class="dm-empty">User ini belum pernah login, jadi belum ada perangkat yang terdaftar. Perangkat pertama yang dipakai login akan otomatis terikat ke akun ini.</div>
      </div>`;
  }

  const info = device.info || {};
  return `
    <div class="dm-card">
      <div class="dm-card-head">
        <div class="dm-pc-name">🖥️ ${escapeHtml(info.pcName || 'Tidak diketahui')}</div>
        ${badge}
      </div>
      <div class="dm-fingerprint-row">
        <span class="dm-fingerprint">ID: ${escapeHtml((device.fingerprint || '').slice(0, 24))}...</span>
        <button class="dm-copy-btn" onclick="doCopyDeviceId()">📋 Salin</button>
      </div>
      <div class="dm-spec-grid">
        <div class="dm-spec-item"><span class="l">🧠 CPU</span><span class="v">${escapeHtml(info.cpuName || '—')}</span></div>
        <div class="dm-spec-item"><span class="l">💾 RAM</span><span class="v">${fmtBytes(info.ramTotalBytes)}</span></div>
        <div class="dm-spec-item"><span class="l">🎮 GPU</span><span class="v">${escapeHtml(info.gpuName || '—')}</span></div>
        <div class="dm-spec-item"><span class="l">🪟 OS</span><span class="v">${escapeHtml(info.osName || '—')}</span></div>
        <div class="dm-spec-item"><span class="l">📅 Didaftarkan</span><span class="v">${device.registeredAt ? fmtDateShort(device.registeredAt) : '—'}</span></div>
        <div class="dm-spec-item"><span class="l">🔑 Login Terakhir</span><span class="v">${device.lastLoginAt ? timeAgo(device.lastLoginAt) : '—'}</span></div>
      </div>
      <div class="dm-actions">
        <button class="btn btn-sm btn-outline" onclick="doShowDeviceSpecs()">🔍 Detail Spesifikasi</button>
        <button class="btn btn-sm btn-outline" onclick="doShowDeviceHistory()">🕘 Riwayat</button>
        <button class="btn btn-sm btn-outline" style="border-color:#ffd76a;color:#ffd76a;" onclick="openDmConfirmModal('change')">🔓 Ganti Device</button>
        <button class="btn btn-sm btn-outline" style="border-color:var(--red);color:var(--red);" onclick="openDmConfirmModal('reset')">♻️ Reset Device</button>
      </div>
    </div>`;
}

function doCopyDeviceId() {
  if (!_dmCurrentDevice?.fingerprint) return;
  navigator.clipboard?.writeText(_dmCurrentDevice.fingerprint)
    .then(() => showToast('Device ID disalin ke clipboard.', 'success'))
    .catch(() => showToast('Gagal menyalin Device ID.', 'error'));
}
window.doCopyDeviceId = doCopyDeviceId;

function doShowDeviceSpecs() {
  const info = _dmCurrentDevice?.info || {};
  const rows = [
    ['🖥️ Nama PC', info.pcName], ['👤 Username Windows', info.windowsUsername],
    ['🪟 Sistem Operasi', info.osName], ['🔢 Versi Windows', info.osVersion],
    ['🏗️ Build Windows', info.osBuild], ['⚙️ Arsitektur', info.arch],
    ['🧠 CPU', info.cpuName], ['🧵 Core / Thread', (info.cpuCores && info.cpuThreads) ? `${info.cpuCores} core / ${info.cpuThreads} thread` : null],
    ['💾 RAM Total', fmtBytes(info.ramTotalBytes)], ['🎮 GPU', info.gpuName],
    ['🔧 Motherboard', [info.boardVendor, info.boardModel].filter(Boolean).join(' ') || null],
    ['💽 Disk Utama', info.diskModel], ['📦 Kapasitas Disk', fmtBytes(info.diskSizeBytes)],
    ['🚀 Versi App', info.appVersion],
  ].filter(([, v]) => v !== null && v !== undefined && v !== '');

  const body = `
    <div class="dm-spec-grid" style="grid-template-columns:1fr 1fr;">
      ${rows.map(([label, value]) => `
        <div class="dm-spec-item"><span class="l">${label}</span><span class="v">${escapeHtml(String(value))}</span></div>
      `).join('')}
    </div>`;
  openDmSubModal('🔍 Detail Spesifikasi Perangkat', body || '<div class="dm-empty">Tidak ada data spesifikasi.</div>');
}
window.doShowDeviceSpecs = doShowDeviceSpecs;

async function doShowDeviceHistory() {
  openDmSubModal('🕘 Riwayat Perangkat', `<div class="empty-cell"><span class="empty-icon">⏳</span>Memuat riwayat...</div>`);
  try {
    const logs = await api(`/api/admin/users/${encodeURIComponent(_dmCurrentDiscordId)}/device/logs`);
    const body = document.getElementById('dmSubModalBody');
    if (!logs.length) { body.innerHTML = `<div class="dm-empty">Belum ada riwayat aktivitas perangkat.</div>`; return; }
    body.innerHTML = logs.map(l => `
      <div class="dm-log-row">
        <div class="dm-log-icon">${DM_LOG_ICON[l.action] || 'ℹ️'}</div>
        <div class="dm-log-body">
          <div class="dm-log-action">${DM_LOG_LABEL[l.action] || l.action}${l.byAdmin ? ' <span style="color:var(--text-faint);">(oleh Admin)</span>' : ''}</div>
          ${l.detail?.attemptedInfo?.pcName ? `<div class="dm-log-detail">Perangkat: ${escapeHtml(l.detail.attemptedInfo.pcName)}</div>` : ''}
          ${l.detail?.changedComponents ? `<div class="dm-log-detail">Komponen berubah: ${escapeHtml(l.detail.changedComponents.join(', '))}</div>` : ''}
          ${l.adminNote ? `<div class="dm-log-detail">📝 ${escapeHtml(l.adminNote)}</div>` : ''}
          <div class="dm-log-time">${fmtDateShort(l.createdAt)}</div>
        </div>
      </div>
    `).join('');
  } catch (e) {
    const body = document.getElementById('dmSubModalBody');
    if (body) body.innerHTML = `<div class="dm-empty">⚠️ Gagal memuat riwayat: ${escapeHtml(e.message)}</div>`;
  }
}
window.doShowDeviceHistory = doShowDeviceHistory;

function openDmSubModal(title, bodyHtml) {
  document.getElementById('dmSubModalTitle').textContent = title;
  document.getElementById('dmSubModalBody').innerHTML = bodyHtml;
  document.getElementById('dmSubModalBackdrop').style.display = 'flex';
}
function closeDmSubModal() {
  document.getElementById('dmSubModalBackdrop').style.display = 'none';
}
window.closeDmSubModal = closeDmSubModal;

// ── Konfirmasi Reset/Ganti Device ──
let _dmConfirmAction = null; // 'reset' | 'change'
function openDmConfirmModal(action) {
  if (!_dmCurrentDiscordId) return;
  _dmConfirmAction = action;
  const isReset = action === 'reset';
  document.getElementById('dmConfirmTitle').textContent = isReset ? '♻️ Reset Device' : '🔓 Ganti Device';
  document.getElementById('dmConfirmText').textContent = isReset
    ? 'Ikatan perangkat user ini akan LANGSUNG dilepas sekarang. Kalau app-nya sedang aktif, user akan otomatis ter-logout. Login berikutnya dari perangkat manapun akan didaftarkan sebagai perangkat baru. Yakin lanjutkan?'
    : 'User TIDAK akan langsung ter-logout. Tapi login berikutnya (dari perangkat manapun) akan didaftarkan sebagai perangkat utama baru, menggantikan yang lama. Yakin lanjutkan?';
  document.getElementById('dmConfirmNote').value = '';
  document.getElementById('dmConfirmModalBackdrop').style.display = 'flex';
}
window.openDmConfirmModal = openDmConfirmModal;

function closeDmConfirmModal() {
  document.getElementById('dmConfirmModalBackdrop').style.display = 'none';
  _dmConfirmAction = null;
}
window.closeDmConfirmModal = closeDmConfirmModal;

document.getElementById('dmConfirmBtn')?.addEventListener('click', async () => {
  if (!_dmConfirmAction || !_dmCurrentDiscordId) return;
  const btn = document.getElementById('dmConfirmBtn');
  const note = document.getElementById('dmConfirmNote').value.trim();
  const endpoint = _dmConfirmAction === 'reset' ? 'reset' : 'allow-change';

  btn.disabled = true; btn.textContent = 'Memproses...';
  try {
    await api(`/api/admin/users/${encodeURIComponent(_dmCurrentDiscordId)}/device/${endpoint}`, {
      method: 'POST', body: JSON.stringify({ note: note || undefined })
    });
    showToast(_dmConfirmAction === 'reset' ? '✅ Device berhasil direset.' : '✅ Pergantian device diizinkan.', 'success');
    closeDmConfirmModal();
    _renderDeviceSection(_dmCurrentDiscordId);
  } catch (e) {
    showToast('Gagal: ' + e.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = 'Konfirmasi';
  }
});

// ══════════════════════════════════════════════════════════════════════════
// BANNER CAROUSEL — Admin CRUD (Tambah/Edit/Hapus/Reorder/Aktif-Nonaktif)
// Data 100% dari koleksi `banners` di DB, realtime ke semua user via WS
// ('banners:update') begitu ada perubahan dari sini.
// ══════════════════════════════════════════════════════════════════════════
let _bannerList = [];
let _bannerEditId = null;
let _bannerType = 'image'; // tipe yang lagi aktif di modal ('image' | 'code')
let _bannerImagePayload = { imageUrl: '', imageData: '' }; // state gambar di modal
let _bannerFilter = { search: '', type: 'all' };
let _bannerCM = { html: null, css: null, js: null }; // instance CodeMirror (dibuat sekali, dipakai ulang)
let _bannerCodePreviewTimer = null;
let _bannerDragFromId = null;

// SATU-SATUNYA fungsi pembangun srcdoc iframe sandbox, disamakan PERSIS dengan
// buildBannerSandboxDoc() di app/app.js supaya Live Preview di sini = tampilan
// asli di App. Kalau ubah salah satu, ubah juga yang satunya.
function buildBannerSandboxDocPreview({ html, css, js }) {
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

window.addEventListener('message', (e) => {
  if (!e.data || e.data.__banner !== 'error') return;
  const errBox = document.getElementById('bannerCodePreviewError');
  const frame = document.getElementById('bannerCodePreviewFrame');
  if (frame && e.source === frame.contentWindow && errBox) errBox.style.display = 'block';
});

async function renderBannerAdmin() {
  const wrap = document.getElementById('bannerList');
  wrap.innerHTML = `<div style="padding:24px;text-align:center;color:var(--text-faint);font-size:12.5px;">Memuat banner...</div>`;
  try {
    _bannerList = await api('/api/admin/banners');
    renderBannerTypeFilter();
    drawBannerAdminList();
  } catch (e) {
    wrap.innerHTML = `<div style="padding:24px;text-align:center;color:var(--red);font-size:12.5px;">Gagal memuat banner: ${escapeHtml(e.message)}</div>`;
  }
}

function renderBannerTypeFilter() {
  const el = document.getElementById('bannerTypeFilter');
  if (!el) return;
  const counts = {
    all: _bannerList.length,
    image: _bannerList.filter(b => (b.bannerType || 'image') === 'image').length,
    code: _bannerList.filter(b => b.bannerType === 'code').length
  };
  const chips = [
    { key: 'all', label: 'Semua', count: counts.all },
    { key: 'image', label: '🖼️ Image', count: counts.image },
    { key: 'code', label: '💻 Code', count: counts.code }
  ];
  el.innerHTML = chips.map(c => `
    <button class="filter-chip ${_bannerFilter.type === c.key ? 'active' : ''}" data-type="${c.key}">
      ${c.label} <span class="count">${c.count}</span>
    </button>`).join('');
  el.querySelectorAll('.filter-chip').forEach(btn => {
    btn.addEventListener('click', () => { _bannerFilter.type = btn.dataset.type; drawBannerAdminList(); });
  });
}

document.getElementById('bannerSearchInput')?.addEventListener('input', (e) => {
  _bannerFilter.search = e.target.value;
  drawBannerAdminList();
});

function getFilteredBanners() {
  let rows = _bannerList;
  if (_bannerFilter.type !== 'all') rows = rows.filter(b => (b.bannerType || 'image') === _bannerFilter.type);
  const q = _bannerFilter.search.trim().toLowerCase();
  if (q) rows = rows.filter(b => (b.title || '').toLowerCase().includes(q) || (b.subtitle || '').toLowerCase().includes(q));
  return rows;
}

function drawBannerAdminList() {
  const wrap = document.getElementById('bannerList');
  const rows = getFilteredBanners();

  if (!_bannerList.length) {
    wrap.innerHTML = `
      <div style="padding:40px 20px;text-align:center;color:var(--text-faint);">
        <div style="font-size:32px;margin-bottom:8px;">🗂️</div>
        <div style="font-size:13px;">Belum ada banner. Klik "Tambah Banner" untuk membuat yang pertama.</div>
      </div>`;
    return;
  }
  if (!rows.length) {
    wrap.innerHTML = `
      <div style="padding:40px 20px;text-align:center;color:var(--text-faint);">
        <div style="font-size:32px;margin-bottom:8px;">🔍</div>
        <div style="font-size:13px;">Tidak ada banner yang cocok dengan pencarian/filter.</div>
      </div>`;
    return;
  }

  wrap.innerHTML = rows.map((b) => {
    const idx = _bannerList.findIndex(x => x._id === b._id);
    const now = new Date();
    const startAt = b.startAt ? new Date(b.startAt) : null;
    const endAt = b.endAt ? new Date(b.endAt) : null;
    const withinPeriod = (!startAt || startAt <= now) && (!endAt || endAt >= now);
    const liveNow = b.isActive && withinPeriod;
    const type = b.bannerType || 'image';
    const img = b.imageData || b.imageUrl;

    const thumb = type === 'code'
      ? `<div class="banner-thumb" style="background:linear-gradient(135deg,#241a3d,#0d0a18);"><span style="font-size:22px;">💻</span></div>`
      : img
        ? `<div class="banner-thumb" style="background-image:url('${escapeHtml(img)}');"></div>`
        : `<div class="banner-thumb" style="background:linear-gradient(135deg, ${escapeHtml(b.gradientFrom || '#7b5cff')}, ${escapeHtml(b.gradientTo || '#241a3d')});"><span style="font-size:20px;">${escapeHtml(b.icon || '🖼️')}</span></div>`;

    return `
    <div class="banner-admin-item" draggable="true" data-id="${b._id}" style="display:flex;align-items:center;gap:12px;padding:14px 16px;border-bottom:1px solid var(--border);">
      <span class="banner-drag-handle" title="Geser untuk ubah urutan">⠿</span>
      <div style="display:flex;flex-direction:column;gap:2px;">
        <button class="btn-icon-sm" title="Naikkan urutan" onclick="moveBanner('${b._id}', -1)" ${idx === 0 ? 'disabled style="opacity:.3;"' : ''}>▲</button>
        <button class="btn-icon-sm" title="Turunkan urutan" onclick="moveBanner('${b._id}', 1)" ${idx === _bannerList.length - 1 ? 'disabled style="opacity:.3;"' : ''}>▼</button>
      </div>
      ${thumb}
      <div style="flex:1;min-width:0;">
        <div style="font-weight:700;font-size:13.5px;color:var(--text-main);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(b.title)}</div>
        <div style="font-size:11.5px;color:var(--text-faint);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(b.subtitle || b.description || '—')}</div>
        <div style="margin-top:4px;display:flex;gap:6px;flex-wrap:wrap;">
          <span class="banner-badge ${type}">${type === 'code' ? '💻 Code' : '🖼️ Image'}</span>
          <span class="tag ${liveNow ? 'gold' : 'public'}" style="font-size:10px;">${liveNow ? '● Tayang' : (b.isActive ? '○ Di luar jadwal' : '○ Nonaktif')}</span>
          ${b.ctaText ? `<span class="tag public" style="font-size:10px;">🔘 ${escapeHtml(b.ctaText)}</span>` : ''}
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:8px;flex-shrink:0;">
        <label class="switch" title="Aktif/Nonaktif">
          <input type="checkbox" ${b.isActive ? 'checked' : ''} onchange="toggleBannerActive('${b._id}', this.checked)">
          <span class="switch-slider"></span>
        </label>
        <button class="btn btn-secondary btn-sm" onclick="openBannerModal('${b._id}')">✎ Edit</button>
        <button class="btn btn-danger btn-sm" onclick="deleteBanner('${b._id}')">🗑</button>
      </div>
    </div>`;
  }).join('');

  wireBannerDragAndDrop();
}

// Drag & drop urutan banner (native HTML5 DnD) — tetap dilengkapi tombol ▲▼
// buat yang lebih nyaman pakai keyboard/klik biasa.
function wireBannerDragAndDrop() {
  const items = document.querySelectorAll('#bannerList .banner-admin-item');
  items.forEach(el => {
    el.addEventListener('dragstart', () => {
      _bannerDragFromId = el.dataset.id;
      el.classList.add('dragging');
    });
    el.addEventListener('dragend', () => {
      el.classList.remove('dragging');
      items.forEach(x => x.classList.remove('drag-over'));
    });
    el.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (el.dataset.id !== _bannerDragFromId) el.classList.add('drag-over');
    });
    el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
    el.addEventListener('drop', async (e) => {
      e.preventDefault();
      el.classList.remove('drag-over');
      const toId = el.dataset.id;
      if (!_bannerDragFromId || _bannerDragFromId === toId) return;
      const fromIdx = _bannerList.findIndex(b => b._id === _bannerDragFromId);
      const toIdx = _bannerList.findIndex(b => b._id === toId);
      if (fromIdx < 0 || toIdx < 0) return;
      const [moved] = _bannerList.splice(fromIdx, 1);
      _bannerList.splice(toIdx, 0, moved);
      drawBannerAdminList(); // optimistic UI
      try {
        await api('/api/admin/banners/reorder', { method: 'PUT', body: JSON.stringify({ order: _bannerList.map(b => b._id) }) });
        showToast('✅ Urutan banner diperbarui.', 'success');
      } catch (err) {
        showToast('Gagal ubah urutan: ' + err.message, 'error');
        renderBannerAdmin();
      }
    });
  });
}

async function moveBanner(id, dir) {
  const idx = _bannerList.findIndex(b => b._id === id);
  const swapIdx = idx + dir;
  if (idx < 0 || swapIdx < 0 || swapIdx >= _bannerList.length) return;
  [_bannerList[idx], _bannerList[swapIdx]] = [_bannerList[swapIdx], _bannerList[idx]];
  drawBannerAdminList(); // optimistic UI
  try {
    await api('/api/admin/banners/reorder', { method: 'PUT', body: JSON.stringify({ order: _bannerList.map(b => b._id) }) });
    showToast('✅ Urutan banner diperbarui.', 'success');
  } catch (e) {
    showToast('Gagal ubah urutan: ' + e.message, 'error');
    renderBannerAdmin();
  }
}

async function toggleBannerActive(id, isActive) {
  try {
    await api(`/api/admin/banners/${id}`, { method: 'PUT', body: JSON.stringify({ isActive }) });
    showToast(isActive ? '✅ Banner diaktifkan.' : '✅ Banner dinonaktifkan.', 'success');
    const b = _bannerList.find(x => x._id === id);
    if (b) b.isActive = isActive;
    drawBannerAdminList();
  } catch (e) {
    showToast('Gagal: ' + e.message, 'error');
    renderBannerAdmin();
  }
}

async function deleteBanner(id) {
  const b = _bannerList.find(x => x._id === id);
  if (!confirm(`Yakin mau hapus banner "${b?.title || ''}"? Tindakan ini tidak bisa dibatalkan.`)) return;
  try {
    await api(`/api/admin/banners/${id}`, { method: 'DELETE' });
    showToast('✅ Banner dihapus.', 'success');
    renderBannerAdmin();
  } catch (e) {
    showToast('Gagal hapus banner: ' + e.message, 'error');
  }
}

function toLocalDatetimeInput(dateVal) {
  if (!dateVal) return '';
  const d = new Date(dateVal);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ── CodeMirror: dibuat SEKALI (lazy), dipakai ulang tiap buka modal supaya
// ga bikin instance baru berkali-kali (yang bisa bikin leak & rebinding aneh).
function ensureBannerCodeMirrors() {
  if (_bannerCM.html) return;
  if (typeof CodeMirror === 'undefined') return; // CDN gagal load (mis. offline) — modal tetap jalan tanpa syntax highlight
  const common = { theme: 'dracula', lineNumbers: true, lineWrapping: true, viewportMargin: Infinity };
  _bannerCM.html = CodeMirror(document.getElementById('cmHtmlBox'), { ...common, mode: 'htmlmixed', value: '' });
  _bannerCM.css  = CodeMirror(document.getElementById('cmCssBox'),  { ...common, mode: 'css',       value: '' });
  _bannerCM.js   = CodeMirror(document.getElementById('cmJsBox'),   { ...common, mode: 'javascript', value: '' });
  [_bannerCM.html, _bannerCM.css, _bannerCM.js].forEach(cm => cm.on('change', scheduleBannerCodePreview));
}

function getBannerCodeValue(which) {
  if (_bannerCM[which]) return _bannerCM[which].getValue();
  // Fallback kalau CodeMirror gagal load dari CDN — pakai <textarea> polos di baliknya (dibuat oleh CodeMirror() saat init, jadi kalau CDN gagal, box-nya kosong; user tetap bisa isi lewat elemen aslinya kalau ada)
  return '';
}
function setBannerCodeValue(which, val) {
  if (_bannerCM[which]) _bannerCM[which].setValue(val || '');
}

function copyBannerCode(which) {
  const val = getBannerCodeValue(which);
  navigator.clipboard?.writeText(val).then(
    () => showToast('✅ Kode disalin.', 'success'),
    () => showToast('Gagal menyalin kode.', 'error')
  );
}
function resetBannerCode(which) {
  if (!confirm('Kosongkan isi editor ini?')) return;
  setBannerCodeValue(which, '');
  scheduleBannerCodePreview();
}

function scheduleBannerCodePreview() {
  clearTimeout(_bannerCodePreviewTimer);
  _bannerCodePreviewTimer = setTimeout(updateBannerCodePreview, 400);
}
function updateBannerCodePreview() {
  const frame = document.getElementById('bannerCodePreviewFrame');
  const errBox = document.getElementById('bannerCodePreviewError');
  if (!frame) return;
  errBox.style.display = 'none';
  frame.srcdoc = buildBannerSandboxDocPreview({
    html: getBannerCodeValue('html'),
    css: getBannerCodeValue('css'),
    js: getBannerCodeValue('js')
  });
}

function setBannerType(type) {
  _bannerType = type;
  document.querySelectorAll('.banner-type-tab').forEach(t => t.classList.toggle('active', t.dataset.type === type));
  document.getElementById('bannerImageFields').style.display = type === 'image' ? '' : 'none';
  document.getElementById('bannerCodeFields').style.display = type === 'code' ? '' : 'none';
  document.getElementById('bannerImagePreviewSection').style.display = type === 'image' ? '' : 'none';
  if (type === 'code') {
    ensureBannerCodeMirrors();
    // CodeMirror butuh refresh() setelah container-nya baru saja ditampilkan
    // (waktu masih display:none, dia ga bisa ngukur lebar dgn benar).
    setTimeout(() => { [_bannerCM.html, _bannerCM.css, _bannerCM.js].forEach(cm => cm?.refresh()); updateBannerCodePreview(); }, 30);
  }
}

function clearBannerImage() {
  _bannerImagePayload = { imageUrl: '', imageData: '' };
  document.getElementById('bannerImageUrl').value = '';
  document.getElementById('bannerImageFile').value = '';
  document.getElementById('bannerImagePreviewWrap').style.display = 'none';
  updateBannerPreview();
}

document.getElementById('bannerImageFile')?.addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  if (file.size > 2 * 1024 * 1024) {
    showToast('Ukuran gambar maksimal 2MB.', 'error');
    e.target.value = '';
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    _bannerImagePayload = { imageUrl: '', imageData: reader.result };
    document.getElementById('bannerImageUrl').value = '';
    showBannerImagePreview(reader.result);
  };
  reader.readAsDataURL(file);
});
document.getElementById('bannerImageUrl')?.addEventListener('input', (e) => {
  const url = e.target.value.trim();
  if (url) {
    _bannerImagePayload = { imageUrl: url, imageData: '' };
    document.getElementById('bannerImageFile').value = '';
    showBannerImagePreview(url);
  } else if (!document.getElementById('bannerImageFile').files?.length) {
    clearBannerImage();
  }
});
function showBannerImagePreview(src) {
  document.getElementById('bannerImagePreviewImg').src = src;
  document.getElementById('bannerImagePreviewWrap').style.display = 'block';
  updateBannerPreview();
}

function openBannerModal(id) {
  _bannerEditId = id || null;
  const b = id ? _bannerList.find(x => x._id === id) : null;

  document.getElementById('bannerModalTitle').textContent = b ? 'Edit Banner' : 'Tambah Banner';
  document.getElementById('bannerTitle').value = b?.title || '';
  document.getElementById('bannerSubtitle').value = b?.subtitle || '';
  document.getElementById('bannerDescription').value = b?.description || '';
  document.getElementById('bannerCtaText').value = b?.ctaText || 'Selengkapnya';
  document.getElementById('bannerCtaLink').value = b?.ctaLink || '';
  document.getElementById('bannerGradientFrom').value = b?.gradientFrom || '#7b5cff';
  document.getElementById('bannerGradientTo').value = b?.gradientTo || '#241a3d';
  document.getElementById('bannerIcon').value = b?.icon || '';
  document.getElementById('bannerStartAt').value = toLocalDatetimeInput(b?.startAt);
  document.getElementById('bannerEndAt').value = toLocalDatetimeInput(b?.endAt);
  document.getElementById('bannerIsActive').checked = b ? !!b.isActive : true;

  // Gambar
  _bannerImagePayload = { imageUrl: b?.imageUrl || '', imageData: b?.imageData || '' };
  document.getElementById('bannerImageUrl').value = b?.imageUrl || '';
  document.getElementById('bannerImageFile').value = '';
  if (b?.imageData || b?.imageUrl) showBannerImagePreview(b.imageData || b.imageUrl);
  else document.getElementById('bannerImagePreviewWrap').style.display = 'none';

  // Kode
  ensureBannerCodeMirrors();
  setBannerCodeValue('html', b?.codeHtml || '');
  setBannerCodeValue('css', b?.codeCss || '');
  setBannerCodeValue('js', b?.codeJs || '');

  setBannerType(b?.bannerType === 'code' ? 'code' : 'image');
  updateBannerPreview();
  document.getElementById('bannerModalBackdrop').style.display = 'flex';
}

function closeBannerModal() {
  document.getElementById('bannerModalBackdrop').style.display = 'none';
  _bannerEditId = null;
}

function updateBannerPreview() {
  const from = document.getElementById('bannerGradientFrom').value;
  const to = document.getElementById('bannerGradientTo').value;
  const title = document.getElementById('bannerTitle').value || 'Judul Banner';
  const desc = document.getElementById('bannerDescription').value || '';
  const img = _bannerImagePayload.imageData || _bannerImagePayload.imageUrl;
  const box = document.getElementById('bannerPreviewBox');
  if (box) {
    box.style.backgroundImage = img
      ? `linear-gradient(90deg, rgba(10,6,16,.82), rgba(10,6,16,.35)), url('${img}')`
      : 'none';
    box.style.background = img ? '' : `linear-gradient(135deg, ${from}, ${to})`;
  }
  document.getElementById('bannerPreviewTitle').textContent = title;
  document.getElementById('bannerPreviewDesc').textContent = desc;
}
['bannerTitle', 'bannerDescription', 'bannerGradientFrom', 'bannerGradientTo'].forEach(id => {
  document.getElementById(id)?.addEventListener('input', updateBannerPreview);
});

document.getElementById('btnAddBanner')?.addEventListener('click', () => openBannerModal(null));

document.getElementById('btnSaveBanner')?.addEventListener('click', async () => {
  const btn = document.getElementById('btnSaveBanner');
  const payload = {
    bannerType: _bannerType,
    title: document.getElementById('bannerTitle').value.trim(),
    subtitle: document.getElementById('bannerSubtitle').value.trim(),
    description: document.getElementById('bannerDescription').value.trim(),
    ctaText: document.getElementById('bannerCtaText').value.trim(),
    ctaLink: document.getElementById('bannerCtaLink').value.trim(),
    isActive: document.getElementById('bannerIsActive').checked,
    startAt: document.getElementById('bannerStartAt').value ? new Date(document.getElementById('bannerStartAt').value).toISOString() : null,
    endAt: document.getElementById('bannerEndAt').value ? new Date(document.getElementById('bannerEndAt').value).toISOString() : null,
  };
  if (!payload.title) { showToast('Judul banner wajib diisi.', 'error'); return; }

  if (_bannerType === 'image') {
    payload.gradientFrom = document.getElementById('bannerGradientFrom').value;
    payload.gradientTo = document.getElementById('bannerGradientTo').value;
    payload.icon = document.getElementById('bannerIcon').value.trim();
    payload.imageUrl = _bannerImagePayload.imageUrl || '';
    payload.imageData = _bannerImagePayload.imageData || '';
  } else {
    const html = getBannerCodeValue('html').trim();
    if (!html) { showToast('HTML wajib diisi untuk Code Banner.', 'error'); return; }
    payload.codeHtml = html;
    payload.codeCss = getBannerCodeValue('css');
    payload.codeJs = getBannerCodeValue('js');
  }

  btn.disabled = true; btn.textContent = 'Menyimpan...';
  try {
    if (_bannerEditId) {
      await api(`/api/admin/banners/${_bannerEditId}`, { method: 'PUT', body: JSON.stringify(payload) });
    } else {
      await api('/api/admin/banners', { method: 'POST', body: JSON.stringify(payload) });
    }
    showToast('✅ Banner berhasil disimpan.', 'success');
    closeBannerModal();
    renderBannerAdmin();
  } catch (e) {
    showToast('Gagal simpan banner: ' + e.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = 'Simpan Banner';
  }
});

// ══════════════════════════════════════════════════════════════════════════
// KELOLA TUTORIAL — Admin Web
// Pola CRUD-nya sama seperti Banner (list + modal + toggle status + delete),
// bedanya "Isi Tutorial" pakai rich text editor (Quill) dan tidak ada
// drag-reorder (tutorial ditampilkan terurut createdAt terbaru dulu, sama
// seperti di App). Thumbnail & Gambar Pendukung disimpan base64 (atau URL),
// polanya identik dengan upload gambar Banner.
// ══════════════════════════════════════════════════════════════════════════
let _tutorialList = [];
let _tutorialEditId = null;
let _tutorialFilter = { search: '', status: 'all' };
let _tutorialThumbPayload = { url: '', data: '' };
let _tutorialImagePayload = { url: '', data: '' };
let _tutorialQuill = null;

async function renderTutorialAdmin() {
  const wrap = document.getElementById('tutorialAdminList');
  wrap.innerHTML = `<div style="padding:24px;text-align:center;color:var(--text-faint);font-size:12.5px;">Memuat tutorial...</div>`;
  try {
    _tutorialList = await api('/api/admin/tutorials');
    renderTutorialStatusFilter();
    drawTutorialAdminList();
    populateTutorialCategoryDatalist();
  } catch (e) {
    wrap.innerHTML = `<div style="padding:24px;text-align:center;color:var(--red);font-size:12.5px;">Gagal memuat tutorial: ${escapeHtml(e.message)}</div>`;
  }
}

function renderTutorialStatusFilter() {
  const el = document.getElementById('tutorialStatusFilter');
  if (!el) return;
  const counts = {
    all: _tutorialList.length,
    published: _tutorialList.filter(t => t.status === 'published').length,
    draft: _tutorialList.filter(t => t.status === 'draft').length
  };
  const chips = [
    { key: 'all', label: 'Semua', count: counts.all },
    { key: 'published', label: '✅ Published', count: counts.published },
    { key: 'draft', label: '📝 Draft', count: counts.draft }
  ];
  el.innerHTML = chips.map(c => `
    <button class="filter-chip ${_tutorialFilter.status === c.key ? 'active' : ''}" data-status="${c.key}">
      ${c.label} <span class="count">${c.count}</span>
    </button>`).join('');
  el.querySelectorAll('.filter-chip').forEach(btn => {
    btn.addEventListener('click', () => { _tutorialFilter.status = btn.dataset.status; drawTutorialAdminList(); });
  });
}

document.getElementById('tutorialSearchInputAdmin')?.addEventListener('input', (e) => {
  _tutorialFilter.search = e.target.value;
  drawTutorialAdminList();
});

function getFilteredTutorials() {
  let rows = _tutorialList;
  if (_tutorialFilter.status !== 'all') rows = rows.filter(t => t.status === _tutorialFilter.status);
  const q = _tutorialFilter.search.trim().toLowerCase();
  if (q) rows = rows.filter(t => (t.title || '').toLowerCase().includes(q) || (t.category || '').toLowerCase().includes(q));
  return rows;
}

function populateTutorialCategoryDatalist() {
  const el = document.getElementById('tutorialCategoryOptions');
  if (!el) return;
  const categories = Array.from(new Set(_tutorialList.map(t => t.category).filter(Boolean))).sort();
  el.innerHTML = categories.map(c => `<option value="${escapeHtml(c)}">`).join('');
}

function drawTutorialAdminList() {
  const wrap = document.getElementById('tutorialAdminList');
  const rows = getFilteredTutorials();

  if (!_tutorialList.length) {
    wrap.innerHTML = `
      <div style="padding:40px 20px;text-align:center;color:var(--text-faint);">
        <div style="font-size:32px;margin-bottom:8px;">📘</div>
        <div style="font-size:13px;">Belum ada tutorial. Klik "Tambah Tutorial" untuk membuat yang pertama.</div>
      </div>`;
    return;
  }
  if (!rows.length) {
    wrap.innerHTML = `
      <div style="padding:40px 20px;text-align:center;color:var(--text-faint);">
        <div style="font-size:32px;margin-bottom:8px;">🔍</div>
        <div style="font-size:13px;">Tidak ada tutorial yang cocok dengan pencarian/filter.</div>
      </div>`;
    return;
  }

  wrap.innerHTML = rows.map((t) => {
    const thumb = t.thumbnailData || t.thumbnailUrl;
    const thumbHtml = thumb
      ? `<div class="banner-thumb" style="background-image:url('${escapeHtml(thumb)}');"></div>`
      : `<div class="banner-thumb" style="background:linear-gradient(135deg,#4facfe,#7c5cff);"><span style="font-size:20px;">📘</span></div>`;

    return `
    <div class="banner-admin-item" data-id="${t._id}" style="display:flex;align-items:center;gap:12px;padding:14px 16px;border-bottom:1px solid var(--border);">
      ${thumbHtml}
      <div style="flex:1;min-width:0;">
        <div style="font-weight:700;font-size:13.5px;color:var(--text-main);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(t.title)}</div>
        <div style="font-size:11.5px;color:var(--text-faint);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(t.description || '—')}</div>
        <div style="margin-top:4px;display:flex;gap:6px;flex-wrap:wrap;">
          <span class="tag public" style="font-size:10px;">🏷️ ${escapeHtml(t.category || 'Umum')}</span>
          <span class="tag ${t.status}" style="font-size:10px;">${t.status === 'published' ? '✅ Published' : '📝 Draft'}</span>
          ${t.videoPlatform === 'tiktok' ? `<span class="tag public" style="font-size:10px;">🎵 TikTok</span>` : ''}
          ${(t.videoPlatform === 'youtube' || (!t.videoPlatform && t.youtubeId)) ? `<span class="tag public" style="font-size:10px;">▶️ YouTube</span>` : ''}
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:8px;flex-shrink:0;">
        <label class="switch" title="Publish/Draft">
          <input type="checkbox" ${t.status === 'published' ? 'checked' : ''} onchange="toggleTutorialStatus('${t._id}', this.checked)">
          <span class="switch-slider"></span>
        </label>
        <button class="btn btn-secondary btn-sm" onclick="openTutorialModal('${t._id}')">✎ Edit</button>
        <button class="btn btn-danger btn-sm" onclick="deleteTutorial('${t._id}')">🗑</button>
      </div>
    </div>`;
  }).join('');
}

async function toggleTutorialStatus(id, isPublished) {
  const status = isPublished ? 'published' : 'draft';
  try {
    await api(`/api/admin/tutorials/${id}/status`, { method: 'PUT', body: JSON.stringify({ status }) });
    showToast(isPublished ? '✅ Tutorial dipublish.' : '✅ Tutorial dijadikan draft.', 'success');
    const t = _tutorialList.find(x => x._id === id);
    if (t) t.status = status;
    renderTutorialStatusFilter();
    drawTutorialAdminList();
  } catch (e) {
    showToast('Gagal: ' + e.message, 'error');
    renderTutorialAdmin();
  }
}

async function deleteTutorial(id) {
  const t = _tutorialList.find(x => x._id === id);
  if (!confirm(`Yakin mau hapus tutorial "${t?.title || ''}"? Tindakan ini tidak bisa dibatalkan.`)) return;
  try {
    await api(`/api/admin/tutorials/${id}`, { method: 'DELETE' });
    showToast('✅ Tutorial dihapus.', 'success');
    renderTutorialAdmin();
  } catch (e) {
    showToast('Gagal hapus tutorial: ' + e.message, 'error');
  }
}

// Quill dibuat sekali (lazy) & dipakai ulang tiap buka modal. Toolbar sengaja
// tidak menyertakan tombol image/video — itu diisi lewat kolom Gambar
// Pendukung & Link YouTube terpisah di modal, bukan disisipkan ke dalam konten.
function ensureTutorialQuill() {
  if (_tutorialQuill) return;
  if (typeof Quill === 'undefined') return; // CDN gagal load (mis. offline) — modal tetap jalan tanpa rich text editor
  _tutorialQuill = new Quill('#tutorialContentEditor', {
    theme: 'snow',
    placeholder: 'Tulis isi tutorial di sini...',
    modules: {
      toolbar: [
        [{ header: [1, 2, 3, false] }],
        ['bold', 'italic', 'underline', 'strike'],
        [{ list: 'ordered' }, { list: 'bullet' }],
        ['blockquote', 'code-block', 'link'],
        ['clean']
      ]
    }
  });
}

function getTutorialContentValue() {
  if (_tutorialQuill) return _tutorialQuill.root.innerHTML;
  return document.querySelector('#tutorialContentEditor')?.innerHTML || '';
}

function setTutorialContentValue(html) {
  if (_tutorialQuill) _tutorialQuill.root.innerHTML = html || '';
}

function clearTutorialImage(which) {
  if (which === 'thumbnail') {
    _tutorialThumbPayload = { url: '', data: '' };
    document.getElementById('tutorialThumbnailUrl').value = '';
    document.getElementById('tutorialThumbnailFile').value = '';
    document.getElementById('tutorialThumbnailPreviewWrap').style.display = 'none';
  } else {
    _tutorialImagePayload = { url: '', data: '' };
    document.getElementById('tutorialImageUrl').value = '';
    document.getElementById('tutorialImageFile').value = '';
    document.getElementById('tutorialImagePreviewWrap').style.display = 'none';
  }
}

function showTutorialImagePreview(which, src) {
  const img = document.getElementById(which === 'thumbnail' ? 'tutorialThumbnailPreviewImg' : 'tutorialImagePreviewImg');
  const wrap = document.getElementById(which === 'thumbnail' ? 'tutorialThumbnailPreviewWrap' : 'tutorialImagePreviewWrap');
  img.src = src;
  wrap.style.display = 'block';
}

function wireTutorialImageInputs(which) {
  const fileId = which === 'thumbnail' ? 'tutorialThumbnailFile' : 'tutorialImageFile';
  const urlId = which === 'thumbnail' ? 'tutorialThumbnailUrl' : 'tutorialImageUrl';
  document.getElementById(fileId)?.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      showToast('Ukuran gambar maksimal 2MB.', 'error');
      e.target.value = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const payload = { url: '', data: reader.result };
      if (which === 'thumbnail') _tutorialThumbPayload = payload; else _tutorialImagePayload = payload;
      document.getElementById(urlId).value = '';
      showTutorialImagePreview(which, reader.result);
    };
    reader.readAsDataURL(file);
  });
  document.getElementById(urlId)?.addEventListener('input', (e) => {
    const url = e.target.value.trim();
    if (url) {
      const payload = { url, data: '' };
      if (which === 'thumbnail') _tutorialThumbPayload = payload; else _tutorialImagePayload = payload;
      document.getElementById(fileId).value = '';
      showTutorialImagePreview(which, url);
    } else if (!document.getElementById(fileId).files?.length) {
      clearTutorialImage(which);
    }
  });
}
wireTutorialImageInputs('thumbnail');
wireTutorialImageInputs('image');

document.getElementById('tutorialStatusSegment')?.querySelectorAll('.segmented-opt').forEach(btn => {
  btn.addEventListener('click', () => {
    const status = btn.dataset.status;
    document.getElementById('tutorialStatus').value = status;
    document.getElementById('tutorialStatusSegment').dataset.value = status;
    document.getElementById('tutorialStatusSegment').querySelectorAll('.segmented-opt').forEach(b => b.classList.toggle('active', b.dataset.status === status));
  });
});

function openTutorialModal(id) {
  _tutorialEditId = id || null;
  const t = id ? _tutorialList.find(x => x._id === id) : null;

  document.getElementById('tutorialModalTitle').textContent = t ? 'Edit Tutorial' : 'Tambah Tutorial';
  document.getElementById('tutorialTitle').value = t?.title || '';
  document.getElementById('tutorialCategory').value = t?.category || '';
  document.getElementById('tutorialDescription').value = t?.description || '';
  const _tPlatform = t?.videoPlatform || (t?.youtubeId ? 'youtube' : '');
  const _tVideoId = t?.videoId || t?.youtubeId || '';
  let _tVideoUrlPrefill = '';
  if (_tPlatform === 'youtube' && _tVideoId) _tVideoUrlPrefill = `https://youtu.be/${_tVideoId}`;
  else if (_tPlatform === 'tiktok' && _tVideoId) _tVideoUrlPrefill = `https://www.tiktok.com/embed/v2/${_tVideoId}`;
  document.getElementById('tutorialVideoUrl').value = _tVideoUrlPrefill;

  const status = t?.status === 'draft' ? 'draft' : 'published';
  document.getElementById('tutorialStatus').value = status;
  document.getElementById('tutorialStatusSegment').dataset.value = status;
  document.getElementById('tutorialStatusSegment').querySelectorAll('.segmented-opt').forEach(b => b.classList.toggle('active', b.dataset.status === status));

  _tutorialThumbPayload = { url: t?.thumbnailUrl || '', data: t?.thumbnailData || '' };
  document.getElementById('tutorialThumbnailUrl').value = t?.thumbnailUrl || '';
  document.getElementById('tutorialThumbnailFile').value = '';
  if (t?.thumbnailData || t?.thumbnailUrl) showTutorialImagePreview('thumbnail', t.thumbnailData || t.thumbnailUrl);
  else document.getElementById('tutorialThumbnailPreviewWrap').style.display = 'none';

  _tutorialImagePayload = { url: t?.imageUrl || '', data: t?.imageData || '' };
  document.getElementById('tutorialImageUrl').value = t?.imageUrl || '';
  document.getElementById('tutorialImageFile').value = '';
  if (t?.imageData || t?.imageUrl) showTutorialImagePreview('image', t.imageData || t.imageUrl);
  else document.getElementById('tutorialImagePreviewWrap').style.display = 'none';

  ensureTutorialQuill();
  setTutorialContentValue(t?.content || '');

  document.getElementById('tutorialModalBackdrop').style.display = 'flex';
}

function closeTutorialModal() {
  document.getElementById('tutorialModalBackdrop').style.display = 'none';
  _tutorialEditId = null;
}

document.getElementById('btnAddTutorial')?.addEventListener('click', () => openTutorialModal(null));

document.getElementById('btnSaveTutorial')?.addEventListener('click', async () => {
  const btn = document.getElementById('btnSaveTutorial');
  const payload = {
    title: document.getElementById('tutorialTitle').value.trim(),
    category: document.getElementById('tutorialCategory').value.trim(),
    description: document.getElementById('tutorialDescription').value.trim(),
    videoUrl: document.getElementById('tutorialVideoUrl').value.trim(),
    status: document.getElementById('tutorialStatus').value,
    content: getTutorialContentValue(),
    thumbnailUrl: _tutorialThumbPayload.url || '',
    thumbnailData: _tutorialThumbPayload.data || '',
    imageUrl: _tutorialImagePayload.url || '',
    imageData: _tutorialImagePayload.data || ''
  };

  if (!payload.title) { showToast('Judul tutorial wajib diisi.', 'error'); return; }
  const plainContent = payload.content.replace(/<[^>]*>/g, '').trim();
  if (!plainContent) { showToast('Isi tutorial wajib diisi.', 'error'); return; }

  btn.disabled = true; btn.textContent = 'Menyimpan...';
  try {
    if (_tutorialEditId) {
      await api(`/api/admin/tutorials/${_tutorialEditId}`, { method: 'PUT', body: JSON.stringify(payload) });
    } else {
      await api('/api/admin/tutorials', { method: 'POST', body: JSON.stringify(payload) });
    }
    showToast('✅ Tutorial berhasil disimpan.', 'success');
    closeTutorialModal();
    renderTutorialAdmin();
  } catch (e) {
    showToast('Gagal simpan tutorial: ' + e.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = 'Simpan Tutorial';
  }
});

// ══════════════════════════════════════════════════════════════════════════
// TOP INSTALLER MINGGUAN — Admin view (realtime dari histori install asli)
// ══════════════════════════════════════════════════════════════════════════
const LB_ADMIN_ROLE_LABEL = { public: 'Public', gold: 'Gold', platinum: 'Platinum', admin: 'Admin' };

function fmtWeekRange(weekStart, weekEnd) {
  if (!weekStart) return '';
  const opts = { day: '2-digit', month: 'short' };
  const s = new Date(weekStart).toLocaleDateString('id-ID', opts);
  const e = new Date(new Date(weekEnd).getTime() - 1).toLocaleDateString('id-ID', opts);
  return `${s} — ${e}`;
}

async function renderLeaderboardAdmin() {
  const wrap = document.getElementById('lbAdminList');
  wrap.innerHTML = `<div style="padding:24px;text-align:center;color:var(--text-faint);font-size:12.5px;">Memuat leaderboard...</div>`;
  try {
    const data = await api('/api/admin/leaderboard');
    document.getElementById('lbWeekRange').textContent = fmtWeekRange(data.weekStart, data.weekEnd);
    drawLeaderboardAdminList(data.entries || []);
    renderLeaderboardHistoryTable();
  } catch (e) {
    wrap.innerHTML = `<div style="padding:24px;text-align:center;color:var(--red);font-size:12.5px;">Gagal memuat leaderboard: ${escapeHtml(e.message)}</div>`;
  }
}

function drawLeaderboardAdminList(entries) {
  const wrap = document.getElementById('lbAdminList');
  if (!entries.length) {
    wrap.innerHTML = `
      <div style="padding:40px 20px;text-align:center;color:var(--text-faint);">
        <div style="font-size:32px;margin-bottom:8px;">🏆</div>
        <div style="font-size:13px;">Belum ada install minggu ini.</div>
      </div>`;
    return;
  }
  const medal = { 1: '🥇', 2: '🥈', 3: '🥉' };
  wrap.innerHTML = entries.map((u, i) => {
    const rank = i + 1;
    return `
    <div style="display:flex;align-items:center;gap:14px;padding:12px 16px;border-bottom:1px solid var(--border);">
      <div style="width:26px;text-align:center;font-size:15px;font-weight:800;">${medal[rank] || rank}</div>
      <img src="${escapeHtml(u.avatarUrl || 'https://cdn.discordapp.com/embed/avatars/0.png')}" style="width:34px;height:34px;border-radius:50%;object-fit:cover;" onerror="this.src='https://cdn.discordapp.com/embed/avatars/0.png'">
      <div style="flex:1;min-width:0;">
        <div style="font-weight:700;font-size:13px;color:var(--text-main);">${escapeHtml(u.username)}</div>
        <div style="font-size:11px;color:var(--text-faint);">${escapeHtml(u.discordId)}</div>
      </div>
      ${roleTagHtml(u.role)}
      <div style="font-weight:800;font-size:13.5px;color:var(--text-main);min-width:70px;text-align:right;">🔥 ${u.installs}</div>
    </div>`;
  }).join('');
}

async function renderLeaderboardHistoryTable() {
  const table = document.getElementById('tableLeaderboardHistory');
  try {
    const rows = await api('/api/admin/leaderboard/history');
    if (!rows.length) {
      table.innerHTML = `<tbody><tr><td style="padding:20px;text-align:center;color:var(--text-faint);">Belum ada histori minggu sebelumnya.</td></tr></tbody>`;
      return;
    }
    table.innerHTML = `
      <thead><tr><th>Minggu</th><th>Juara 1</th><th>Juara 2</th><th>Juara 3</th></tr></thead>
      <tbody>
        ${rows.map(r => `
          <tr>
            <td>${fmtWeekRange(r.weekStart, r.weekEnd)}</td>
            ${[0, 1, 2].map(i => r.entries[i]
              ? `<td>${escapeHtml(r.entries[i].username)} <span style="color:var(--text-faint);">(🔥${r.entries[i].installs})</span></td>`
              : `<td style="color:var(--text-faint);">—</td>`
            ).join('')}
          </tr>`).join('')}
      </tbody>`;
  } catch (e) {
    table.innerHTML = `<tbody><tr><td style="padding:20px;text-align:center;color:var(--red);">Gagal memuat histori: ${escapeHtml(e.message)}</td></tr></tbody>`;
  }
}

document.getElementById('btnRefreshLeaderboard')?.addEventListener('click', renderLeaderboardAdmin);

// ══════════════════════════════════════════════════════════════════════════
// HUBCAP API — Dokumentasi (Swagger-style), API Key Management, Monitoring, Logs
// ══════════════════════════════════════════════════════════════════════════
let _hcWired = false;
let _hcSnapshot = null;
let _hcDocsCache = null;
let _hcActiveTab = 'docs';
let _rySnapshot = null;

async function renderHubcapPage() {
  wireHubcapOnce();
  await Promise.all([loadHcDocs(), loadHcKeysAndMonitor()]);
  if (_hcActiveTab === 'logs') loadHcLogs();
  if (_hcActiveTab === 'ryu') loadRyKeys();
}

function wireHubcapOnce() {
  if (_hcWired) return;
  _hcWired = true;

  document.querySelectorAll('.hc-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.hc-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const tab = btn.dataset.hctab;
      _hcActiveTab = tab;
      document.querySelectorAll('.hc-panel').forEach(p => p.classList.remove('active'));
      const panel = document.getElementById('hcPanel' + tab.charAt(0).toUpperCase() + tab.slice(1));
      if (panel) panel.classList.add('active');
      if (tab === 'logs') loadHcLogs();
      if (tab === 'monitor' && _hcSnapshot) renderHcMonitor(_hcSnapshot);
      if (tab === 'ryu') loadRyKeys();
    });
  });

  document.getElementById('btnHcAddKey').addEventListener('click', () => openHcKeyModal(null));
  document.getElementById('btnHcMonitorRefresh').addEventListener('click', () => loadHcKeysAndMonitor(true));
  document.getElementById('btnHcLogsRefresh').addEventListener('click', () => loadHcLogs());
  document.getElementById('btnHcSaveKey').addEventListener('click', doSaveHcKey);
  document.getElementById('hcKeysList').addEventListener('click', handleHcKeysListClick);
  document.getElementById('hcKeysList').addEventListener('change', handleHcKeysListChange);

  document.getElementById('btnRyAddKey').addEventListener('click', () => openRyKeyModal(null));
  document.getElementById('btnRySaveKey').addEventListener('click', doSaveRyKey);
  document.getElementById('ryKeysList').addEventListener('click', handleRyKeysListClick);
  document.getElementById('ryKeysList').addEventListener('change', handleRyKeysListChange);
}

// ─── Dokumentasi API (ala Swagger) ───
async function loadHcDocs() {
  const container = document.getElementById('hcDocsList');
  try {
    if (!_hcDocsCache) _hcDocsCache = await api('/api/admin/hubcap/docs');
    container.innerHTML = _hcDocsCache.endpoints.map(hcDocCardHtml).join('');
    wireHcDocButtons();
  } catch (e) {
    container.innerHTML = `<div class="empty-cell"><span class="empty-icon">⚠️</span>Gagal memuat dokumentasi: ${escapeHtml(e.message)}</div>`;
  }
}

function hcDocCardHtml(ep, idx) {
  const authBadge = ep.auth
    ? `<span class="hc-doc-auth">🔒 Butuh API Key</span>`
    : `<span class="hc-doc-free">Free · No usage count</span>`;
  const respJson = escapeHtml(JSON.stringify(ep.exampleResponse, null, 2));
  return `
  <div class="hc-doc-card">
    <div class="hc-doc-head">
      <span class="hc-doc-method">${escapeHtml(ep.method)}</span>
      <span class="hc-doc-path">${escapeHtml(ep.path)}</span>
      ${authBadge}
    </div>
    <div class="hc-doc-body">
      <div class="hc-doc-desc">${escapeHtml(ep.description)}</div>

      <div class="hc-doc-section-label">Contoh Request (curl)</div>
      <div class="hc-code-block">
        <button class="hc-copy-btn" data-hc-copy="${idx}">📋 Copy Request</button>
        <pre>${escapeHtml(ep.curl)}</pre>
      </div>

      <div class="hc-doc-section-label">Contoh Response</div>
      <div class="hc-code-block response">
        <pre>${respJson}</pre>
      </div>

      <div class="hc-doc-tryrow">
        <button class="btn btn-secondary btn-sm" data-hc-try="${idx}">▶ Coba Sekarang (Try it)</button>
      </div>
      <div class="hc-try-result" data-hc-tryresult="${idx}"></div>
    </div>
  </div>`;
}

function wireHcDocButtons() {
  document.querySelectorAll('[data-hc-copy]').forEach(btn => {
    btn.addEventListener('click', () => {
      const ep = _hcDocsCache.endpoints[btn.dataset.hcCopy];
      navigator.clipboard.writeText(ep.curl).then(() => {
        const original = btn.textContent;
        btn.textContent = '✓ Disalin'; btn.classList.add('copied');
        setTimeout(() => { btn.textContent = original; btn.classList.remove('copied'); }, 1600);
      }).catch(() => showToast('Gagal menyalin ke clipboard.', 'error'));
    });
  });
  document.querySelectorAll('[data-hc-try]').forEach(btn => {
    btn.addEventListener('click', () => doHcTryIt(btn));
  });
}

async function doHcTryIt(btn) {
  const idx = btn.dataset.hcTry;
  const ep = _hcDocsCache.endpoints[idx];
  const resultEl = document.querySelector(`[data-hc-tryresult="${idx}"]`);
  const original = btn.textContent;
  btn.disabled = true; btn.textContent = 'Memanggil...';
  resultEl.classList.remove('show');
  try {
    const token = localStorage.getItem('adminToken');
    const res = await fetch(SERVER_URL + ep.liveEndpoint, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    const data = await res.json().catch(() => ({}));
    resultEl.textContent = JSON.stringify(data, null, 2);
    resultEl.classList.add('show');
    if (!res.ok) showToast('Try it: ' + (data.error || `HTTP ${res.status}`), 'error');
  } catch (e) {
    resultEl.textContent = 'Gagal memanggil endpoint: ' + e.message;
    resultEl.classList.add('show');
  } finally {
    btn.disabled = false; btn.textContent = original;
  }
}

// ─── Status global (badge di header halaman) ───
function renderHcGlobalBadge(snapshot) {
  const el = document.getElementById('hcGlobalBadge');
  if (!el) return;
  if (!snapshot.totalKeys) {
    el.className = 'hc-global-badge warn';
    el.textContent = '⚠️ Belum ada API Key';
  } else if (snapshot.allLimited) {
    el.className = 'hc-global-badge error';
    el.textContent = '🚨 Seluruh API Key telah mencapai batas harian';
  } else {
    const cur = snapshot.keys.find(k => k.id === snapshot.currentKeyId);
    el.className = 'hc-global-badge';
    el.textContent = `🟢 Dipakai: ${cur ? cur.name : '-'} · ${snapshot.activeCount} key aktif`;
  }
}

// ─── API Key Management ───
async function loadHcKeysAndMonitor(force = false) {
  try {
    const snapshot = await api('/api/admin/hubcap/keys' + (force ? '?force=1' : ''));
    _hcSnapshot = snapshot;
    renderHcGlobalBadge(snapshot);
    renderHcKeysList(snapshot);
    renderHcMonitor(snapshot);
  } catch (e) {
    document.getElementById('hcKeysList').innerHTML = `<div class="empty-cell"><span class="empty-icon">⚠️</span>Gagal memuat API Key: ${escapeHtml(e.message)}</div>`;
  }
}

const HC_STATUS_LABEL = { active: '🟢 Active', limited: '🟡 Limit', error: '🔴 Error', inactive: '⚪ Nonaktif' };

function hcKeyRowHtml(k) {
  return `
  <div class="hc-key-row ${k.isCurrent ? 'is-current' : ''}" data-id="${k.id}">
    <div class="hc-key-main">
      <div class="hc-key-name">${escapeHtml(k.name)} ${k.isCurrent ? '<span class="hc-key-current-pill">Sedang Dipakai</span>' : ''}</div>
      <div class="hc-key-masked">${escapeHtml(k.maskedKey)}</div>
    </div>
    <span class="hc-status-pill ${k.status}">${HC_STATUS_LABEL[k.status] || k.status}</span>
    <div class="hc-key-actions">
      <label class="switch" title="Aktif / Nonaktif">
        <input type="checkbox" data-hc-toggle="${k.id}" ${k.active ? 'checked' : ''}>
        <span class="switch-slider"></span>
      </label>
      <button class="btn-icon-sm" title="Edit" data-hc-edit="${k.id}">✏️</button>
      <button class="btn-icon-sm" title="Hapus" data-hc-delete="${k.id}">🗑️</button>
    </div>
  </div>`;
}

function renderHcKeysList(snapshot) {
  const container = document.getElementById('hcKeysList');
  if (!container) return;
  if (!snapshot.keys.length) {
    container.innerHTML = `<div class="empty-cell"><span class="empty-icon">🔑</span>Belum ada API Key. Klik "+ Tambah API Key" untuk mulai.</div>`;
    return;
  }
  container.innerHTML = snapshot.keys.map(hcKeyRowHtml).join('');
}

function handleHcKeysListClick(e) {
  const editBtn = e.target.closest('[data-hc-edit]');
  const delBtn = e.target.closest('[data-hc-delete]');
  if (editBtn) {
    const k = _hcSnapshot?.keys.find(x => x.id === editBtn.dataset.hcEdit);
    openHcKeyModal(k || null);
  } else if (delBtn) {
    doDeleteHcKey(delBtn.dataset.hcDelete);
  }
}

function handleHcKeysListChange(e) {
  const toggleEl = e.target.closest('[data-hc-toggle]');
  if (toggleEl) doToggleHcKey(toggleEl.dataset.hcToggle, toggleEl.checked, toggleEl);
}

function openHcKeyModal(k) {
  document.getElementById('hcKeyModalTitle').textContent = k ? 'Edit API Key' : 'Tambah API Key';
  document.getElementById('hcKeyId').value = k ? k.id : '';
  document.getElementById('hcKeyName').value = k ? k.name : '';
  document.getElementById('hcKeyValue').value = '';
  document.getElementById('hcKeyValue').placeholder = k ? 'Kosongkan kalau tidak ingin mengubah API Key' : 'Tempel API Key HubCap di sini';
  document.getElementById('hcKeyValueHint').textContent = k ? `(saat ini: ${k.maskedKey})` : '';
  document.getElementById('hcKeyActive').checked = k ? k.active : true;
  document.getElementById('hcKeyModalBackdrop').style.display = 'flex';
}
function closeHcKeyModal() { document.getElementById('hcKeyModalBackdrop').style.display = 'none'; }

async function doSaveHcKey() {
  const id = document.getElementById('hcKeyId').value;
  const name = document.getElementById('hcKeyName').value.trim();
  const key = document.getElementById('hcKeyValue').value.trim();
  const active = document.getElementById('hcKeyActive').checked;
  if (!id && !key) { showToast('API Key wajib diisi.', 'error'); return; }

  const btn = document.getElementById('btnHcSaveKey');
  const original = btn.textContent;
  btn.disabled = true; btn.textContent = 'Menyimpan...';
  try {
    const body = { name, active };
    if (key) body.key = key;
    const snapshot = id
      ? await api(`/api/admin/hubcap/keys/${id}`, { method: 'PUT', body: JSON.stringify(body) })
      : await api('/api/admin/hubcap/keys', { method: 'POST', body: JSON.stringify(body) });
    _hcSnapshot = snapshot;
    renderHcGlobalBadge(snapshot); renderHcKeysList(snapshot); renderHcMonitor(snapshot);
    showToast(id ? 'API Key berhasil diperbarui.' : 'API Key berhasil ditambahkan.', 'success');
    closeHcKeyModal();
  } catch (e) {
    showToast('Gagal menyimpan: ' + e.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = original;
  }
}

async function doDeleteHcKey(id) {
  const k = _hcSnapshot?.keys.find(x => x.id === id);
  if (!confirm(`Hapus API Key "${k?.name || id}"? Tindakan ini tidak bisa dibatalkan.`)) return;
  try {
    const snapshot = await api(`/api/admin/hubcap/keys/${id}`, { method: 'DELETE' });
    _hcSnapshot = snapshot;
    renderHcGlobalBadge(snapshot); renderHcKeysList(snapshot); renderHcMonitor(snapshot);
    showToast('API Key berhasil dihapus.', 'success');
  } catch (e) {
    showToast('Gagal menghapus: ' + e.message, 'error');
  }
}

async function doToggleHcKey(id, checked, checkboxEl) {
  try {
    const snapshot = await api(`/api/admin/hubcap/keys/${id}/toggle`, { method: 'PUT', body: JSON.stringify({ active: checked }) });
    _hcSnapshot = snapshot;
    renderHcGlobalBadge(snapshot); renderHcKeysList(snapshot); renderHcMonitor(snapshot);
    showToast(`API Key ${checked ? 'diaktifkan' : 'dinonaktifkan'}.`, 'success');
  } catch (e) {
    if (checkboxEl) checkboxEl.checked = !checked;
    showToast('Gagal mengubah status: ' + e.message, 'error');
  }
}

// ─── Ryu API — Key Management (pola identik dengan HubCap di atas) ───
async function loadRyKeys() {
  try {
    const snapshot = await api('/api/admin/ryu/keys');
    _rySnapshot = snapshot;
    renderRyKeysList(snapshot);
  } catch (e) {
    document.getElementById('ryKeysList').innerHTML = `<div class="empty-cell"><span class="empty-icon">⚠️</span>Gagal memuat API Key Ryu: ${escapeHtml(e.message)}</div>`;
  }
}

function ryKeyRowHtml(k) {
  return `
  <div class="hc-key-row ${k.isCurrent ? 'is-current' : ''}" data-id="${k.id}">
    <div class="hc-key-main">
      <div class="hc-key-name">${escapeHtml(k.name)} ${k.isCurrent ? '<span class="hc-key-current-pill">Sedang Dipakai</span>' : ''}</div>
      <div class="hc-key-masked">${escapeHtml(k.maskedKey)}</div>
    </div>
    <span class="hc-status-pill ${k.status}">${HC_STATUS_LABEL[k.status] || k.status}</span>
    <div class="hc-key-actions">
      <label class="switch" title="Aktif / Nonaktif">
        <input type="checkbox" data-ry-toggle="${k.id}" ${k.active ? 'checked' : ''}>
        <span class="switch-slider"></span>
      </label>
      <button class="btn-icon-sm" title="Edit" data-ry-edit="${k.id}">✏️</button>
      <button class="btn-icon-sm" title="Hapus" data-ry-delete="${k.id}">🗑️</button>
    </div>
  </div>`;
}

function renderRyKeysList(snapshot) {
  const container = document.getElementById('ryKeysList');
  if (!container) return;
  if (!snapshot.keys.length) {
    container.innerHTML = `<div class="empty-cell"><span class="empty-icon">🐉</span>Belum ada API Key Ryu. Klik "+ Tambah API Key" untuk mulai.</div>`;
    return;
  }
  container.innerHTML = snapshot.keys.map(ryKeyRowHtml).join('');
}

function handleRyKeysListClick(e) {
  const editBtn = e.target.closest('[data-ry-edit]');
  const delBtn = e.target.closest('[data-ry-delete]');
  if (editBtn) {
    const k = _rySnapshot?.keys.find(x => x.id === editBtn.dataset.ryEdit);
    openRyKeyModal(k || null);
  } else if (delBtn) {
    doDeleteRyKey(delBtn.dataset.ryDelete);
  }
}

function handleRyKeysListChange(e) {
  const toggleEl = e.target.closest('[data-ry-toggle]');
  if (toggleEl) doToggleRyKey(toggleEl.dataset.ryToggle, toggleEl.checked, toggleEl);
}

function openRyKeyModal(k) {
  document.getElementById('ryKeyModalTitle').textContent = k ? 'Edit API Key Ryu' : 'Tambah API Key Ryu';
  document.getElementById('ryKeyId').value = k ? k.id : '';
  document.getElementById('ryKeyName').value = k ? k.name : '';
  document.getElementById('ryKeyValue').value = '';
  document.getElementById('ryKeyValue').placeholder = k ? 'Kosongkan kalau tidak ingin mengubah API Key' : 'Tempel API Key Ryu (X-Auth-Key) di sini';
  document.getElementById('ryKeyValueHint').textContent = k ? `(saat ini: ${k.maskedKey})` : '';
  document.getElementById('ryKeyActive').checked = k ? k.active : true;
  document.getElementById('ryKeyModalBackdrop').style.display = 'flex';
}
function closeRyKeyModal() { document.getElementById('ryKeyModalBackdrop').style.display = 'none'; }

async function doSaveRyKey() {
  const id = document.getElementById('ryKeyId').value;
  const name = document.getElementById('ryKeyName').value.trim();
  const key = document.getElementById('ryKeyValue').value.trim();
  const active = document.getElementById('ryKeyActive').checked;
  if (!id && !key) { showToast('API Key wajib diisi.', 'error'); return; }

  const btn = document.getElementById('btnRySaveKey');
  const original = btn.textContent;
  btn.disabled = true; btn.textContent = 'Menyimpan...';
  try {
    const body = { name, active };
    if (key) body.key = key;
    const snapshot = id
      ? await api(`/api/admin/ryu/keys/${id}`, { method: 'PUT', body: JSON.stringify(body) })
      : await api('/api/admin/ryu/keys', { method: 'POST', body: JSON.stringify(body) });
    _rySnapshot = snapshot;
    renderRyKeysList(snapshot);
    showToast(id ? 'API Key Ryu berhasil diperbarui.' : 'API Key Ryu berhasil ditambahkan.', 'success');
    closeRyKeyModal();
  } catch (e) {
    showToast('Gagal menyimpan: ' + e.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = original;
  }
}

async function doDeleteRyKey(id) {
  const k = _rySnapshot?.keys.find(x => x.id === id);
  if (!confirm(`Hapus API Key Ryu "${k?.name || id}"? Tindakan ini tidak bisa dibatalkan.`)) return;
  try {
    const snapshot = await api(`/api/admin/ryu/keys/${id}`, { method: 'DELETE' });
    _rySnapshot = snapshot;
    renderRyKeysList(snapshot);
    showToast('API Key Ryu berhasil dihapus.', 'success');
  } catch (e) {
    showToast('Gagal menghapus: ' + e.message, 'error');
  }
}

async function doToggleRyKey(id, checked, checkboxEl) {
  try {
    const snapshot = await api(`/api/admin/ryu/keys/${id}/toggle`, { method: 'PUT', body: JSON.stringify({ active: checked }) });
    _rySnapshot = snapshot;
    renderRyKeysList(snapshot);
    showToast(`API Key Ryu ${checked ? 'diaktifkan' : 'dinonaktifkan'}.`, 'success');
  } catch (e) {
    if (checkboxEl) checkboxEl.checked = !checked;
    showToast('Gagal mengubah status: ' + e.message, 'error');
  }
}

// ─── Monitoring ───
function renderHcMonitor(snapshot) {
  const summaryEl = document.getElementById('hcMonitorSummary');
  const listEl = document.getElementById('hcMonitorList');
  if (!summaryEl || !listEl) return;

  const activeCount = snapshot.activeCount || 0;
  const limitedCount = snapshot.keys.filter(k => k.status === 'limited').length;
  const errorCount = snapshot.keys.filter(k => k.status === 'error').length;

  summaryEl.innerHTML = `
    <div class="hc-summary-card"><div class="hc-summary-label">Total API Key</div><div class="hc-summary-value">${snapshot.totalKeys}</div></div>
    <div class="hc-summary-card"><div class="hc-summary-label">Key Aktif</div><div class="hc-summary-value" style="color:var(--green);">${activeCount}</div></div>
    <div class="hc-summary-card"><div class="hc-summary-label">Kena Limit</div><div class="hc-summary-value" style="color:var(--gold);">${limitedCount}</div></div>
    <div class="hc-summary-card"><div class="hc-summary-label">Error</div><div class="hc-summary-value" style="color:var(--red);">${errorCount}</div></div>`;

  if (!snapshot.keys.length) {
    listEl.innerHTML = `<div class="empty-cell"><span class="empty-icon">📊</span>Belum ada API Key untuk dipantau.</div>`;
    return;
  }

  const allLimitedNotice = snapshot.allLimited
    ? `<div class="empty-cell"><span class="empty-icon">🚨</span>Seluruh API Key telah mencapai batas harian. Sistem akan otomatis mencoba lagi setelah cooldown selesai.</div>`
    : '';
  listEl.innerHTML = allLimitedNotice + snapshot.keys.map(hcMonitorCardHtml).join('');
}

function hcMonitorCardHtml(k) {
  const pct = (k.dailyLimit != null && k.dailyUsage != null && k.dailyLimit > 0)
    ? Math.min(100, Math.round((k.dailyUsage / k.dailyLimit) * 100)) : null;
  const barClass = pct == null ? '' : pct >= 90 ? 'danger' : pct >= 70 ? 'warn' : '';
  return `
  <div class="hc-monitor-card ${k.isCurrent ? 'is-current' : ''}">
    <div class="hc-monitor-top">
      <div class="hc-monitor-title">${escapeHtml(k.name)} ${k.isCurrent ? '<span class="hc-key-current-pill">Sedang Dipakai</span>' : ''}</div>
      <span class="hc-status-pill ${k.status}">${HC_STATUS_LABEL[k.status] || k.status}</span>
    </div>
    <div class="hc-monitor-nums">
      <span>Daily Usage: <b>${k.dailyUsage ?? '—'}</b></span>
      <span>Daily Limit: <b>${k.dailyLimit ?? '—'}</b></span>
      <span>Remaining Request: <b>${k.remaining ?? '—'}</b></span>
    </div>
    ${pct != null ? `<div class="hc-progress-track"><div class="hc-progress-fill ${barClass}" style="width:${pct}%;"></div></div>` : ''}
    ${k.error ? `<div class="hc-monitor-error">⚠️ ${escapeHtml(k.error)}</div>` : ''}
  </div>`;
}

// ─── Logs ───
async function loadHcLogs() {
  const tbody = document.getElementById('hcLogsTable');
  if (!tbody) return;
  tbody.innerHTML = `<tr><td colspan="5"><div class="empty-cell"><span class="empty-icon">⏳</span>Memuat log...</div></td></tr>`;
  try {
    const data = await api('/api/admin/logs?category=hubcap&perPage=50&sort=newest');
    if (!data.rows.length) {
      tbody.innerHTML = `<tr><td colspan="5"><div class="empty-cell"><span class="empty-icon">🧾</span>Belum ada aktivitas Hubcap API.</div></td></tr>`;
      return;
    }
    tbody.innerHTML = data.rows.map(hcLogRowHtml).join('');
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="5"><div class="empty-cell"><span class="empty-icon">⚠️</span>Gagal memuat log: ${escapeHtml(e.message)}</div></td></tr>`;
  }
}

function hcLogRowHtml(item) {
  return `<tr>
    <td>${item.icon || ''} ${escapeHtml(item.label || item.type)}</td>
    <td>${escapeHtml(item.description || '')}</td>
    <td>${escapeHtml(item.admin || '—')}</td>
    <td>${logBadgeHtml(item.status)}</td>
    <td>${timeAgo(item.createdAt)}</td>
  </tr>`;
}
