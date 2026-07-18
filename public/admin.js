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

if (localStorage.getItem('adminToken')) showShell();

// ─── NAVIGASI ───
const PAGE_META = {
  dashboard: { title: 'Dashboard',  breadcrumb: 'Pages / Dashboard' },
  games:     { title: 'Game',       breadcrumb: 'Pages / Game' },
  bypasses:  { title: 'Bypass',     breadcrumb: 'Pages / Bypass' },
  users:     { title: 'Users',      breadcrumb: 'Pages / Users' },
  history:   { title: 'Histori',    breadcrumb: 'Pages / Histori' },
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

// ─── TABEL GAME & BYPASS ───
let tableDataCache = {};

async function renderTable(type) {
  const tableId = type === 'games' ? 'tableGames' : 'tableBypasses';
  const table = document.getElementById(tableId);
  table.innerHTML = `<tr><td class="empty-cell" colspan="4"><span class="empty-icon">⏳</span>Memuat data...</td></tr>`;
  try {
    const rows = await api(`/api/admin/${type}`);
    tableDataCache[type] = rows;
    renderTableRows(type, rows);
    // Bind search
    const searchEl = document.getElementById(type === 'games' ? 'searchGames' : 'searchBypasses');
    if (searchEl) searchEl.oninput = (e) => filterTable(type, e.target.value);
  } catch (e) {
    table.innerHTML = `<tr><td class="empty-cell" colspan="4"><span class="empty-icon">⚠️</span>Gagal memuat: ${escapeHtml(e.message)}</td></tr>`;
  }
}

function filterTable(type, q) {
  const rows = tableDataCache[type] || [];
  const filtered = q ? rows.filter(r => (r.name || '').toLowerCase().includes(q.toLowerCase())) : rows;
  renderTableRows(type, filtered);
}
window.filterTable = filterTable;

function renderTableRows(type, rows) {
  const tableId = type === 'games' ? 'tableGames' : 'tableBypasses';
  const table = document.getElementById(tableId);
  if (!rows.length) {
    table.innerHTML = `<tr><td class="empty-cell" colspan="4"><span class="empty-icon">📭</span>Belum ada data. Klik "＋ Tambah" untuk menambahkan.</td></tr>`;
    return;
  }
  table.innerHTML = `
    <thead><tr>
      <th style="width:60px;">Cover</th>
      <th>Nama</th>
      <th style="width:110px;">Role</th>
      <th style="width:130px;">Aksi</th>
    </tr></thead>
    <tbody>
    ${rows.map(item => `
      <tr>
        <td>${item.imageUrl
          ? `<img class="cell-img" src="${escapeHtml(item.imageUrl)}" onerror="this.style.display='none'">`
          : `<div class="cell-img" style="display:flex;align-items:center;justify-content:center;color:var(--text-faint);font-size:18px;">🎮</div>`}
        </td>
        <td>
          <div class="cell-name">${escapeHtml(item.name)}</div>
          ${item.description ? `<div class="cell-desc">${escapeHtml(item.description)}</div>` : ''}
        </td>
        <td>${roleTagHtml(item.role)}</td>
        <td class="row-actions">
          <button class="btn btn-ghost btn-sm" onclick='openItemModal("${type}", ${JSON.stringify(item).replace(/'/g, "&#39;")})'>Edit</button>
          <button class="btn btn-danger btn-sm" onclick="deleteItem('${type}','${item._id}')">Hapus</button>
        </td>
      </tr>
    `).join('')}
    </tbody>
  `;
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

function openItemModal(type, item) {
  editingContext = item ? { type, id: item._id } : { type, id: null };
  document.getElementById('itemModalTitle').textContent = item
    ? `Edit ${type === 'games' ? 'Game' : 'Bypass'}`
    : `Tambah ${type === 'games' ? 'Game' : 'Bypass'}`;
  document.getElementById('itemName').value = item?.name || '';
  document.getElementById('itemDescription').value = item?.description || '';
  document.getElementById('itemRole').value = item?.role || 'public';
  document.getElementById('itemImageUrl').value = item?.imageUrl || '';
  document.getElementById('coverResults').innerHTML = '';

  // Checkbox "sekalian jadi Bypass" cuma relevan pas nambah GAME BARU (bukan edit, bukan pas di halaman Bypass)
  const alsoBypassRow = document.getElementById('alsoBypassRow');
  const alsoBypassCheckbox = document.getElementById('itemAlsoBypass');
  const showAlsoBypass = (type === 'games' && !item);
  alsoBypassRow.style.display = showAlsoBypass ? 'block' : 'none';
  alsoBypassCheckbox.checked = false;

  document.getElementById('itemModalBackdrop').style.display = 'flex';
}
window.openItemModal = openItemModal;

