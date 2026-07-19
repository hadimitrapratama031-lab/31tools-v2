const SERVER_URL = '';

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

const ROLE_TAG_ICON = { public: '🌐', gold: '🥇', platinum: '💎' };
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
  location.reload();
});

function showShell() {
  document.getElementById('loginWrap').style.display = 'none';
  document.getElementById('shell').style.display = 'flex';
  loadPage('games');
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
}

document.getElementById('btnAddItem').addEventListener('click', () => openItemModal(currentPage, null));

// ─── DASHBOARD ───
async function renderDashboard() {
  try {
    const d = await api('/api/admin/dashboard').catch(() => null)
           || await api('/api/admin/stats').catch(() => ({}));

    // Stats
    setText('dashStatUsers',    d.totalUsers    ?? d.users    ?? '—');
    setText('dashStatLogins',   d.loginsToday   ?? '—');
    setText('dashStatGames',    d.totalGames    ?? '—');
    setText('dashStatBypasses', d.totalBypasses ?? '—');
    setText('dashStatGold',     d.activeGold    ?? '—');
    setText('dashStatPlat',     d.activePlatinum ?? '—');
    setText('dashStatInstalls', d.totalInstalls ?? '—');
    setText('dashStatWeek',     d.loginsWeek    ?? '—');

    // Mini stats
    const totalPremium = (d.activeGold ?? 0) + (d.activePlatinum ?? 0);
    setText('miniActivePackage', totalPremium || '—');
    setText('miniInstallTotal',  d.totalInstalls ?? '—');
    setText('miniTotalGames',    d.totalGames ?? '—');
    setText('miniTotalBypasses', d.totalBypasses ?? '—');

    // Donut
    const totalU = (d.totalUsers ?? 0) || 1;
    const gold   = d.activeGold ?? 0;
    const plat   = d.activePlatinum ?? 0;
    const pub    = Math.max(0, totalU - gold - plat);
    const CIRC   = 2 * Math.PI * 48; // ~301.6
    const pctPub  = (pub  / totalU) * CIRC;
    const pctGold = (gold / totalU) * CIRC;
    const pctPlat = (plat / totalU) * CIRC;
    setDonut('donutPublic', pctPub,  0);
    setDonut('donutGold',   pctGold, pctPub);
    setDonut('donutPlat',   pctPlat, pctPub + pctGold);
    setText('donutPct', totalU > 0 ? Math.round(((gold + plat) / totalU) * 100) + '%' : '—');
    setText('donutLegPublic', pub);
    setText('donutLegGold',   gold);
    setText('donutLegPlat',   plat);

    // Chart subtitle
    document.getElementById('dashChartSub').textContent = `Total login: ${d.loginsWeek ?? '—'} minggu ini`;

    // Draw login chart
    if (d.loginTrend) drawLoginChart(d.loginTrend);

    // Recent activity
    renderActivity(d.recentActivity || d.loginTrend || []);

  } catch(e) {
    showToast('Gagal memuat dashboard: ' + e.message, 'error');
  }
}

function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

function setDonut(id, dash, offset) {
  const el = document.getElementById(id);
  if (!el) return;
  const CIRC = 301.6;
  el.style.strokeDasharray  = `${dash} ${CIRC - dash}`;
  el.style.strokeDashoffset = -offset;
}

function renderActivity(data) {
  const el = document.getElementById('dashActivity');
  if (!el) return;
  if (!data || !data.length) {
    el.innerHTML = '<div class="activity-item"><span style="color:var(--text-faint);font-size:12.5px;">Belum ada aktivitas.</span></div>';
    return;
  }
  // loginTrend format: { _id: 'YYYY-MM-DD', count: N }
  const colors = ['#7b5cff','#e64bb8','#3dd9f5','#ffd76a','#4ade80','#f87171','#a78bfa'];
  el.innerHTML = data.slice(0, 6).map((item, i) => {
    const label = item._id ? `${item._id}: ${item.count} login` : (item.text || JSON.stringify(item));
    return `<div class="activity-item">
      <span class="activity-dot" style="background:${colors[i % colors.length]};"></span>
      <span class="activity-text">${escapeHtml(String(label))}</span>
    </div>`;
  }).join('');
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
  const c = { total: rows.length, public: 0, gold: 0, platinum: 0 };
  rows.forEach(r => { if (c[r.role] !== undefined) c[r.role]++; });
  return c;
}

