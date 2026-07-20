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
  users:     { title: 'Users',      breadcrumb: 'Pages / Users' },
  history:   { title: 'Histori',    breadcrumb: 'Pages / Histori' },
  verifyrole:{ title: 'Verify Role',breadcrumb: 'Pages / Verify Role' },
  webhooks:  { title: 'Webhook Settings', breadcrumb: 'Pages / Webhook Settings' },
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
  else if (page === 'users') renderUsers();
  else if (page === 'history') renderHistory();
  else if (page === 'verifyrole') renderVerifyRole();
  else if (page === 'webhooks') renderWebhookSettings();
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
      } else if (msg.event === 'user:update') {
        if (typeof mergeUserUpdate === 'function') mergeUserUpdate(msg.data);
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

// ─── MODAL ───
let editingContext = null;

let lookupData = null; // hasil terakhir dari /api/admin/appid-lookup, dipakai pas Simpan

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

// ─── APP ID LOOKUP (hubcapmanifest + Steam) — HANYA dipakai di halaman Game ───
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
  statusEl.innerHTML = '<span style="color:var(--text-dim);">🔎 Mengambil data dari Steam &amp; hubcapmanifest...</span>';
  previewEl.style.display = 'none';
  manifestUrlRow.style.display = 'none';

  try {
    const data = await api(`/api/admin/appid-lookup/${encodeURIComponent(appId)}`);
    lookupData = data;

    // Auto-isi form (tetap bisa diedit manual setelahnya)
    if (data.name) document.getElementById('itemName').value = data.name;
    if (data.description) document.getElementById('itemDescription').value = data.description;
    if (data.imageUrl) document.getElementById('itemImageUrl').value = data.imageUrl;
    if (data.sizeLabel) document.getElementById('itemSizeLabel').value = data.sizeLabel;

    // Link manifest — otomatis muncul kalau ADA di hubcapmanifest, biar bisa dicek/dibuka manual
    if (data.manifestUrl) {
      document.getElementById('itemManifestUrl').value = data.manifestUrl;
      document.getElementById('btnOpenManifestUrl').href = data.manifestUrl;
      manifestUrlRow.style.display = 'block';
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
    body.appId = appId;
    body.storeUrl = appId ? (lookupData?.storeUrl || `https://store.steampowered.com/app/${appId}/`) : null;
    body.manifestUrl = document.getElementById('itemManifestUrl').value.trim() || null;
    body.sizeBytes = lookupData?.sizeBytes ?? null;
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