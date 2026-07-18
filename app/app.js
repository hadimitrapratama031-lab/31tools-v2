// ══════════════════════════════════════════════════════════════════════════
// GANTI INI sebelum di-build/dipakai — alamat backend yang sudah kamu deploy
// (contoh setelah deploy ke Railway: 'https://nama-project-kamu.up.railway.app')
// ══════════════════════════════════════════════════════════════════════════
const SERVER_URL = 'https://31tools-v2-production.up.railway.app';

// ── Title bar custom ──
document.getElementById('btnMinimize').addEventListener('click', () => window.electronAPI.minimize());
document.getElementById('btnClose').addEventListener('click', () => window.electronAPI.close());

// ── Helper kecil ──
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

function timeAgo(dateStr) {
  const diffSec = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (diffSec < 60) return 'Baru saja';
  if (diffSec < 3600) return Math.floor(diffSec / 60) + ' menit lalu';
  if (diffSec < 86400) return Math.floor(diffSec / 3600) + ' jam lalu';
  return Math.floor(diffSec / 86400) + ' hari lalu';
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

// ── Load config publik (nama brand) ──
async function loadConfig() {
  try {
    const res = await fetch(SERVER_URL + '/api/config');
    const cfg = await res.json();
    document.title = cfg.appName;
    document.getElementById('titlebarAppName').textContent = cfg.appName;
    document.getElementById('loginAppName').textContent = cfg.appName;
  } catch (e) { /* biarin default kalau server belum jalan */ }
}

// ══════════════════════════════════════════════════════════════════════════
// LOGIN FLOW
// ══════════════════════════════════════════════════════════════════════════
let pollTimer = null;

document.getElementById('btnLoginDiscord').addEventListener('click', startLogin);

function startLogin() {
  const deviceId = getOrCreateDeviceId();
  window.electronAPI.openExternal(`${SERVER_URL}/auth/discord?state=${encodeURIComponent(deviceId)}`);

  const statusEl = document.getElementById('loginStatus');
  statusEl.textContent = 'Menunggu login di browser...';

  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    try {
      const res = await fetch(`${SERVER_URL}/auth/poll?state=${encodeURIComponent(deviceId)}`);
      const data = await res.json();
      if (data.ready) {
        clearInterval(pollTimer);
        localStorage.setItem('token', data.token);
        statusEl.textContent = '';
        enterApp(data.user);
      }
    } catch (e) { /* server mungkin belum siap, coba lagi di tick berikutnya */ }
  }, 2000);
}

document.getElementById('btnLogout').addEventListener('click', () => {
  localStorage.removeItem('token');
  location.reload();
});

// ══════════════════════════════════════════════════════════════════════════
// MASUK APP SETELAH LOGIN
// ══════════════════════════════════════════════════════════════════════════
function enterApp(user) {
  document.getElementById('viewLogin').style.display = 'none';
  document.getElementById('viewApp').style.display = 'flex';

  document.getElementById('profileAvatar').src = user.avatarUrl;
  document.getElementById('profileName').textContent = user.username;
  const roleBadge = document.getElementById('profileRole');
  roleBadge.textContent = user.role;
  roleBadge.className = 'role-badge ' + user.role;

  loadGames();
  loadBypasses();
  loadHistori();
}

// ── Cek token yang udah tersimpan sebelumnya (biar gak perlu login ulang tiap buka app) ──
async function tryAutoLogin() {
  const token = localStorage.getItem('token');
  if (!token) return;
  try {
    const user = await api('/api/me');
    enterApp(user);
  } catch (e) {
    localStorage.removeItem('token'); // token basi/invalid
  }
}

// ══════════════════════════════════════════════════════════════════════════
// NAVIGASI SIDEBAR
// ══════════════════════════════════════════════════════════════════════════
const PAGE_META = {
  game: { title: 'Game', subtitle: 'Daftar game yang bisa kamu install sesuai paket kamu.' },
  bypass: { title: 'Bypass', subtitle: 'Tools bypass yang tersedia buat kamu.' },
  histori: { title: 'Histori', subtitle: 'Riwayat game & bypass yang pernah kamu pakai.' }
};

document.querySelectorAll('.nav-item').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const page = btn.dataset.page;
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.getElementById('page' + page.charAt(0).toUpperCase() + page.slice(1)).classList.add('active');
    document.getElementById('pageTitle').textContent = PAGE_META[page].title;
    document.getElementById('pageSubtitle').textContent = PAGE_META[page].subtitle;
  });
});

// ══════════════════════════════════════════════════════════════════════════
// RENDER: GAME & BYPASS
// ══════════════════════════════════════════════════════════════════════════
function renderCard(item, itemType) {
  const img = item.imageUrl
    ? `<img src="${item.imageUrl}" alt="${escapeHtml(item.name)}" loading="lazy">`
    : `<div class="ph">🎮</div>`;
  return `
    <div class="game-card">
      <div class="game-card-img">
        ${img}
        <span class="card-role-tag ${item.role}">${item.role}</span>
      </div>
      <div class="game-card-body">
        <div class="game-card-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</div>
        <button class="btn-install" onclick="handleInstall('${itemType}','${item._id}','${escapeHtml(item.name).replace(/'/g, "\\'")}')">Install</button>
      </div>
    </div>`;
}

async function loadGames() {
  const grid = document.getElementById('gameGrid');
  try {
    const games = await api('/api/games');
    grid.innerHTML = games.length
      ? games.map(g => renderCard(g, 'game')).join('')
      : '<div class="empty-hint">Belum ada game yang tersedia buat paket kamu.</div>';
  } catch (e) {
    grid.innerHTML = `<div class="empty-hint">Gagal memuat: ${escapeHtml(e.message)}</div>`;
  }
}

async function loadBypasses() {
  const grid = document.getElementById('bypassGrid');
  try {
    const rows = await api('/api/bypasses');
    grid.innerHTML = rows.length
      ? rows.map(b => renderCard(b, 'bypass')).join('')
      : '<div class="empty-hint">Belum ada bypass yang tersedia buat paket kamu.</div>';
  } catch (e) {
    grid.innerHTML = `<div class="empty-hint">Gagal memuat: ${escapeHtml(e.message)}</div>`;
  }
}

// Dipanggil dari tombol "Install" di kartu — cuma nyatet histori (belum ada logic download nyata)
async function handleInstall(itemType, itemId, itemName) {
  try {
    await api('/api/history', { method: 'POST', body: JSON.stringify({ itemType, itemId }) });
    loadHistori();
  } catch (e) {
    alert('Gagal mencatat histori: ' + e.message);
  }
}
window.handleInstall = handleInstall;

// ══════════════════════════════════════════════════════════════════════════
// RENDER: HISTORI
// ══════════════════════════════════════════════════════════════════════════
async function loadHistori() {
  const list = document.getElementById('historiList');
  try {
    const rows = await api('/api/history');
    list.innerHTML = rows.length ? rows.map(h => `
      <div class="history-item">
        <div class="icon">${h.itemType === 'game' ? '🎮' : '🛡️'}</div>
        <div class="info">
          <b>${escapeHtml(h.itemName)}</b>
          <span>${timeAgo(h.createdAt)}</span>
        </div>
        <span class="type-tag">${h.itemType}</span>
      </div>
    `).join('') : '<div class="empty-hint">Belum ada histori.</div>';
  } catch (e) {
    list.innerHTML = `<div class="empty-hint">Gagal memuat histori: ${escapeHtml(e.message)}</div>`;
  }
}

// ══════════════════════════════════════════════════════════════════════════
// START
// ══════════════════════════════════════════════════════════════════════════
loadConfig();
tryAutoLogin();