function closeModal() {
  document.getElementById('itemModalBackdrop').style.display = 'none';
}

document.getElementById('btnModalClose').addEventListener('click', closeModal);
document.getElementById('btnCancelItem').addEventListener('click', closeModal);
document.getElementById('itemModalBackdrop').addEventListener('click', e => {
  if (e.target === document.getElementById('itemModalBackdrop')) closeModal();
});

document.getElementById('btnSaveItem').addEventListener('click', async () => {
  const body = {
    name:        document.getElementById('itemName').value.trim(),
    description: document.getElementById('itemDescription').value.trim(),
    role:        document.getElementById('itemRole').value,
    imageUrl:    document.getElementById('itemImageUrl').value.trim() || null
  };
  if (!body.name) { showToast('Nama wajib diisi.', 'error'); return; }
  const alsoBypass = document.getElementById('itemAlsoBypass').checked;
  const btn = document.getElementById('btnSaveItem');
  btn.textContent = 'Menyimpan...'; btn.disabled = true;
  try {
    const { type, id } = editingContext;
    if (id) await api(`/api/admin/${type}/${id}`, { method: 'PUT',  body: JSON.stringify(body) });
    else    await api(`/api/admin/${type}`,        { method: 'POST', body: JSON.stringify(body) });

    // Kalau checkbox "sekalian jadi Bypass" dicentang, bikin entri Bypass juga pakai data yang sama
    if (!id && type === 'games' && alsoBypass) {
      await api('/api/admin/bypasses', { method: 'POST', body: JSON.stringify(body) });
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
async function renderUsers() {
  const table = document.getElementById('tableUsers');
  table.innerHTML = `<tr><td class="empty-cell" colspan="3"><span class="empty-icon">⏳</span>Memuat data...</td></tr>`;
  try {
    const rows = await api('/api/admin/users');
    if (!rows.length) {
      table.innerHTML = `<tr><td class="empty-cell" colspan="3"><span class="empty-icon">👤</span>Belum ada user yang login.</td></tr>`;
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
        <tr>
          <td style="display:flex;align-items:center;gap:12px;">
            ${u.avatarUrl
              ? `<img class="cell-avatar" src="${escapeHtml(u.avatarUrl)}">`
              : `<div class="cell-avatar" style="display:flex;align-items:center;justify-content:center;font-weight:800;font-size:13px;background:linear-gradient(135deg,#7b5cff,#e64bb8);">${(u.username||'?')[0].toUpperCase()}</div>`}
            <div>
              <div class="cell-name">${escapeHtml(u.username)}</div>
              <span style="margin-top:3px;">${roleTagHtml(u.role)}</span>
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
  } catch (e) {
    table.innerHTML = `<tr><td class="empty-cell" colspan="3"><span class="empty-icon">⚠️</span>Gagal memuat: ${escapeHtml(e.message)}</td></tr>`;
  }
}

async function changeUserRole(discordId, role) {
  try {
    await api(`/api/admin/users/${discordId}/role`, { method: 'PUT', body: JSON.stringify({ role }) });
    showToast('Role berhasil diubah ke ' + role + '.', 'success');
  } catch (e) {
    showToast('Gagal mengubah role: ' + e.message, 'error');
    renderUsers();
  }
}
window.changeUserRole = changeUserRole;

// ─── HISTORY ───
async function renderHistory() {
  const table = document.getElementById('tableHistory');
  table.innerHTML = `<tr><td class="empty-cell" colspan="4"><span class="empty-icon">⏳</span>Memuat data...</td></tr>`;
  try {
    const rows = await api('/api/admin/history');
    if (!rows.length) {
      table.innerHTML = `<tr><td class="empty-cell" colspan="4"><span class="empty-icon">📜</span>Belum ada histori.</td></tr>`;
      return;
    }
    table.innerHTML = `
      <thead><tr>
        <th>User</th>
        <th>Item</th>
        <th style="width:100px;">Tipe</th>
        <th style="width:150px;">Waktu</th>
      </tr></thead>
      <tbody>
      ${rows.map(h => `
        <tr>
          <td class="cell-name">${escapeHtml(h.username)}</td>
          <td>${escapeHtml(h.itemName)}</td>
          <td><span class="tag ${h.itemType}">${h.itemType}</span></td>
          <td style="color:var(--text-faint);font-size:12px;">${new Date(h.createdAt).toLocaleString('id-ID')}</td>
        </tr>
      `).join('')}
      </tbody>
    `;
  } catch (e) {
    table.innerHTML = `<tr><td class="empty-cell" colspan="4"><span class="empty-icon">⚠️</span>Gagal memuat: ${escapeHtml(e.message)}</td></tr>`;
  }
}