function renderPageStats(containerId, counts, labels) {
  const el = document.getElementById(containerId);
  if (!el) return;
  const items = [
    { key: 'total',    icon: '📦', color: 'rgba(123,92,255,.16)', value: counts.total,    label: labels.total || 'Total' },
    { key: 'public',   icon: '🌐', color: 'rgba(255,255,255,.08)', value: counts.public,   label: 'Public' },
    { key: 'gold',     icon: '🥇', color: 'rgba(255,215,106,.16)', value: counts.gold,     label: 'Gold' },
    { key: 'platinum', icon: '💎', color: 'rgba(167,139,250,.16)', value: counts.platinum, label: 'Platinum' },
  ];
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

function renderRoleChips(containerId, counts, activeRole, onSelect) {
  const el = document.getElementById(containerId);
  if (!el) return;
  const chips = [
    { key: 'all',      label: 'Semua',    count: counts.total },
    { key: 'public',   label: '🌐 Public',   count: counts.public },
    { key: 'gold',     label: '🥇 Gold',     count: counts.gold },
    { key: 'platinum', label: '💎 Platinum', count: counts.platinum },
  ];
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
const usersUiState = { role: 'all', search: '', page: 1 };
let usersDataCache = [];

async function renderUsers() {
  const table = document.getElementById('tableUsers');
  table.innerHTML = `<tr><td class="empty-cell" colspan="3"><span class="empty-icon">⏳</span>Memuat data...</td></tr>`;
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
    table.innerHTML = `<tr><td class="empty-cell" colspan="3"><span class="empty-icon">⚠️</span>Gagal memuat: ${escapeHtml(e.message)}</td></tr>`;
  }
}

function applyUsersFilters() {
  const rows = usersDataCache;
  const counts = roleCounts(rows);
  renderPageStats('usersStats', counts, { total: 'Total User' });
  renderRoleChips('usersRoleFilter', counts, usersUiState.role, (role) => {
    usersUiState.role = role;
    usersUiState.page = 1;
    applyUsersFilters();
  });

  let filtered = usersUiState.role === 'all' ? rows : rows.filter(r => r.role === usersUiState.role);
  if (usersUiState.search.trim()) {
    const q = usersUiState.search.trim().toLowerCase();
    filtered = filtered.filter(u => (u.username || '').toLowerCase().includes(q) || (u.discordId || '').includes(q));
  }

  const start = (usersUiState.page - 1) * PER_PAGE;
  const pageRows = filtered.slice(start, start + PER_PAGE);
  renderUsersRows(pageRows, filtered.length === 0 && (usersUiState.search || usersUiState.role !== 'all'));

  renderPagination('usersPagination', filtered.length, usersUiState.page, PER_PAGE, (p) => {
    usersUiState.page = p;
    applyUsersFilters();
  });
}

function renderUsersRows(rows, isFilteredEmpty) {
  const table = document.getElementById('tableUsers');
  if (!rows.length) {
    table.innerHTML = isFilteredEmpty
      ? `<tr><td class="empty-cell" colspan="3"><span class="empty-icon">🔍</span>Tidak ada user yang cocok.</td></tr>`
      : `<tr><td class="empty-cell" colspan="3"><span class="empty-icon">👤</span>Belum ada user yang login.</td></tr>`;
    return;
  }
  table.innerHTML = `
    <thead><tr>
      <th>User</th>
      <th>Discord ID</th>
      <th style="width:150px;">Role</th>
    </tr></thead>
    <tbody>
    ${rows.map(u => `
      <tr class="row-role-accent ${u.role}">
        <td style="display:flex;align-items:center;gap:12px;">
          ${u.avatarUrl
            ? `<img class="cell-avatar" src="${escapeHtml(u.avatarUrl)}">`
            : `<div class="cell-avatar" style="display:flex;align-items:center;justify-content:center;font-weight:800;font-size:13px;background:linear-gradient(135deg,#7b5cff,#e64bb8);">${(u.username||'?')[0].toUpperCase()}</div>`}
          <div>
            <div class="cell-name">${escapeHtml(u.username)}</div>
            <span style="margin-top:3px;display:inline-block;">${roleTagHtml(u.role)}</span>
            ${u.createdAt ? `<div class="cell-time">🕓 Bergabung ${timeAgo(u.createdAt)}</div>` : ''}
          </div>
        </td>
        <td style="color:var(--text-faint);font-size:12.5px;">${escapeHtml(u.discordId)}</td>
        <td>
          <select class="role-select" onchange="changeUserRole('${escapeHtml(u.discordId)}', this.value)">
            <option value="public"   ${u.role==='public'   ? 'selected':''}>🌐 Public</option>
            <option value="gold"     ${u.role==='gold'     ? 'selected':''}>🥇 Gold</option>
            <option value="platinum" ${u.role==='platinum' ? 'selected':''}>💎 Platinum</option>
          </select>
        </td>
      </tr>
    `).join('')}
    </tbody>
  `;
}

async function changeUserRole(discordId, role) {
  try {
    const result = await api(`/api/admin/users/${discordId}/role`, { method: 'PUT', body: JSON.stringify({ role }) });
    const u = usersDataCache.find(x => x.discordId === discordId);
    if (u) u.role = role;
    applyUsersFilters();

    // Kasih tau juga status sync ke Discord-nya, biar admin gak nyangka semua otomatis
    // beres kalau ternyata role Discord belum di-mapping / bot gak nemu usernya.
    const ds = result?.discordSync;
    if (!ds) {
      showToast('Role berhasil diubah ke ' + role + '.', 'success');
    } else if (ds.ok) {
      showToast(`Role diubah ke ${role} — role Discord ikut disinkronkan ✓`, 'success');
    } else if (ds.reason === 'not_configured') {
      showToast(`Role diubah ke ${role}. Mapping role Discord belum diatur (lihat halaman Verify Role).`, 'default');
    } else if (ds.reason === 'not_member') {
      showToast(`Role diubah ke ${role}. User ini bukan member Discord, role Discord tidak disentuh.`, 'default');
    } else if (ds.reason === 'bot_not_configured') {
      showToast(`Role diubah ke ${role}. DISCORD_BOT_TOKEN/GUILD_ID belum diisi, role Discord tidak disinkron.`, 'default');
    } else {
      showToast(`Role diubah ke ${role}, tapi gagal sinkron ke Discord: ${(ds.errors||[]).join(', ') || ds.reason}`, 'error');
    }
  } catch (e) {
    showToast('Gagal mengubah role: ' + e.message, 'error');
    renderUsers();
  }
}
window.changeUserRole = changeUserRole;

// ─── HISTORY ───
const historyUiState = { type: 'all', search: '', page: 1 };
let historyDataCache = [];

async function renderHistory() {
  const table = document.getElementById('tableHistory');
  table.innerHTML = `<tr><td class="empty-cell" colspan="4"><span class="empty-icon">⏳</span>Memuat data...</td></tr>`;
  try {
    const rows = await api('/api/admin/history');
    historyDataCache = rows;
    historyUiState.page = 1;
    applyHistoryFilters();

    const searchEl = document.getElementById('searchHistory');
    if (searchEl) {
      searchEl.value = historyUiState.search;
      searchEl.oninput = (e) => {
        historyUiState.search = e.target.value;
        historyUiState.page = 1;
        applyHistoryFilters();
      };
    }
  } catch (e) {
    table.innerHTML = `<tr><td class="empty-cell" colspan="4"><span class="empty-icon">⚠️</span>Gagal memuat: ${escapeHtml(e.message)}</td></tr>`;
  }
}

function applyHistoryFilters() {
  const rows = historyDataCache;
  const today = new Date(); today.setHours(0,0,0,0);
  const todayCount = rows.filter(h => new Date(h.createdAt) >= today).length;
  const gameCount = rows.filter(h => h.itemType === 'game').length;
  const bypassCount = rows.filter(h => h.itemType === 'bypass').length;

  const statsEl = document.getElementById('historyStats');
  if (statsEl) {
    statsEl.innerHTML = `
      <div class="page-stat-pill">
        <div class="page-stat-pill-icon" style="background:rgba(123,92,255,.16);">📜</div>
        <div><div class="page-stat-pill-value">${rows.length}</div><div class="page-stat-pill-label">Total Aktivitas</div></div>
      </div>
      <div class="page-stat-pill">
        <div class="page-stat-pill-icon" style="background:rgba(74,222,128,.16);">📅</div>
        <div><div class="page-stat-pill-value">${todayCount}</div><div class="page-stat-pill-label">Hari Ini</div></div>
      </div>
      <div class="page-stat-pill">
        <div class="page-stat-pill-icon" style="background:rgba(123,92,255,.16);">🎮</div>
        <div><div class="page-stat-pill-value">${gameCount}</div><div class="page-stat-pill-label">Inject Game</div></div>
      </div>
      <div class="page-stat-pill">
        <div class="page-stat-pill-icon" style="background:rgba(61,217,245,.16);">🛡️</div>
        <div><div class="page-stat-pill-value">${bypassCount}</div><div class="page-stat-pill-label">Bypass</div></div>
      </div>
    `;
  }

  const chipsEl = document.getElementById('historyTypeFilter');
  if (chipsEl) {
    const chips = [
      { key: 'all',     label: 'Semua',       count: rows.length },
      { key: 'game',    label: '🎮 Game',     count: gameCount },
      { key: 'bypass',  label: '🛡️ Bypass',   count: bypassCount },
    ];
    chipsEl.innerHTML = chips.map(c => `
      <button class="filter-chip ${historyUiState.type === c.key ? 'active' : ''}" data-type="${c.key}">
        ${c.label} <span class="count">${c.count}</span>
      </button>
    `).join('');
    chipsEl.querySelectorAll('.filter-chip').forEach(btn => {
      btn.addEventListener('click', () => {
        historyUiState.type = btn.dataset.type;
        historyUiState.page = 1;
        applyHistoryFilters();
      });
    });
  }

  let filtered = historyUiState.type === 'all' ? rows : rows.filter(h => h.itemType === historyUiState.type);
  if (historyUiState.search.trim()) {
    const q = historyUiState.search.trim().toLowerCase();
    filtered = filtered.filter(h => (h.username || '').toLowerCase().includes(q) || (h.itemName || '').toLowerCase().includes(q));
  }

  const start = (historyUiState.page - 1) * PER_PAGE;
  const pageRows = filtered.slice(start, start + PER_PAGE);
  renderHistoryRows(pageRows, filtered.length === 0 && (historyUiState.search || historyUiState.type !== 'all'));

  renderPagination('historyPagination', filtered.length, historyUiState.page, PER_PAGE, (p) => {
    historyUiState.page = p;
    applyHistoryFilters();
  });
}

function renderHistoryRows(rows, isFilteredEmpty) {
  const table = document.getElementById('tableHistory');
  table.style.display = 'none';

  const wrapper = table.closest('.table-wrap');
  let feed = wrapper.querySelector('.hist-feed');
  if (!feed) {
    feed = document.createElement('div');
    feed.className = 'hist-feed';
    table.parentNode.insertBefore(feed, table);
  }

  if (!rows.length) {
    feed.innerHTML = `<div class="hist-empty">
      <span class="hist-empty__icon">${isFilteredEmpty ? '🔍' : '📜'}</span>
      <div class="hist-empty__text">${isFilteredEmpty ? 'Tidak ada histori yang cocok.' : 'Belum ada histori aktivitas.'}</div>
    </div>`;
    return;
  }

  const gameSvg   = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M12 12h.01M8 12h.01M16 12h.01M12 8v8"/></svg>`;
  const bypassSvg = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>`;
  const clockSvg  = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`;
  const userSvg   = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`;

  // Kelompokkan per tanggal
  const groups = {};
  rows.forEach(h => {
    const d   = new Date(h.createdAt);
    const key = d.toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    if (!groups[key]) groups[key] = [];
    groups[key].push(h);
  });

  feed.innerHTML = Object.entries(groups).map(([dateLabel, items]) => `
    <div class="hist-group">
      <div class="hist-group__label">
        <span class="hist-group__label-line"></span>
        <span class="hist-group__label-text">${dateLabel}</span>
        <span class="hist-group__label-count">${items.length} aktivitas</span>
        <span class="hist-group__label-line"></span>
      </div>
      <div class="hist-group__items">
        ${items.map(h => {
          const isGame     = h.itemType === 'game';
          const initials   = (h.username || '?').slice(0, 2).toUpperCase();
          const timeStr    = new Date(h.createdAt).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
          const roleClass  = h.userRole || 'public';
          const roleLabel  = roleClass === 'platinum' ? '💠' : roleClass === 'gold' ? '⭐' : '🌐';

          return `<div class="hist-card hist-card--${h.itemType}">
            <!-- Type indicator strip -->
            <div class="hist-card__strip hist-card__strip--${h.itemType}"></div>

            <!-- Type icon -->
            <div class="hist-card__type-icon hist-card__type-icon--${h.itemType}">
              ${isGame ? gameSvg : bypassSvg}
            </div>

            <!-- User avatar -->
            <div class="hist-card__avatar" title="${escapeHtml(h.username)}">
              ${initials}
              <span class="hist-card__avatar-role" title="${roleClass}">${roleLabel}</span>
            </div>

            <!-- Main info -->
            <div class="hist-card__main">
              <div class="hist-card__top-row">
                <span class="hist-card__username">${userSvg} ${escapeHtml(h.username)}</span>
                <span class="hist-card__action-label hist-card__action-label--${h.itemType}">
                  ${isGame ? 'Inject Game' : 'Install Bypass'}
                </span>
              </div>
              <div class="hist-card__item-name">${escapeHtml(h.itemName || '—')}</div>
              ${h.itemRole ? `<div class="hist-card__item-meta">
                <span class="hist-card__item-role-chip hist-card__item-role-chip--${h.itemRole}">
                  ${h.itemRole === 'platinum' ? '💠 Platinum' : h.itemRole === 'gold' ? '⭐ Gold' : '🌐 Public'}
                </span>
              </div>` : ''}
            </div>

            <!-- Time -->
            <div class="hist-card__time">
              <div class="hist-card__time-rel">${timeAgo(h.createdAt)}</div>
              <div class="hist-card__time-abs">${clockSvg} ${timeStr}</div>
            </div>
          </div>`;
        }).join('')}
      </div>
    </div>
  `).join('');
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
  resync: '🔄 Resync'
};

async function renderVerifyRole() {
  await Promise.all([loadRoleSyncSettings(), loadRoleSyncLogs()]);
  wireVerifyRoleButtons();
}

async function loadRoleSyncSettings() {
  const pubSel  = document.getElementById('vrRolePublic');
  const goldSel = document.getElementById('vrRoleGold');
  const platSel = document.getElementById('vrRolePlatinum');
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
    const autoSyncFromDiscord = document.getElementById('vrAutoSync').checked;
    const resetRoleOnLeave = document.getElementById('vrResetOnLeave').checked;
    btn.disabled = true; btn.textContent = 'Menyimpan...';
    try {
      await api('/api/admin/role-sync/settings', {
        method: 'PUT',
        body: JSON.stringify({ discordRoleMap: { public: publicRole, gold, platinum }, autoSyncFromDiscord, resetRoleOnLeave })
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
        <th>Sumber</th>
        <th style="width:130px;">Waktu</th>
      </tr></thead>
      <tbody>
      ${rows.map(r => `
        <tr>
          <td>
            <div class="cell-name">${escapeHtml(r.username || r.discordId)}</div>
            <div style="color:var(--text-faint);font-size:11.5px;">${escapeHtml(r.discordId)}</div>
          </td>
          <td>${roleTagHtml(r.oldRole || 'public')} → ${roleTagHtml(r.newRole)}
            ${r.discordSynced === false ? `<div style="color:var(--red);font-size:11px;margin-top:4px;">⚠️ Sync Discord gagal${r.discordSyncReason ? ' ('+escapeHtml(r.discordSyncReason)+')' : ''}</div>` : ''}
          </td>
          <td><span class="tag source-${r.source}">${ROLE_SOURCE_LABEL[r.source] || r.source}</span></td>
          <td class="cell-time" style="margin-top:0;">${timeAgo(r.createdAt)}</td>
        </tr>
      `).join('')}
      </tbody>
    `;
  } catch (e) {
    table.innerHTML = `<tr><td class="empty-cell" colspan="4"><span class="empty-icon">⚠️</span>Gagal memuat: ${escapeHtml(e.message)}</td></tr>`;
  }
}