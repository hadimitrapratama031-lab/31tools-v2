const SERVER_URL = '';

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

// FIX BUG "Gagal memuat akun: IMG_ONERROR_ATTR is not defined" — halaman Steam
// Account admin memakai dua konstanta global buat fallback <img> yang gambarnya
// gagal dimuat (URL rusak/dihapus/expired), tapi konstantanya belum pernah
// didefinisikan di file ini, jadi seluruh render tabel Steam Account error
// begitu ada baris yang butuh fallback gambar.
// IMG_FALLBACK_SRC = data URI SVG placeholder abu-abu polos (tidak butuh request
// network tambahan, tidak akan pernah gagal dimuat lagi).
const IMG_FALLBACK_SRC = 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="36" viewBox="0 0 64 36">' +
  '<rect width="64" height="36" fill="#2a2a3a"/>' +
  '<path d="M20 24l6-8 5 6 8-10 9 12H20z" fill="#454560"/>' +
  '<circle cx="24" cy="12" r="3" fill="#454560"/>' +
  '</svg>'
);
// IMG_ONERROR_ATTR = string atribut HTML siap-pakai buat ditempel di tag <img>
// mentah (template string), otomatis ganti src ke placeholder di atas kalau
// gambar aslinya gagal dimuat, dan `onerror` di-null-kan supaya tidak infinite
// loop kalau placeholder-nya sendiri somehow gagal juga.
const IMG_ONERROR_ATTR = `onerror="this.onerror=null;this.src='${IMG_FALLBACK_SRC}'"`;

const ROLE_TAG_ICON = { public: '<svg class="icon icon-16"><use href="#ic-globe"></use></svg>', gold: '<svg class="icon icon-16"><use href="#ic-trophy"></use></svg>', platinum: '<svg class="icon icon-16"><use href="#ic-gem"></use></svg>', admin: '<svg class="icon icon-16"><use href="#ic-crown"></use></svg>' };
function roleTagHtml(role) {
  const icon = ROLE_TAG_ICON[role] || '';
  return `<span class="tag ${role}">${icon} ${escapeHtml(role)}</span>`;
}

// FIX GAMBAR 401: endpoint GET .../image butuh admin token (requireAdmin),
// tapi tag <img src="..."> TIDAK bisa mengirim header Authorization seperti
// fetch() biasa (lihat api() di bawah) — browser cuma request URL polos.
// requireAdmin sudah punya fallback baca token dari query string ?token=,
// jadi solusinya cukup selipkan token di sana KHUSUS untuk URL gambar yang
// dipakai sebagai src <img>, tanpa mengubah cara autentikasi endpoint lain
// sama sekali.
function adminImageUrl(path) {
  const token = localStorage.getItem('adminToken');
  if (!token) return path;
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}token=${encodeURIComponent(token)}`;
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
  const icon = type === 'success' ? '<svg class="icon icon-16"><use href="#ic-check"></use></svg>' : type === 'error' ? '<svg class="icon icon-16"><use href="#ic-x"></use></svg>' : 'ℹ';
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
        statusEl.innerHTML = `<svg class="icon icon-16"><use href="#ic-check"></use></svg> Login sebagai ${checkData.admin?.username || 'Admin'}.`;
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
  tutorial:  { title: 'Kelola Tutorial', breadcrumb: 'Pages / Tutorial' },
  leaderboard:{ title: 'Top Installer', breadcrumb: 'Pages / Top Installer' },
  users:     { title: 'Users',      breadcrumb: 'Pages / Users' },
  history:   { title: 'Histori',    breadcrumb: 'Pages / Histori' },
  logs:      { title: 'Logs',       breadcrumb: 'Pages / Logs' },
  verifyrole:{ title: 'Verify Role',breadcrumb: 'Pages / Verify Role' },
  webhooks:  { title: 'Notifications Channel Setting', breadcrumb: 'Pages / Notifications Channel Setting' },
  hubcap:    { title: 'Hubcap API', breadcrumb: 'Pages / Hubcap API' },
  librarygame:  { title: 'Library Game', breadcrumb: 'Pages / Library Game' },
  paket:     { title: 'Paket', breadcrumb: 'Pages / Paket' },
  goldtrial: { title: 'Gold Trial', breadcrumb: 'Pages / Gold Trial' },
  categories:{ title: 'Kategori', breadcrumb: 'Pages / Kategori' },
  upgradepaket: { title: 'Upgrade Paket', breadcrumb: 'Pages / Upgrade Paket' },
  pakasir:      { title: 'KlikQRIS Settings', breadcrumb: 'Pages / KlikQRIS Settings' },
  autoorder:    { title: 'Auto Order (Discord Bot)', breadcrumb: 'Pages / Auto Order (Discord Bot)' },
  watermark:    { title: 'Watermark Detection', breadcrumb: 'Pages / Watermark Detection' },
  transaksi:    { title: 'Transaksi', breadcrumb: 'Pages / Transaksi' },
  steamaccounts: { title: 'Steam Accounts', breadcrumb: 'Pages / Steam Accounts' },
  steamaccountscontent: { title: 'Kelola Game', breadcrumb: 'Pages / Steam Accounts / Kelola Game' },
  appupdate:    { title: 'App Update', breadcrumb: 'Pages / App Update' },
  maintenance:  { title: 'Maintenance Mode', breadcrumb: 'Pages / Maintenance Mode' },
  activetools:  { title: 'Active Tools', breadcrumb: 'Pages / Active Tools' },
  welcomepopup: { title: 'Welcome Popup', breadcrumb: 'Pages / Welcome Popup' },
  requestgame:  { title: 'Request Game', breadcrumb: 'Pages / Request Game' },
  websitesettings: { title: 'Website Settings', breadcrumb: 'Pages / Website Settings' },
  notifsend:    { title: 'Kirim Notifikasi', breadcrumb: 'Pages / Notifikasi / Kirim Notifikasi' },
  packageembeds: { title: 'Package Embed Builder', breadcrumb: 'Pages / Notification Package / Embed Builder' },
  marketplace:  { title: 'Marketplace', breadcrumb: 'Pages / Marketplace' },
  appcustomization: { title: 'App Customization', breadcrumb: 'Pages / App Customization' },
  settingbanner: { title: 'Setting Banner', breadcrumb: 'Pages / Setting Banner' },
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

  const autoFillInfoBtn = document.getElementById('btnAutoFillInfo');
  const autoFillImagesBtn = document.getElementById('btnAutoFillImages');
  const isCatalogPage = (page === 'games' || page === 'bypasses');
  autoFillInfoBtn.style.display = isCatalogPage ? 'inline-flex' : 'none';
  autoFillImagesBtn.style.display = isCatalogPage ? 'inline-flex' : 'none';
  autoFillInfoBtn.innerHTML = page === 'bypasses' ? '<svg class="icon icon-16"><use href="#ic-wrench"></use></svg> Auto-Isi Deskripsi' : '<svg class="icon icon-16"><use href="#ic-wrench"></use></svg> Auto-Isi Deskripsi/Kategori';
  _autoFillTargetPage = page;

  if (page === 'dashboard') renderDashboard();
  else if (page === 'games') renderTable('games');
  else if (page === 'bypasses') renderTable('bypasses');
  else if (page === 'categories') renderCategoryAdmin();
  else if (page === 'tutorial') renderTutorialAdmin();
  else if (page === 'leaderboard') renderLeaderboardAdmin();
  else if (page === 'users') renderUsers();
  else if (page === 'history') renderHistory();
  else if (page === 'logs') renderLogs();
  else if (page === 'verifyrole') renderVerifyRole();
  else if (page === 'webhooks') renderWebhookSettings();
  else if (page === 'notifsend') renderNotifSendPage();
  else if (page === 'packageembeds') renderPackageEmbedsPage();
  else if (page === 'hubcap') renderHubcapPage();
  else if (page === 'paket') renderPaketSettings();
  else if (page === 'voucher') renderVoucherPage();
  else if (page === 'goldtrial') renderGoldTrialPage();
  else if (page === 'upgradepaket') renderUpgradePaketPage();
  else if (page === 'pakasir') renderPakasirPage();
  else if (page === 'autoorder') renderAutoOrderPage();
  else if (page === 'watermark') renderWatermarkPage();
  else if (page === 'transaksi') renderTransaksiPage();
  else if (page === 'steamaccounts') renderSteamAccountsAdmin();
  else if (page === 'steamaccountscontent') renderSteamAccountsContentPage();
  else if (page === 'appupdate') renderAppUpdatePage();
  else if (page === 'maintenance') renderMaintenancePage();
  else if (page === 'activetools') renderActiveToolsPage();
  else if (page === 'welcomepopup') renderWelcomePopupPage();
  else if (page === 'requestgame') { loadGameRequests(); loadRequestGameSettings(); }
  else if (page === 'librarygame') renderLibraryGamePage();
  else if (page === 'websitesettings') renderWebsiteSettingsPage();
  else if (page === 'marketplace') renderMarketplaceAdmin();
  else if (page === 'appcustomization') renderAppCustomizationPage();
  else if (page === 'settingbanner') renderSettingBannerPage();
}

document.getElementById('btnAddItem').addEventListener('click', () => openItemModal(currentPage, null));

// ─── AUTO-ISI MASSAL (Deskripsi/Kategori & Gambar) — Games & Bypass ───
// Jalan ke SEMUA item di halaman yang lagi dibuka (Games/Bypass) yang punya
// App ID Steam, isi ulang field yang kosong ATAU tidak sesuai lewat pipeline
// lookup Steam + HubCap/Ryu yang sama seperti pas nambah 1 game manual.
let _autoFillTargetPage = 'games';
let _autoFillRunning = false;
let _autoFillCurrentJobId = null;
let _autoFillLogBuffer = []; // cuma nyimpen entry yg PERLU ditampilkan (failed/not_found) biar list ga meledak buat ribuan item

// kind: 'info' (deskripsi/kategori) | 'images' (gambar) — dikirim client cuma
// buat bikin URL endpoint & label; server sendiri yang nentuin kategori
// success/failed/notFound/skipped final (lihat runAutoFillJob di server.js).
async function runAutoFill(kind) {
  if (_autoFillRunning) { showToast('Masih ada proses Auto-Isi yang berjalan, tunggu sampai selesai ya.', 'error'); return; }
  const page = _autoFillTargetPage; // 'games' | 'bypasses'
  const label = kind === 'info' ? (page === 'bypasses' ? 'Deskripsi' : 'Deskripsi/Kategori') : 'Gambar';
  if (!confirm(`Jalankan Auto-Isi ${label} untuk semua ${page === 'games' ? 'game' : 'bypass'} yang punya App ID? Field yang kosong atau tidak sesuai akan diisi ulang otomatis dari Steam Store API (bukan HubCap/Ryu, kuota API key tidak terpakai). Data lama tetap dipertahankan kalau Steam tidak mengembalikan data baru. Prosesnya berjalan bertahap (satu per satu) supaya tidak terkena rate limit.`)) return;

  const infoBtn = document.getElementById('btnAutoFillInfo');
  const imagesBtn = document.getElementById('btnAutoFillImages');
  _autoFillRunning = true;
  infoBtn.disabled = true; imagesBtn.disabled = true;

  const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  _autoFillCurrentJobId = jobId;
  openAutoFillModal({ page, kind, label });

  try {
    const endpoint = `/api/admin/${page}/auto-fill-${kind === 'info' ? 'info' : 'images'}`;
    const data = await api(endpoint, { method: 'POST', body: JSON.stringify({ jobId }) });
    // Fallback kalau WS sempat putus di tengah jalan — modal tetap dapat hasil akhir yang benar dari response HTTP-nya.
    finalizeAutoFillModal(data);
  } catch (e) {
    afModalError(e.message);
  } finally {
    _autoFillRunning = false;
    infoBtn.disabled = false; imagesBtn.disabled = false;
  }
}

document.getElementById('btnAutoFillInfo').addEventListener('click', () => runAutoFill('info'));
document.getElementById('btnAutoFillImages').addEventListener('click', () => runAutoFill('images'));

// ── Modal progress — di-drive realtime dari event WebSocket 'autofill:progress'
// (lihat connectAdminWS -> handleAutoFillProgress), bukan cuma nunggu HTTP selesai. ──
function openAutoFillModal({ page, kind, label }) {
  _autoFillLogBuffer = [];
  document.getElementById('afModalTitle').textContent = `Auto-Isi ${label} Berjalan...`;
  document.getElementById('afModalSubtitle').textContent = `Memproses ${page === 'games' ? 'game' : 'bypass'} satu per satu — jangan tutup halaman ini.`;
  document.getElementById('afModalCloseBtn').style.display = 'none';
  document.getElementById('afCloseFooterBtn').style.display = 'none';
  document.getElementById('afProgressFill').style.width = '0%';
  document.getElementById('afProgressFill').classList.remove('af-progress-done', 'af-progress-error');
  document.getElementById('afProgressCount').textContent = '0 / 0';
  document.getElementById('afProgressPct').textContent = '0%';
  ['afStatSuccess', 'afStatFailed', 'afStatNotFound', 'afStatSkipped'].forEach(id => document.getElementById(id).textContent = '0');
  document.getElementById('afCurrentItem').style.display = 'none';
  document.getElementById('afLogList').innerHTML = '';
  document.getElementById('afModalBackdrop').style.display = 'flex';
}

function closeAutoFillModal() {
  document.getElementById('afModalBackdrop').style.display = 'none';
}
window.closeAutoFillModal = closeAutoFillModal;

// Dipanggil dari connectAdminWS() tiap kali server broadcast 'autofill:progress'.
// Diabaikan kalau jobId-nya bukan job yang sedang kita pantau (jaga-jaga ada
// admin lain yang kebetulan lagi jalanin proses serupa bersamaan).
function handleAutoFillProgress(data) {
  if (!data || data.jobId !== _autoFillCurrentJobId) return;
  if (data.phase === 'error') { afModalError(data.error); return; }

  const pct = data.total > 0 ? Math.round((data.processed / data.total) * 100) : 0;
  document.getElementById('afProgressFill').style.width = pct + '%';
  document.getElementById('afProgressCount').textContent = `${data.processed} / ${data.total}`;
  document.getElementById('afProgressPct').textContent = pct + '%';
  const etaEl = document.getElementById('afProgressEta');
  if (etaEl) {
    if (data.etaMs && data.processed < data.total) {
      const etaSec = Math.round(data.etaMs / 1000);
      etaEl.innerHTML = etaSec >= 60 ? `<svg class="icon icon-16"><use href="#ic-loader-circle"></use></svg> ~${Math.ceil(etaSec / 60)} menit lagi` : `<svg class="icon icon-16"><use href="#ic-loader-circle"></use></svg> ~${etaSec} detik lagi`;
    } else {
      etaEl.textContent = '';
    }
  }
  document.getElementById('afStatSuccess').textContent = data.success ?? 0;
  document.getElementById('afStatFailed').textContent = data.failed ?? 0;
  document.getElementById('afStatNotFound').textContent = data.notFound ?? 0;
  document.getElementById('afStatSkipped').textContent = data.skipped ?? 0;

  if (data.currentItem) {
    const el = document.getElementById('afCurrentItem');
    el.style.display = '';
    el.innerHTML = `<span class="af-current-icon">${afStatusIcon(data.currentItem.status)}</span> ${escapeHtml(data.currentItem.name || '—')}`;

    // Cuma item bermasalah (failed/not_found) yang dicatat ke log list — kalau
    // semua ribuan item ditampilkan bakal bikin modal berat & susah dibaca.
    if (data.currentItem.status === 'failed' || data.currentItem.status === 'not_found') {
      _autoFillLogBuffer.unshift(data.currentItem);
      if (_autoFillLogBuffer.length > 100) _autoFillLogBuffer.pop();
      renderAutoFillLog();
    }
  }

  if (data.phase === 'done') {
    document.getElementById('afProgressFill').classList.add('af-progress-done');
    document.getElementById('afCurrentItem').style.display = 'none';
    document.getElementById('afModalCloseBtn').style.display = '';
    document.getElementById('afCloseFooterBtn').style.display = '';
    document.getElementById('afModalTitle').textContent = 'Auto-Isi Selesai';
    document.getElementById('afModalSubtitle').textContent = `${data.success} berhasil · ${data.failed} gagal · ${data.notFound} tidak ditemukan · ${data.skipped} dilewati.`;
    // Cukup SEKALI refresh tabel di akhir (bukan tiap item) — hindari flicker/reset scroll di tabel admin selama proses jalan.
    if (data.success > 0) refreshTable(_autoFillTargetPage);
  }
}

function afStatusIcon(status) {
  return { success: '<svg class="icon icon-16"><use href="#ic-circle-check-big"></use></svg>', failed: '<svg class="icon icon-16"><use href="#ic-circle-x"></use></svg>', not_found: '<svg class="icon icon-16"><use href="#ic-search"></use></svg>', skipped: '<svg class="icon icon-16"><use href="#ic-skip-forward"></use></svg>' }[status] || '<svg class="icon icon-16"><use href="#ic-info"></use></svg>';
}

function renderAutoFillLog() {
  const el = document.getElementById('afLogList');
  if (!_autoFillLogBuffer.length) { el.innerHTML = ''; return; }
  el.innerHTML = `<div class="af-log-title">Item bermasalah (${_autoFillLogBuffer.length})</div>` +
    _autoFillLogBuffer.map(item => `
      <div class="af-log-row">
        <span class="af-current-icon">${afStatusIcon(item.status)}</span>
        <span class="af-log-name">${escapeHtml(item.name || '—')}</span>
        <span class="af-log-reason">${escapeHtml(item.reason || '')}</span>
      </div>`).join('');
}

// Fallback dari response HTTP akhir — dipakai kalau WS sempat putus di tengah
// proses, jadi modal tetap kebaruan angka finalnya walau progress tickernya sempat kelewat.
function finalizeAutoFillModal(data) {
  if (!data || data.jobId !== _autoFillCurrentJobId) return;
  handleAutoFillProgress({
    jobId: data.jobId, phase: 'done',
    processed: data.total, total: data.total,
    success: data.success, failed: data.failed, notFound: data.notFound, skipped: data.skipped
  });
}

function afModalError(message) {
  document.getElementById('afProgressFill').classList.add('af-progress-error');
  document.getElementById('afModalTitle').textContent = 'Auto-Isi Gagal';
  document.getElementById('afModalSubtitle').textContent = message || 'Terjadi kesalahan saat menjalankan proses.';
  document.getElementById('afCurrentItem').style.display = 'none';
  document.getElementById('afModalCloseBtn').style.display = '';
  document.getElementById('afCloseFooterBtn').style.display = '';
}

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
  login: '<svg class="icon icon-16"><use href="#ic-key-round"></use></svg>', logout: '<svg class="icon icon-16"><use href="#ic-log-out"></use></svg>', install: '<svg class="icon icon-16"><use href="#ic-arrow-down-to-line"></use></svg>', download_failed: '<svg class="icon icon-16"><use href="#ic-triangle-alert"></use></svg>',
  purchase: '<svg class="icon icon-16"><use href="#ic-credit-card"></use></svg>', renewal: '<svg class="icon icon-16"><use href="#ic-refresh-cw"></use></svg>', request_game: '<svg class="icon icon-16"><use href="#ic-target"></use></svg>',
  admin_add_game: '<svg class="icon icon-16"><use href="#ic-plus"></use></svg>', admin_edit_game: '<svg class="icon icon-16"><use href="#ic-pencil"></use></svg>', admin_delete_game: '<svg class="icon icon-16"><use href="#ic-trash-2"></use></svg>',
  admin_add_bypass: '<svg class="icon icon-16"><use href="#ic-plus"></use></svg>', admin_edit_bypass: '<svg class="icon icon-16"><use href="#ic-pencil"></use></svg>', admin_delete_bypass: '<svg class="icon icon-16"><use href="#ic-trash-2"></use></svg>',
  admin_reset_quota: '<svg class="icon icon-16"><use href="#ic-recycle"></use></svg>', announcement: '<svg class="icon icon-16"><use href="#ic-megaphone"></use></svg>', system_error: '<svg class="icon icon-16"><use href="#ic-siren"></use></svg>', account_status: '<svg class="icon icon-16"><use href="#ic-shield-check"></use></svg>'
};

function activityItemHtml(item) {
  const icon = item.icon || ACTIVITY_ICON_FALLBACK[item.type] || '<svg class="icon icon-16"><use href="#ic-info"></use></svg>';
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

// Request Game sekarang fitur nyata — arahkan ke halamannya.
function quickActionRequestGame() {
  loadPage('requestgame');
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
      } else if (msg.event === 'autofill:progress') {
        handleAutoFillProgress(msg.data);
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
      } else if (msg.event === 'voucher:update') {
        _voucherList = msg.data;
        if (currentPage === 'voucher') renderVoucherTable(_voucherList);
      } else if (msg.event === 'transaction:update') {
        if (currentPage === 'transaksi') loadTransaksiList();
      } else if (msg.event === 'packages:update') {
        if (currentPage === 'upgradepaket' && !_pkgFormDirty) renderUpgradePaketPage();
      } else if (msg.event === 'gameRequest:new' || msg.event === 'gameRequest:decided') {
        if (currentPage === 'requestgame') loadGameRequests();
        if (msg.event === 'gameRequest:new') {
          showToast(`🎯 Request Game baru: "${msg.data.name || msg.data.appId}" dari ${msg.data.username}`, 'default');
        }
        // Popup "Lihat Semua Requester" lagi kebuka buat App ID yang sama? Refresh isinya juga.
        if (_reqGameRequestersCurrentAppId && msg.data?.appId === _reqGameRequestersCurrentAppId) {
          refreshGameRequestersPopup();
        }
      } else if (msg.event === 'request-game-settings:update') {
        // Diubah dari sesi admin lain — reload panel Pengaturan kalau sedang dibuka.
        if (currentPage === 'requestgame') loadRequestGameSettings();
      } else if (msg.event === 'watermark:alert') {
        showToast(`🔎 Indikasi perangkat lain: "${msg.data?.productName || 'item'}" milik ${msg.data?.username || '-'}`, 'default');
        if (currentPage === 'watermark' && typeof prependWatermarkAlert === 'function') prependWatermarkAlert(msg.data);
      } else if (msg.event === 'goldTrial:settings') {
        // Diubah dari sesi admin lain — reload halaman Gold Trial kalau sedang
        // dibuka, supaya toggle Aktif/Nonaktif, durasi, dan limit selalu
        // sinkron di semua sesi Admin Web tanpa perlu refresh manual.
        if (currentPage === 'goldtrial') loadGoldTrialSettings();
      } else if (msg.event === 'goldTrial:claims') {
        // Broadcast setelah ada klaim baru dari App — refresh tabel riwayat
        // kalau sedang dibuka.
        if (currentPage === 'goldtrial') renderGoldTrialClaimsTable(msg.data || []);
      } else if (msg.event === 'steamAccounts:products:update') {
        // FIX: sebelumnya TIDAK ADA handler sama sekali di Admin Web utk event
        // ini — jadi kalau ada Add/Edit/Delete/Update dari sesi Admin lain
        // (atau dari tab lain milik admin yang sama), tabel Steam Account di
        // sini tidak pernah ikut ter-refresh tanpa reload manual (spec poin 3).
        // Payload cuma sinyal "ada perubahan" (lihat broadcastSteamAccountsUpdate
        // di server.js) — jadi tinggal reload list admin kalau halamannya lagi
        // dibuka. Kalau modal Kelola Game utk produk yang sama lagi kebuka,
        // ikut di-refresh juga biar List Game-nya tidak stale.
        if (currentPage === 'steamaccounts') loadSteamAccounts();
        if (currentPage === 'steamaccountscontent' && _staContentProductId) {
          reloadStaContentProductOnly();
        }
      } else if (msg.event === 'steamAccounts:order:update') {
        if (currentPage === 'steamaccounts') loadSteamAccountOrders();
        // Steam Account juga transaksi KlikQRIS — ikut ditampilkan di halaman
        // Transaksi (riwayat gabungan), jadi refresh juga kalau lagi dibuka.
        if (currentPage === 'transaksi') loadTransaksiList();
      } else if (msg.event === 'marketplace:products:update') {
        // FIX: sebelumnya Admin Web TIDAK punya handler untuk event ini sama
        // sekali — jadi Add/Edit/Delete Product (termasuk Add Game/Bypass
        // BARU langsung dari drawer Kelola Konten, yang sekarang linking-nya
        // atomic di server) tidak pernah bikin daftar Product di Admin Web
        // ikut ter-refresh tanpa reload manual (requirement realtime dari
        // spec awal: "Admin Web langsung update daftar konten Product").
        // Payload cuma sinyal "ada perubahan" (lihat broadcastMarketplaceProductsUpdate
        // di server.js) — reload list produk kalau halamannya lagi dibuka,
        // dan kalau drawer Kelola Konten produk yang sama lagi kebuka, ikut
        // di-refresh juga biar daftar Game/Bypass-nya tidak stale.
        if (currentPage === 'marketplace') { loadMktStats(); loadMktProducts(); }
        if (_mktDrawerProductId) reloadMktDrawerContentOnly();
      } else if (msg.event === 'marketplace:order:update') {
        // Order Marketplace ikut jadi baris di riwayat Transaksi gabungan
        // (lihat listUnifiedAdminTransactions di server.js) — refresh tabel
        // Transaksi realtime kalau lagi dibuka, pola sama persis dengan
        // 'steamAccounts:order:update' & 'transaction:update' di atas.
        if (currentPage === 'transaksi') loadTransaksiList();
      } else if (msg.event === 'marketplace:access:update') {
        // FIX: sebelumnya Admin Web TIDAK punya handler untuk event ini sama
        // sekali — jadi drawer "Kelola Akses" produk yang sedang dibuka tidak
        // ikut ter-refresh realtime saat entitlement seorang user berubah
        // (baru lunas beli, ATAU akses purchase/whitelist dicabut admin lain/
        // sesi lain) — admin harus tutup-buka ulang drawer utk lihat data
        // terbaru. Payload personal per-user, tapi drawer ini nampilkan akses
        // SEMUA user utk 1 produk, jadi cukup reload drawer kalau produk yang
        // berubah sama dengan yang sedang dibuka (atau kalau productId tidak
        // ada di payload, refresh saja sebagai fallback aman & murah).
        if (_mktDrawerProductId && (!msg.data?.productId || msg.data.productId === _mktDrawerProductId)) {
          reloadMktDrawerContentOnly();
        }
      } else if (msg.event.startsWith('livechat:')) {
        // MODULE BARU — Live Chat Support. Halaman chat-nya sendiri sepenuhnya
        // di livechat-admin.html/js (terpisah) — di sini cukup jaga badge unread
        // di sidebar supaya admin tahu ada pesan baru walau belum buka halamannya.
        refreshLiveChatNavBadgeDebounced();
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

// MODULE BARU — Live Chat Support: badge unread di sidebar (jumlah percakapan
// yang punya pesan belum dibaca), realtime lewat event 'livechat:*' di atas +
// polling ringan sebagai fallback.
let _lcNavBadgeTimer = null;
function refreshLiveChatNavBadgeDebounced() {
  clearTimeout(_lcNavBadgeTimer);
  _lcNavBadgeTimer = setTimeout(refreshLiveChatNavBadge, 800);
}
async function refreshLiveChatNavBadge() {
  const el = document.getElementById('navLiveChatBadge');
  if (!el) return;
  try {
    const { conversations } = await api('/api/admin/livechat/conversations?filter=unread');
    const count = (conversations || []).length;
    if (count > 0) { el.style.display = 'flex'; el.textContent = count > 99 ? '99+' : String(count); }
    else el.style.display = 'none';
  } catch (e) { /* diam-diam, bukan fitur kritikal */ }
}
refreshLiveChatNavBadge();
setInterval(refreshLiveChatNavBadge, 45000);

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
    { key: 'total',    icon: '<svg class="icon icon-24"><use href="#ic-package"></use></svg>', color: 'rgba(123,92,255,.16)', value: counts.total,    label: labels.total || 'Total' },
    { key: 'public',   icon: '<svg class="icon icon-24"><use href="#ic-globe"></use></svg>', color: 'rgba(255,255,255,.08)', value: counts.public,   label: 'Gratis' },
    { key: 'gold',     icon: '<svg class="icon icon-24"><use href="#ic-trophy"></use></svg>', color: 'rgba(255,215,106,.16)', value: counts.gold,     label: 'Gold' },
    { key: 'platinum', icon: '<svg class="icon icon-24"><use href="#ic-gem"></use></svg>', color: 'rgba(167,139,250,.16)', value: counts.platinum, label: 'Platinum' },
  ];
  // Pil "Admin" cuma relevan di halaman Users (game/bypass gak butuh paket Admin).
  if (opts.showAdmin) items.push({ key: 'admin', icon: '<svg class="icon icon-24"><use href="#ic-crown"></use></svg>', color: 'rgba(74,222,128,.16)', value: counts.admin || 0, label: 'Admin' });
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
    { key: 'public',   label: '<svg class="icon icon-16"><use href="#ic-globe"></use></svg> Gratis',   count: counts.public },
    { key: 'gold',     label: '<svg class="icon icon-16"><use href="#ic-trophy"></use></svg> Gold',     count: counts.gold },
    { key: 'platinum', label: '<svg class="icon icon-16"><use href="#ic-gem"></use></svg> Platinum', count: counts.platinum },
  ];
  if (opts.showAdmin) chips.push({ key: 'admin', label: '<svg class="icon icon-16"><use href="#ic-crown"></use></svg> Admin', count: counts.admin || 0 });
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
// Server-side pagination: hanya `perPage` baris yang diambil dari server per
// request (bukan seluruh koleksi), jadi tetap cepat walau datanya sampai
// ribuan. Backend endpoint GET /api/admin/games dan /api/admin/bypasses HARUS
// menerima query params berikut dan membalas dalam bentuk object (bukan array
// polos seperti sebelumnya):
//   ?page=1&perPage=50&search=&role=all&category=all   (category cuma dipakai games)
//   -> { rows: [...max perPage item...],
//        total: <jumlah item yang cocok dgn search+role+category, dipakai utk pagination>,
//        counts: { total, public, gold, platinum, admin } // dihitung dari SELURUH data
//                                                          // (tanpa filter apa pun) —
//                                                          // dipakai buat stat pill & angka di filter chip.
//      }
// Pola query-string & response ini sama persis dgn yang sudah dipakai di
// /api/admin/logs & /api/admin/history — tinggal disamakan di controller games/bypasses.
const CATALOG_PER_PAGE_OPTIONS = [25, 50, 100];
const tableUiState = {
  games:    { role: 'all', category: 'all', search: '', page: 1, perPage: 50 },
  bypasses: { role: 'all', search: '', page: 1, perPage: 50 },
};
let tableSearchTimeout = { games: null, bypasses: null };
let tableReqSeq = { games: 0, bypasses: 0 }; // guard: abaikan response yang basi/telat (out-of-order network)
let tableToolbarWired = { games: false, bypasses: false };

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

function hasActiveCatalogFilters(type) {
  const s = tableUiState[type];
  return !!(s.search.trim() || s.role !== 'all' || (type === 'games' && s.category !== 'all'));
}

// Dipanggil saat pertama kali masuk ke halaman Game/Bypass — reset ke halaman 1.
async function renderTable(type) {
  tableUiState[type].page = 1;
  wireTableToolbarOnce(type);
  await fetchAndRenderTable(type);
}

// Dipanggil setelah tambah/edit/hapus/auto-isi — TETAP di halaman & filter yang
// sedang aktif (tidak reset ke halaman pertama), sesuai requirement.
async function refreshTable(type) {
  await fetchAndRenderTable(type, { allowClamp: true });
}

async function fetchAndRenderTable(type, opts = {}) {
  const state = tableUiState[type];
  const mySeq = ++tableReqSeq[type];
  const isFirstLoad = !document.querySelector(`#${type === 'games' ? 'tableGames' : 'tableBypasses'}`)
    .closest('.table-wrap').querySelector('.item-card-grid, .item-card');

  if (isFirstLoad) {
    _setTableMsg(type, '<svg class="icon icon-16"><use href="#ic-loader-circle"></use></svg>', 'Memuat data...');
  }

  try {
    const params = new URLSearchParams({
      page: state.page,
      perPage: state.perPage,
      search: state.search,
      role: state.role,
    });
    if (type === 'games') params.set('category', state.category);

    const data = await api(`/api/admin/${type}?${params.toString()}`);
    if (mySeq !== tableReqSeq[type]) return; // ada request lebih baru yang menyusul — buang response ini

    const total = data.total || 0;
    const totalPages = Math.max(1, Math.ceil(total / state.perPage));
    // Kalau halaman aktif ternyata di luar jangkauan (mis. abis hapus item terakhir
    // di halaman itu), mundur ke halaman terakhir yang valid & fetch ulang sekali.
    if (opts.allowClamp && state.page > totalPages && !opts._retried) {
      state.page = totalPages;
      return fetchAndRenderTable(type, { allowClamp: true, _retried: true });
    }

    const counts = data.counts || { total: 0, public: 0, gold: 0, platinum: 0, admin: 0 };
    renderPageStats(type === 'games' ? 'gamesStats' : 'bypassesStats', counts, { total: 'Total ' + (type === 'games' ? 'Game' : 'Bypass') });
    renderRoleChips(type === 'games' ? 'gamesRoleFilter' : 'bypassesRoleFilter', counts, state.role, (role) => {
      state.role = role;
      state.page = 1;
      fetchAndRenderTable(type);
    });

    if (type === 'games') renderCategoryFilterSelect(state, () => fetchAndRenderTable(type));

    renderTableRows(type, data.rows || [], total === 0 && hasActiveCatalogFilters(type));
    renderCatalogPagination(type, total, state, (p) => {
      state.page = p;
      fetchAndRenderTable(type);
    }, () => {
      state.page = 1;
      fetchAndRenderTable(type);
    });
  } catch (e) {
    _setTableMsg(type, '<svg class="icon icon-16"><use href="#ic-triangle-alert"></use></svg>', `Gagal memuat: ${escapeHtml(e.message)}`);
  }
}

function wireTableToolbarOnce(type) {
  if (tableToolbarWired[type]) return;
  tableToolbarWired[type] = true;
  const state = tableUiState[type];

  const searchEl = document.getElementById(type === 'games' ? 'searchGames' : 'searchBypasses');
  if (searchEl) {
    searchEl.value = state.search;
    searchEl.addEventListener('input', (e) => {
      clearTimeout(tableSearchTimeout[type]);
      const val = e.target.value;
      tableSearchTimeout[type] = setTimeout(() => {
        state.search = val;
        state.page = 1;
        fetchAndRenderTable(type);
      }, 350);
    });
  }
}

function filterTable(type, q) {
  tableUiState[type].search = q;
  tableUiState[type].page = 1;
  fetchAndRenderTable(type);
}
window.filterTable = filterTable;

// Dropdown filter Kategori — cuma di halaman Game (Bypass tidak punya kategori).
// Daftar kategori diambil dari `adminCategories` (sudah dimuat global oleh
// loadAdminCategories(), dipakai bareng dropdown Tambah/Edit Game).
function renderCategoryFilterSelect(state, onChange) {
  const el = document.getElementById('gamesCategoryFilter');
  if (!el) return;
  const current = state.category;
  const options = ['<option value="all">Semua Kategori</option>']
    .concat(adminCategories.map(c => `<option value="${escapeHtml(c.slug)}">${escapeHtml(c.name)}</option>`));
  el.innerHTML = options.join('');
  el.value = adminCategories.some(c => c.slug === current) || current === 'all' ? current : 'all';

  if (!el._wired) {
    el._wired = true;
    el.addEventListener('change', (e) => {
      state.category = e.target.value;
      state.page = 1;
      onChange();
    });
  }
}

// Pagination khusus katalog (Game/Bypass) — beda dari renderPagination() generik
// (dipakai Users/History/Logs) karena di sini juga ada pilihan jumlah data per
// halaman (25/50/100), dan info "Menampilkan X–Y dari Z" tetap tampil walau
// datanya cuma satu halaman.
function renderCatalogPagination(type, total, state, onPageChange, onPerPageChange) {
  const el = document.getElementById(type === 'games' ? 'gamesPagination' : 'bypassesPagination');
  if (!el) return;
  const { page, perPage } = state;
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const start = total === 0 ? 0 : (page - 1) * perPage + 1;
  const end = Math.min(page * perPage, total);

  let pageBtns = '';
  const windowSize = 5;
  let from = Math.max(1, page - Math.floor(windowSize / 2));
  let to = Math.min(totalPages, from + windowSize - 1);
  from = Math.max(1, to - windowSize + 1);
  for (let p = from; p <= to; p++) {
    pageBtns += `<button class="pagination-btn ${p === page ? 'active' : ''}" data-page="${p}">${p}</button>`;
  }

  el.style.display = 'flex';
  el.innerHTML = `
    <div class="pagination-info-wrap">
      <div class="pagination-info">Menampilkan ${start}–${end} dari ${total} data</div>
      <label class="pagination-per-page-label">
        Tampilkan
        <select class="hist-select pagination-per-page" id="${type}PerPageSelect">
          ${CATALOG_PER_PAGE_OPTIONS.map(n => `<option value="${n}" ${n === perPage ? 'selected' : ''}>${n}</option>`).join('')}
        </select>
        / halaman
      </label>
    </div>
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
  const perPageEl = document.getElementById(`${type}PerPageSelect`);
  if (perPageEl) {
    perPageEl.addEventListener('change', (e) => {
      state.perPage = parseInt(e.target.value, 10) || 50;
      onPerPageChange();
    });
  }
}

// Cache item mentah per halaman yang lagi tampil, keyed by _id — lihat
// renderTableRows & openItemModalFromCache (dipakai tombol Edit di grid).
const _catalogItemCache = { games: new Map(), bypasses: new Map() };
function openItemModalFromCache(type, id) {
  const item = _catalogItemCache[type]?.get(String(id));
  if (!item) {
    alert('Data item ini sudah tidak ada di halaman saat ini — coba muat ulang.');
    return;
  }
  openItemModal(type, item);
}

function renderTableRows(type, rows, isFilteredEmpty) {
  // Simpan data mentah per item (keyed by _id) di memori — tombol Edit tinggal
  // kirim ID-nya saja lewat onclick (lihat di bawah), BUKAN nge-dump seluruh
  // object item sebagai JSON mentah ke dalam atribut HTML seperti sebelumnya.
  // Itu penyebab bug "tombol Edit tidak bisa dipencet" untuk sebagian item:
  // begitu ada field (nama/deskripsi/dll) yang isinya mengandung karakter
  // tertentu (newline unicode, dsb — atau sekadar teks yang sangat panjang),
  // JSON yang disisipkan ke atribut onclick jadi rusak dan bikin tombolnya
  // error diam-diam (cuma kelihatan di console browser, klik jadi tidak
  // berfungsi tanpa ada pesan apapun ke user). Pakai ID + lookup di memori
  // sepenuhnya menghindari masalah ini karena tidak ada data mentah apapun
  // yang perlu disisipkan ke HTML.
  _catalogItemCache[type] = new Map(rows.map(item => [String(item._id), item]));

  const tableId = type === 'games' ? 'tableGames' : 'tableBypasses';
  const table = document.getElementById(tableId);

  if (!rows.length) {
    // Render empty state tetap pakai wrapper div (bukan tr/td) karena kita ganti jadi div grid
    table.innerHTML = '';
    table.insertAdjacentHTML('afterend', ''); // safety
    const emptyHtml = `<div class="item-grid-empty">
      <span class="empty-icon">${isFilteredEmpty ? '<svg class="icon icon-16"><use href="#ic-search"></use></svg>' : '<svg class="icon icon-16"><use href="#ic-inbox"></use></svg>'}</span>
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
    const roleLabel  = roleClass === 'admin' ? '<svg class="icon icon-16"><use href="#ic-crown"></use></svg> Admin' : roleClass === 'platinum' ? '<svg class="icon icon-16"><use href="#ic-gem"></use></svg> Platinum' : roleClass === 'gold' ? '<svg class="icon icon-16"><use href="#ic-star"></use></svg> Gold' : '<svg class="icon icon-16"><use href="#ic-globe"></use></svg> Gratis';
    const hasLink    = !!(item.zipUrl || item.link || item.manifestUrl);
    const placeholderIcon = isGame ? '<svg class="icon icon-16"><use href="#ic-gamepad-2"></use></svg>' : '<svg class="icon icon-16"><use href="#ic-shield-check"></use></svg>';
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
          ${isGame && item.category ? `<span class="item-card__meta-chip"><svg class="icon icon-18"><use href="#ic-tag"></use></svg> ${escapeHtml((adminCategories.find(c => c.slug === item.category) || {}).name || item.category)}</span>` : ''}
          ${item.appId     ? `<span class="item-card__meta-chip">${idSvg} ${escapeHtml(item.appId)}</span>` : ''}
          ${item.sizeLabel ? `<span class="item-card__meta-chip">${sizeSvg} ${escapeHtml(item.sizeLabel)}</span>` : ''}
          ${item.createdAt ? `<span class="item-card__meta-chip item-card__meta-chip--time">${clockSvg} ${timeAgo(item.createdAt)}</span>` : ''}
        </div>
      </div>

      <!-- Actions -->
      <div class="item-card__actions">
        <button class="item-card__btn item-card__btn--edit"
          title="Edit"
          onclick="openItemModalFromCache('${type}','${item._id}')">
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
    refreshTable(type);
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
    renderCategoryFilterSelect(tableUiState.games, () => fetchAndRenderTable('games'));
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
    statusEl.innerHTML = `<svg class="icon icon-16"><use href="#ic-check"></use></svg> Kategori "${created.name}" ditambahkan.`;
    statusEl.style.color = 'var(--green, #4ade80)';
    showToast('Kategori berhasil ditambahkan.', 'success');
  } catch (e) {
    statusEl.textContent = e.message;
    statusEl.style.color = 'var(--red)';
    showToast('Gagal menambah kategori: ' + e.message, 'error');
  }
});

// ══════════════════════════════════════════════════════════════════════════
// HALAMAN "Kelola Kategori" — CRUD lengkap + Active/Inactive + reorder (drag &
// drop + tombol ▲▼), realtime ke App lewat WebSocket 'categories:update' (di-
// broadcast server tiap kali ada perubahan, lihat broadcastCategoriesUpdate()
// di server.js). Kategori Inactive TIDAK dikirim ke App sama sekali.
// ══════════════════════════════════════════════════════════════════════════
let _categoryDragFromId = null;

// ══════════════════════════════════════════════════════════════════════════
// HALAMAN "Request Game" — daftar request user (Gold/Platinum), search +
// filter status, realtime lewat WS 'gameRequest:new'/'gameRequest:decided'
// (lihat connectAdminWS()). Approve TIDAK punya modal sendiri — dibuka lewat
// modal "Tambah Game" yang sudah ada (openItemModal), cuma di-prefill dari
// data Steam yang sudah tersimpan di request-nya + dikaitkan lewat
// `pendingApproveRequestId` supaya submit-nya otomatis approve request ini
// (lihat perluasan openItemModal & saveItem di bawah).
// ══════════════════════════════════════════════════════════════════════════
let _reqGameList = [];
let _reqGamePage = 1;
let _reqGameStatusFilter = 'all';
let _reqGameSearchDebounce = null;
let pendingApproveRequestId = null; // di-set sebelum openItemModal('games', ...) dipanggil dari tombol Approve

const REQ_GAME_STATUS_META = {
  pending:  { label: 'Menunggu',  cls: 'pending' },
  approved: { label: 'Disetujui', cls: 'approved' },
  rejected: { label: 'Ditolak',   cls: 'rejected' }
};

function reqGameStatusChipHtml(status) {
  const meta = REQ_GAME_STATUS_META[status] || { label: status, cls: '' };
  return `<span class="tag ${meta.cls}">${escapeHtml(meta.label)}</span>`;
}

async function loadGameRequests() {
  const grid = document.getElementById('tableReqGame');
  grid.innerHTML = `<div class="empty-cell empty-cell--grid">Memuat...</div>`;
  try {
    const search = document.getElementById('searchReqGame').value.trim();
    const params = new URLSearchParams({ page: _reqGamePage, limit: 20 });
    if (_reqGameStatusFilter !== 'all') params.set('status', _reqGameStatusFilter);
    if (search) params.set('search', search);
    const data = await api(`/api/admin/game-requests?${params.toString()}`);
    _reqGameList = data.items || [];
    renderReqGameStatusFilterChips();
    renderReqGameStats();
    renderReqGameRows(_reqGameList, !!search || _reqGameStatusFilter !== 'all');
    renderPagination('reqGamePagination', data.total, data.page, 20, (p) => { _reqGamePage = p; loadGameRequests(); });
  } catch (e) {
    grid.innerHTML = `<div class="empty-cell empty-cell--grid">Gagal memuat: ${escapeHtml(e.message)}</div>`;
  }
}

function renderReqGameStats() {
  const pending = _reqGameList.filter(r => r.status === 'pending').length;
  const approved = _reqGameList.filter(r => r.status === 'approved').length;
  const rejected = _reqGameList.filter(r => r.status === 'rejected').length;
  document.getElementById('reqGameStats').innerHTML = `
    <div class="stat-card"><div class="stat-card-label">Menunggu (halaman ini)</div><div class="stat-card-value">${pending}</div></div>
    <div class="stat-card"><div class="stat-card-label">Disetujui (halaman ini)</div><div class="stat-card-value">${approved}</div></div>
    <div class="stat-card"><div class="stat-card-label">Ditolak (halaman ini)</div><div class="stat-card-value">${rejected}</div></div>
  `;
}

function renderReqGameStatusFilterChips() {
  const el = document.getElementById('reqGameStatusFilter');
  const options = [['all', 'Semua'], ['pending', 'Menunggu'], ['approved', 'Disetujui'], ['rejected', 'Ditolak']];
  el.innerHTML = options.map(([val, label]) =>
    `<button class="filter-chip ${_reqGameStatusFilter === val ? 'active' : ''}" onclick="setReqGameStatusFilter('${val}')">${label}</button>`
  ).join('');
}
function setReqGameStatusFilter(val) { _reqGameStatusFilter = val; _reqGamePage = 1; loadGameRequests(); }
window.setReqGameStatusFilter = setReqGameStatusFilter;

document.getElementById('searchReqGame').addEventListener('input', () => {
  clearTimeout(_reqGameSearchDebounce);
  _reqGameSearchDebounce = setTimeout(() => { _reqGamePage = 1; loadGameRequests(); }, 350);
});

function renderReqGameRows(rows, isFilteredEmpty) {
  const grid = document.getElementById('tableReqGame');
  if (!rows.length) {
    grid.innerHTML = isFilteredEmpty
      ? `<div class="empty-cell empty-cell--grid"><span class="empty-icon"><svg class="icon icon-18"><use href="#ic-search"></use></svg></span>Tidak ada request yang cocok.</div>`
      : `<div class="empty-cell empty-cell--grid"><span class="empty-icon"><svg class="icon icon-18"><use href="#ic-target"></use></svg></span>Belum ada Request Game.</div>`;
    return;
  }
  grid.innerHTML = rows.map(r => `
    <div class="user-card" data-request-id="${escapeHtml(r._id)}">
      <div class="user-card-top">
        ${r.headerImage
          ? `<img class="user-card-avatar" style="border-radius:8px;" src="${escapeHtml(r.headerImage)}" alt="">`
          : `<div class="user-card-avatar user-card-avatar--fallback" style="border-radius:8px;">🎮</div>`}
        <div class="user-card-headtext">
          <div class="user-card-name" title="${escapeHtml(r.name || r.appId)}">${escapeHtml(r.name || r.appId)}</div>
          <div class="cell-time"><svg class="icon icon-18"><use href="#ic-clock"></use></svg> ${timeAgo(r.requestedAt)}</div>
        </div>
        <div class="user-card-badges">
          ${roleTagHtml(r.role)}
          ${reqGameStatusChipHtml(r.status)}
        </div>
      </div>
      <div class="user-card-id" title="${escapeHtml(r.appId)}">
        <svg width="12" height="12" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" style="flex-shrink:0;"><rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 3.5V7M16 3.5V7"/></svg>
        <span>App ID ${escapeHtml(r.appId)} · diminta oleh <strong>${escapeHtml(r.username)}</strong></span>
      </div>
      <button class="btn btn-sm btn-secondary" style="width:100%;justify-content:center;margin-top:2px;" onclick="openGameRequestersPopup('${escapeHtml(r.appId)}', '${escapeHtml((r.name || r.appId).replace(/'/g, "\\'"))}')">
        <svg class="icon icon-16"><use href="#ic-users"></use></svg>
        ${r.requesterCount > 1 ? `${r.requesterCount} User Pernah Request Game Ini` : 'Lihat Detail Requester'}
      </button>
      ${r.status === 'rejected' && r.rejectReason ? `<div class="user-card-id" style="color:var(--danger, #ff6b81);">📝 ${escapeHtml(r.rejectReason)}</div>` : ''}
      ${r.status === 'pending' ? `
        <div class="user-card-actions">
          <button class="btn btn-sm btn-primary user-card-action-main" onclick="approveGameRequest('${escapeHtml(r._id)}')">
            <svg class="icon icon-18"><use href="#ic-check"></use></svg> Approve
          </button>
          <button class="btn btn-sm btn-danger" onclick="openRejectGameRequestModal('${escapeHtml(r._id)}')">
            <svg class="icon icon-18"><use href="#ic-x"></use></svg> Reject
          </button>
        </div>
      ` : `<div class="user-card-id" style="color:var(--text-faint);">Diputuskan oleh ${escapeHtml(r.decidedBy || '-')} · ${r.decidedAt ? timeAgo(r.decidedAt) : ''}</div>`}
    </div>
  `).join('');
}

// Approve = buka modal "Tambah Game" yang SUDAH ADA, di-prefill dari data
// Steam yang tersimpan di request (gameData snapshot pas user request) — admin
// tinggal pilih Kategori/Role/Bypass/pengaturan lain lalu Simpan seperti biasa.
function approveGameRequest(requestId) {
  const req = _reqGameList.find(r => r._id === requestId);
  if (!req) return;
  openItemModal('games', null);
  pendingApproveRequestId = requestId; // WAJIB di-set SETELAH openItemModal (fungsi itu reset ke null tiap dibuka)
  document.getElementById('itemModalSubtitle').textContent = `Approve Request Game dari ${req.username} — data di bawah sudah diambil otomatis dari Steam, lengkapi Kategori/Paket/Bypass lalu Simpan.`;
  // Isi App ID lalu pakai App ID Lookup yang SUDAH ADA (sama persis dengan alur
  // Tambah Game manual) — jadi field yang ke-prefill selalu lengkap & konsisten,
  // tidak ada logic auto-fill kedua yang terpisah/bisa beda hasil.
  document.getElementById('itemAppId').value = req.appId;
  doAppIdLookup();
}
window.approveGameRequest = approveGameRequest;

function openRejectGameRequestModal(requestId) {
  const req = _reqGameList.find(r => r._id === requestId);
  if (!req) return;
  document.getElementById('reqGameRejectBackdrop').dataset.requestId = requestId;
  document.getElementById('reqGameRejectTarget').textContent = `Tolak request "${req.name || req.appId}" dari ${req.username}?`;
  document.getElementById('reqGameRejectReason').value = '';
  document.getElementById('reqGameRejectBackdrop').style.display = 'flex';
}
window.openRejectGameRequestModal = openRejectGameRequestModal;

function closeReqGameRejectModal() { document.getElementById('reqGameRejectBackdrop').style.display = 'none'; }
document.getElementById('btnReqGameRejectClose').addEventListener('click', closeReqGameRejectModal);
document.getElementById('btnReqGameRejectCancel').addEventListener('click', closeReqGameRejectModal);
document.getElementById('reqGameRejectBackdrop').addEventListener('click', (e) => { if (e.target.id === 'reqGameRejectBackdrop') closeReqGameRejectModal(); });

document.getElementById('btnReqGameRejectConfirm').addEventListener('click', async () => {
  const requestId = document.getElementById('reqGameRejectBackdrop').dataset.requestId;
  const reason = document.getElementById('reqGameRejectReason').value.trim();
  try {
    await api(`/api/admin/game-requests/${requestId}/reject`, { method: 'PUT', body: JSON.stringify({ reason }) });
    showToast('✅ Request Game ditolak.', 'success');
    closeReqGameRejectModal();
    loadGameRequests();
  } catch (e) {
    showToast('Gagal menolak request: ' + e.message, 'error');
  }
});

// ══════════════════════════════════════════════════════════════════════════
// POPUP: Daftar semua user yang PERNAH request 1 game (App ID) yang sama.
// Berguna kalau beberapa user request game yang sama — admin bisa lihat
// semuanya sekaligus dari 1 kartu, tanpa perlu scroll cari satu-satu di list.
// Realtime: dengar event WS yang sama dipakai list utama (gameRequest:new /
// gameRequest:decided) dan auto-refresh isi popup KALAU appId-nya cocok
// dengan yang lagi dibuka.
// ══════════════════════════════════════════════════════════════════════════
let _reqGameRequestersCurrentAppId = null;

async function openGameRequestersPopup(appId, gameName) {
  _reqGameRequestersCurrentAppId = appId;
  document.getElementById('reqGameRequestersTitle').textContent = `Requester — ${gameName}`;
  document.getElementById('reqGameRequestersBackdrop').style.display = 'flex';
  await refreshGameRequestersPopup();
}
window.openGameRequestersPopup = openGameRequestersPopup;

async function refreshGameRequestersPopup() {
  if (!_reqGameRequestersCurrentAppId) return;
  const list = document.getElementById('reqGameRequestersList');
  list.innerHTML = `<div style="padding:24px;text-align:center;color:var(--text-faint);font-size:12.5px;">Memuat...</div>`;
  try {
    const data = await api(`/api/admin/game-requests/by-app/${encodeURIComponent(_reqGameRequestersCurrentAppId)}`);
    renderGameRequestersPopupList(data.items || []);
  } catch (e) {
    list.innerHTML = `<div style="padding:24px;text-align:center;color:var(--red);font-size:12.5px;">Gagal memuat: ${escapeHtml(e.message)}</div>`;
  }
}

function renderGameRequestersPopupList(items) {
  const list = document.getElementById('reqGameRequestersList');
  if (!items.length) {
    list.innerHTML = `<div style="padding:24px;text-align:center;color:var(--text-faint);font-size:12.5px;">Belum ada yang request game ini.</div>`;
    return;
  }
  list.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:8px;">
      ${items.map(r => `
        <div style="display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:10px;background:var(--bg-elevated,rgba(255,255,255,.03));">
          <div style="flex:1;min-width:0;">
            <div style="font-weight:600;font-size:13px;display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
              ${escapeHtml(r.username)} ${roleTagHtml(r.role)}
            </div>
            <div style="font-size:11.5px;color:var(--text-faint);margin-top:2px;">
              ${timeAgo(r.requestedAt)}${r.decidedBy ? ` · diputuskan oleh ${escapeHtml(r.decidedBy)}` : ''}
            </div>
            ${r.status === 'rejected' && r.rejectReason ? `<div style="font-size:11.5px;color:var(--danger,#ff6b81);margin-top:3px;">📝 ${escapeHtml(r.rejectReason)}</div>` : ''}
          </div>
          ${reqGameStatusChipHtml(r.status)}
        </div>
      `).join('')}
    </div>`;
}

function closeGameRequestersPopup() {
  document.getElementById('reqGameRequestersBackdrop').style.display = 'none';
  _reqGameRequestersCurrentAppId = null;
}
document.getElementById('btnReqGameRequestersClose').addEventListener('click', closeGameRequestersPopup);
document.getElementById('reqGameRequestersBackdrop').addEventListener('click', (e) => { if (e.target.id === 'reqGameRequestersBackdrop') closeGameRequestersPopup(); });

async function renderCategoryAdmin() {
  const wrap = document.getElementById('categoryAdminList');
  wrap.innerHTML = `<div style="padding:24px;text-align:center;color:var(--text-faint);font-size:12.5px;">Memuat kategori...</div>`;
  try {
    await loadAdminCategories(); // isi ulang `adminCategories` (dipakai bareng dropdown di form Tambah Game)
    drawCategoryAdminList();
  } catch (e) {
    wrap.innerHTML = `<div style="padding:24px;text-align:center;color:var(--red);font-size:12.5px;">Gagal memuat kategori: ${escapeHtml(e.message)}</div>`;
  }
}

function drawCategoryAdminList() {
  const wrap = document.getElementById('categoryAdminList');
  if (!wrap) return;
  const rows = [...adminCategories].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  if (!rows.length) {
    wrap.innerHTML = `
      <div style="padding:40px 20px;text-align:center;color:var(--text-faint);">
        <div style="font-size:32px;margin-bottom:8px;"><svg class="icon icon-18"><use href="#ic-folder-kanban"></use></svg></div>
        <div style="font-size:13px;">Belum ada kategori. Klik "Tambah Kategori" untuk membuat yang pertama.</div>
      </div>`;
    return;
  }

  wrap.innerHTML = rows.map((c) => {
    const idx = rows.findIndex(x => x._id === c._id);
    const isActive = c.isActive !== false; // field lama tanpa isActive dianggap Active
    return `
    <div class="banner-admin-item" draggable="true" data-id="${c._id}" style="display:flex;align-items:center;gap:12px;padding:14px 16px;border-bottom:1px solid var(--border);">
      <span class="banner-drag-handle" title="Geser untuk ubah urutan">⠿</span>
      <div style="display:flex;flex-direction:column;gap:2px;">
        <button class="btn-icon-sm" title="Naikkan urutan" onclick="moveCategory('${c._id}', -1)" ${idx === 0 ? 'disabled style="opacity:.3;"' : ''}><svg class="icon icon-18"><use href="#ic-chevron-up"></use></svg></button>
        <button class="btn-icon-sm" title="Turunkan urutan" onclick="moveCategory('${c._id}', 1)" ${idx === rows.length - 1 ? 'disabled style="opacity:.3;"' : ''}><svg class="icon icon-18"><use href="#ic-chevron-down"></use></svg></button>
      </div>
      <div class="banner-thumb" style="background:linear-gradient(135deg,#7b5cff,#241a3d);display:flex;align-items:center;justify-content:center;"><span style="font-size:18px;"><svg class="icon icon-18"><use href="#ic-folder-kanban"></use></svg></span></div>
      <div style="flex:1;min-width:0;">
        <div style="font-weight:700;font-size:13.5px;color:var(--text-main);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(c.name)}</div>
        <div style="font-size:11.5px;color:var(--text-faint);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">slug: ${escapeHtml(c.slug)}</div>
        <div style="margin-top:4px;display:flex;gap:6px;flex-wrap:wrap;">
          <span class="tag ${isActive ? 'gold' : 'public'}" style="font-size:10px;">${isActive ? '<svg class="icon icon-16 icon-success"><use href="#ic-circle"></use></svg> Active' : '<svg class="icon icon-16 icon-muted"><use href="#ic-circle"></use></svg> Inactive'}</span>
          ${c.source === 'steam-auto' ? `<span class="tag public" style="font-size:10px;"><svg class="icon icon-16"><use href="#ic-bot"></use></svg> Auto dari Steam</span>` : ''}
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:8px;flex-shrink:0;">
        <label class="switch" title="Aktif/Nonaktif — kategori Inactive tidak muncul di App">
          <input type="checkbox" ${isActive ? 'checked' : ''} onchange="toggleCategoryActive('${c._id}', this.checked)">
          <span class="switch-slider"></span>
        </label>
        <button class="btn btn-secondary btn-sm" onclick="renameCategory('${c._id}')"><svg class="icon icon-18"><use href="#ic-pencil"></use></svg> Ubah Nama</button>
        <button class="btn btn-danger btn-sm" onclick="deleteCategoryPage('${c._id}')"><svg class="icon icon-18"><use href="#ic-trash-2"></use></svg></button>
      </div>
    </div>`;
  }).join('');

  wireCategoryDragAndDrop();
}

function wireCategoryDragAndDrop() {
  const items = document.querySelectorAll('#categoryAdminList .banner-admin-item');
  items.forEach(el => {
    el.addEventListener('dragstart', () => {
      _categoryDragFromId = el.dataset.id;
      el.classList.add('dragging');
    });
    el.addEventListener('dragend', () => {
      el.classList.remove('dragging');
      items.forEach(x => x.classList.remove('drag-over'));
    });
    el.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (el.dataset.id !== _categoryDragFromId) el.classList.add('drag-over');
    });
    el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
    el.addEventListener('drop', async (e) => {
      e.preventDefault();
      el.classList.remove('drag-over');
      const toId = el.dataset.id;
      if (!_categoryDragFromId || _categoryDragFromId === toId) return;
      const rows = [...adminCategories].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      const fromIdx = rows.findIndex(c => c._id === _categoryDragFromId);
      const toIdx = rows.findIndex(c => c._id === toId);
      if (fromIdx < 0 || toIdx < 0) return;
      const [moved] = rows.splice(fromIdx, 1);
      rows.splice(toIdx, 0, moved);
      rows.forEach((c, i) => c.order = i);
      adminCategories = rows;
      drawCategoryAdminList(); // optimistic UI
      try {
        await api('/api/admin/categories/reorder', { method: 'PUT', body: JSON.stringify({ order: rows.map(c => c._id) }) });
        showToast('Urutan kategori diperbarui.', 'success');
      } catch (err) {
        showToast('Gagal ubah urutan: ' + err.message, 'error');
        renderCategoryAdmin();
      }
    });
  });
}

async function moveCategory(id, dir) {
  const rows = [...adminCategories].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const idx = rows.findIndex(c => c._id === id);
  const swapIdx = idx + dir;
  if (idx < 0 || swapIdx < 0 || swapIdx >= rows.length) return;
  [rows[idx], rows[swapIdx]] = [rows[swapIdx], rows[idx]];
  rows.forEach((c, i) => c.order = i);
  adminCategories = rows;
  drawCategoryAdminList(); // optimistic UI
  try {
    await api('/api/admin/categories/reorder', { method: 'PUT', body: JSON.stringify({ order: rows.map(c => c._id) }) });
    showToast('Urutan kategori diperbarui.', 'success');
  } catch (e) {
    showToast('Gagal ubah urutan: ' + e.message, 'error');
    renderCategoryAdmin();
  }
}

async function toggleCategoryActive(id, isActive) {
  try {
    await api(`/api/admin/categories/${id}`, { method: 'PUT', body: JSON.stringify({ isActive }) });
    showToast(isActive ? 'Kategori diaktifkan.' : 'Kategori dinonaktifkan (tidak akan muncul di App).', 'success');
    const c = adminCategories.find(x => x._id === id);
    if (c) c.isActive = isActive;
    drawCategoryAdminList();
  } catch (e) {
    showToast('Gagal: ' + e.message, 'error');
    renderCategoryAdmin();
  }
}

async function renameCategory(id) {
  const c = adminCategories.find(x => x._id === id);
  if (!c) return;
  const name = prompt('Nama baru kategori:', c.name);
  if (name === null) return; // batal
  if (!name.trim()) { showToast('Nama kategori tidak boleh kosong.', 'error'); return; }
  try {
    await api(`/api/admin/categories/${id}`, { method: 'PUT', body: JSON.stringify({ name: name.trim() }) });
    showToast('Nama kategori diperbarui.', 'success');
    renderCategoryAdmin();
  } catch (e) {
    showToast('Gagal ubah nama: ' + e.message, 'error');
  }
}

async function deleteCategoryPage(id) {
  const c = adminCategories.find(x => x._id === id);
  if (!c) return;
  if (!confirm(`Hapus kategori "${c.name}"? Kategori hanya bisa dihapus kalau tidak ada game yang memakainya.`)) return;
  try {
    await api(`/api/admin/categories/${id}`, { method: 'DELETE' });
    showToast('Kategori dihapus.', 'success');
    renderCategoryAdmin();
  } catch (e) {
    showToast('Gagal hapus: ' + e.message, 'error');
  }
}

document.getElementById('btnAddCategoryPage')?.addEventListener('click', async () => {
  const name = prompt('Nama kategori baru (contoh: Racing, Horror, dll):');
  if (!name || !name.trim()) return;
  try {
    const created = await api('/api/admin/categories', { method: 'POST', body: JSON.stringify({ name: name.trim() }) });
    showToast(`Kategori "${created.name}" ditambahkan.`, 'success');
    renderCategoryAdmin();
  } catch (e) {
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
    statusEl.innerHTML = `<svg class="icon icon-16"><use href="#ic-check"></use></svg> Kategori "${cat.name}" dihapus.`;
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

// marketplaceProductId: diisi HANYA kalau modal ini dibuka dari Marketplace →
// Product → Kelola Konten (lihat openItemModalForProduct / editMktContentItem
// di bawah). Kalau null/undefined = mode NORMAL biasa (Role/Paket Minimum
// tetap tampil & wajib, perilaku lama sama sekali tidak berubah).
function openItemModal(type, item, marketplaceProductId = null) {
  editingContext = item ? { type, id: item._id, marketplaceProductId } : { type, id: null, marketplaceProductId };
  lookupData = null;
  pendingApproveRequestId = null; // di-set ulang ke request ID SETELAH ini kalau dibuka dari tombol Approve Request Game
  const label = type === 'games' ? 'Game' : 'Bypass';
  document.getElementById('itemModalTitle').textContent = item ? `Edit ${label}` : `Tambah ${label}`;
  document.getElementById('itemModalSubtitle').textContent = type === 'games'
    ? 'Cari lewat App ID Steam, atau isi manual di bawah.'
    : 'Isi manual — link bypass selalu dari kamu sendiri, hubcapmanifest cuma dipakai di halaman Game.';

  document.getElementById('itemName').value = item?.name || '';
  document.getElementById('itemDescription').value = item?.description || '';
  document.getElementById('itemFullDescription').value = item?.fullDescription || '';
  document.getElementById('itemDeveloper').value = item?.developer || '';
  document.getElementById('itemPublisher').value = item?.publisher || '';
  document.getElementById('itemReleaseDate').value = item?.releaseDate || '';
  document.getElementById('itemGenre').value = item?.genre || '';
  setSegmentValue(roleSegmentEl, roleHiddenEl, 'role', item?.role || 'public');
  setSegmentValue(onlineSegmentEl, onlineHiddenEl, 'online', item?.isOnline === false ? 'false' : 'true');
  document.getElementById('itemOnlineHint').textContent = '';
  document.getElementById('itemOnlineHint').className = 'segmented-hint';
  document.getElementById('itemImageUrl').value = item?.imageUrl || '';
  document.getElementById('itemCapsuleImageUrl').value = item?.capsuleImageUrl || '';
  document.getElementById('itemLibraryImageUrl').value = item?.libraryImageUrl || '';
  document.getElementById('itemHeroImageUrl').value = item?.heroImageUrl || '';
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

  // Checkbox "sekalian jadi Bypass" cuma relevan pas nambah GAME BARU (bukan
  // edit, bukan pas di halaman Bypass) — TETAP tersedia juga di mode
  // Marketplace Product (bypass companion-nya sekarang ikut dikirim dengan
  // marketplaceProductId di btnSaveItem, jadi tidak ada lagi bypass "nyasar"
  // tak terhubung ke Product).
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

  // ─── MODE Marketplace Product: sembunyikan Role/Paket Minimum ───
  // Kalau form ini dibuka dari Marketplace → Product → Kelola Konten, akses
  // Game/Bypass ini TIDAK ditentukan oleh Role/Paket (public/gold/platinum),
  // tapi oleh entitlement Product (purchase/whitelist) — lihat
  // marketplaceManager.hasAnyProductAccess & hasCatalogAccess di server.js.
  // Field-nya disembunyikan total (bukan cuma disabled) supaya admin tidak
  // bingung, dan value yang dikirim ke backend tetap default 'public' (lihat
  // btnSaveItem) karena field ini WAJIB diisi di endpoint API tapi memang
  // tidak dipakai untuk keputusan akses saat item terhubung ke Product.
  const roleFieldGroup = document.getElementById('itemRoleFieldGroup');
  const mktContextBanner = document.getElementById('itemMktContextBanner');
  if (marketplaceProductId) {
    roleFieldGroup.style.display = 'none';
    mktContextBanner.style.display = 'block';
    mktContextBanner.textContent = `Konten Marketplace Product — akses otomatis mengikuti pembelian/whitelist "${_mktDrawerProduct?.name || ''}", bukan Role/Paket.`;
  } else {
    roleFieldGroup.style.display = '';
    mktContextBanner.style.display = 'none';
  }

  document.getElementById('itemModalBackdrop').style.display = 'flex';
}
window.openItemModal = openItemModal;

// Dipanggil dari tombol "+ Tambah Game Baru" / "+ Tambah Bypass Baru" di
// drawer Kelola Konten Product — reuse TOTAL form & endpoint Add Game/Add
// Bypass yang sudah ada (bukan sistem baru), cuma bedanya field Role/Paket
// disembunyikan dan setelah Save otomatis ke-link ke Product aktif (lihat
// btnSaveItem).
function openItemModalForProduct(contentType) {
  if (!_mktDrawerProductId) return;
  openItemModal(contentType, null, _mktDrawerProductId);
}
window.openItemModalForProduct = openItemModalForProduct;

// Dipanggil dari tombol "Edit" pada baris Game/Bypass di drawer Kelola Konten
// Product — fetch dokumen lengkapnya dulu (listContent Cuma kembalikan field
// ringkas: _id/name/imageUrl/appId), lalu buka form Edit Game/Edit Bypass
// existing dalam mode Marketplace Product (Role/Paket tetap disembunyikan,
// relasi ke Product TIDAK disentuh sama sekali oleh PUT biasa).
async function editMktContentItem(contentType, itemId) {
  if (!_mktDrawerProductId) return;
  const type = contentType === 'bypass' ? 'bypasses' : 'games';
  try {
    const item = await api(`/api/admin/${type}/${itemId}`);
    openItemModal(type, item, _mktDrawerProductId);
  } catch (e) {
    showToast('Gagal memuat data untuk diedit: ' + e.message, 'error');
  }
}
window.editMktContentItem = editMktContentItem;

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
  statusEl.innerHTML = `<span style="color:var(--text-dim);"><svg class="icon icon-18"><use href="#ic-search"></use></svg> Mengambil data dari Steam &amp; ${selectedProvider === 'ryu' ? 'Ryu API' : 'hubcapmanifest'}...</span>`;
  previewEl.style.display = 'none';
  manifestUrlRow.style.display = 'none';

  try {
    const data = await api(`/api/admin/appid-lookup/${encodeURIComponent(appId)}?provider=${selectedProvider}`);
    lookupData = data;

    // Auto-isi form (tetap bisa diedit manual setelahnya)
    if (data.name) document.getElementById('itemName').value = data.name;
    if (data.description) document.getElementById('itemDescription').value = data.description;
    if (data.fullDescription) document.getElementById('itemFullDescription').value = data.fullDescription;
    if (data.developer) document.getElementById('itemDeveloper').value = data.developer;
    if (data.publisher) document.getElementById('itemPublisher').value = data.publisher;
    if (data.releaseDate) document.getElementById('itemReleaseDate').value = data.releaseDate;
    if (data.genres?.length) document.getElementById('itemGenre').value = data.genres.join(', ');
    // Kategori disarankan otomatis dari genre Steam (categorySlugs sudah dicocokkan/
    // dibuat baru di server kalau belum ada — lihat resolveCategorySlugsForGenres()).
    // Reload dulu daftar kategori (biar kategori yang baru dibuat otomatis ikut
    // muncul di dropdown) baru pilih yang paling relevan. Admin tetap bisa ganti manual.
    if (data.categorySlugs?.length) {
      await loadAdminCategories();
      renderCategorySelect(data.categorySlugs[0]);
    }
    if (data.imageUrl) document.getElementById('itemImageUrl').value = data.imageUrl;
    if (data.capsuleImageUrl) document.getElementById('itemCapsuleImageUrl').value = data.capsuleImageUrl;
    if (data.libraryImageUrl) document.getElementById('itemLibraryImageUrl').value = data.libraryImageUrl;
    if (data.heroImageUrl) document.getElementById('itemHeroImageUrl').value = data.heroImageUrl;
    if (data.sizeLabel) document.getElementById('itemSizeLabel').value = data.sizeLabel;

    // Link manifest — SEKARANG SELALU otomatis terisi (diprediksi dari pola URL
    // resmi provider), TANPA memakai kuota API key. Admin bisa klik "Verifikasi
    // Ketersediaan" kalau mau memastikan filenya benar-benar ada sebelum publish.
    if (data.manifestUrl) {
      document.getElementById('itemManifestUrl').value = data.manifestUrl;
      document.getElementById('btnOpenManifestUrl').href = data.manifestUrl;
      manifestUrlRow.style.display = 'block';
      const label = document.getElementById('manifestUrlProviderLabel');
      if (label) label.textContent = data.provider === 'ryu' ? '(Ryu API)' : '(hubcapmanifest)';
    } else {
      document.getElementById('itemManifestUrl').value = '';
    }

    // Preview card — SELALU ditampilkan setelah Search selesai (bukan cuma
    // kalau Steam berhasil kasih nama/gambar), supaya App ID yang Steam-nya
    // 'not_found'/'error' tetap kelihatan jelas kartunya sebagai pengingat
    // "lanjut isi manual di bawah" (poin permintaan #4 — Add Game harus
    // tetap berhasil walau Steam Store tidak punya data untuk App ID ini).
    previewEl.style.display = 'flex';
    document.getElementById('appIdPreviewImg').src = data.imageUrl || '';
    document.getElementById('appIdPreviewImg').style.display = data.imageUrl ? 'block' : 'none';
    document.getElementById('appIdPreviewName').textContent = data.name || `App ID ${appId} (isi nama manual di bawah)`;
    document.getElementById('appIdPreviewSize').textContent = 'Ukuran: ' + (data.sizeLabel || 'belum diverifikasi');
    renderManifestChip(data.hasManifest);
    document.getElementById('appIdPreviewLink').href = data.storeUrl || '#';

    // Chip tipe game (Online/Offline) — hasil deteksi otomatis dari kategori Steam
    const onlineChip = document.getElementById('appIdPreviewOnline');
    if (data.isOnlineSuggested !== null && data.isOnlineSuggested !== undefined) {
      onlineChip.style.display = 'inline-block';
      onlineChip.innerHTML = 'Tipe: ' + (data.isOnlineSuggested ? '<svg class="icon icon-16"><use href="#ic-globe"></use></svg> Online Multiplayer' : '<svg class="icon icon-16"><use href="#ic-power-off"></use></svg> Offline / Singleplayer');
      onlineChip.className = 'chip ' + (data.isOnlineSuggested ? 'chip-ok' : '');
    } else {
      onlineChip.style.display = 'none';
    }

    // Auto-set toggle Online/Offline sesuai hasil deteksi kategori Steam — admin tetap
    // bebas ubah manual sesudahnya kalau deteksinya kurang tepat.
    if (data.isOnlineSuggested !== null && data.isOnlineSuggested !== undefined) {
      setSegmentValue(onlineSegmentEl, onlineHiddenEl, 'online', data.isOnlineSuggested ? 'true' : 'false');
      const hintEl = document.getElementById('itemOnlineHint');
      hintEl.innerHTML = `<svg class="icon icon-16"><use href="#ic-lightbulb"></use></svg> Terdeteksi otomatis dari kategori Steam${data.categories?.length ? ' (' + data.categories.slice(0, 3).join(', ') + (data.categories.length > 3 ? ', ...' : '') + ')' : ''} — ubah manual kalau kurang tepat.`;
      hintEl.className = 'segmented-hint is-suggested';
    }

    // Pesan status dibedakan sesuai `data.steamStatus` (poin permintaan #7 —
    // jangan menyatukan semua kegagalan Steam jadi satu pesan generik):
    //   'ok'        — hijau, data Steam berhasil diisi otomatis.
    //   'not_found' — kuning, TAPI TEGAS bilang App ID tetap valid & form
    //                 tetap bisa disimpan manual (poin #4 — Steam Store
    //                 BUKAN satu-satunya sumber kebenaran App ID, jangan
    //                 bikin admin mengira Add Game gagal total).
    //   'error'     — kuning juga (bukan merah — ini BUKAN berarti App ID-
    //                 nya salah), tegaskan ini masalah Steam sesaat, bukan
    //                 masalah App ID, dan sarankan coba lagi/isi manual.
    // Pesan status dibedakan sesuai `data.steamStatus` DAN `data.metadataSource`
    // (poin permintaan #7 — jangan menyatukan semua kegagalan Steam jadi satu
    // pesan generik, dan bedakan "App ID tidak valid" dari "metadata tidak
    // bisa diambil otomatis"):
    //   steamStatus 'ok'                              — hijau, Steam berhasil.
    //   steamStatus bukan 'ok', metadataSource 'hubcap' — biru, App ID valid
    //     (dikonfirmasi HubCap) & nama/gambar SUDAH otomatis terisi dari
    //     HubCap, tapi deskripsi/developer/publisher/dll tidak tersedia dari
    //     sumber manapun — beda jelas dari "auto-fill benar-benar gagal".
    //   steamStatus bukan 'ok', metadataSource null    — kuning, App ID tetap
    //     boleh dipakai tapi TIDAK ADA satupun sumber (Steam maupun HubCap)
    //     yang berhasil mengisi metadata otomatis — isi manual.
    //   steamStatus 'error'                             — kuning terpisah,
    //     ini masalah Steam sesaat (network/rate-limit), BUKAN soal App ID.
    let statusHtml;
    if (data.steamStatus === 'ok') {
      statusHtml = `<span style="color:var(--green,#4ade80);"><svg class="icon icon-18"><use href="#ic-check"></use></svg> Data ditemukan &amp; berhasil diisi otomatis.</span>`;
    } else if (data.metadataSource === 'hubcap') {
      statusHtml = `<span style="color:var(--blue,#60a5fa);"><svg class="icon icon-18"><use href="#ic-check"></use></svg> Game ditemukan (nama &amp; gambar dari HubCap), tetapi deskripsi/developer/publisher/rilis tidak tersedia otomatis — lengkapi sisanya secara manual di bawah lalu Simpan.</span>`;
    } else if (data.steamStatus === 'error') {
      statusHtml = `<span style="color:var(--yellow,#ffd76a);"><svg class="icon icon-18"><use href="#ic-triangle-alert"></use></svg> Steam Store API sedang tidak bisa dihubungi (bukan berarti App ID salah) — coba klik Search sekali lagi, atau isi form manual dulu lalu Simpan.</span>`;
    } else if (data.steamStatus === 'not_found') {
      statusHtml = `<span style="color:var(--yellow,#ffd76a);"><svg class="icon icon-18"><use href="#ic-triangle-alert"></use></svg> Game ditemukan, tetapi metadata tidak dapat diambil otomatis. Silakan lengkapi data secara manual di bawah lalu Simpan.</span>`;
    } else if (data.warnings?.length) {
      statusHtml = `<span style="color:var(--yellow,#ffd76a);"><svg class="icon icon-18"><use href="#ic-triangle-alert"></use></svg> ${escapeHtml(data.warnings.join(' · '))}</span>`;
    } else {
      statusHtml = `<span style="color:var(--green,#4ade80);"><svg class="icon icon-18"><use href="#ic-check"></use></svg> Data ditemukan &amp; berhasil diisi otomatis.</span>`;
    }
    statusEl.innerHTML = statusHtml;
  } catch (e) {
    statusEl.innerHTML = `<span style="color:var(--red);"><svg class="icon icon-18"><use href="#ic-x"></use></svg> ${escapeHtml(e.message)}</span>`;
  } finally {
    btn.innerHTML = '<svg class="icon icon-16"><use href="#ic-search"></use></svg> Search'; btn.disabled = false;
  }
}

// Chip "Manifest: ..." di preview — hasManifest null (belum diverifikasi, kondisi
// NORMAL/default sekarang biar hemat kuota) sengaja dibedakan tampilannya dari
// hasManifest === false (SUDAH diverifikasi & memang tidak ada), supaya admin
// tidak salah kira App ID-nya bermasalah padahal cuma belum dicek.
function renderManifestChip(hasManifest) {
  const el = document.getElementById('appIdPreviewManifest');
  if (hasManifest === true) {
    el.innerHTML = 'Manifest: <svg class="icon icon-16"><use href="#ic-circle-check-big"></use></svg> Tersedia'; el.className = 'chip chip-ok';
  } else if (hasManifest === false) {
    el.innerHTML = 'Manifest: <svg class="icon icon-16"><use href="#ic-circle-x"></use></svg> Tidak ditemukan'; el.className = 'chip chip-bad';
  } else {
    el.innerHTML = 'Manifest: <svg class="icon icon-16"><use href="#ic-circle-help"></use></svg> Belum diverifikasi'; el.className = 'chip';
  }
}

// Tombol opt-in "🔍 Verifikasi Ketersediaan" — SATU-SATUNYA jalur yang benar-benar
// memakai kuota API key HubCap/Ryu di form Tambah Game sekarang, dan cuma jalan
// kalau admin klik sendiri (bukan otomatis tiap Search).
document.getElementById('btnVerifyManifest')?.addEventListener('click', async () => {
  const appId = document.getElementById('itemAppId').value.trim();
  if (!appId) { showToast('Isi & Search App ID dulu.', 'error'); return; }

  const btn = document.getElementById('btnVerifyManifest');
  const original = btn.innerHTML;
  btn.disabled = true; btn.textContent = 'Memverifikasi...';
  try {
    const data = await api(`/api/admin/appid-lookup/${encodeURIComponent(appId)}?provider=${selectedProvider}&verify=1`);
    lookupData = data;
    renderManifestChip(data.hasManifest);
    document.getElementById('appIdPreviewSize').textContent = 'Ukuran: ' + (data.sizeLabel || 'tidak diketahui');
    if (data.sizeLabel) document.getElementById('itemSizeLabel').value = data.sizeLabel;
    if (data.warnings?.length) showToast(data.warnings.join(' · '), data.hasManifest === false ? 'error' : 'info');
    else showToast('Terverifikasi — file tersedia.', 'success');
  } catch (e) {
    showToast('Gagal verifikasi: ' + e.message, 'error');
  } finally {
    btn.disabled = false; btn.innerHTML = original;
  }
});

document.getElementById('btnSaveItem').addEventListener('click', async () => {
  const { type, id, marketplaceProductId } = editingContext;
  const appId = type === 'games' ? (document.getElementById('itemAppId').value.trim() || null) : null;

  const body = {
    name:        document.getElementById('itemName').value.trim(),
    description: document.getElementById('itemDescription').value.trim(),
    fullDescription: document.getElementById('itemFullDescription').value.trim() || null,
    developer:   document.getElementById('itemDeveloper').value.trim() || null,
    publisher:   document.getElementById('itemPublisher').value.trim() || null,
    releaseDate: document.getElementById('itemReleaseDate').value.trim() || null,
    genre:       document.getElementById('itemGenre').value.trim() || null,
    // Mode Marketplace Product: field Role/Paket disembunyikan dari UI, kirim
    // default 'public' (endpoint API tetap mewajibkan field ini terisi valid),
    // TIDAK berpengaruh ke akses karena marketplaceProductIds yang jadi sumber
    // keputusan akses begitu item ini di-link ke Product (lihat di bawah).
    role:        marketplaceProductId ? 'public' : document.getElementById('itemRole').value,
    isOnline:    document.getElementById('itemIsOnline').value === 'true',
    imageUrl:    document.getElementById('itemImageUrl').value.trim() || null,
    capsuleImageUrl: document.getElementById('itemCapsuleImageUrl').value.trim() || null,
    libraryImageUrl: document.getElementById('itemLibraryImageUrl').value.trim() || null,
    heroImageUrl:    document.getElementById('itemHeroImageUrl').value.trim() || null,
    sizeLabel:   document.getElementById('itemSizeLabel').value.trim() || null
  };
  if (!body.name) { showToast('Nama wajib diisi.', 'error'); return; }

  if (type === 'games') {
    body.category = document.getElementById('itemCategory').value;
    if (!body.category) { showToast('Kategori wajib dipilih.', 'error'); return; }
    // Maks 4 kategori/genre paling relevan buat tag Dashboard App — pakai hasil
    // App ID Lookup terakhir kalau ada (dari Steam), fallback ke kategori tunggal
    // yang dipilih admin di dropdown.
    body.categories = (lookupData?.categorySlugs?.length ? lookupData.categorySlugs : [body.category]).slice(0, 4);
    body.genres = (lookupData?.genres?.length ? lookupData.genres : (body.genre ? body.genre.split(',').map(s => s.trim()).filter(Boolean) : [])).slice(0, 4);
    body.appId = appId;
    body.storeUrl = appId ? (lookupData?.storeUrl || `https://store.steampowered.com/app/${appId}/`) : null;
    body.manifestUrl = document.getElementById('itemManifestUrl').value.trim() || null;
    body.sizeBytes = lookupData?.sizeBytes ?? null;
    // Provider ('hubcap'/'ryu') dari hasil Search terakhir kalau ada — kalau admin isi
    // manifestUrl manual tanpa pernah klik Search, ikut toggle yang lagi aktif.
    body.provider = body.manifestUrl ? (lookupData?.provider || selectedProvider) : null;
    // Kalau modal ini dibuka lewat tombol "Approve" di halaman Request Game —
    // sertakan requestId-nya, server yang urus link + approve + notifikasi user
    // (lihat POST /api/admin/games di server.js). Cuma relevan pas BIKIN BARU
    // (id null) — approve TIDAK PERNAH lewat mode edit.
    if (!id && pendingApproveRequestId) body.requestId = pendingApproveRequestId;
    // Mode Marketplace Product + BIKIN BARU: kirim productId dalam SATU
    // request yang sama ke POST /api/admin/games — server yang urus linking
    // secara atomic (lihat komentar di server.js), BUKAN request kedua
    // terpisah dari sini. Ini yang mencegah celah waktu game "polos" tanpa
    // proteksi Marketplace sesaat setelah dibuat.
    if (!id && marketplaceProductId) body.marketplaceProductId = marketplaceProductId;
  } else {
    // Halaman Bypass: link SELALU manual dari admin, tidak ada urusan sama hubcap/App ID.
    body.zipUrl = document.getElementById('itemBypassOnlyContent').value.trim() || null;
    body.link   = body.zipUrl; // backward compat
    body.appId  = document.getElementById('itemBypassAppId').value.trim() || null;
    // Sama seperti Game — kalau ini "+ Tambah Bypass Baru" dari drawer Kelola
    // Konten Product, kirim productId di request CREATE yang sama (atomic),
    // bukan link menyusul lewat request kedua.
    if (!id && marketplaceProductId) body.marketplaceProductId = marketplaceProductId;
  }

  const alsoBypass = document.getElementById('itemAlsoBypass').checked;
  const btn = document.getElementById('btnSaveItem');
  btn.textContent = 'Menyimpan...'; btn.disabled = true;
  try {
    let savedGame = null;
    let savedBypass = null;
    if (id) {
      await api(`/api/admin/${type}/${id}`, { method: 'PUT', body: JSON.stringify(body) });
    } else {
      savedGame = await api(`/api/admin/${type}`, { method: 'POST', body: JSON.stringify(body) });
    }

    // Kalau checkbox "sekalian jadi Bypass" dicentang, bikin entri Bypass juga.
    // Role, nama, deskripsi & cover SAMA PERSIS dengan Game di atas (jadi otomatis ikut role Game),
    // tapi LINK bypass-nya tetap dari input "Link Bypass" yang admin isi sendiri (bukan dari hubcap).
    // Kalau ini mode Marketplace Product, bypass companion ini JUGA dikirim
    // dengan marketplaceProductId (atomic, sama seperti Game-nya di atas) —
    // supaya ikut ke-link + ownerMarketplaceProductId-nya keisi, tidak
    // "nyasar" tak terhubung ke Product manapun.
    if (!id && type === 'games' && alsoBypass) {
      savedBypass = await api('/api/admin/bypasses', {
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
          gameId: savedGame?._id || null,
          marketplaceProductId: marketplaceProductId || undefined
        })
      });
    }

    // ─── MODE Marketplace Product: link otomatis ke Product ───
    // CATATAN: linking untuk item UTAMA (Game/Bypass yang barusan disimpan di
    // atas) sudah dilakukan ATOMIC oleh server dalam request CREATE yang sama
    // (body.marketplaceProductId di atas) — jadi TIDAK ada request kedua di
    // sini lagi (menghindari percobaan link ganda yang bakal error "sudah ada
    // di produk ini"). Blok ini SENGAJA dihapus.

    const wasApprovingRequest = !id && type === 'games' && pendingApproveRequestId;
    closeModal();
    showToast(
      wasApprovingRequest ? '✅ Request Game disetujui & game ditambahkan!' :
      (alsoBypass && !id ? 'Game & Bypass berhasil disimpan!' : 'Berhasil disimpan!'),
      'success'
    );
    refreshTable(type);
    if (wasApprovingRequest && currentPage === 'requestgame') loadGameRequests();
    pendingApproveRequestId = null;

    // Drawer Kelola Konten tetap terbuka (admin biasanya mau tambah beberapa
    // konten sekaligus) — refresh daftar kontennya di tempat, tanpa perlu
    // tutup-buka drawer manual. Berlaku baik untuk Tambah Baru maupun Edit
    // item yang dibuka dari drawer ini. (Kalau backend broadcast realtime
    // sempat lebih cepat sampai, ini jadi no-op kedua yang aman — bukan
    // duplikat state, cuma re-render data yang sama.)
    if (marketplaceProductId) await reloadMktDrawerContentOnly();
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
const usersUiState = { role: 'all', status: 'all', search: '', page: 1, perPage: 24 };
const PER_PAGE = 8; // masih dipakai halaman lain yang belum server-side pagination
let usersDataCache = []; // cache halaman AKTIF saja (bukan seluruh koleksi users lagi)
let _usersReqSeq = 0;
let _usersSearchDebounce = null;

// PERF FIX: sebelumnya renderUsers() fetch SELURUH koleksi users sekali lalu
// applyUsersFilters() melakukan search/filter/pagination di browser (cache
// penuh di usersDataCache). Sekarang page/search/role/status dikirim ke
// server (lihat GET /api/admin/users) dan cuma baris utk halaman aktif yang
// pernah sampai ke browser — perilaku UI (stat pill, chip, pagination) sama
// persis, cuma sumber datanya server-side.
async function renderUsers() {
  usersUiState.page = 1;
  wireUsersSearchOnce();
  await fetchAndRenderUsers();
}

async function fetchAndRenderUsers(opts = {}) {
  const grid = document.getElementById('tableUsers');
  const mySeq = ++_usersReqSeq;
  const isFirstLoad = !grid.querySelector('.item-card, .user-card, [data-user-card]');
  if (isFirstLoad) {
    grid.innerHTML = `<div class="empty-cell empty-cell--grid"><span class="empty-icon"><svg class="icon icon-18"><use href="#ic-loader-circle"></use></svg></span>Memuat data...</div>`;
  }
  try {
    const params = new URLSearchParams({
      page: usersUiState.page, perPage: usersUiState.perPage,
      search: usersUiState.search, role: usersUiState.role, status: usersUiState.status,
    });
    const data = await api(`/api/admin/users?${params.toString()}`);
    if (mySeq !== _usersReqSeq) return; // ada request lebih baru menyusul — buang response ini

    const total = data.total || 0;
    const totalPages = Math.max(1, Math.ceil(total / usersUiState.perPage));
    if (opts.allowClamp !== false && usersUiState.page > totalPages && total > 0 && !opts._retried) {
      usersUiState.page = totalPages;
      return fetchAndRenderUsers({ _retried: true });
    }

    usersDataCache = data.rows || [];

    const counts = data.counts || { total: 0, public: 0, gold: 0, platinum: 0, admin: 0 };
    renderPageStats('usersStats', counts, { total: 'Total User' }, { showAdmin: true });
    renderRoleChips('usersRoleFilter', counts, usersUiState.role, (role) => {
      usersUiState.role = role;
      usersUiState.page = 1;
      fetchAndRenderUsers();
    }, { showAdmin: true });

    const statusCounts = data.statusCounts || { all: 0, active: 0, suspended: 0, banned: 0 };
    renderStatusChips('usersStatusFilter', statusCounts, usersUiState.status, (status) => {
      usersUiState.status = status;
      usersUiState.page = 1;
      fetchAndRenderUsers();
    });

    const isFilteredEmpty = total === 0 && (usersUiState.search || usersUiState.role !== 'all' || usersUiState.status !== 'all');
    renderUsersRows(usersDataCache, isFilteredEmpty);
    renderPagination('usersPagination', total, usersUiState.page, usersUiState.perPage, (p) => {
      usersUiState.page = p;
      fetchAndRenderUsers();
    });
  } catch (e) {
    grid.innerHTML = `<div class="empty-cell empty-cell--grid"><span class="empty-icon"><svg class="icon icon-18"><use href="#ic-triangle-alert"></use></svg></span>Gagal memuat: ${escapeHtml(e.message)}</div>`;
  }
}

function wireUsersSearchOnce() {
  const searchEl = document.getElementById('searchUsers');
  if (!searchEl || searchEl._wired) return;
  searchEl._wired = true;
  searchEl.value = usersUiState.search;
  searchEl.addEventListener('input', (e) => {
    clearTimeout(_usersSearchDebounce);
    const val = e.target.value;
    // Debounce 350ms — sekarang tiap ketik memicu request ke server (dulu cuma
    // filter array lokal), jadi debounce WAJIB biar tidak nembak request per huruf.
    _usersSearchDebounce = setTimeout(() => {
      usersUiState.search = val;
      usersUiState.page = 1;
      fetchAndRenderUsers();
    }, 350);
  });
}

// Pil filter Status Akun (Aktif / Suspend / Banned) — terpisah dari pil filter Role
// yang sudah ada, biar admin bisa gabung dua filter sekaligus (mis. "Gold" + "Suspend").
const STATUS_CHIP_LABEL = { all: 'Semua Status', active: '<svg class="icon icon-16"><use href="#ic-circle-check-big"></use></svg> Aktif', suspended: '<svg class="icon icon-16"><use href="#ic-pause"></use></svg> Suspend', banned: '<svg class="icon icon-16"><use href="#ic-ban"></use></svg> Banned' };
function renderStatusChips(containerId, counts, activeStatus, onSelect) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = ['all', 'active', 'suspended', 'banned'].map(key => `
    <button class="filter-chip ${activeStatus === key ? 'active' : ''}" data-status="${key}">
      ${STATUS_CHIP_LABEL[key]} <span class="count">${counts[key]}</span>
    </button>
  `).join('');
  el.querySelectorAll('.filter-chip').forEach(btn => {
    btn.addEventListener('click', () => onSelect(btn.dataset.status));
  });
}

// Dipertahankan sebagai alias tipis ke fetchAndRenderUsers() supaya SEMUA
// pemanggil lama (habis update role/status/quota, dll — lihat pencarian
// "applyUsersFilters" di file ini) tetap jalan tanpa perlu diganti satu-satu.
// Bedanya: sekarang re-fetch dari server (tetap di halaman & filter aktif),
// bukan re-filter array lokal yang sejak PERF FIX di atas cuma berisi 1 halaman.
function applyUsersFilters() {
  fetchAndRenderUsers();
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

const STATUS_TAG_LABEL = { active: '<svg class="icon icon-16"><use href="#ic-circle-check-big"></use></svg> Aktif', suspended: '<svg class="icon icon-16"><use href="#ic-pause"></use></svg> Suspend', banned: '<svg class="icon icon-16"><use href="#ic-ban"></use></svg> Banned' };
function statusTagHtml(status) {
  const s = status || 'active';
  return `<span class="status-tag ${s}">${STATUS_TAG_LABEL[s] || s}</span>`;
}

// Blok "Masa Aktif" + "Limit Download" di tiap kartu user — supaya admin bisa langsung
// lihat sisa kuota & sisa masa aktif tiap user tanpa buka modal Set Paket dulu.
function accountStatusHtml(status) {
  if (!status) return '';

  const activeRow = !status.hasActivePeriod
    ? `<div class="user-card-status-row"><span class="user-card-status-label"><svg class="icon icon-18"><use href="#ic-loader-circle"></use></svg> Masa Aktif</span><span class="user-card-status-value unlimited">Unlimited</span></div>`
    : status.activeUntil
      ? `<div class="user-card-status-row"><span class="user-card-status-label"><svg class="icon icon-18"><use href="#ic-loader-circle"></use></svg> Masa Aktif</span><span class="user-card-status-value ${status.isExpired ? 'expired' : 'ok'}">${escapeHtml(fmtDateShort(status.activeUntil))}${status.isExpired ? ' · Habis' : ''}</span></div>`
      : `<div class="user-card-status-row"><span class="user-card-status-label"><svg class="icon icon-18"><use href="#ic-loader-circle"></use></svg> Masa Aktif</span><span class="user-card-status-value">Belum diatur</span></div>`;

  const quotaRow = (label, q) => {
    if (!q) return '';
    const valueHtml = q.unlimited
      ? `<span class="user-card-status-value unlimited">Unlimited</span>`
      : `<span class="user-card-status-value ${q.remaining === 0 ? 'expired' : ''}">${q.used}/${q.limit} hari ini</span>`;
    return `<div class="user-card-status-row"><span class="user-card-status-label">${label}</span>${valueHtml}</div>`;
  };

  return `<div class="user-card-status">
    ${activeRow}
    ${quotaRow('<svg class="icon icon-16"><use href="#ic-gamepad-2"></use></svg> Limit Game', status.download && status.download.game)}
    ${quotaRow('<svg class="icon icon-16"><use href="#ic-shield-check"></use></svg> Limit Bypass', status.download && status.download.bypass)}
  </div>`;
}

function renderUsersRows(rows, isFilteredEmpty) {
  const grid = document.getElementById('tableUsers');
  if (!rows.length) {
    grid.innerHTML = isFilteredEmpty
      ? `<div class="empty-cell empty-cell--grid"><span class="empty-icon"><svg class="icon icon-18"><use href="#ic-search"></use></svg></span>Tidak ada user yang cocok.</div>`
      : `<div class="empty-cell empty-cell--grid"><span class="empty-icon"><svg class="icon icon-18"><use href="#ic-user"></use></svg></span>Belum ada user yang login.</div>`;
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
          <div class="cell-time"><svg class="icon icon-18"><use href="#ic-clock"></use></svg> Login terakhir ${u.lastLoginAt ? timeAgo(u.lastLoginAt) : '—'}</div>
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
        <div class="user-card-stat-box"><div class="v">${(u.stats && u.stats.downloads) || 0}</div><div class="l"><svg class="icon icon-18"><use href="#ic-gamepad-2"></use></svg> Download</div></div>
        <div class="user-card-stat-box"><div class="v">${(u.stats && u.stats.installs) || 0}</div><div class="l"><svg class="icon icon-18"><use href="#ic-shield-check"></use></svg> Install</div></div>
      </div>
      <div class="user-card-actions">
        <button class="btn btn-sm btn-primary user-card-action-main" onclick="openSetRoleModal('${escapeHtml(u.discordId)}','${escapeHtml(u.username)}','${escapeHtml(u.role)}')">
          <svg class="icon icon-18"><use href="#ic-search"></use></svg> Lihat Detail
        </button>
        <div class="user-card-actions-icons">
          <button class="icon-btn" title="Reset limit download harian" onclick="doResetQuota('${escapeHtml(u.discordId)}','${escapeHtml(u.username)}')"><svg class="icon icon-18"><use href="#ic-recycle"></use></svg></button>
          <button class="icon-btn" title="Kirim notifikasi ke user ini" onclick="openSendNotifModal('${escapeHtml(u.discordId)}','${escapeHtml(u.username)}')"><svg class="icon icon-18"><use href="#ic-megaphone"></use></svg></button>
          <button class="icon-btn" title="Hapus manual seluruh game/bypass user ini (berlaku semua role, termasuk Gratis)" onclick="doManualPremiumCleanup('${escapeHtml(u.discordId)}','${escapeHtml(u.username)}')"><svg class="icon icon-18"><use href="#ic-brush"></use></svg></button>
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
    showToast(`Limit download ${username} sudah direset.`, 'success');
  } catch (e) {
    showToast('Gagal reset limit: ' + e.message, 'error');
  }
}
window.doResetQuota = doResetQuota;

async function doManualPremiumCleanup(discordId, username) {
  if (!confirm(`Hapus MANUAL seluruh game & bypass milik ${username} sekarang? Berlaku untuk role apapun (Gratis/Gold/Platinum).\nProses ini langsung dijalankan begitu app user connect/dibuka.`)) return;
  try {
    const result = await api(`/api/admin/users/${discordId}/premium-cleanup`, { method: 'POST' });
    if (!result.scheduled) {
      showToast(`${username} tidak punya game/bypass yang terpasang.`, 'info');
    } else {
      showToast(`Dijadwalkan: ${result.gameCount} game & ${result.bypassCount} bypass ${username} akan dihapus.`, 'success');
    }
  } catch (e) {
    showToast('Gagal memicu hapus manual: ' + e.message, 'error');
  }
}
window.doManualPremiumCleanup = doManualPremiumCleanup;

// ─── Kirim notifikasi manual (In-App + opsional Discord DM/Webhook) ───
// Sebelumnya modal prompt()/confirm() browser bawaan — sekarang diarahkan ke
// halaman penuh "Kirim Notifikasi" (Notification Composer + Live Preview),
// lihat renderNotifSendPage() di bawah. discordId/username (kalau ada)
// dipakai sebagai prefill target, dicari ulang lewat /api/admin/users/lookup
// EXISTING (bukan data yang ditempel mentah) supaya tetap tervalidasi.
function openSendNotifModal(discordId, username) {
  _nsPrefillTarget = discordId ? { discordId, username } : null;
  document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.page === 'notifsend'));
  loadPage('notifsend');
}
window.openSendNotifModal = openSendNotifModal;

// ══════════════════════════════════════════════════════════════════════════
// KIRIM NOTIFIKASI — Notification Composer + Live Preview
// ══════════════════════════════════════════════════════════════════════════
// Memakai backend notifikasi EXISTING 100%:
//   GET  /api/admin/notifications/types  -> daftar type (ADMIN_NOTIF_TYPES,
//        server.js) dipakai isi grid Type & preview icon/badge — TIDAK
//        di-hardcode di sini, murni mengikuti backend.
//   GET  /api/admin/users/lookup?q=      -> validasi target user by Discord
//        ID/username (dipakai jugaoleh modal "Set Paket via Discord ID"),
//        backend = authority, frontend cuma menampilkan hasilnya.
//   POST /api/admin/notifications/send   -> kirim beneran (in-app DB + WS
//        realtime + opsional DM/Webhook Discord), sudah ada & sudah extend
//        terima `type`/`priority` (lihat catatan progress).
// TIDAK ADA endpoint/service/socket baru dibuat untuk fitur ini.

// Badge (kategori notifikasi, sama seperti NOTIF_BADGE_ICON di app/app.js)
// -> icon yang TERSEDIA di sprite Admin Web (lihat <svg id="ic-sprite"> di
// admin.html). Satu-satunya tempat mapping badge->icon Admin Web.
const NS_BADGE_ICON = {
  game: 'ic-gamepad-2', bypass: 'ic-shield-check', game_bypass: 'ic-gamepad-2',
  user: 'ic-user', paket: 'ic-package', voucher: 'ic-ticket',
  request_game: 'ic-inbox', payment: 'ic-credit-card', update: 'ic-refresh-cw',
  admin: 'ic-megaphone', security: 'ic-lock', system: 'ic-settings',
  maintenance: 'ic-construction', welcome: 'ic-sparkles',
  gold_trial: 'ic-crown', marketplace: 'ic-shopping-bag', download: 'ic-arrow-down-to-line'
};
function _nsIcon(badge) { return NS_BADGE_ICON[badge] || 'ic-bell'; }

const NS_PRIORITIES = [
  { value: 'low',    label: 'Low',    color: '#8993A8' },
  { value: 'normal', label: 'Normal', color: '#7b5cff' },
  { value: 'high',   label: 'High',   color: '#ffd76a' },
  { value: 'urgent', label: 'Urgent', color: '#f87171' }
];

let _nsTypes = null;           // cache ADMIN_NOTIF_TYPES dari backend
let _nsPrefillTarget = null;   // { discordId, username } — diisi openSendNotifModal()
let _nsSending = false;        // guard cegah double submit
let _nsRealtimeTimer = null;
let _ns = {
  mode: 'all',        // 'all' | 'user'
  targetQuery: '',
  targetUser: null,   // hasil /api/admin/users/lookup (publicUser shape)
  targetSearching: false,
  targetNotFound: false,
  title: '',
  message: '',
  type: 'announcement',
  priority: 'normal',
  dm: false,
  webhook: true
};

async function renderNotifSendPage() {
  const root = document.getElementById('notifSendRoot');
  if (!root) return;

  // Terapkan prefill (dari tombol "Kirim ke user ini" di halaman Users) —
  // sekali pakai, langsung dicari ulang lewat backend supaya tetap tervalidasi.
  if (_nsPrefillTarget) {
    _ns = { ..._ns, mode: 'user', targetQuery: _nsPrefillTarget.discordId, targetUser: null, targetNotFound: false };
    const pending = _nsPrefillTarget;
    _nsPrefillTarget = null;
    _nsRenderLayout(root);
    _nsSearchTarget(pending.discordId);
  } else {
    _nsRenderLayout(root);
  }

  if (!_nsTypes) {
    try {
      const res = await api('/api/admin/notifications/types');
      _nsTypes = res.types || [];
    } catch (e) {
      _nsTypes = [];
    }
    _nsRenderLayout(root);
  }

  _nsStartRealtimeBadge();
}

function _nsStartRealtimeBadge() {
  clearInterval(_nsRealtimeTimer);
  const tick = () => {
    const badge = document.getElementById('nsRealtimeBadge');
    if (!badge || currentPage !== 'notifsend') { clearInterval(_nsRealtimeTimer); return; }
    const open = typeof _adminWs !== 'undefined' && _adminWs && _adminWs.readyState === WebSocket.OPEN;
    badge.className = 'ns-realtime-badge' + (open ? ' online' : '');
    badge.innerHTML = `<span class="ns-realtime-dot"></span> ${open ? 'Realtime Terhubung' : 'Realtime Terputus'}`;
  };
  tick();
  _nsRealtimeTimer = setInterval(tick, 2000);
}

function _nsRenderLayout(root) {
  root.innerHTML = `
    <div class="ns-layout">
      <div class="ns-form-col">
        ${_nsFormHtml()}
      </div>
      <div class="ns-preview-col">
        ${_nsPreviewColHtml()}
      </div>
    </div>
  `;
  _nsBindEvents(root);
}

function _nsFormHtml() {
  const typesHtml = (_nsTypes || []).map(t => `
    <button type="button" class="ns-type-chip${t.value === _ns.type ? ' active' : ''}" data-type="${t.value}">
      <svg class="icon icon-16"><use href="#${_nsIcon(t.badge)}"></use></svg>
      <span>${escapeHtml(t.label)}</span>
    </button>
  `).join('') || `<div class="ns-type-loading">Memuat daftar type...</div>`;

  const priorityHtml = NS_PRIORITIES.map(p => `
    <button type="button" class="ns-priority-pill${p.value === _ns.priority ? ' active' : ''}" data-priority="${p.value}" style="--pill-color:${p.color}">
      ${escapeHtml(p.label)}
    </button>
  `).join('');

  return `
    <div class="card ns-card">
      <div class="card-header">
        <div class="card-title"><svg class="icon icon-18"><use href="#ic-target"></use></svg> Target / Penerima</div>
        <div class="card-sub">Kirim ke semua user, atau cari satu user spesifik lewat Discord ID/username (tervalidasi ke database).</div>
      </div>
      <div class="card-body">
        <div class="ns-mode-toggle">
          <button type="button" class="ns-mode-btn${_ns.mode === 'all' ? ' active' : ''}" data-mode="all"><svg class="icon icon-16"><use href="#ic-users"></use></svg> Semua User</button>
          <button type="button" class="ns-mode-btn${_ns.mode === 'user' ? ' active' : ''}" data-mode="user"><svg class="icon icon-16"><use href="#ic-user"></use></svg> User Tertentu</button>
        </div>
        ${_ns.mode === 'user' ? _nsTargetSearchHtml() : `<div class="ns-target-all-hint"><svg class="icon icon-16"><use href="#ic-info"></use></svg> Notifikasi akan dikirim ke <b>seluruh user</b> yang terdaftar.</div>`}
      </div>
    </div>

    <div class="card ns-card">
      <div class="card-header">
        <div class="card-title"><svg class="icon icon-18"><use href="#ic-file-pen-line"></use></svg> Isi Notifikasi</div>
        <div class="card-sub">Judul & isi pesan yang akan tampil di Notification Center App.</div>
      </div>
      <div class="card-body">
        <div class="form-group">
          <label class="form-label">Judul <span class="ns-count">${_ns.title.length}/100</span></label>
          <input class="form-input" id="nsTitle" maxlength="100" placeholder="Contoh: Update Maintenance Server" value="${escapeHtml(_ns.title)}">
        </div>
        <div class="form-group" style="margin-bottom:0;">
          <label class="form-label">Isi Notification <span class="ns-count">${_ns.message.length}/400</span></label>
          <textarea class="form-input" id="nsMessage" maxlength="400" rows="4" placeholder="Tulis isi pesan notifikasi di sini...">${escapeHtml(_ns.message)}</textarea>
        </div>
      </div>
    </div>

    <div class="card ns-card">
      <div class="card-header">
        <div class="card-title"><svg class="icon icon-18"><use href="#ic-tag"></use></svg> Type &amp; Priority</div>
        <div class="card-sub">Type menentukan icon &amp; kategori notifikasi (mengikuti mapping backend existing).</div>
      </div>
      <div class="card-body">
        <div class="form-group">
          <label class="form-label">Type</label>
          <div class="ns-type-grid" id="nsTypeGrid">${typesHtml}</div>
        </div>
        <div class="form-group" style="margin-bottom:0;">
          <label class="form-label">Priority</label>
          <div class="ns-priority-row" id="nsPriorityRow">${priorityHtml}</div>
        </div>
      </div>
    </div>

    <div class="card ns-card">
      <div class="card-header">
        <div class="card-title"><svg class="icon icon-18"><use href="#ic-bot"></use></svg> Pengiriman Discord</div>
        <div class="card-sub">Opsional — di luar Notification Center in-app yang selalu tersimpan ke database.</div>
      </div>
      <div class="card-body">
        <div class="ns-switch-row">
          <label class="peb-switch"><input type="checkbox" id="nsWebhook" ${_ns.webhook ? 'checked' : ''}><span class="peb-switch-track"></span></label>
          <div>
            <div class="ns-switch-label">Kirim ke Channel Discord</div>
            <div class="ns-switch-desc">Webhook kategori sesuai type, lewat Discord Bot existing.</div>
          </div>
        </div>
        <div class="ns-switch-row">
          <label class="peb-switch"><input type="checkbox" id="nsDm" ${_ns.dm ? 'checked' : ''}><span class="peb-switch-track"></span></label>
          <div>
            <div class="ns-switch-label">Kirim juga sebagai DM Discord</div>
            <div class="ns-switch-desc">Langsung ke inbox Discord user yang dituju (butuh target user tertentu, bukan broadcast semua).</div>
          </div>
        </div>
      </div>
    </div>

    <div id="nsResultBanner"></div>
    <button class="btn btn-primary ns-send-btn" id="nsSendBtn"><svg class="icon icon-18"><use href="#ic-megaphone"></use></svg> Kirim Notifikasi</button>
  `;
}

function _nsTargetSearchHtml() {
  if (_ns.targetUser) {
    const u = _ns.targetUser;
    return `
      <div class="ns-target-found">
        <img class="ns-target-avatar" src="${u.avatarUrl || IMG_FALLBACK_SRC}" ${IMG_ONERROR_ATTR}>
        <div class="ns-target-found-body">
          <div class="ns-target-found-name">${escapeHtml(u.username || u.discordId)}</div>
          <div class="ns-target-found-meta">${roleTagHtml(u.role)} <span class="ns-target-found-id">${escapeHtml(u.discordId)}</span></div>
        </div>
        <button type="button" class="ns-target-clear" id="nsTargetClear" title="Ganti target"><svg class="icon icon-16"><use href="#ic-x"></use></svg></button>
      </div>
    `;
  }
  return `
    <div class="ns-target-search-row">
      <input class="form-input" id="nsTargetInput" placeholder="Discord ID atau username..." value="${escapeHtml(_ns.targetQuery)}">
      <button type="button" class="btn btn-secondary btn-sm" id="nsTargetSearchBtn" ${_ns.targetSearching ? 'disabled' : ''}>
        ${_ns.targetSearching ? '<svg class="icon icon-16 spin"><use href="#ic-loader-circle"></use></svg>' : '<svg class="icon icon-16"><use href="#ic-search"></use></svg>'} Cari
      </button>
    </div>
    ${_ns.targetNotFound ? `<div class="ns-target-notfound"><svg class="icon icon-16"><use href="#ic-circle-x"></use></svg> User tidak ditemukan. Periksa kembali Discord ID/username.</div>` : ''}
  `;
}

function _nsPreviewColHtml() {
  const chosen = (_nsTypes || []).find(t => t.value === _ns.type);
  const badge = chosen ? chosen.badge : 'admin';
  const title = _ns.title.trim() || 'Judul notifikasi';
  const message = _ns.message.trim() || 'Isi pesan notifikasi akan tampil di sini...';
  const targetLabel = _ns.mode === 'all' ? 'Semua User' : (_ns.targetUser ? (_ns.targetUser.username || _ns.targetUser.discordId) : 'Belum memilih target');

  return `
    <div class="ns-preview-sticky">
      <div class="ns-preview-topline">
        <svg class="icon icon-16"><use href="#ic-monitor"></use></svg> Live Preview — Notification Center App
      </div>
      <div class="ns-preview-shell">
        <div class="ns-preview-topbar-mock">
          <span class="ns-preview-app-name">31 Tools</span>
          <div class="notif-center-wrap">
            <button class="notif-bell-btn" aria-expanded="true" tabindex="-1">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M18 8a6 6 0 00-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 01-3.46 0"/></svg>
              <span class="notif-unread-dot"></span>
            </button>
          </div>
        </div>
        <div class="notif-center-popup open">
          <div class="notif-center-header">
            <div class="notif-center-title-row">
              <span class="notif-center-title">Notifikasi</span>
              <span class="notif-center-unread-badge">1</span>
            </div>
            <div class="notif-center-header-actions">
              <button class="notif-mark-all-btn" tabindex="-1">Tandai semua dibaca</button>
              <button class="notif-close-btn" tabindex="-1"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M18 6L6 18M6 6l12 12"/></svg></button>
            </div>
          </div>
          <div class="notif-center-body">
            <div class="notif-item unread">
              <div class="notif-item-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><use href="#${_nsIcon(badge)}"></use></svg></div>
              <div class="notif-item-body">
                <div class="notif-item-title-row"><span class="notif-item-title">${escapeHtml(title)}</span></div>
                <div class="notif-item-desc">${escapeHtml(message)}</div>
                <div class="notif-item-meta-row">
                  <span class="notif-item-unread-mark"></span>
                  <span class="notif-item-time">Baru saja</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div class="ns-preview-summary">
        <div class="ns-preview-summary-row"><span>Target</span><b>${escapeHtml(targetLabel)}</b></div>
        <div class="ns-preview-summary-row"><span>Type</span><b>${escapeHtml(chosen ? chosen.label : '-')}</b></div>
        <div class="ns-preview-summary-row"><span>Priority</span><b style="text-transform:capitalize;">${escapeHtml(_ns.priority)}</b></div>
      </div>
    </div>
  `;
}

function _nsRefreshForm() {
  const root = document.getElementById('notifSendRoot');
  if (!root) return;
  const formCol = root.querySelector('.ns-form-col');
  if (formCol) formCol.innerHTML = _nsFormHtml();
  _nsBindEvents(root);
}

function _nsRefreshPreview() {
  const root = document.getElementById('notifSendRoot');
  if (!root) return;
  const previewCol = root.querySelector('.ns-preview-col');
  if (previewCol) previewCol.innerHTML = _nsPreviewColHtml();
}

function _nsBindEvents(root) {
  root.querySelectorAll('.ns-mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      _ns.mode = btn.dataset.mode;
      if (_ns.mode === 'all') { _ns.targetUser = null; _ns.targetNotFound = false; }
      _nsRefreshForm();
      _nsRefreshPreview();
    });
  });

  const targetInput = root.querySelector('#nsTargetInput');
  if (targetInput) {
    targetInput.addEventListener('input', () => { _ns.targetQuery = targetInput.value; });
    targetInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); _nsSearchTarget(); } });
  }
  const searchBtn = root.querySelector('#nsTargetSearchBtn');
  if (searchBtn) searchBtn.addEventListener('click', () => _nsSearchTarget());
  const clearBtn = root.querySelector('#nsTargetClear');
  if (clearBtn) clearBtn.addEventListener('click', () => {
    _ns.targetUser = null; _ns.targetQuery = ''; _ns.targetNotFound = false;
    _nsRefreshForm(); _nsRefreshPreview();
  });

  const titleInput = root.querySelector('#nsTitle');
  if (titleInput) titleInput.addEventListener('input', () => {
    _ns.title = titleInput.value;
    const counter = root.querySelector('.form-group .ns-count');
    if (counter) counter.textContent = `${_ns.title.length}/100`;
    _nsRefreshPreview();
  });
  const msgInput = root.querySelector('#nsMessage');
  if (msgInput) msgInput.addEventListener('input', () => {
    _ns.message = msgInput.value;
    const counters = root.querySelectorAll('.ns-count');
    if (counters[1]) counters[1].textContent = `${_ns.message.length}/400`;
    _nsRefreshPreview();
  });

  root.querySelectorAll('.ns-type-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      _ns.type = chip.dataset.type;
      root.querySelectorAll('.ns-type-chip').forEach(c => c.classList.toggle('active', c === chip));
      _nsRefreshPreview();
    });
  });
  root.querySelectorAll('.ns-priority-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      _ns.priority = pill.dataset.priority;
      root.querySelectorAll('.ns-priority-pill').forEach(p => p.classList.toggle('active', p === pill));
      _nsRefreshPreview();
    });
  });

  const dmToggle = root.querySelector('#nsDm');
  if (dmToggle) dmToggle.addEventListener('change', () => { _ns.dm = dmToggle.checked; });
  const webhookToggle = root.querySelector('#nsWebhook');
  if (webhookToggle) webhookToggle.addEventListener('change', () => { _ns.webhook = webhookToggle.checked; });

  const sendBtn = root.querySelector('#nsSendBtn');
  if (sendBtn) sendBtn.addEventListener('click', _nsSubmit);
}

async function _nsSearchTarget(forcedQuery) {
  const root = document.getElementById('notifSendRoot');
  const q = (forcedQuery || _ns.targetQuery || '').trim();
  if (!q) { showToast('Masukkan Discord ID atau username dulu.', 'error'); return; }
  _ns.targetSearching = true;
  _ns.targetNotFound = false;
  _nsRefreshForm();
  try {
    const user = await api(`/api/admin/users/lookup?q=${encodeURIComponent(q)}`);
    _ns.targetUser = user;
    _ns.targetNotFound = false;
  } catch (e) {
    _ns.targetUser = null;
    _ns.targetNotFound = true;
  } finally {
    _ns.targetSearching = false;
    _nsRefreshForm();
    _nsRefreshPreview();
  }
}

async function _nsSubmit() {
  if (_nsSending) return;
  if (!_ns.title.trim() || !_ns.message.trim()) { showToast('Judul & isi notifikasi wajib diisi.', 'error'); return; }
  if (_ns.mode === 'user' && !_ns.targetUser) { showToast('Cari & pilih target user dulu.', 'error'); return; }

  _nsSending = true;
  const btn = document.getElementById('nsSendBtn');
  const banner = document.getElementById('nsResultBanner');
  if (btn) { btn.disabled = true; btn.innerHTML = '<svg class="icon icon-18 spin"><use href="#ic-loader-circle"></use></svg> Mengirim...'; }
  if (banner) banner.innerHTML = '';

  try {
    const res = await api('/api/admin/notifications/send', {
      method: 'POST',
      body: JSON.stringify({
        target: _ns.mode === 'all' ? 'all' : _ns.targetUser.discordId,
        title: _ns.title.trim(),
        message: _ns.message.trim(),
        type: _ns.type,
        priority: _ns.priority,
        dm: !!_ns.dm,
        webhook: !!_ns.webhook
      })
    });
    showToast(`Notifikasi terkirim ke ${res.sentTo} user.`, 'success');
    if (banner) banner.innerHTML = `<div class="ns-result-banner success"><svg class="icon icon-18"><use href="#ic-circle-check-big"></use></svg> Terkirim ke ${res.sentTo} user — tersimpan di database &amp; realtime lewat Socket.IO existing.</div>`;
    // Reset isi pesan (Judul/Isi) setelah sukses, target & type/priority tetap
    // (memudahkan kirim beberapa notifikasi type sama ke user berbeda).
    _ns.title = ''; _ns.message = '';
    _nsRefreshForm();
    _nsRefreshPreview();
  } catch (e) {
    if (banner) banner.innerHTML = `<div class="ns-result-banner error"><svg class="icon icon-18"><use href="#ic-circle-x"></use></svg> Gagal mengirim: ${escapeHtml(e.message)}</div>`;
    showToast('Gagal kirim notifikasi: ' + e.message, 'error');
  } finally {
    _nsSending = false;
    const freshBtn = document.getElementById('nsSendBtn');
    if (freshBtn) { freshBtn.disabled = false; freshBtn.innerHTML = '<svg class="icon icon-18"><use href="#ic-megaphone"></use></svg> Kirim Notifikasi'; }
  }
}

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
  return d.getTime() <= Date.now() ? `<svg class="icon icon-16"><use href="#ic-loader-circle"></use></svg> Sudah habis (${label})` : `<svg class="icon icon-16"><use href="#ic-circle-check-big"></use></svg> Aktif sampai ${label}`;
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
  const appProfile = u.profile?.app || {};
  el.innerHTML = `
    <div class="user-summary-grid">
      <div class="user-summary-item"><span class="l">Login Terakhir</span><span class="v">${u.lastLoginAt ? timeAgo(u.lastLoginAt) : '—'}</span></div>
      <div class="user-summary-item"><span class="l">Bergabung Sejak</span><span class="v">${u.createdAt ? fmtDateShort(u.createdAt) : '—'}</span></div>
      <div class="user-summary-item"><span class="l">Total Download</span><span class="v">${(u.stats && u.stats.downloads) || 0}x</span></div>
      <div class="user-summary-item"><span class="l">Total Install</span><span class="v">${(u.stats && u.stats.installs) || 0}x</span></div>
      <div class="user-summary-item"><span class="l">Sisa Limit Game</span><span class="v ${gameQ?.unlimited ? 'unlimited' : gameQ?.remaining === 0 ? 'expired' : ''}">${quotaText(gameQ)}</span></div>
      <div class="user-summary-item"><span class="l">Sisa Limit Bypass</span><span class="v ${bypassQ?.unlimited ? 'unlimited' : bypassQ?.remaining === 0 ? 'expired' : ''}">${quotaText(bypassQ)}</span></div>
      <div class="user-summary-item"><span class="l">Username App</span><span class="v">${appProfile.username ? '@' + escapeHtml(appProfile.username) : '—'}</span></div>
      <div class="user-summary-item"><span class="l">Bio</span><span class="v">${appProfile.bio ? escapeHtml(appProfile.bio) : '—'}</span></div>
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
    infoEl.innerHTML = label ? `Masa aktif saat ini: ${label.replace(/^<svg[^>]*><use[^>]*><\/use><\/svg>\s*/, '')}` : 'Masa aktif saat ini: belum diatur (unlimited waktu).';
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
    // PERF FIX: sebelumnya fetch SELURUH koleksi users cuma buat cari 1 baris
    // by Discord ID/username. Sekarang lookup langsung di server (indexed).
    const found = await api(`/api/admin/users/lookup?q=${encodeURIComponent(discordId)}`);
    _setRoleTarget = found;
    _fillSetRoleModal(found);
    statusEl.innerHTML = `<span style="color:var(--green);"><svg class="icon icon-18"><use href="#ic-check"></use></svg> User ditemukan.</span>`;
  } catch (e) {
    if (e.message === 'not_found') {
      previewEl.innerHTML = `<div class="sr-preview-empty"><svg class="icon icon-18"><use href="#ic-triangle-alert"></use></svg> User dengan Discord ID <code>${escapeHtml(discordId)}</code> belum pernah login ke app.</div>`;
      _setRoleTarget = null;
      document.getElementById('srUserSummary').innerHTML = '';
      document.getElementById('srStatusCurrent').innerHTML = '';
    } else {
      statusEl.innerHTML = `<span style="color:var(--red);"><svg class="icon icon-18"><use href="#ic-x"></use></svg> ${escapeHtml(e.message)}</span>`;
    }
  } finally {
    btn.innerHTML = '<svg class="icon icon-16"><use href="#ic-search"></use></svg> Cari'; btn.disabled = false;
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
      showToast(`Paket ${_setRoleTarget.username} diubah ke ${role}${activeInfo}${ds?.ok ? ' — Discord disinkron' : ''}.`, 'success');
    } else if (ds.reason === 'not_configured') {
      showToast(`Paket diubah ke ${role}${activeInfo} Mapping Discord belum diatur.`, 'default');
    } else if (ds.reason === 'not_member') {
      showToast(`Paket diubah ke ${role}${activeInfo} User bukan member Discord.`, 'default');
    } else {
      showToast(`Paket diubah ke ${role}${activeInfo} sync Discord gagal: ${ds.reason}`, 'error');
    }
  } catch (e) {
    statusEl.innerHTML = `<span style="color:var(--red);"><svg class="icon icon-18"><use href="#ic-x"></use></svg> ${escapeHtml(e.message)}</span>`;
    showToast('Gagal mengubah paket: ' + e.message, 'error');
  } finally {
    btn.innerHTML = '<svg class="icon icon-16"><use href="#ic-save"></use></svg> Simpan Paket'; btn.disabled = false;
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
    showToast(`Limit ${type === 'game' ? 'Game' : 'Bypass'} diperbarui — sisa ${result.remaining}/${result.limit}.`, 'success');
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
    showToast(`Status ${_setRoleTarget.username} diubah ke ${STATUS_TAG_LABEL[status]}.`, 'success');
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
    showToast(`Pesan terkirim ke ${_setRoleTarget.username}.`, 'success');
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
  tbody.innerHTML = `<tr><td class="hist-td-empty" colspan="5"><span class="empty-icon"><svg class="icon icon-18"><use href="#ic-loader-circle"></use></svg></span>Memuat data...</td></tr>`;

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
    tbody.innerHTML = `<tr><td class="hist-td-empty" colspan="5"><span class="empty-icon"><svg class="icon icon-18"><use href="#ic-triangle-alert"></use></svg></span>Gagal memuat: ${escapeHtml(e.message)}</td></tr>`;
  }
}

function renderHistoryStats(stats) {
  const statsEl = document.getElementById('historyStats');
  if (!statsEl) return;
  statsEl.innerHTML = `
    <div class="page-stat-pill">
      <div class="page-stat-pill-icon" style="background:rgba(123,92,255,.16);"><svg class="icon icon-18"><use href="#ic-scroll-text"></use></svg></div>
      <div><div class="page-stat-pill-value">${stats.all ?? 0}</div><div class="page-stat-pill-label">Total Aktivitas</div></div>
    </div>
    <div class="page-stat-pill">
      <div class="page-stat-pill-icon" style="background:rgba(74,222,128,.16);"><svg class="icon icon-18"><use href="#ic-calendar"></use></svg></div>
      <div><div class="page-stat-pill-value">${stats.today ?? 0}</div><div class="page-stat-pill-label">Hari Ini</div></div>
    </div>
    <div class="page-stat-pill">
      <div class="page-stat-pill-icon" style="background:rgba(123,92,255,.16);"><svg class="icon icon-18"><use href="#ic-gamepad-2"></use></svg></div>
      <div><div class="page-stat-pill-value">${stats.game ?? 0}</div><div class="page-stat-pill-label">Inject Game</div></div>
    </div>
    <div class="page-stat-pill">
      <div class="page-stat-pill-icon" style="background:rgba(61,217,245,.16);"><svg class="icon icon-18"><use href="#ic-shield-check"></use></svg></div>
      <div><div class="page-stat-pill-value">${stats.bypass ?? 0}</div><div class="page-stat-pill-label">Bypass</div></div>
    </div>
  `;
}

function renderHistoryTypeChips(stats) {
  const chipsEl = document.getElementById('historyTypeFilter');
  if (!chipsEl) return;
  const chips = [
    { key: 'all',    label: 'Semua',      count: stats.all ?? 0 },
    { key: 'game',   label: '<svg class="icon icon-16"><use href="#ic-gamepad-2"></use></svg> Game',    count: stats.game ?? 0 },
    { key: 'bypass', label: '<svg class="icon icon-16"><use href="#ic-shield-check"></use></svg> Bypass',  count: stats.bypass ?? 0 },
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
        <span class="hist-empty__icon">${isFilteredEmpty ? '<svg class="icon icon-16"><use href="#ic-search"></use></svg>' : '<svg class="icon icon-16"><use href="#ic-scroll-text"></use></svg>'}</span>
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
    tbody.innerHTML = `<tr><td class="hist-td-empty" colspan="8"><span class="empty-icon"><svg class="icon icon-18"><use href="#ic-triangle-alert"></use></svg></span>Gagal memuat: ${escapeHtml(e.message)}</td></tr>`;
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
      <div class="page-stat-pill-icon" style="background:rgba(123,92,255,.16);"><svg class="icon icon-18"><use href="#ic-receipt"></use></svg></div>
      <div><div class="page-stat-pill-value">${stats.all ?? 0}</div><div class="page-stat-pill-label">Total Log</div></div>
    </div>
    <div class="page-stat-pill">
      <div class="page-stat-pill-icon" style="background:rgba(61,217,245,.16);"><svg class="icon icon-18"><use href="#ic-calendar"></use></svg></div>
      <div><div class="page-stat-pill-value">${stats.today ?? 0}</div><div class="page-stat-pill-label">Hari Ini</div></div>
    </div>
    <div class="page-stat-pill">
      <div class="page-stat-pill-icon" style="background:rgba(74,222,128,.16);"><svg class="icon icon-18"><use href="#ic-circle-check-big"></use></svg></div>
      <div><div class="page-stat-pill-value">${stats.success ?? 0}</div><div class="page-stat-pill-label">Sukses</div></div>
    </div>
    <div class="page-stat-pill">
      <div class="page-stat-pill-icon" style="background:rgba(255,215,106,.16);"><svg class="icon icon-18"><use href="#ic-triangle-alert"></use></svg></div>
      <div><div class="page-stat-pill-value">${stats.warning ?? 0}</div><div class="page-stat-pill-label">Warning</div></div>
    </div>
    <div class="page-stat-pill">
      <div class="page-stat-pill-icon" style="background:rgba(248,113,113,.16);"><svg class="icon icon-18"><use href="#ic-siren"></use></svg></div>
      <div><div class="page-stat-pill-value">${stats.error ?? 0}</div><div class="page-stat-pill-label">Error</div></div>
    </div>
  `;
}

function renderLogsStatusChips(stats) {
  const el = document.getElementById('logsStatusFilter');
  if (!el) return;
  const chips = [
    { key: 'all',     label: 'Semua',    count: stats.all ?? 0 },
    { key: 'success', label: '<svg class="icon icon-16"><use href="#ic-circle-check-big"></use></svg> Sukses', count: stats.success ?? 0 },
    { key: 'warning', label: '<svg class="icon icon-16"><use href="#ic-triangle-alert"></use></svg> Warning', count: stats.warning ?? 0 },
    { key: 'error',   label: '<svg class="icon icon-16"><use href="#ic-siren"></use></svg> Error',  count: stats.error ?? 0 },
    { key: 'info',    label: '<svg class="icon icon-16"><use href="#ic-info"></use></svg> Info',   count: stats.info ?? 0 },
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
  const meta = (logsCatalog && logsCatalog[item.type]) || { icon: item.icon || '<svg class="icon icon-16"><use href="#ic-info"></use></svg>', label: item.label || item.type, category: item.category || 'system' };
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
      <td>${item.admin ? `<span class="log-admin-name"><svg class="icon icon-18"><use href="#ic-user"></use></svg> ${escapeHtml(item.admin)}</span>` : `<span class="log-cell-muted">—</span>`}</td>
      <td><div class="log-desc-cell">${escapeHtml(item.description || '')}</div></td>
      <td>${logRoleChipHtml(item.role)}</td>
      <td>${logBadgeHtml(item.status)}</td>
      <td>
        <div class="log-meta-cell">
          ${item.ip ? `<span class="ip"><svg class="icon icon-18"><use href="#ic-globe"></use></svg> ${escapeHtml(item.ip)}</span>` : '<span>—</span>'}
          ${deviceShort ? `<span class="dev" title="${escapeHtml(item.device)}"><svg class="icon icon-18"><use href="#ic-monitor"></use></svg> ${escapeHtml(deviceShort)}</span>` : ''}
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
        <span class="hist-empty__icon">${isFilteredEmpty ? '<svg class="icon icon-16"><use href="#ic-search"></use></svg>' : '<svg class="icon icon-16"><use href="#ic-receipt"></use></svg>'}</span>
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
  body.innerHTML = `<div class="hist-empty" style="padding:24px 0;"><span class="empty-icon"><svg class="icon icon-18"><use href="#ic-loader-circle"></use></svg></span>Memuat detail...</div>`;

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
    body.innerHTML = `<div class="hist-empty" style="padding:24px 0;"><span class="empty-icon"><svg class="icon icon-18"><use href="#ic-triangle-alert"></use></svg></span>Gagal memuat detail: ${escapeHtml(e.message)}</div>`;
  }
}

function renderLogDetailBody(item) {
  const body = document.getElementById('logDetailBody');
  const titleEl = document.getElementById('logDetailTitle');
  const subEl = document.getElementById('logDetailSubtitle');
  if (!item) return;

  const meta = (logsCatalog && logsCatalog[item.type]) || { icon: item.icon || '<svg class="icon icon-16"><use href="#ic-info"></use></svg>', label: item.label || item.type, category: item.category || 'system' };
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
      <div class="log-detail-section-title"><svg class="icon icon-16"><use href="#ic-shuffle"></use></svg> Detail Perubahan (Before <svg class="icon icon-16"><use href="#ic-arrow-right"></use></svg> After)</div>
      <div class="log-detail-changes">
        <div class="before">${escapeHtml(fmt(item.changes.before))}</div>
        <div class="arrow"><svg class="icon icon-18"><use href="#ic-arrow-right"></use></svg></div>
        <div class="after">${escapeHtml(fmt(item.changes.after))}</div>
      </div>
    `;
  }

  if (item.meta && Object.keys(item.meta).length) {
    html += `
      <div class="log-detail-section-title"><svg class="icon icon-18"><use href="#ic-folder-kanban"></use></svg> Data Tambahan</div>
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

  statusEl.innerHTML = '<span style="color:var(--text-dim);"><svg class="icon icon-18"><use href="#ic-search"></use></svg> Mengambil info dari Steam...</span>';

  try {
    // Pakai endpoint appid-lookup yang sudah ada — kita abaikan bagian manifest-nya,
    // yang kita pakai cuma name + imageUrl dari Steam Store.
    const data = await api(`/api/admin/appid-lookup/${encodeURIComponent(appId)}`);

    if (!data.name) {
      // Bypass TIDAK butuh data Steam sama sekali (link diisi manual admin) —
      // ini murni auto-fill nama/cover yang opsional, jadi status "kuning
      // info", BUKAN merah (poin permintaan #4/#7 — Steam Store tidak
      // ditemukan bukan berarti ada yang salah/gagal).
      statusEl.innerHTML = data.steamStatus === 'error'
        ? '<span style="color:var(--yellow,#ffd76a);"><svg class="icon icon-18"><use href="#ic-triangle-alert"></use></svg> Steam Store sedang tidak bisa dihubungi — nama/cover tidak ke-auto-fill, isi manual saja.</span>'
        : '<span style="color:var(--yellow,#ffd76a);"><svg class="icon icon-18"><use href="#ic-triangle-alert"></use></svg> App ID ini tidak punya halaman di Steam Store — nama/cover tidak ke-auto-fill, isi manual saja (tidak masalah untuk Bypass).</span>';
      return;
    }

    statusEl.innerHTML = `<span style="color:var(--success);"><svg class="icon icon-18"><use href="#ic-circle-check-big"></use></svg> ${escapeHtml(data.name)}</span>`;

    // Auto-fill nama kalau field nama masih kosong (tidak overwrite kalau sudah diisi)
    const nameEl = document.getElementById('itemName');
    if (nameEl && !nameEl.value.trim()) nameEl.value = data.name;

    // Auto-fill cover kalau field imageUrl masih kosong
    const imgEl = document.getElementById('itemImageUrl');
    if (imgEl && !imgEl.value.trim() && data.imageUrl) imgEl.value = data.imageUrl;

    showBypassPreview(data.name, data.imageUrl, appId, data.storeUrl);
  } catch (e) {
    statusEl.innerHTML = `<span style="color:var(--danger);"><svg class="icon icon-18"><use href="#ic-circle-x"></use></svg> ${escapeHtml(e.message)}</span>`;
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
  admin: '<svg class="icon icon-16"><use href="#ic-wrench"></use></svg> Admin',
  discord: '<svg class="icon icon-16"><use href="#ic-message-circle"></use></svg> Discord',
  left_guild: '<svg class="icon icon-16"><use href="#ic-log-out"></use></svg> Keluar Server',
  resync: '<svg class="icon icon-16"><use href="#ic-refresh-cw"></use></svg> Resync',
  expired: '<svg class="icon icon-16"><use href="#ic-loader-circle"></use></svg> Masa Aktif Habis'
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
    autoSyncEl.checked = settings.autoSyncFromDiscord !== false;
    resetOnLeaveEl.checked = settings.resetRoleOnLeave !== false;

    const gw = settings.gateway || {};
    if (gw.connected) {
      badge.className = 'vr-gateway-badge ok';
      badge.innerHTML = `<svg class="icon icon-16 icon-success"><use href="#ic-circle"></use></svg> Bot terhubung${gw.guildName ? ' — ' + gw.guildName : ''}`;
    } else if (gw.error) {
      badge.className = 'vr-gateway-badge error';
      badge.innerHTML = '<svg class="icon icon-16 icon-danger"><use href="#ic-circle"></use></svg> Bot belum terhubung';
      badge.title = gw.error;
    } else {
      badge.className = 'vr-gateway-badge';
      badge.innerHTML = '<svg class="icon icon-16 icon-warning"><use href="#ic-circle"></use></svg> Menunggu koneksi bot...';
    }
  } catch (e) {
    badge.className = 'vr-gateway-badge error';
    badge.innerHTML = '<svg class="icon icon-16"><use href="#ic-triangle-alert"></use></svg> Gagal memuat pengaturan';
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
      btn.disabled = false; btn.innerHTML = '<svg class="icon icon-16"><use href="#ic-save"></use></svg> Simpan Mapping';
    }
  });

  document.getElementById('btnResyncToDiscord').addEventListener('click', () => runResync('app_to_discord'));
  document.getElementById('btnResyncToApp').addEventListener('click', () => runResync('discord_to_app'));
}

async function runResync(direction) {
  const label = direction === 'app_to_discord' ? 'App <svg class="icon icon-16"><use href="#ic-arrow-right"></use></svg> Discord' : 'Discord <svg class="icon icon-16"><use href="#ic-arrow-right"></use></svg> App';
  if (!confirm(`Jalankan full resync ${label} untuk SEMUA user sekarang?`)) return;

  const btnId = direction === 'app_to_discord' ? 'btnResyncToDiscord' : 'btnResyncToApp';
  const btn = document.getElementById(btnId);
  const resultEl = document.getElementById('vrResyncResult');
  btn.disabled = true; btn.textContent = 'Memproses...';
  resultEl.className = 'vr-resync-result show';
  resultEl.innerHTML = `<svg class="icon icon-16"><use href="#ic-loader-circle"></use></svg> Sedang menjalankan resync ${label}, mohon tunggu (bisa beberapa menit tergantung jumlah user)...`;

  try {
    const summary = await api('/api/admin/role-sync/resync', { method: 'POST', body: JSON.stringify({ direction }) });
    resultEl.innerHTML = `
      <svg class="icon icon-16"><use href="#ic-circle-check-big"></use></svg> Resync ${label} selesai.<br>
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
    resultEl.innerHTML = '<svg class="icon icon-16"><use href="#ic-circle-x"></use></svg> Resync gagal: ' + e.message;
    showToast('Resync gagal: ' + e.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = 'Jalankan';
  }
}

async function loadRoleSyncLogs() {
  const table = document.getElementById('tableRoleLogs');
  table.innerHTML = `<tr><td class="empty-cell" colspan="4"><span class="empty-icon"><svg class="icon icon-18"><use href="#ic-loader-circle"></use></svg></span>Memuat log...</td></tr>`;
  try {
    const rows = await api('/api/admin/role-sync/logs');
    if (!rows.length) {
      table.innerHTML = `<tr><td class="empty-cell" colspan="4"><span class="empty-icon"><svg class="icon icon-18"><use href="#ic-scroll-text"></use></svg></span>Belum ada perubahan role yang tercatat.</td></tr>`;
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
            <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">${roleTagHtml(r.oldRole || 'public')} <svg class="icon icon-16"><use href="#ic-arrow-right"></use></svg> ${roleTagHtml(r.newRole)}</div>
            ${r.discordSynced === false ? `<div style="color:var(--red);font-size:11px;margin-top:4px;"><svg class="icon icon-18"><use href="#ic-triangle-alert"></use></svg> Sync Discord gagal${r.discordSyncReason ? ' ('+escapeHtml(r.discordSyncReason)+')' : ''}</div>` : ''}
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
    table.innerHTML = `<tr><td class="empty-cell" colspan="4"><span class="empty-icon"><svg class="icon icon-18"><use href="#ic-triangle-alert"></use></svg></span>Gagal memuat: ${escapeHtml(e.message)}</td></tr>`;
  }
}
// ─── DISCORD NOTIFICATION CHANNEL SETTING ───
// Menggantikan Webhook Settings lama sepenuhnya — admin memilih channel
// Discord dari server yang sudah terhubung ke Bot lewat dropdown custom
// (search + floating panel), BUKAN lagi menempel URL webhook manual. Data
// kategori dirender dinamis dari /api/admin/notification-channels (jadi
// kalau suatu saat ada kategori baru di discordNotifyManager.js, panel ini
// otomatis ikut menampilkannya tanpa ubah admin.html), daftar channel
// diambil LIVE dari /api/admin/discord/channels.
const NC_STATUS_LABEL = { valid: '<svg class="icon icon-16 icon-success"><use href="#ic-circle"></use></svg> Valid', invalid: '<svg class="icon icon-16 icon-danger"><use href="#ic-circle"></use></svg> Invalid', unknown: '<svg class="icon icon-16 icon-warning"><use href="#ic-circle"></use></svg> Belum diuji' };

let _ncChannels = [];        // cache daftar channel Discord (live dari server, sekali per render halaman)
let _ncChannelsError = null;
let _ncCategories = [];      // cache daftar kategori notifikasi + config-nya
let _ncOpenDropdown = null;  // instance dropdown yang lagi terbuka (biar bisa ditutup pas klik di luar / buka dropdown lain)

function ncChannelIcon(type) {
  return type === 'announcement'
    ? '<svg class="icon icon-14"><use href="#ic-megaphone"></use></svg>'
    : '<svg class="icon icon-14"><use href="#ic-hash"></use></svg>';
}

// Dropdown channel custom — reusable, dipakai baik di tiap card kategori
// maupun di section Test Notification. Floating panel dekat input (BUKAN
// modal fullscreen), ada search box, scroll kalau channel banyak.
//
// PERBAIKAN: panel TIDAK LAGI dirender sebagai child di dalam trigger (`el`).
// Sebelumnya panel ikut kepotong karena beberapa card/container leluhur pakai
// `overflow: hidden` (untuk sudut membulat) — z-index berapa pun tidak bisa
// menembus itu. Sekarang panel di-"portal" ke satu elemen tunggal yang
// ditempel langsung ke <body> (`position: fixed`, dihitung dari
// getBoundingClientRect() trigger), jadi tidak pernah kepotong oleh card,
// section, atau scroll container manapun. Posisi dihitung ulang tiap kali
// dibuka + saat scroll/resize, dan otomatis membuka ke ATAS kalau ruang di
// bawah tidak cukup tapi ruang di atas lebih luas (poin #10).
function ncPortalEl() {
  let portal = document.getElementById('ncDropdownPortal');
  if (!portal) {
    portal = document.createElement('div');
    portal.id = 'ncDropdownPortal';
    document.body.appendChild(portal);
  }
  return portal;
}

function ncBuildChannelDropdown(el, { selectedId, onChange } = {}) {
  let selected = selectedId || null;
  let open = false;
  const instance = { close: () => { if (open) closePanel(); }, getSelected: () => selected, setSelected: (id) => { selected = id; renderTrigger(); } };

  function selectedChannel() { return _ncChannels.find(c => c.id === selected) || null; }

  function channelItemsHtml(list) {
    if (!list.length) return `<div class="nc-dropdown-empty">Channel tidak ditemukan.</div>`;
    return list.map(c => `
      <div class="nc-dropdown-item ${c.id === selected ? 'active' : ''}" data-nc-item="${escapeHtml(c.id)}">
        ${ncChannelIcon(c.type)} ${escapeHtml(c.name)}
        ${c.parentName ? `<span class="nc-chan-parent">${escapeHtml(c.parentName)}</span>` : ''}
      </div>
    `).join('');
  }

  function panelInnerHtml() {
    if (_ncChannelsError) return `<div class="nc-dropdown-empty">${escapeHtml(_ncChannelsError)}</div>`;
    if (!_ncChannels.length) return `<div class="nc-dropdown-empty">Tidak ada channel ditemukan.</div>`;
    return `
      <div class="nc-dropdown-search">
        <svg class="icon icon-14"><use href="#ic-search"></use></svg>
        <input type="text" placeholder="Search channel" data-nc-search>
      </div>
      <div class="nc-dropdown-list" data-nc-list>${channelItemsHtml(_ncChannels)}</div>
    `;
  }

  function wireItems(panel) {
    panel.querySelectorAll('[data-nc-item]').forEach(item => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        selected = item.dataset.ncItem;
        closePanel();
        renderTrigger();
        onChange && onChange(selected);
      });
    });
  }

  // Hitung & terapkan posisi panel relatif ke trigger, flip ke atas kalau
  // ruang di bawah viewport tidak cukup (max-height panel 260px + margin).
  function positionPanel(panel) {
    const rect = el.getBoundingClientRect();
    const PANEL_MAX_H = 260;
    const GAP = 6;
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;
    const openUpward = spaceBelow < (PANEL_MAX_H + GAP) && spaceAbove > spaceBelow;
    panel.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - rect.width - 8))}px`;
    panel.style.width = `${rect.width}px`;
    if (openUpward) {
      panel.style.maxHeight = `${Math.min(PANEL_MAX_H, spaceAbove - GAP - 8)}px`;
      panel.style.top = '';
      panel.style.bottom = `${window.innerHeight - rect.top + GAP}px`;
      panel.classList.add('nc-flip-up');
    } else {
      panel.style.maxHeight = `${Math.min(PANEL_MAX_H, spaceBelow - GAP - 8)}px`;
      panel.style.bottom = '';
      panel.style.top = `${rect.bottom + GAP}px`;
      panel.classList.remove('nc-flip-up');
    }
  }

  function onReposition() { if (open) positionPanel(ncPortalEl().firstElementChild); }

  function openPanel() {
    if (_ncOpenDropdown && _ncOpenDropdown !== instance) _ncOpenDropdown.close();
    const portal = ncPortalEl();
    portal.innerHTML = `<div class="nc-dropdown-panel">${panelInnerHtml()}</div>`;
    const panel = portal.firstElementChild;
    positionPanel(panel);
    wireItems(panel);
    const search = panel.querySelector('[data-nc-search]');
    if (search) {
      search.addEventListener('click', e => e.stopPropagation());
      search.addEventListener('input', () => {
        const q = search.value.trim().toLowerCase();
        const filtered = q ? _ncChannels.filter(c => c.name.toLowerCase().includes(q)) : _ncChannels;
        panel.querySelector('[data-nc-list]').innerHTML = channelItemsHtml(filtered);
        wireItems(panel);
      });
      setTimeout(() => search.focus(), 0);
    }
    open = true;
    _ncOpenDropdown = instance;
    window.addEventListener('scroll', onReposition, true);
    window.addEventListener('resize', onReposition);
    renderTrigger();
  }

  function closePanel() {
    open = false;
    ncPortalEl().innerHTML = '';
    if (_ncOpenDropdown === instance) _ncOpenDropdown = null;
    window.removeEventListener('scroll', onReposition, true);
    window.removeEventListener('resize', onReposition);
    renderTrigger();
  }

  function renderTrigger() {
    const ch = selectedChannel();
    const label = ch
      ? `<span class="nc-chan-label">${ncChannelIcon(ch.type)} ${escapeHtml(ch.name)}</span>`
      : `<span class="nc-chan-label placeholder">Pilih channel…</span>`;
    el.innerHTML = `
      <div class="nc-dropdown-trigger ${open ? 'open' : ''}" data-nc-trigger tabindex="0">
        ${label}
        <svg class="icon icon-14 nc-caret"><use href="#ic-chevron-down"></use></svg>
      </div>
    `;
    el.querySelector('[data-nc-trigger]').addEventListener('click', (e) => {
      e.stopPropagation();
      if (open) { closePanel(); return; }
      openPanel();
    });
  }

  renderTrigger();
  return instance;
}
// Tutup dropdown manapun yang lagi terbuka kalau klik di luar area dropdown —
// dipasang sekali di level document (bukan per-instance) supaya tidak numpuk.
// Klik DI DALAM panel (sekarang ada di portal <body>, bukan lagi di dalam
// trigger) sengaja tidak dihitung "di luar" karena listener item/search di
// atas sudah stopPropagation() masing-masing.
if (!window._ncOutsideClickWired) {
  window._ncOutsideClickWired = true;
  document.addEventListener('click', (e) => {
    if (_ncOpenDropdown && !ncPortalEl().contains(e.target)) _ncOpenDropdown.close();
  });
}

function ncCardHtml(row) {
  const statusClass = row.status === 'valid' ? 'valid' : row.status === 'invalid' ? 'invalid' : 'unknown';
  const statusLabel = NC_STATUS_LABEL[row.status] || NC_STATUS_LABEL.unknown;
  return `
    <div class="nc-card" data-category="${escapeHtml(row.key)}">
      <div class="nc-card-head">
        <div class="nc-card-title">
          ${row.icon || '<svg class="icon icon-16"><use href="#ic-bell"></use></svg>'} ${escapeHtml(row.label)}
          ${row.optional ? '<span class="nc-optional-tag">Opsional</span>' : ''}
        </div>
        <span class="nc-status ${statusClass}" data-nc-status title="${row.lastError ? escapeHtml(row.lastError) : ''}">${statusLabel}</span>
      </div>
      <div class="nc-card-desc">${escapeHtml(row.description || '')}</div>
      <div>
        <div class="nc-field-label">Channel</div>
        <div class="nc-dropdown" data-nc-channel-dropdown></div>
      </div>
      <div class="nc-card-foot">
        <label class="nc-toggle">
          <input type="checkbox" data-nc-enabled ${row.enabled ? 'checked' : ''}>
          Aktif
        </label>
        <button class="nc-save-btn" data-nc-save><svg class="icon icon-16"><use href="#ic-save"></use></svg> Save</button>
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
      statusEl.innerHTML = `<svg class="icon icon-16"><use href="#ic-circle-check-big"></use></svg> Tersimpan — Auto Remove ${enabled ? 'AKTIF' : 'NONAKTIF'}, berlaku ${delay === 'immediate' ? 'langsung' : delay === '1h' ? 'setelah 1 jam' : 'setelah 24 jam'}.`;
      showToast('Pengaturan Auto Remove berhasil disimpan.', 'success');
    } catch (e) {
      statusEl.innerHTML = '<svg class="icon icon-16"><use href="#ic-triangle-alert"></use></svg> Gagal menyimpan: ' + e.message;
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
    if (!confirm(`Hapus MANUAL seluruh game & bypass milik Discord ID ${discordId}? Berlaku untuk role apapun (Gratis/Gold/Platinum).`)) return;
    const btn = document.getElementById('btnManualCleanup');
    btn.disabled = true;
    statusEl.textContent = 'Memproses...';
    try {
      const result = await api(`/api/admin/users/${encodeURIComponent(discordId)}/premium-cleanup`, { method: 'POST' });
      statusEl.textContent = result.scheduled
        ? `<svg class="icon icon-16"><use href="#ic-circle-check-big"></use></svg> Dijadwalkan: ${result.gameCount} game & ${result.bypassCount} bypass akan dihapus.`
        : `<svg class="icon icon-16"><use href="#ic-info"></use></svg> ${result.message || 'Tidak ada game/bypass yang terpasang untuk user ini.'}`;
      showToast(statusEl.textContent, result.scheduled ? 'success' : 'info');
    } catch (e) {
      statusEl.innerHTML = '<svg class="icon icon-16"><use href="#ic-triangle-alert"></use></svg> Gagal: ' + e.message;
      showToast('Gagal memicu hapus manual: ' + e.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });
}

// ══════════════════════════════════════════════════════════════════════════
// KELOLA VOUCHER — Voucher Paket Gold/Platinum (lihat voucherManager.js di server)
// ══════════════════════════════════════════════════════════════════════════
let _voucherWired = false;
let _voucherList = [];
const VOUCHER_UNIT_LABEL = { minutes: 'Menit', hours: 'Jam', days: 'Hari' };
const VOUCHER_STATUS_LABEL = { active: 'Aktif', inactive: 'Nonaktif', expired: 'Kedaluwarsa', full: 'Kuota Habis' };
const VOUCHER_STATUS_CLASS = { active: 'success', inactive: 'info', expired: 'error', full: 'warning' };

async function renderVoucherPage() {
  wireVoucherPageOnce();
  await loadVoucherList();
}

function wireVoucherPageOnce() {
  if (_voucherWired) return;
  _voucherWired = true;

  document.getElementById('btnAddVoucher').addEventListener('click', () => openVoucherModal(null));
  document.getElementById('btnSaveVoucher').addEventListener('click', doSaveVoucher);

  const roleSegmentEl = document.getElementById('voucherRoleSegment');
  const roleHiddenEl = document.getElementById('voucherRole');
  roleSegmentEl.querySelectorAll('.segmented-opt').forEach(btn => {
    btn.addEventListener('click', () => setSegmentValue(roleSegmentEl, roleHiddenEl, 'role', btn.dataset.role));
  });

  document.getElementById('tableVoucher').addEventListener('click', handleVoucherTableClick);
  document.getElementById('tableVoucher').addEventListener('change', handleVoucherTableChange);
}

async function loadVoucherList() {
  const table = document.getElementById('tableVoucher');
  table.innerHTML = `<tbody><tr><td style="padding:20px;text-align:center;color:var(--text-3);"><svg class="icon icon-18"><use href="#ic-loader-circle"></use></svg> Memuat voucher...</td></tr></tbody>`;
  try {
    const data = await api('/api/admin/vouchers');
    _voucherList = data.vouchers || [];
    renderVoucherTable(_voucherList);
  } catch (e) {
    table.innerHTML = `<tbody><tr><td style="padding:20px;text-align:center;color:var(--red);">Gagal memuat voucher: ${escapeHtml(e.message)}</td></tr></tbody>`;
  }
}

function renderVoucherTable(list) {
  const table = document.getElementById('tableVoucher');
  if (!list.length) {
    table.innerHTML = `<tbody><tr><td style="padding:24px;text-align:center;color:var(--text-3);"><svg class="icon icon-18"><use href="#ic-ticket"></use></svg> Belum ada voucher. Klik "+ Buat Voucher" untuk membuat yang pertama.</td></tr></tbody>`;
    return;
  }
  table.innerHTML = `
    <thead>
      <tr>
        <th>Kode</th>
        <th>Paket</th>
        <th>Durasi</th>
        <th>Kuota</th>
        <th>Masa Berlaku</th>
        <th>Status</th>
        <th>Dibuat</th>
        <th style="text-align:right;">Aksi</th>
      </tr>
    </thead>
    <tbody>
      ${list.map(voucherRowHtml).join('')}
    </tbody>`;
}

function voucherRowHtml(v) {
  const durationLabel = `${v.durationAmount} ${VOUCHER_UNIT_LABEL[v.durationUnit] || v.durationUnit}`;
  const expiryLabel = v.expiresAt ? fmtDateShort(v.expiresAt) : 'Tidak ada batas';
  const statusClass = VOUCHER_STATUS_CLASS[v.status] || 'info';
  const statusLabel = VOUCHER_STATUS_LABEL[v.status] || v.status;
  return `
    <tr data-id="${v.id}">
      <td><code style="font-weight:700;letter-spacing:.03em;">${escapeHtml(v.code)}</code></td>
      <td>${roleTagHtml(v.role)}</td>
      <td>${escapeHtml(durationLabel)}</td>
      <td>${v.usedCount} / ${v.quota} <span style="color:var(--text-3);">(sisa ${v.remaining})</span></td>
      <td>${escapeHtml(expiryLabel)}</td>
      <td><span class="log-badge log-badge--${statusClass}">${escapeHtml(statusLabel)}</span></td>
      <td>${v.createdAt ? timeAgo(v.createdAt) : '—'}${v.createdBy ? ` <span style="color:var(--text-3);">oleh ${escapeHtml(v.createdBy)}</span>` : ''}</td>
      <td style="text-align:right;white-space:nowrap;">
        <label class="switch" title="Aktif / Nonaktif" style="vertical-align:middle;margin-right:8px;">
          <input type="checkbox" data-voucher-toggle="${v.id}" ${v.active ? 'checked' : ''}>
          <span class="switch-slider"></span>
        </label>
        <button class="btn-icon-sm" title="Edit" data-voucher-edit="${v.id}"><svg class="icon icon-18"><use href="#ic-pencil"></use></svg></button>
        <button class="btn-icon-sm" title="Hapus" data-voucher-delete="${v.id}"><svg class="icon icon-18"><use href="#ic-trash-2"></use></svg></button>
      </td>
    </tr>`;
}

function handleVoucherTableClick(e) {
  const editBtn = e.target.closest('[data-voucher-edit]');
  const delBtn = e.target.closest('[data-voucher-delete]');
  if (editBtn) {
    const v = _voucherList.find(x => x.id === editBtn.dataset.voucherEdit);
    if (v) openVoucherModal(v);
  } else if (delBtn) {
    doDeleteVoucher(delBtn.dataset.voucherDelete);
  }
}

function handleVoucherTableChange(e) {
  const toggleEl = e.target.closest('[data-voucher-toggle]');
  if (toggleEl) doToggleVoucher(toggleEl.dataset.voucherToggle, toggleEl.checked, toggleEl);
}

function openVoucherModal(v) {
  document.getElementById('voucherModalTitle').textContent = v ? 'Edit Voucher' : 'Buat Voucher';
  document.getElementById('voucherId').value = v ? v.id : '';
  document.getElementById('voucherCode').value = v ? v.code : '';
  document.getElementById('voucherCode').disabled = false;
  document.getElementById('voucherDurationAmount').value = v ? v.durationAmount : '';
  document.getElementById('voucherDurationUnit').value = v ? v.durationUnit : 'days';
  document.getElementById('voucherQuota').value = v ? v.quota : '';
  document.getElementById('voucherExpiresAt').value = v && v.expiresAt ? toDatetimeLocalValue(v.expiresAt) : '';
  document.getElementById('voucherActive').checked = v ? v.active : true;

  const roleSegmentEl = document.getElementById('voucherRoleSegment');
  const roleHiddenEl = document.getElementById('voucherRole');
  setSegmentValue(roleSegmentEl, roleHiddenEl, 'role', v ? v.role : 'gold');

  document.getElementById('voucherModalBackdrop').style.display = 'flex';
}
function closeVoucherModal() { document.getElementById('voucherModalBackdrop').style.display = 'none'; }

function toDatetimeLocalValue(dateStr) {
  const d = new Date(dateStr);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function doSaveVoucher() {
  const id = document.getElementById('voucherId').value;
  const code = document.getElementById('voucherCode').value.trim();
  const role = document.getElementById('voucherRole').value;
  const durationAmount = document.getElementById('voucherDurationAmount').value;
  const durationUnit = document.getElementById('voucherDurationUnit').value;
  const quota = document.getElementById('voucherQuota').value;
  const expiresAtLocal = document.getElementById('voucherExpiresAt').value;
  const active = document.getElementById('voucherActive').checked;

  if (!code) { showToast('Kode voucher wajib diisi.', 'error'); return; }
  if (!durationAmount || Number(durationAmount) <= 0) { showToast('Durasi paket harus lebih dari 0.', 'error'); return; }
  if (!quota || Number(quota) <= 0) { showToast('Jumlah kuota voucher harus lebih dari 0.', 'error'); return; }

  const body = {
    code, role,
    durationAmount: Number(durationAmount),
    durationUnit,
    quota: Number(quota),
    expiresAt: expiresAtLocal ? new Date(expiresAtLocal).toISOString() : null,
    active
  };

  const btn = document.getElementById('btnSaveVoucher');
  const original = btn.textContent;
  btn.disabled = true; btn.textContent = 'Menyimpan...';
  try {
    if (id) {
      await api(`/api/admin/vouchers/${id}`, { method: 'PUT', body: JSON.stringify(body) });
      showToast('Voucher berhasil diperbarui.', 'success');
    } else {
      await api('/api/admin/vouchers', { method: 'POST', body: JSON.stringify(body) });
      showToast('Voucher berhasil dibuat.', 'success');
    }
    closeVoucherModal();
    await loadVoucherList();
  } catch (e) {
    showToast('Gagal menyimpan voucher: ' + e.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = original;
  }
}

async function doToggleVoucher(id, checked, checkboxEl) {
  try {
    await api(`/api/admin/vouchers/${id}/toggle`, { method: 'PUT', body: JSON.stringify({ active: checked }) });
    const v = _voucherList.find(x => x.id === id);
    if (v) { v.active = checked; v.status = checked ? (v.isExpired ? 'expired' : v.isFull ? 'full' : 'active') : 'inactive'; }
    renderVoucherTable(_voucherList);
    showToast(`Voucher ${checked ? 'diaktifkan' : 'dinonaktifkan'}.`, 'success');
  } catch (e) {
    if (checkboxEl) checkboxEl.checked = !checked;
    showToast('Gagal mengubah status: ' + e.message, 'error');
  }
}

async function doDeleteVoucher(id) {
  const v = _voucherList.find(x => x.id === id);
  if (!confirm(`Hapus voucher "${v?.code || id}"? Riwayat klaim voucher ini juga akan ikut terhapus. Tindakan ini tidak bisa dibatalkan.`)) return;
  try {
    await api(`/api/admin/vouchers/${id}`, { method: 'DELETE' });
    showToast('Voucher berhasil dihapus.', 'success');
    await loadVoucherList();
  } catch (e) {
    showToast('Gagal menghapus voucher: ' + e.message, 'error');
  }
}

// Urutan section tetap (bukan ikut urutan kemunculan di data) supaya panel
// selalu tampil konsisten tiap reload: User, Game, Bypass, Paket,
// Steam Account, Request Game, Update, Admin Activity, Security.
const NC_GROUP_ORDER = ['user', 'game', 'bypass', 'paket', 'steam_account', 'request_game', 'update', 'admin', 'security'];

function ncGroupSectionHtml(groupKey, groupLabel, groupIcon, rows) {
  return `
    <div class="nc-group" data-group="${escapeHtml(groupKey)}">
      <div class="nc-group-title">${groupIcon || ''} ${escapeHtml(groupLabel)}</div>
      <div class="nc-grid">${rows.map(ncCardHtml).join('')}</div>
    </div>
  `;
}

async function ncLoadBotStatus() {
  const el = document.getElementById('ncBotStatus');
  if (!el) return;
  try {
    const s = await api('/api/admin/discord/bot-status');
    if (s.connected) {
      el.className = 'nc-bot-status connected';
      el.innerHTML = '<span class="nc-dot"></span> Connected';
    } else {
      el.className = 'nc-bot-status disconnected';
      el.innerHTML = `<span class="nc-dot"></span> ${s.reason === 'not_configured' ? 'Bot belum dikonfigurasi' : 'Disconnected'}`;
    }
  } catch (e) {
    el.className = 'nc-bot-status disconnected';
    el.innerHTML = '<span class="nc-dot"></span> Gagal memeriksa status';
  }
}

async function renderWebhookSettings() {
  const container = document.getElementById('ncList');
  container.innerHTML = `<div class="nc-skeleton-grid"><div class="nc-skeleton-card"></div><div class="nc-skeleton-card"></div><div class="nc-skeleton-card"></div></div>`;
  ncLoadBotStatus();
  try {
    const [rows, chResult] = await Promise.all([
      api('/api/admin/notification-channels'),
      api('/api/admin/discord/channels')
    ]);
    _ncCategories = rows;
    _ncChannels = chResult.channels || [];
    _ncChannelsError = chResult.error || null;

    // Kelompokkan per bucket (row.group) — fallback ke satu bucket "Lainnya"
    // kalau suatu saat ada kategori baru yang belum dikasih `group` di server.
    const byGroup = {};
    for (const row of rows) {
      const g = row.group || 'other';
      if (!byGroup[g]) byGroup[g] = [];
      byGroup[g].push(row);
    }
    const orderedKeys = [...NC_GROUP_ORDER, ...Object.keys(byGroup).filter(k => !NC_GROUP_ORDER.includes(k))];
    container.innerHTML = orderedKeys
      .filter(g => byGroup[g]?.length)
      .map(g => {
        const first = byGroup[g][0];
        return ncGroupSectionHtml(g, first.groupLabel || 'Lainnya', first.groupIcon || '', byGroup[g]);
      })
      .join('') || `<div class="empty-cell"><span class="empty-icon"><svg class="icon icon-18"><use href="#ic-inbox"></use></svg></span>Belum ada kategori notifikasi.</div>`;

    // Pasang dropdown channel di tiap card SETELAH innerHTML ditulis (elemen
    // targetnya harus sudah ada di DOM).
    container.querySelectorAll('.nc-card').forEach(card => {
      const category = card.dataset.category;
      const row = rows.find(r => r.key === category);
      const dropdownEl = card.querySelector('[data-nc-channel-dropdown]');
      card._ncDropdown = ncBuildChannelDropdown(dropdownEl, { selectedId: row?.discordChannelId || null });
    });

    wireNotificationChannelButtons();
    ncWireTestSection();
  } catch (e) {
    container.innerHTML = `<div class="empty-cell"><span class="empty-icon"><svg class="icon icon-18"><use href="#ic-triangle-alert"></use></svg></span>Gagal memuat pengaturan notifikasi: ${escapeHtml(e.message)}</div>`;
  }
}

let _ncButtonsWired = false;
function wireNotificationChannelButtons() {
  if (_ncButtonsWired) return; // event delegation di container — cukup dipasang sekali, gak numpuk tiap render ulang
  _ncButtonsWired = true;
  const container = document.getElementById('ncList');

  container.addEventListener('click', async (e) => {
    const saveBtn = e.target.closest('[data-nc-save]');
    if (!saveBtn) return;
    const card = saveBtn.closest('.nc-card');
    const category = card.dataset.category;
    const enabledInput = card.querySelector('[data-nc-enabled]');
    const statusEl = card.querySelector('[data-nc-status]');
    const channelId = card._ncDropdown ? card._ncDropdown.getSelected() : null;

    const originalHtml = saveBtn.innerHTML;
    saveBtn.disabled = true;
    saveBtn.innerHTML = '<svg class="icon icon-16"><use href="#ic-loader-circle"></use></svg> Menyimpan...';
    try {
      const updated = await api(`/api/admin/notification-channels/${encodeURIComponent(category)}`, {
        method: 'PUT',
        body: JSON.stringify({ discordChannelId: channelId, enabled: enabledInput.checked })
      });
      const cls = updated.status === 'valid' ? 'valid' : updated.status === 'invalid' ? 'invalid' : 'unknown';
      statusEl.className = `nc-status ${cls}`;
      statusEl.innerHTML = NC_STATUS_LABEL[updated.status] || NC_STATUS_LABEL.unknown;
      statusEl.title = updated.lastError || '';
      saveBtn.innerHTML = '<svg class="icon icon-16"><use href="#ic-circle-check-big"></use></svg> Saved';
      saveBtn.classList.add('saved');
      showToast(`Channel notifikasi "${updated.label}" berhasil disimpan.`, 'success');
      setTimeout(() => { saveBtn.innerHTML = originalHtml; saveBtn.classList.remove('saved'); saveBtn.disabled = false; }, 1200);
    } catch (err) {
      showToast('Gagal menyimpan: ' + err.message, 'error');
      saveBtn.innerHTML = originalHtml;
      saveBtn.disabled = false;
    }
  });
}

// ─── Test Notification (kartu terpisah di bawah daftar kategori) ───
let _ncTestWired = false;
let _ncTestChannelDropdown = null;
function ncWireTestSection() {
  const notifEl = document.getElementById('ncTestNotifDropdown');
  const chanEl = document.getElementById('ncTestChannelDropdown');
  if (!notifEl || !chanEl) return;

  notifEl.innerHTML = `<select class="form-input" id="ncTestNotifSelect" style="margin:0;">${_ncCategories.map(c => `<option value="${escapeHtml(c.key)}">${escapeHtml(c.label)}</option>`).join('')}</select>`;
  _ncTestChannelDropdown = ncBuildChannelDropdown(chanEl, { selectedId: null });

  if (_ncTestWired) return; // listener tombol cukup dipasang sekali
  _ncTestWired = true;
  document.getElementById('btnNcSendTest')?.addEventListener('click', async () => {
    const category = document.getElementById('ncTestNotifSelect').value;
    const channelId = _ncTestChannelDropdown.getSelected();
    const resultEl = document.getElementById('ncTestResult');
    if (!channelId) { showToast('Pilih channel dulu sebelum mengirim test.', 'error'); return; }
    const btn = document.getElementById('btnNcSendTest');
    const originalHtml = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<svg class="icon icon-16"><use href="#ic-loader-circle"></use></svg> Mengirim...';
    try {
      await api(`/api/admin/notification-channels/${encodeURIComponent(category)}/test`, {
        method: 'POST',
        body: JSON.stringify({ discordChannelId: channelId })
      });
      resultEl.className = 'nc-test-result show success';
      resultEl.innerHTML = '<svg class="icon icon-16"><use href="#ic-circle-check-big"></use></svg> Notification berhasil dikirim';
      showToast('Test notification terkirim, cek channel Discord kamu.', 'success');
    } catch (err) {
      resultEl.className = 'nc-test-result show error';
      resultEl.innerHTML = `<svg class="icon icon-16"><use href="#ic-triangle-alert"></use></svg> ${escapeHtml(err.message || 'Bot tidak memiliki permission')}`;
      showToast('Gagal kirim test: ' + err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = originalHtml;
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

const DM_STATUS_LABEL = { bound: '<svg class="icon icon-16 icon-success"><use href="#ic-circle"></use></svg> Terikat', unbound: '<svg class="icon icon-16 icon-muted"><use href="#ic-circle"></use></svg> Belum Terikat', pending_change: '<svg class="icon icon-16 icon-warning"><use href="#ic-circle"></use></svg> Menunggu Ganti Device' };
const DM_LOG_ICON = {
  device_registered: '<svg class="icon icon-16"><use href="#ic-sparkles"></use></svg>', login_rejected: '<svg class="icon icon-16"><use href="#ic-ban"></use></svg>', minor_change_tolerated: '<svg class="icon icon-16"><use href="#ic-wrench"></use></svg>',
  device_reset: '<svg class="icon icon-16"><use href="#ic-recycle"></use></svg>', device_change_allowed: '<svg class="icon icon-16"><use href="#ic-lock-open"></use></svg>', device_change_used: '<svg class="icon icon-16"><use href="#ic-refresh-cw"></use></svg>'
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

  el.innerHTML = `<div class="empty-cell"><span class="empty-icon"><svg class="icon icon-18"><use href="#ic-loader-circle"></use></svg></span>Memuat info perangkat...</div>`;
  try {
    const res = await api(`/api/admin/users/${encodeURIComponent(discordId)}/device`);
    _dmCurrentDevice = res.device;
    el.innerHTML = _dmCardHtml(res.status, res.device);
  } catch (e) {
    el.innerHTML = `<div class="dm-empty"><svg class="icon icon-18"><use href="#ic-triangle-alert"></use></svg> Gagal memuat info perangkat: ${escapeHtml(e.message)}</div>`;
  }
}

function _dmCardHtml(status, device) {
  const badge = `<span class="dm-status-badge ${status}">${DM_STATUS_LABEL[status] || status}</span>`;

  if (status === 'unbound' || !device) {
    return `
      <div class="dm-card">
        <div class="dm-card-head">
          <div class="dm-pc-name"><svg class="icon icon-18"><use href="#ic-lock"></use></svg> Belum ada perangkat terikat</div>
          ${badge}
        </div>
        <div class="dm-empty">User ini belum pernah login, jadi belum ada perangkat yang terdaftar. Perangkat pertama yang dipakai login akan otomatis terikat ke akun ini.</div>
      </div>`;
  }

  const info = device.info || {};
  return `
    <div class="dm-card">
      <div class="dm-card-head">
        <div class="dm-pc-name"><svg class="icon icon-18"><use href="#ic-monitor"></use></svg> ${escapeHtml(info.pcName || 'Tidak diketahui')}</div>
        ${badge}
      </div>
      <div class="dm-fingerprint-row">
        <span class="dm-fingerprint">ID: ${escapeHtml((device.fingerprint || '').slice(0, 24))}...</span>
        <button class="dm-copy-btn" onclick="doCopyDeviceId()"><svg class="icon icon-18"><use href="#ic-clipboard-list"></use></svg> Salin</button>
      </div>
      <div class="dm-spec-grid">
        <div class="dm-spec-item"><span class="l"><svg class="icon icon-18"><use href="#ic-brain"></use></svg> CPU</span><span class="v">${escapeHtml(info.cpuName || '—')}</span></div>
        <div class="dm-spec-item"><span class="l"><svg class="icon icon-18"><use href="#ic-save"></use></svg> RAM</span><span class="v">${fmtBytes(info.ramTotalBytes)}</span></div>
        <div class="dm-spec-item"><span class="l"><svg class="icon icon-18"><use href="#ic-gamepad-2"></use></svg> GPU</span><span class="v">${escapeHtml(info.gpuName || '—')}</span></div>
        <div class="dm-spec-item"><span class="l"><svg class="icon icon-18"><use href="#ic-app-window"></use></svg> OS</span><span class="v">${escapeHtml(info.osName || '—')}</span></div>
        <div class="dm-spec-item"><span class="l"><svg class="icon icon-18"><use href="#ic-calendar"></use></svg> Didaftarkan</span><span class="v">${device.registeredAt ? fmtDateShort(device.registeredAt) : '—'}</span></div>
        <div class="dm-spec-item"><span class="l"><svg class="icon icon-18"><use href="#ic-key-round"></use></svg> Login Terakhir</span><span class="v">${device.lastLoginAt ? timeAgo(device.lastLoginAt) : '—'}</span></div>
      </div>
      <div class="dm-actions">
        <button class="btn btn-sm btn-outline" onclick="doShowDeviceSpecs()"><svg class="icon icon-18"><use href="#ic-search"></use></svg> Detail Spesifikasi</button>
        <button class="btn btn-sm btn-outline" onclick="doShowDeviceHistory()"><svg class="icon icon-18"><use href="#ic-clock"></use></svg> Riwayat</button>
        <button class="btn btn-sm btn-outline" style="border-color:#ffd76a;color:#ffd76a;" onclick="openDmConfirmModal('change')"><svg class="icon icon-18"><use href="#ic-lock-open"></use></svg> Ganti Device</button>
        <button class="btn btn-sm btn-outline" style="border-color:var(--red);color:var(--red);" onclick="openDmConfirmModal('reset')"><svg class="icon icon-18"><use href="#ic-recycle"></use></svg> Reset Device</button>
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
    ['<svg class="icon icon-16"><use href="#ic-monitor"></use></svg> Nama PC', info.pcName], ['<svg class="icon icon-16"><use href="#ic-user"></use></svg> Username Windows', info.windowsUsername],
    ['<svg class="icon icon-16"><use href="#ic-app-window"></use></svg> Sistem Operasi', info.osName], ['<svg class="icon icon-16"><use href="#ic-hash"></use></svg> Versi Windows', info.osVersion],
    ['<svg class="icon icon-16"><use href="#ic-construction"></use></svg> Build Windows', info.osBuild], ['<svg class="icon icon-16"><use href="#ic-settings"></use></svg> Arsitektur', info.arch],
    ['<svg class="icon icon-16"><use href="#ic-brain"></use></svg> CPU', info.cpuName], ['<svg class="icon icon-16"><use href="#ic-cpu"></use></svg> Core / Thread', (info.cpuCores && info.cpuThreads) ? `${info.cpuCores} core / ${info.cpuThreads} thread` : null],
    ['<svg class="icon icon-16"><use href="#ic-save"></use></svg> RAM Total', fmtBytes(info.ramTotalBytes)], ['<svg class="icon icon-16"><use href="#ic-gamepad-2"></use></svg> GPU', info.gpuName],
    ['<svg class="icon icon-16"><use href="#ic-wrench"></use></svg> Motherboard', [info.boardVendor, info.boardModel].filter(Boolean).join(' ') || null],
    ['<svg class="icon icon-16"><use href="#ic-hard-drive"></use></svg> Disk Utama', info.diskModel], ['<svg class="icon icon-16"><use href="#ic-package"></use></svg> Kapasitas Disk', fmtBytes(info.diskSizeBytes)],
    ['<svg class="icon icon-16"><use href="#ic-rocket"></use></svg> Versi App', info.appVersion],
  ].filter(([, v]) => v !== null && v !== undefined && v !== '');

  const body = `
    <div class="dm-spec-grid" style="grid-template-columns:1fr 1fr;">
      ${rows.map(([label, value]) => `
        <div class="dm-spec-item"><span class="l">${label}</span><span class="v">${escapeHtml(String(value))}</span></div>
      `).join('')}
    </div>`;
  openDmSubModal('<svg class="icon icon-16"><use href="#ic-search"></use></svg> Detail Spesifikasi Perangkat', body || '<div class="dm-empty">Tidak ada data spesifikasi.</div>');
}
window.doShowDeviceSpecs = doShowDeviceSpecs;

async function doShowDeviceHistory() {
  openDmSubModal('<svg class="icon icon-16"><use href="#ic-clock"></use></svg> Riwayat Perangkat', `<div class="empty-cell"><span class="empty-icon"><svg class="icon icon-18"><use href="#ic-loader-circle"></use></svg></span>Memuat riwayat...</div>`);
  try {
    const logs = await api(`/api/admin/users/${encodeURIComponent(_dmCurrentDiscordId)}/device/logs`);
    const body = document.getElementById('dmSubModalBody');
    if (!logs.length) { body.innerHTML = `<div class="dm-empty">Belum ada riwayat aktivitas perangkat.</div>`; return; }
    body.innerHTML = logs.map(l => `
      <div class="dm-log-row">
        <div class="dm-log-icon">${DM_LOG_ICON[l.action] || '<svg class="icon icon-16"><use href="#ic-info"></use></svg>'}</div>
        <div class="dm-log-body">
          <div class="dm-log-action">${DM_LOG_LABEL[l.action] || l.action}${l.byAdmin ? ' <span style="color:var(--text-faint);">(oleh Admin)</span>' : ''}</div>
          ${l.detail?.attemptedInfo?.pcName ? `<div class="dm-log-detail">Perangkat: ${escapeHtml(l.detail.attemptedInfo.pcName)}</div>` : ''}
          ${l.detail?.changedComponents ? `<div class="dm-log-detail">Komponen berubah: ${escapeHtml(l.detail.changedComponents.join(', '))}</div>` : ''}
          ${l.adminNote ? `<div class="dm-log-detail"><svg class="icon icon-18"><use href="#ic-file-pen-line"></use></svg> ${escapeHtml(l.adminNote)}</div>` : ''}
          <div class="dm-log-time">${fmtDateShort(l.createdAt)}</div>
        </div>
      </div>
    `).join('');
  } catch (e) {
    const body = document.getElementById('dmSubModalBody');
    if (body) body.innerHTML = `<div class="dm-empty"><svg class="icon icon-18"><use href="#ic-triangle-alert"></use></svg> Gagal memuat riwayat: ${escapeHtml(e.message)}</div>`;
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
  document.getElementById('dmConfirmTitle').innerHTML = isReset ? '<svg class="icon icon-16"><use href="#ic-recycle"></use></svg> Reset Device' : '<svg class="icon icon-16"><use href="#ic-lock-open"></use></svg> Ganti Device';
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
    showToast(_dmConfirmAction === 'reset' ? 'Device berhasil direset.' : 'Pergantian device diizinkan.', 'success');
    closeDmConfirmModal();
    _renderDeviceSection(_dmCurrentDiscordId);
  } catch (e) {
    showToast('Gagal: ' + e.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = 'Konfirmasi';
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
    { key: 'published', label: '<svg class="icon icon-16"><use href="#ic-circle-check-big"></use></svg> Published', count: counts.published },
    { key: 'draft', label: '<svg class="icon icon-16"><use href="#ic-file-pen-line"></use></svg> Draft', count: counts.draft }
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
        <div style="font-size:32px;margin-bottom:8px;"><svg class="icon icon-18"><use href="#ic-book-open"></use></svg></div>
        <div style="font-size:13px;">Belum ada tutorial. Klik "Tambah Tutorial" untuk membuat yang pertama.</div>
      </div>`;
    return;
  }
  if (!rows.length) {
    wrap.innerHTML = `
      <div style="padding:40px 20px;text-align:center;color:var(--text-faint);">
        <div style="font-size:32px;margin-bottom:8px;"><svg class="icon icon-18"><use href="#ic-search"></use></svg></div>
        <div style="font-size:13px;">Tidak ada tutorial yang cocok dengan pencarian/filter.</div>
      </div>`;
    return;
  }

  wrap.innerHTML = rows.map((t) => {
    const thumb = t.thumbnailData || t.thumbnailUrl;
    const thumbHtml = thumb
      ? `<div class="banner-thumb" style="background-image:url('${escapeHtml(thumb)}');"></div>`
      : `<div class="banner-thumb" style="background:linear-gradient(135deg,#4facfe,#7c5cff);"><span style="font-size:20px;"><svg class="icon icon-18"><use href="#ic-book-open"></use></svg></span></div>`;

    return `
    <div class="banner-admin-item" data-id="${t._id}" style="display:flex;align-items:center;gap:12px;padding:14px 16px;border-bottom:1px solid var(--border);">
      ${thumbHtml}
      <div style="flex:1;min-width:0;">
        <div style="font-weight:700;font-size:13.5px;color:var(--text-main);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(t.title)}</div>
        <div style="font-size:11.5px;color:var(--text-faint);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(t.description || '—')}</div>
        <div style="margin-top:4px;display:flex;gap:6px;flex-wrap:wrap;">
          <span class="tag public" style="font-size:10px;"><svg class="icon icon-18"><use href="#ic-tag"></use></svg> ${escapeHtml(t.category || 'Umum')}</span>
          <span class="tag ${t.status}" style="font-size:10px;">${t.status === 'published' ? '<svg class="icon icon-16"><use href="#ic-circle-check-big"></use></svg> Published' : '<svg class="icon icon-16"><use href="#ic-file-pen-line"></use></svg> Draft'}</span>
          ${t.videoPlatform === 'tiktok' ? `<span class="tag public" style="font-size:10px;"><svg class="icon icon-16"><use href="#ic-music"></use></svg> TikTok</span>` : ''}
          ${(t.videoPlatform === 'youtube' || (!t.videoPlatform && t.youtubeId)) ? `<span class="tag public" style="font-size:10px;"><svg class="icon icon-18"><use href="#ic-play"></use></svg> YouTube</span>` : ''}
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:8px;flex-shrink:0;">
        <label class="switch" title="Publish/Draft">
          <input type="checkbox" ${t.status === 'published' ? 'checked' : ''} onchange="toggleTutorialStatus('${t._id}', this.checked)">
          <span class="switch-slider"></span>
        </label>
        <button class="btn btn-secondary btn-sm" onclick="openTutorialModal('${t._id}')"><svg class="icon icon-18"><use href="#ic-pencil"></use></svg> Edit</button>
        <button class="btn btn-danger btn-sm" onclick="deleteTutorial('${t._id}')"><svg class="icon icon-18"><use href="#ic-trash-2"></use></svg></button>
      </div>
    </div>`;
  }).join('');
}

async function toggleTutorialStatus(id, isPublished) {
  const status = isPublished ? 'published' : 'draft';
  try {
    await api(`/api/admin/tutorials/${id}/status`, { method: 'PUT', body: JSON.stringify({ status }) });
    showToast(isPublished ? 'Tutorial dipublish.' : 'Tutorial dijadikan draft.', 'success');
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
    showToast('Tutorial dihapus.', 'success');
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
    showToast('Tutorial berhasil disimpan.', 'success');
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
const LB_ADMIN_ROLE_LABEL = { public: 'Gratis', gold: 'Gold', platinum: 'Platinum', admin: 'Admin' };

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
        <div style="font-size:32px;margin-bottom:8px;"><svg class="icon icon-18"><use href="#ic-trophy"></use></svg></div>
        <div style="font-size:13px;">Belum ada install minggu ini.</div>
      </div>`;
    return;
  }
  const medal = { 1: '<svg class="icon icon-16"><use href="#ic-trophy"></use></svg>', 2: '<svg class="icon icon-16"><use href="#ic-medal"></use></svg>', 3: '<svg class="icon icon-16"><use href="#ic-medal"></use></svg>' };
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
      <div style="font-weight:800;font-size:13.5px;color:var(--text-main);min-width:70px;text-align:right;"><svg class="icon icon-18"><use href="#ic-flame"></use></svg> ${u.installs}</div>
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
              ? `<td>${escapeHtml(r.entries[i].username)} <span style="color:var(--text-faint);">(<svg class="icon icon-16"><use href="#ic-flame"></use></svg>${r.entries[i].installs})</span></td>`
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
// LIBRARY GAME (HubCap) — halaman BARU, kode terpisah total dari halaman
// "Request Game" (approve/reject) di atas maupun fitur Request Game milik App.
// Cuma menampilkan APA ADANYA seluruh katalog HubCap (GET /api/admin/library-
// game, yang di backend juga cuma proxy tipis ke endpoint gratis HubCap
// /api/v1/library — TANPA enrich Steam sama sekali), 100 game/halaman, 5
// kolom per baris, server-side pagination (Total Halaman/Total Data dari
// `total_count` asli HubCap).
// ══════════════════════════════════════════════════════════════════════════
const LG_PER_PAGE = 100;
const _lgState = { page: 1, search: '', totalData: 0 };
let _lgSearchDebounce = null;
let _lgReqSeq = 0; // guard: abaikan response yang basi/telat kalau user ganti halaman/search dgn cepat
let _lgWired = false;

// Dipanggil dari onerror <img> di kartu Library Game — coba kandidat URL
// gambar BERIKUTNYA (lihat data-candidates), dan kalau semua kandidat sudah
// habis dicoba & tetap gagal, baru ganti jadi ikon placeholder.
function lgImageFallback(img) {
  let candidates = [];
  try { candidates = JSON.parse(img.dataset.candidates || '[]'); } catch (e) { candidates = []; }
  const nextIdx = (parseInt(img.dataset.idx, 10) || 0) + 1;
  if (nextIdx < candidates.length) {
    img.dataset.idx = String(nextIdx);
    img.src = candidates[nextIdx];
  } else {
    img.parentElement.innerHTML = '<span class="item-card__cover-fallback"><svg class="icon icon-16"><use href="#ic-gamepad-2"></use></svg></span>';
  }
}

function wireLibraryGameOnce() {
  if (_lgWired) return;
  _lgWired = true;
  const input = document.getElementById('lgSearchInput');
  input?.addEventListener('input', () => {
    clearTimeout(_lgSearchDebounce);
    _lgSearchDebounce = setTimeout(() => {
      _lgState.search = input.value.trim();
      _lgState.page = 1;
      loadLibraryGamePage();
    }, 400);
  });
}

function renderLibraryGamePage() {
  wireLibraryGameOnce();
  loadLibraryGamePage();
}

function lgSkeletonCards(n = LG_PER_PAGE) {
  return Array.from({ length: n }).map(() => `
    <div class="lg-skeleton">
      <div class="lg-skeleton-cover"></div>
      <div class="lg-skeleton-line"></div>
      <div class="lg-skeleton-line lg-skeleton-line--short"></div>
    </div>`).join('');
}

async function loadLibraryGamePage() {
  const seq = ++_lgReqSeq;
  const grid = document.getElementById('lgGrid');
  const pagWrap = document.getElementById('lgPagination');
  const badge = document.getElementById('lgTotalBadge');

  grid.innerHTML = lgSkeletonCards();
  pagWrap.style.display = 'none';
  badge.innerHTML = '<svg class="icon icon-18"><use href="#ic-loader-circle"></use></svg> Memuat...';

  try {
    const params = new URLSearchParams({ page: _lgState.page, limit: LG_PER_PAGE });
    if (_lgState.search) params.set('search', _lgState.search);
    const data = await api(`/api/admin/library-game?${params.toString()}`);
    if (seq !== _lgReqSeq) return; // sudah ada request baru yang lebih baru — buang hasil ini

    _lgState.totalData = data.pagination?.totalData || 0;
    badge.innerHTML = `<svg class="icon icon-18"><use href="#ic-layout-grid"></use></svg> Total ${_lgState.totalData.toLocaleString('id-ID')} Game`;

    const items = data.items || [];
    if (!items.length) {
      grid.innerHTML = `<div class="item-grid-empty"><span class="empty-icon"><svg class="icon icon-18"><use href="#ic-search"></use></svg></span>Tidak ada game yang cocok ditemukan.</div>`;
    } else {
      grid.innerHTML = items.map(item => {
        // Coba tiap kandidat URL gambar SATU PER SATU (data-idx disimpan di elemen
        // <img> itu sendiri) — baru kalau SEMUA kandidat gagal dimuat, tampilkan
        // ikon placeholder. Ini yang bikin game yang gambarnya tidak ada di path
        // Steam CDN "tebakan" pertama tetap bisa kelihatan gambarnya (baik dari
        // URL yang HubCap sediakan sendiri, maupun varian CDN Steam lainnya).
        const candidates = (item.images && item.images.length ? item.images : [item.headerImage]).filter(Boolean);
        const candidatesJson = escapeHtml(JSON.stringify(candidates));
        return `
        <div class="item-card lg-card">
          <div class="item-card__cover">
            <img src="${escapeHtml(candidates[0] || '')}" alt="${escapeHtml(item.name)}" loading="lazy" decoding="async"
              data-candidates='${candidatesJson}' data-idx="0"
              onerror="lgImageFallback(this)">
          </div>
          <div class="item-card__body">
            <div class="item-card__name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</div>
            <div class="item-card__meta">
              <span class="item-card__meta-chip lg-card__appid">ID: ${escapeHtml(item.appId)}</span>
              ${item.sizeLabel ? `<span class="item-card__meta-chip">${escapeHtml(item.sizeLabel)}</span>` : ''}
              ${item.updatedAt ? `<span class="item-card__meta-chip item-card__meta-chip--time">${timeAgo(item.updatedAt)}</span>` : ''}
            </div>
          </div>
        </div>`;
      }).join('');
    }

    renderPagination('lgPagination', _lgState.totalData, _lgState.page, LG_PER_PAGE, (p) => {
      _lgState.page = p;
      loadLibraryGamePage();
      document.querySelector('.main')?.scrollTo({ top: 0, behavior: 'auto' });
    });
  } catch (e) {
    if (seq !== _lgReqSeq) return;
    badge.innerHTML = `<svg class="icon icon-18"><use href="#ic-triangle-alert"></use></svg> Gagal memuat`;
    grid.innerHTML = `<div class="item-grid-empty"><span class="empty-icon"><svg class="icon icon-18"><use href="#ic-triangle-alert"></use></svg></span>${escapeHtml(e.message)}</div>`;
  }
}

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
    container.innerHTML = `<div class="empty-cell"><span class="empty-icon"><svg class="icon icon-18"><use href="#ic-triangle-alert"></use></svg></span>Gagal memuat dokumentasi: ${escapeHtml(e.message)}</div>`;
  }
}

function hcDocCardHtml(ep, idx) {
  const authBadge = ep.auth
    ? `<span class="hc-doc-auth"><svg class="icon icon-18"><use href="#ic-lock"></use></svg> Butuh API Key</span>`
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
        <button class="hc-copy-btn" data-hc-copy="${idx}"><svg class="icon icon-18"><use href="#ic-clipboard-list"></use></svg> Copy Request</button>
        <pre>${escapeHtml(ep.curl)}</pre>
      </div>

      <div class="hc-doc-section-label">Contoh Response</div>
      <div class="hc-code-block response">
        <pre>${respJson}</pre>
      </div>

      <div class="hc-doc-tryrow">
        <button class="btn btn-secondary btn-sm" data-hc-try="${idx}"><svg class="icon icon-18"><use href="#ic-play"></use></svg> Coba Sekarang (Try it)</button>
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
        btn.innerHTML = '<svg class="icon icon-16"><use href="#ic-check"></use></svg> Disalin'; btn.classList.add('copied');
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
    el.innerHTML = '<svg class="icon icon-16"><use href="#ic-triangle-alert"></use></svg> Belum ada API Key';
  } else if (snapshot.allLimited) {
    el.className = 'hc-global-badge error';
    el.innerHTML = '<svg class="icon icon-16"><use href="#ic-siren"></use></svg> Seluruh API Key telah mencapai batas harian';
  } else {
    const cur = snapshot.keys.find(k => k.id === snapshot.currentKeyId);
    el.className = 'hc-global-badge';
    el.innerHTML = `<svg class="icon icon-16 icon-success"><use href="#ic-circle"></use></svg> Dipakai: ${cur ? cur.name : '-'} · ${snapshot.activeCount} key aktif`;
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
    document.getElementById('hcKeysList').innerHTML = `<div class="empty-cell"><span class="empty-icon"><svg class="icon icon-18"><use href="#ic-triangle-alert"></use></svg></span>Gagal memuat API Key: ${escapeHtml(e.message)}</div>`;
  }
}

const HC_STATUS_LABEL = { active: '<svg class="icon icon-16 icon-success"><use href="#ic-circle"></use></svg> Active', limited: '<svg class="icon icon-16 icon-warning"><use href="#ic-circle"></use></svg> Limit', error: '<svg class="icon icon-16 icon-danger"><use href="#ic-circle"></use></svg> Error', inactive: '<svg class="icon icon-16 icon-muted"><use href="#ic-circle"></use></svg> Nonaktif' };

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
      <button class="btn-icon-sm" title="Edit" data-hc-edit="${k.id}"><svg class="icon icon-18"><use href="#ic-pencil"></use></svg></button>
      <button class="btn-icon-sm" title="Hapus" data-hc-delete="${k.id}"><svg class="icon icon-18"><use href="#ic-trash-2"></use></svg></button>
    </div>
  </div>`;
}

function renderHcKeysList(snapshot) {
  const container = document.getElementById('hcKeysList');
  if (!container) return;
  if (!snapshot.keys.length) {
    container.innerHTML = `<div class="empty-cell"><span class="empty-icon"><svg class="icon icon-18"><use href="#ic-key-round"></use></svg></span>Belum ada API Key. Klik "+ Tambah API Key" untuk mulai.</div>`;
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
    document.getElementById('ryKeysList').innerHTML = `<div class="empty-cell"><span class="empty-icon"><svg class="icon icon-18"><use href="#ic-triangle-alert"></use></svg></span>Gagal memuat API Key Ryu: ${escapeHtml(e.message)}</div>`;
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
      <button class="btn-icon-sm" title="Edit" data-ry-edit="${k.id}"><svg class="icon icon-18"><use href="#ic-pencil"></use></svg></button>
      <button class="btn-icon-sm" title="Hapus" data-ry-delete="${k.id}"><svg class="icon icon-18"><use href="#ic-trash-2"></use></svg></button>
    </div>
  </div>`;
}

function renderRyKeysList(snapshot) {
  const container = document.getElementById('ryKeysList');
  if (!container) return;
  if (!snapshot.keys.length) {
    container.innerHTML = `<div class="empty-cell"><span class="empty-icon"><svg class="icon icon-18"><use href="#ic-flame"></use></svg></span>Belum ada API Key Ryu. Klik "+ Tambah API Key" untuk mulai.</div>`;
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
    listEl.innerHTML = `<div class="empty-cell"><span class="empty-icon"><svg class="icon icon-18"><use href="#ic-chart-column"></use></svg></span>Belum ada API Key untuk dipantau.</div>`;
    return;
  }

  const allLimitedNotice = snapshot.allLimited
    ? `<div class="empty-cell"><span class="empty-icon"><svg class="icon icon-18"><use href="#ic-siren"></use></svg></span>Seluruh API Key telah mencapai batas harian. Sistem akan otomatis mencoba lagi setelah cooldown selesai.</div>`
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
    ${k.error ? `<div class="hc-monitor-error"><svg class="icon icon-18"><use href="#ic-triangle-alert"></use></svg> ${escapeHtml(k.error)}</div>` : ''}
  </div>`;
}

// ─── Logs ───
async function loadHcLogs() {
  const tbody = document.getElementById('hcLogsTable');
  if (!tbody) return;
  tbody.innerHTML = `<tr><td colspan="5"><div class="empty-cell"><span class="empty-icon"><svg class="icon icon-18"><use href="#ic-loader-circle"></use></svg></span>Memuat log...</div></td></tr>`;
  try {
    const data = await api('/api/admin/logs?category=hubcap&perPage=50&sort=newest');
    if (!data.rows.length) {
      tbody.innerHTML = `<tr><td colspan="5"><div class="empty-cell"><span class="empty-icon"><svg class="icon icon-18"><use href="#ic-receipt"></use></svg></span>Belum ada aktivitas Hubcap API.</div></td></tr>`;
      return;
    }
    tbody.innerHTML = data.rows.map(hcLogRowHtml).join('');
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="5"><div class="empty-cell"><span class="empty-icon"><svg class="icon icon-18"><use href="#ic-triangle-alert"></use></svg></span>Gagal memuat log: ${escapeHtml(e.message)}</div></td></tr>`;
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

// ══════════════════════════════════════════════════════════════════════════
// GOLD TRIAL SETTINGS — lihat goldTrialManager.js di server buat logika lengkap.
// ══════════════════════════════════════════════════════════════════════════
let _goldTrialWired = false;

async function renderGoldTrialPage() {
  wireGoldTrialPageOnce();
  await loadGoldTrialSettings();
  await loadGoldTrialClaims();
}

function wireGoldTrialPageOnce() {
  if (_goldTrialWired) return;
  _goldTrialWired = true;
  document.getElementById('btnSaveGoldTrial').addEventListener('click', saveGoldTrialSettings);
  document.getElementById('btnGoldTrialTest').addEventListener('click', runGoldTrialTest);
  document.getElementById('btnGoldTrialForceClaim').addEventListener('click', runGoldTrialForceClaim);
  document.getElementById('btnGoldTrialSearch').addEventListener('click', searchGoldTrialUser);
  document.getElementById('gtNotifyDiscordId').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') searchGoldTrialUser();
  });
}

async function loadGoldTrialSettings() {
  try {
    const data = await api('/api/admin/gold-trial/settings');
    const s = data.settings;
    document.getElementById('gtActive').checked = !!s.active;
    document.getElementById('gtDurationAmount').value = s.durationAmount;
    document.getElementById('gtDurationUnit').value = s.durationUnit;
    document.getElementById('gtGameLimit').value = s.gameLimit === null ? '' : s.gameLimit;
    document.getElementById('gtBypassLimit').value = s.bypassLimit === null ? '' : s.bypassLimit;
    document.getElementById('gtOfferMessage').value = s.offerMessage || '';
    document.getElementById('gtSuccessMessage').value = s.successMessage || '';
    document.getElementById('gtActivatedInfo').textContent = s.activatedAt
      ? `Aktif sejak: ${new Date(s.activatedAt).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })} WIB — user yang join Discord SEBELUM tanggal ini tidak akan pernah eligible Gold Trial.`
      : 'Belum pernah diaktifkan — cutoff "member baru" akan tercatat begitu Gold Trial pertama kali diaktifkan.';
    document.getElementById('gtActiveCount').textContent = `${data.activeCount || 0} user sedang menjalani Gold Trial.`;
  } catch (e) {
    showToast('Gagal memuat pengaturan Gold Trial: ' + e.message, 'error');
  }
}

async function saveGoldTrialSettings() {
  const btn = document.getElementById('btnSaveGoldTrial');
  const rawGame = document.getElementById('gtGameLimit').value.trim();
  const rawBypass = document.getElementById('gtBypassLimit').value.trim();
  const payload = {
    active: document.getElementById('gtActive').checked,
    durationAmount: Number(document.getElementById('gtDurationAmount').value),
    durationUnit: document.getElementById('gtDurationUnit').value,
    gameLimit: rawGame === '' ? null : Number(rawGame),
    bypassLimit: rawBypass === '' ? null : Number(rawBypass),
    offerMessage: document.getElementById('gtOfferMessage').value.trim(),
    successMessage: document.getElementById('gtSuccessMessage').value.trim()
  };
  btn.disabled = true;
  try {
    await api('/api/admin/gold-trial/settings', { method: 'PUT', body: JSON.stringify(payload) });
    showToast('Pengaturan Gold Trial berhasil disimpan.', 'success');
    await loadGoldTrialSettings();
  } catch (e) {
    showToast('Gagal menyimpan: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

const GOLD_TRIAL_STATUS_LABEL = { active: 'Aktif', expired: 'Berakhir' };
const GOLD_TRIAL_STATUS_CLASS = { active: 'success', expired: 'info' };

async function loadGoldTrialClaims() {
  const table = document.getElementById('tableGoldTrial');
  table.innerHTML = `<tbody><tr><td style="padding:20px;text-align:center;color:var(--text-3);"><svg class="icon icon-18"><use href="#ic-loader-circle"></use></svg> Memuat riwayat klaim...</td></tr></tbody>`;
  try {
    const data = await api('/api/admin/gold-trial/claims');
    renderGoldTrialClaimsTable(data.claims || []);
  } catch (e) {
    table.innerHTML = `<tbody><tr><td style="padding:20px;text-align:center;color:var(--red);">Gagal memuat riwayat: ${escapeHtml(e.message)}</td></tr></tbody>`;
  }
}

function renderGoldTrialClaimsTable(list) {
  const table = document.getElementById('tableGoldTrial');
  if (!list.length) {
    table.innerHTML = `<tbody><tr><td style="padding:24px;text-align:center;color:var(--text-3);"><svg class="icon icon-18"><use href="#ic-star"></use></svg> Belum ada user yang klaim Gold Trial.</td></tr></tbody>`;
    return;
  }
  table.innerHTML = `
    <thead>
      <tr>
        <th>Username</th>
        <th>Discord ID</th>
        <th>Device ID</th>
        <th>Waktu Klaim</th>
        <th>Waktu Berakhir</th>
        <th>Limit Game/Bypass</th>
        <th>Status</th>
      </tr>
    </thead>
    <tbody>
      ${list.map(c => `
        <tr>
          <td>${escapeHtml(c.username || '-')}</td>
          <td><code>${escapeHtml(c.discordId)}</code></td>
          <td><code title="${c.deviceId ? escapeHtml(c.deviceId) : 'Tidak tercatat (klaim sebelum fitur device-lock aktif)'}">${c.deviceId ? escapeHtml(c.deviceId.slice(0, 12)) + '…' : '-'}</code></td>
          <td>${timeAgo(c.claimedAt)}</td>
          <td>${timeAgo(c.expiresAt)}</td>
          <td>${c.gameLimit === null ? 'Unlimited' : c.gameLimit + 'x'} / ${c.bypassLimit === null ? 'Unlimited' : c.bypassLimit + 'x'}</td>
          <td><span class="tag ${GOLD_TRIAL_STATUS_CLASS[c.status] || 'info'}">${GOLD_TRIAL_STATUS_LABEL[c.status] || c.status}</span></td>
        </tr>
      `).join('')}
    </tbody>
  `;
}

// ── TEST — FLOW B (server: POST /api/admin/gold-trial/test). HANYA mengirim
// notifikasi Gold Trial ke 1 Discord ID (untuk uji UI/Socket.IO/tombol), TIDAK
// mengaktifkan trial apa pun — jadi riwayat klaim di bawah TIDAK berubah. ──
async function runGoldTrialTest() {
  const input = document.getElementById('gtTestDiscordId');
  const btn = document.getElementById('btnGoldTrialTest');
  const resultEl = document.getElementById('gtTestResult');
  const discordId = input.value.trim();
  if (!discordId) { showToast('Masukkan Discord ID yang mau ditest.', 'error'); return; }

  btn.disabled = true;
  resultEl.textContent = 'Mengirim notifikasi test...';
  resultEl.style.color = 'var(--text-3)';
  try {
    const data = await api('/api/admin/gold-trial/test', { method: 'POST', body: JSON.stringify({ discordId }) });
    resultEl.textContent = `Notifikasi test terkirim (durasi ditampilkan: ${data.durationLabel}). Trial TIDAK diaktifkan.`;
    resultEl.style.color = 'var(--green, #4CB782)';
    showToast('Notifikasi test Gold Trial terkirim.', 'success');
  } catch (e) {
    resultEl.textContent = `Gagal — ${e.message}`;
    resultEl.style.color = 'var(--red)';
    showToast('Test notifikasi Gold Trial gagal: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

// ── FORCE CLAIM — FLOW C (server: POST /api/admin/gold-trial/force-claim).
// Satu-satunya jalur yang boleh bypass restriction klaim normal. Refresh
// riwayat klaim begitu berhasil. ──
async function runGoldTrialForceClaim() {
  const discordId = document.getElementById('gtForceDiscordId').value.trim();
  const btn = document.getElementById('btnGoldTrialForceClaim');
  const resultEl = document.getElementById('gtForceResult');
  if (!discordId) { showToast('Masukkan Discord ID target.', 'error'); return; }
  if (!confirm(`Force Claim Gold Trial untuk Discord ID ${discordId}?\n\nIni akan MENGAKTIFKAN Gold Trial secara manual meskipun akun/device ini sudah pernah klaim sebelumnya.`)) return;

  const durationAmount = document.getElementById('gtForceDurationAmount').value.trim();
  const durationUnit = document.getElementById('gtForceDurationUnit').value;
  const payload = { discordId };
  if (durationAmount !== '') payload.durationAmount = Number(durationAmount);
  if (durationUnit !== '') payload.durationUnit = durationUnit;

  btn.disabled = true;
  resultEl.textContent = 'Memproses force claim...';
  resultEl.style.color = 'var(--text-3)';
  try {
    const data = await api('/api/admin/gold-trial/force-claim', { method: 'POST', body: JSON.stringify(payload) });
    resultEl.textContent = `Berhasil — Gold Trial dipaksa aktif ${data.durationLabel} (limit Game ${data.gameLimit === null ? 'Unlimited' : data.gameLimit + 'x'}, Bypass ${data.bypassLimit === null ? 'Unlimited' : data.bypassLimit + 'x'}).${data.deviceConflict ? ' Catatan: device akun ini sudah tercatat di akun lain, jadi deviceId tidak ditimpa.' : ''}`;
    resultEl.style.color = 'var(--green, #4CB782)';
    showToast('Force Claim Gold Trial berhasil.', 'success');
    await loadGoldTrialClaims();
  } catch (e) {
    resultEl.textContent = `Gagal — ${e.message}`;
    resultEl.style.color = 'var(--red)';
    showToast('Force Claim Gold Trial gagal: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

// ── KIRIM NOTIFIKASI GOLD TRIAL — cari user by Discord ID (GET
// /api/admin/gold-trial/lookup), tampilkan hasil + tombol konfirmasi kirim
// (POST /api/admin/gold-trial/notify). Tidak pernah mengaktifkan trial. ──
let _gtNotifyTarget = null;

async function searchGoldTrialUser() {
  const input = document.getElementById('gtNotifyDiscordId');
  const resultEl = document.getElementById('gtNotifyResult');
  const btn = document.getElementById('btnGoldTrialSearch');
  const discordId = input.value.trim();
  _gtNotifyTarget = null;
  if (!discordId) { showToast('Masukkan Discord ID.', 'error'); return; }

  btn.disabled = true;
  resultEl.innerHTML = `<div style="font-size:12px;color:var(--text-3);"><svg class="icon icon-16"><use href="#ic-loader-circle"></use></svg> Mencari user...</div>`;
  try {
    const data = await api('/api/admin/gold-trial/lookup?discordId=' + encodeURIComponent(discordId));
    _gtNotifyTarget = data.user;
    const eligLabel = data.eligible ? 'Eligible untuk klaim' : (GOLD_TRIAL_NOTIFY_REASON[data.reason] || 'Belum eligible');
    const claimLabel = data.claim
      ? (data.claim.status === 'active' ? 'Sedang menjalani Gold Trial' : 'Sudah pernah klaim (berakhir)')
      : 'Belum pernah klaim';
    resultEl.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:14px;padding:12px 14px;border:1px solid var(--line);border-radius:10px;background:rgba(255,255,255,.03);flex-wrap:wrap;">
        <div>
          <div style="font-weight:600;">${escapeHtml(data.user.username)}</div>
          <div style="font-size:12px;color:var(--text-3);margin-top:2px;"><code>${escapeHtml(data.user.discordId)}</code> · Paket: ${escapeHtml(data.user.role)}</div>
          <div style="font-size:12px;color:var(--text-3);margin-top:2px;">${escapeHtml(eligLabel)} · ${escapeHtml(claimLabel)}</div>
        </div>
        <button class="btn btn-primary" id="btnGoldTrialNotifySend"><svg class="icon icon-18"><use href="#ic-bell"></use></svg> Kirim Notifikasi</button>
      </div>`;
    document.getElementById('btnGoldTrialNotifySend').addEventListener('click', sendGoldTrialNotify);
  } catch (e) {
    if (e.message === 'not_found') {
      resultEl.innerHTML = `<div style="font-size:13px;color:var(--text-3);padding:10px 0;">User tidak ditemukan.</div>`;
    } else {
      resultEl.innerHTML = `<div style="font-size:13px;color:var(--red);padding:10px 0;">Gagal mencari user: ${escapeHtml(e.message)}</div>`;
    }
  } finally {
    btn.disabled = false;
  }
}

const GOLD_TRIAL_NOTIFY_REASON = {
  inactive: 'Gold Trial sedang tidak aktif',
  already_claimed: 'Sudah pernah klaim sebelumnya',
  device_already_claimed: 'Perangkat sudah pernah klaim',
  device_not_verified: 'Perangkat belum terverifikasi',
  not_new_member: 'Bukan member baru Discord',
  had_gold_before: 'Pernah punya Gold/Platinum sebelumnya'
};

async function sendGoldTrialNotify() {
  if (!_gtNotifyTarget) return;
  const btn = document.getElementById('btnGoldTrialNotifySend');
  btn.disabled = true;
  try {
    await api('/api/admin/gold-trial/notify', { method: 'POST', body: JSON.stringify({ discordId: _gtNotifyTarget.discordId }) });
    showToast(`Notifikasi Gold Trial terkirim ke ${_gtNotifyTarget.username}.`, 'success');
  } catch (e) {
    showToast('Gagal mengirim notifikasi: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
  }
}
// ══════════════════════════════════════════════════════════════════════════
// UPGRADE PAKET — form harga/masa aktif/benefit/limit/badge Public/Gold/Platinum
// (lihat packageManager.js di server — 1 dokumen settings, dibaca App realtime)
// ══════════════════════════════════════════════════════════════════════════
const PKG_UNIT_LABEL = { minutes: 'Menit', hours: 'Jam', days: 'Hari' };
let _pkgFormDirty = false; // true selagi admin lain lagi ngetik — cegah form ketiban re-render dari WS pas lagi diisi

async function renderUpgradePaketPage() {
  const grid = document.getElementById('pkgFormGrid');
  grid.innerHTML = `<div style="padding:20px;color:var(--text-3);"><svg class="icon icon-18"><use href="#ic-loader-circle"></use></svg> Memuat pengaturan paket...</div>`;
  try {
    const { packages } = await api('/api/admin/packages');
    grid.innerHTML = pkgCardHtml('public', 'Gratis', packages.public, 'ic-globe') +
                      pkgCardHtml('gold', 'Gold', packages.gold, 'ic-trophy') +
                      pkgCardHtml('platinum', 'Platinum', packages.platinum, 'ic-gem');
    wirePkgCards();
  } catch (e) {
    grid.innerHTML = `<div style="padding:20px;color:var(--red);">Gagal memuat pengaturan paket: ${escapeHtml(e.message)}</div>`;
  }
}

function pkgCardHtml(tier, label, data, icon) {
  const isPaid = tier !== 'public';
  return `
  <div class="card pkg-card" data-tier="${tier}">
    <div class="card-header">
      <div class="card-title"><svg class="icon icon-18"><use href="#${icon}"></use></svg> ${label}</div>
      ${isPaid ? `<div class="vr-toggle-row" style="margin:0;"><label class="vr-toggle"><input type="checkbox" class="pkg-active" ${data.active ? 'checked' : ''}><span>Aktif</span></label></div>` : ''}
    </div>
    <div class="card-body">
      <div class="form-group">
        <label class="form-label">Deskripsi Singkat <span style="color:var(--text-faint);font-weight:400;">(tampil di App di bawah harga)</span></label>
        <input class="form-input pkg-description" type="text" maxlength="200" value="${escapeHtml(data.description || '')}">
      </div>
      ${isPaid ? `
      <div class="form-group">
        <label class="form-label">Harga (Rp)</label>
        <input class="form-input pkg-price" type="number" min="0" step="1000" value="${data.price}">
      </div>
      <div style="display:flex;gap:10px;">
        <div class="form-group" style="flex:1;">
          <label class="form-label">Masa Aktif</label>
          <input class="form-input pkg-duration-amount" type="number" min="1" value="${data.durationAmount}">
        </div>
        <div class="form-group" style="flex:1;">
          <label class="form-label">Satuan</label>
          <select class="form-input pkg-duration-unit">
            ${Object.entries(PKG_UNIT_LABEL).map(([k, v]) => `<option value="${k}" ${data.durationUnit === k ? 'selected' : ''}>${v}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">Badge <span style="color:var(--text-faint);font-weight:400;">(opsional, contoh: "Best Value")</span></label>
        <input class="form-input pkg-badge" type="text" maxlength="40" value="${escapeHtml(data.badge || '')}">
      </div>` : ''}
      <div class="form-group">
        <label class="form-label">Benefit <span style="color:var(--text-faint);font-weight:400;">(satu baris = satu benefit)</span></label>
        <textarea class="form-input pkg-benefits" rows="4" style="resize:vertical;">${escapeHtml((data.benefits || []).join('\n'))}</textarea>
      </div>
      <div style="display:flex;gap:10px;">
        <div class="form-group" style="flex:1;">
          <label class="form-label">Limit Game/hari <span style="color:var(--text-faint);font-weight:400;">(kosong = unlimited)</span></label>
          <input class="form-input pkg-game-limit" type="number" min="0" value="${data.gameLimit === null || data.gameLimit === undefined ? '' : data.gameLimit}">
        </div>
        <div class="form-group" style="flex:1;">
          <label class="form-label">Limit Bypass/hari <span style="color:var(--text-faint);font-weight:400;">(kosong = unlimited)</span></label>
          <input class="form-input pkg-bypass-limit" type="number" min="0" value="${data.bypassLimit === null || data.bypassLimit === undefined ? '' : data.bypassLimit}">
        </div>
      </div>
      <button class="btn btn-primary pkg-save-btn"><svg class="icon icon-18"><use href="#ic-save"></use></svg> Simpan ${label}</button>
      <div class="pkg-status" style="margin-top:10px;font-size:12px;color:var(--text-3);"></div>
    </div>
  </div>`;
}

function wirePkgCards() {
  // Discoped ke #pkgFormGrid (bukan document-wide) — supaya kartu apapun di
  // halaman LAIN yang mungkin kebetulan lupa dikasih class unik sendiri tidak
  // pernah ikut ke-select di sini dan bikin `.pkg-save-btn` null lalu crash
  // (pernah kejadian dgn kartu tier halaman Auto Order sebelum di-rename ke
  // `dao-tier-card`).
  document.getElementById('pkgFormGrid')?.querySelectorAll('.pkg-card').forEach(card => {
    const tier = card.dataset.tier;
    card.querySelectorAll('input, textarea, select').forEach(el => {
      el.addEventListener('input', () => { _pkgFormDirty = true; });
    });
    card.querySelector('.pkg-save-btn').addEventListener('click', () => savePkgCard(tier, card));
  });
}

async function savePkgCard(tier, card) {
  const btn = card.querySelector('.pkg-save-btn');
  const statusEl = card.querySelector('.pkg-status');
  const benefits = card.querySelector('.pkg-benefits').value.split('\n').map(s => s.trim()).filter(Boolean);
  const gameLimitRaw = card.querySelector('.pkg-game-limit').value;
  const bypassLimitRaw = card.querySelector('.pkg-bypass-limit').value;
  const body = {
    description: card.querySelector('.pkg-description').value,
    benefits,
    gameLimit: gameLimitRaw === '' ? null : Number(gameLimitRaw),
    bypassLimit: bypassLimitRaw === '' ? null : Number(bypassLimitRaw)
  };
  if (tier !== 'public') {
    body.price = Number(card.querySelector('.pkg-price').value);
    body.durationAmount = Number(card.querySelector('.pkg-duration-amount').value);
    body.durationUnit = card.querySelector('.pkg-duration-unit').value;
    body.badge = card.querySelector('.pkg-badge').value;
    body.active = card.querySelector('.pkg-active').checked;
  }

  btn.disabled = true;
  statusEl.textContent = 'Menyimpan...';
  try {
    await api(`/api/admin/packages/${tier}`, { method: 'PUT', body: JSON.stringify(body) });
    statusEl.innerHTML = '<svg class="icon icon-16"><use href="#ic-circle-check-big"></use></svg> Tersimpan — langsung berlaku di App.';
    showToast(`Paket ${tier.toUpperCase()} berhasil disimpan.`, 'success');
    _pkgFormDirty = false;
  } catch (e) {
    statusEl.innerHTML = '<svg class="icon icon-16"><use href="#ic-triangle-alert"></use></svg> Gagal: ' + escapeHtml(e.message);
    showToast('Gagal menyimpan paket: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

// ══════════════════════════════════════════════════════════════════════════
// KLIKQRIS SETTINGS
// ══════════════════════════════════════════════════════════════════════════
let _pakasirWired = false;

async function renderPakasirPage() {
  wirePakasirPageOnce();
  try {
    const { settings } = await api('/api/admin/klikqris-settings');
    document.getElementById('pkrEnabled').checked = !!settings.enabled;
    document.getElementById('pkrMode').value = settings.mode || 'sandbox';
    document.getElementById('pkrWebhookUrl').value = settings.webhookUrl || '';

    document.getElementById('pkrSandboxApiKey').value = '';
    document.getElementById('pkrSandboxMerchantId').value = settings.sandbox?.merchantId || '';
    document.getElementById('pkrSandboxApiKeyCurrent').textContent = settings.sandbox?.hasApiKey
      ? `API Key tersimpan: ${settings.sandbox.apiKeyMasked}`
      : 'API Key Sandbox belum diisi.';

    document.getElementById('pkrProductionApiKey').value = '';
    document.getElementById('pkrProductionMerchantId').value = settings.production?.merchantId || '';
    document.getElementById('pkrProductionApiKeyCurrent').textContent = settings.production?.hasApiKey
      ? `API Key tersimpan: ${settings.production.apiKeyMasked}`
      : 'API Key Production belum diisi.';
  } catch (e) {
    showToast('Gagal memuat pengaturan KlikQRIS: ' + e.message, 'error');
  }
}

function wirePakasirPageOnce() {
  if (_pakasirWired) return;
  _pakasirWired = true;

  document.getElementById('btnSavePakasir').addEventListener('click', async () => {
    const btn = document.getElementById('btnSavePakasir');
    const statusEl = document.getElementById('pkrStatus');
    const body = {
      enabled: document.getElementById('pkrEnabled').checked,
      mode: document.getElementById('pkrMode').value,
      sandboxMerchantId: document.getElementById('pkrSandboxMerchantId').value.trim(),
      productionMerchantId: document.getElementById('pkrProductionMerchantId').value.trim()
    };
    const sandboxApiKey = document.getElementById('pkrSandboxApiKey').value.trim();
    if (sandboxApiKey) body.sandboxApiKey = sandboxApiKey;
    const productionApiKey = document.getElementById('pkrProductionApiKey').value.trim();
    if (productionApiKey) body.productionApiKey = productionApiKey;

    btn.disabled = true;
    statusEl.textContent = 'Menyimpan...';
    try {
      const res = await api('/api/admin/klikqris-settings', { method: 'PUT', body: JSON.stringify(body) });
      statusEl.innerHTML = `<svg class="icon icon-16"><use href="#ic-circle-check-big"></use></svg> Tersimpan — gateway ${res.settings.enabled ? 'AKTIF' : 'NONAKTIF'}, mode ${res.settings.mode.toUpperCase()}.`;
      showToast('Pengaturan KlikQRIS berhasil disimpan.', 'success');
      document.getElementById('pkrSandboxApiKey').value = '';
      document.getElementById('pkrProductionApiKey').value = '';
      document.getElementById('pkrSandboxApiKeyCurrent').textContent = res.settings.sandbox?.hasApiKey ? `API Key tersimpan: ${res.settings.sandbox.apiKeyMasked}` : 'API Key Sandbox belum diisi.';
      document.getElementById('pkrProductionApiKeyCurrent').textContent = res.settings.production?.hasApiKey ? `API Key tersimpan: ${res.settings.production.apiKeyMasked}` : 'API Key Production belum diisi.';
    } catch (e) {
      statusEl.innerHTML = '<svg class="icon icon-16"><use href="#ic-triangle-alert"></use></svg> Gagal: ' + escapeHtml(e.message);
      showToast('Gagal menyimpan pengaturan KlikQRIS: ' + e.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById('btnTestPakasir').addEventListener('click', async () => {
    const btn = document.getElementById('btnTestPakasir');
    const statusEl = document.getElementById('pkrStatus');
    btn.disabled = true;
    statusEl.textContent = 'Mengecek koneksi...';
    try {
      const res = await api('/api/admin/klikqris-settings/status');
      statusEl.innerHTML = res.ok
        ? `<svg class="icon icon-16"><use href="#ic-circle-check-big"></use></svg> ${escapeHtml(res.message)}`
        : `<svg class="icon icon-16"><use href="#ic-triangle-alert"></use></svg> ${escapeHtml(res.message)}`;
      showToast(res.message, res.ok ? 'success' : 'error');
    } catch (e) {
      statusEl.innerHTML = '<svg class="icon icon-16"><use href="#ic-triangle-alert"></use></svg> Gagal cek koneksi: ' + escapeHtml(e.message);
      showToast('Gagal cek koneksi: ' + e.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById('btnTestPakasirTx').addEventListener('click', async () => {
    const btn = document.getElementById('btnTestPakasirTx');
    const statusEl = document.getElementById('pkrStatus');
    btn.disabled = true;
    statusEl.textContent = 'Membuat transaksi uji coba (Rp1.000)...';
    try {
      const res = await api('/api/admin/klikqris-settings/test-transaction', { method: 'POST' });
      statusEl.innerHTML = `<svg class="icon icon-16"><use href="#ic-circle-check-big"></use></svg> Transaksi uji coba berhasil dibuat (order ${escapeHtml(res.payment.order_id)}, total Rp${Number(res.payment.total_payment).toLocaleString('id-ID')}).`;
      showToast('Test Create Transaction berhasil.', 'success');
    } catch (e) {
      statusEl.innerHTML = '<svg class="icon icon-16"><use href="#ic-triangle-alert"></use></svg> Gagal: ' + escapeHtml(e.message);
      showToast('Gagal membuat transaksi uji coba: ' + e.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById('btnTestPakasirWebhook').addEventListener('click', async () => {
    const btn = document.getElementById('btnTestPakasirWebhook');
    const statusEl = document.getElementById('pkrStatus');
    btn.disabled = true;
    statusEl.textContent = 'Menguji endpoint webhook...';
    try {
      const res = await api('/api/admin/klikqris-settings/test-webhook', { method: 'POST' });
      statusEl.innerHTML = res.ok
        ? `<svg class="icon icon-16"><use href="#ic-circle-check-big"></use></svg> Endpoint webhook terjangkau (HTTP ${res.status}).`
        : `<svg class="icon icon-16"><use href="#ic-triangle-alert"></use></svg> Endpoint webhook TIDAK merespon 200 (HTTP ${res.status}).`;
      showToast(res.ok ? 'Endpoint webhook terjangkau.' : 'Endpoint webhook bermasalah.', res.ok ? 'success' : 'error');
    } catch (e) {
      statusEl.innerHTML = '<svg class="icon icon-16"><use href="#ic-triangle-alert"></use></svg> Gagal menguji webhook: ' + escapeHtml(e.message);
      showToast('Gagal menguji webhook: ' + e.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });
}

// ══════════════════════════════════════════════════════════════════════════
// TRANSAKSI — SEMUA transaksi KlikQRIS dari semua user (Upgrade Paket,
// Marketplace Product, Steam Account, dan jenis KlikQRIS lain yang tersedia
// di sistem) — digabung jadi SATU riwayat lewat /api/admin/transactions
// (server-side sudah menggabungkan transactionManager, marketplaceOrderManager,
// & steamAccountOrderManager — lihat listUnifiedAdminTransactions di server.js).
// Tiap baris punya field `kind` ('package' | 'marketplace' | 'steam_account')
// yang dipakai buat: (1) label & warna badge Jenis, (2) tentukan endpoint mana
// yang dipanggil tombol Refresh/Batalkan — endpoint per-sumber yang SUDAH ADA
// sebelumnya (transactions pakai Mongo _id, marketplace/steam_account pakai
// orderId) TIDAK diubah sama sekali, cuma di-routing dari sini.
// ══════════════════════════════════════════════════════════════════════════
let _transaksiWired = false;
const TX_STATUS_LABEL = { pending: 'Pending', completed: 'Success', failed: 'Failed', cancelled: 'Cancelled', expired: 'Expired' };
const TX_STATUS_CLASS = { pending: 'warning', completed: 'success', failed: 'error', cancelled: 'error', expired: 'info' };
// 'completed' Marketplace/Steam Account ditampilkan "Paid" (istilah pembelian produk),
// sedangkan Upgrade Paket tetap "Success" — cuma beda label, status asli (field `status`) sama persis.
const TX_KIND_LABEL = { package: 'Upgrade Paket', marketplace: 'Marketplace', steam_account: 'Steam Account' };
const TX_KIND_CLASS = { package: 'info', marketplace: 'success', steam_account: 'warning' };
// Endpoint per kind buat tombol Refresh/Batalkan — reuse endpoint admin yang
// SUDAH ADA sebelumnya per sumber (tidak ada endpoint baru dibuat).
const TX_KIND_ENDPOINT = {
  package: { base: '/api/admin/transactions', key: 'id' },
  marketplace: { base: '/api/admin/marketplace/orders', key: 'orderId' },
  steam_account: { base: '/api/admin/steam-accounts/orders', key: 'orderId' }
};
let _txSearchDebounce = null;

async function renderTransaksiPage() {
  wireTransaksiPageOnce();
  await loadTransaksiList();
}

function wireTransaksiPageOnce() {
  if (_transaksiWired) return;
  _transaksiWired = true;

  document.getElementById('txStatusFilter').addEventListener('change', loadTransaksiList);
  document.getElementById('txTypeFilter').addEventListener('change', loadTransaksiList);
  document.getElementById('txSearchInput').addEventListener('input', () => {
    clearTimeout(_txSearchDebounce);
    _txSearchDebounce = setTimeout(loadTransaksiList, 350);
  });
  document.getElementById('tableTransaksi').addEventListener('click', async (e) => {
    const refreshBtn = e.target.closest('.tx-refresh-btn');
    const cancelBtn = e.target.closest('.tx-cancel-btn');

    if (refreshBtn) {
      const { base, key } = TX_KIND_ENDPOINT[refreshBtn.dataset.kind] || TX_KIND_ENDPOINT.package;
      const idVal = key === 'id' ? refreshBtn.dataset.id : refreshBtn.dataset.orderid;
      refreshBtn.disabled = true;
      try {
        const res = await api(`${base}/${idVal}/refresh`, { method: 'POST' });
        const changed = 'changed' in res ? res.changed : (res.order || res.transaction)?.status !== 'pending';
        showToast(changed ? 'Status transaksi diperbarui.' : 'Status transaksi tidak berubah (masih pending di KlikQRIS).', changed ? 'success' : 'default');
        await loadTransaksiList();
      } catch (err) {
        showToast('Gagal refresh status: ' + err.message, 'error');
      } finally {
        refreshBtn.disabled = false;
      }
      return;
    }

    if (cancelBtn) {
      if (!confirm('Batalkan transaksi ini? User tidak akan bisa membayar invoice ini lagi.')) return;
      const { base, key } = TX_KIND_ENDPOINT[cancelBtn.dataset.kind] || TX_KIND_ENDPOINT.package;
      const idVal = key === 'id' ? cancelBtn.dataset.id : cancelBtn.dataset.orderid;
      cancelBtn.disabled = true;
      try {
        await api(`${base}/${idVal}/cancel`, { method: 'POST' });
        showToast('Transaksi berhasil dibatalkan.', 'success');
        await loadTransaksiList();
      } catch (err) {
        showToast('Gagal membatalkan transaksi: ' + err.message, 'error');
      } finally {
        cancelBtn.disabled = false;
      }
    }
  });
}

async function loadTransaksiList() {
  const table = document.getElementById('tableTransaksi');
  table.innerHTML = `<tbody><tr><td style="padding:20px;text-align:center;color:var(--text-3);"><svg class="icon icon-18"><use href="#ic-loader-circle"></use></svg> Memuat transaksi...</td></tr></tbody>`;
  try {
    const status = document.getElementById('txStatusFilter').value;
    const type = document.getElementById('txTypeFilter').value;
    const q = document.getElementById('txSearchInput').value.trim();
    const params = new URLSearchParams();
    if (status) params.set('status', status);
    if (type) params.set('type', type);
    if (q) params.set('q', q);
    const data = await api('/api/admin/transactions?' + params.toString());
    renderTransaksiTable(data.transactions || []);
  } catch (e) {
    table.innerHTML = `<tbody><tr><td style="padding:20px;text-align:center;color:var(--red);">Gagal memuat transaksi: ${escapeHtml(e.message)}</td></tr></tbody>`;
  }
}

function renderTransaksiTable(list) {
  const table = document.getElementById('tableTransaksi');
  if (!list.length) {
    table.innerHTML = `<tbody><tr><td style="padding:24px;text-align:center;color:var(--text-3);"><svg class="icon icon-18"><use href="#ic-receipt"></use></svg> Belum ada transaksi.</td></tr></tbody>`;
    return;
  }
  table.innerHTML = `
    <thead>
      <tr>
        <th>Invoice</th>
        <th>Jenis</th>
        <th>User</th>
        <th>Product / Paket</th>
        <th>Nominal</th>
        <th>Metode</th>
        <th>Status</th>
        <th>Waktu Transaksi</th>
        <th>Waktu Pembayaran</th>
        <th style="text-align:right;">Aksi</th>
      </tr>
    </thead>
    <tbody>${list.map(txRowHtml).join('')}</tbody>`;
}

function txRowHtml(t) {
  const kind = t.kind || 'package';
  const cls = TX_STATUS_CLASS[t.status] || 'info';
  // Marketplace/Steam Account pakai istilah "Paid" utk completed (pembelian produk),
  // Upgrade Paket tetap "Success" — cuma label, sumber status-nya field yang sama.
  const label = t.status === 'completed' && kind !== 'package' ? 'Paid' : (TX_STATUS_LABEL[t.status] || t.status);
  const kindLabel = TX_KIND_LABEL[kind] || kind;
  const kindCls = TX_KIND_CLASS[kind] || 'info';
  const productCell = kind === 'package' ? roleTagHtml(t.tier) : escapeHtml(t.productLabel || t.productName || '—');
  return `
    <tr>
      <td><code style="font-weight:700;letter-spacing:.02em;">${escapeHtml(t.orderId)}</code></td>
      <td><span class="log-badge log-badge--${kindCls}">${kindLabel}</span></td>
      <td>${escapeHtml(t.username || t.discordId || '—')}</td>
      <td>${productCell}</td>
      <td>Rp${Number(t.totalPayment || t.amount).toLocaleString('id-ID')}</td>
      <td>${escapeHtml(String(t.paymentMethod || '-').toUpperCase())}</td>
      <td><span class="log-badge log-badge--${cls}">${label}</span></td>
      <td>${fmtDateShort(t.createdAt)}</td>
      <td>${t.completedAt ? fmtDateShort(t.completedAt) : '—'}</td>
      <td style="text-align:right;">
        <button class="btn btn-secondary btn-sm tx-refresh-btn" data-kind="${kind}" data-id="${t.id}" data-orderid="${escapeHtml(t.orderId)}" ${t.status !== 'pending' ? 'disabled' : ''}>
          <svg class="icon icon-16"><use href="#ic-refresh-cw"></use></svg> Refresh Status
        </button>
        <button class="btn btn-secondary btn-sm tx-cancel-btn" data-kind="${kind}" data-id="${t.id}" data-orderid="${escapeHtml(t.orderId)}" style="color:var(--red);" ${t.status !== 'pending' ? 'disabled' : ''}>
          <svg class="icon icon-16"><use href="#ic-circle-x"></use></svg> Batalkan
        </button>
      </td>
    </tr>`;
}

// ══════════════════════════════════════════════════════════════════════════
// STEAM ACCOUNT MARKETPLACE (Admin Web) — state & endpoint semuanya terpisah
// (/api/admin/steam-accounts/*). "Kelola Game" TIDAK memakai modal Add
// Game/Bypass biasa — search-nya lewat Steam App ID (searchStaGame), reuse
// fetchSteamDetailsForAppId lewat endpoint /search-game.
// ══════════════════════════════════════════════════════════════════════════
const STA_STATUS_LABEL = { available: 'Available', disabled: 'Disabled' };
const STA_STATUS_CLASS = { available: 'success', disabled: 'error' };
let _staAccountList = [];
let _staEditId = null;
let _staImagePayload = { imageUrl: '', imageData: '' };
let _staWired = false;
let _staOrderSearchDebounce = null;
let _staContentProductId = null;
let _staContentProduct = null;
let _staSearchedGame = null;

async function renderSteamAccountsAdmin() {
  wireSteamAccountsAdminOnce();
  // PERF FIX: sebelumnya `await loadSteamAccounts(); await loadSteamAccountOrders();`
  // berurutan padahal keduanya independen (endpoint & tabel beda) — total waktu
  // tunggu = jumlah keduanya. Sekarang jalan paralel.
  await Promise.all([loadSteamAccounts(), loadSteamAccountOrders()]);
}

function wireSteamAccountsAdminOnce() {
  if (_staWired) return;
  _staWired = true;

  document.getElementById('btnAddSteamAccount').addEventListener('click', () => openSteamAccountModal(null));

  document.getElementById('tableSteamAccounts').addEventListener('click', async (e) => {
    const editBtn = e.target.closest('.sta-edit-btn');
    const delBtn = e.target.closest('.sta-delete-btn');
    const contentBtn = e.target.closest('.sta-content-btn');
    const toggleBtn = e.target.closest('.sta-status-toggle');

    if (contentBtn) return openSteamAccountContentPage(contentBtn.dataset.id);
    if (editBtn) return openSteamAccountModal(editBtn.dataset.id);

    if (delBtn) {
      const p = _staAccountList.find(x => x.id === delBtn.dataset.id);
      const ownersCount = Number(delBtn.dataset.owners || 0);
      let force = false;
      if (ownersCount > 0) {
        // Sudah dimiliki user — minta konfirmasi lebih ketat (ketik ulang nama produk)
        // sebelum menghapus paksa. Histori pembelian (steamAccountOwnerships) TIDAK
        // ikut terhapus, cuma produknya.
        const typed = prompt(`Akun "${p?.name || ''}" sudah dimiliki ${ownersCount} user. Menghapusnya akan menghilangkan produk ini secara permanen (histori pembelian tetap tersimpan).\n\nKetik ulang nama produk untuk konfirmasi Hapus Paksa:`);
        if (typed === null) return;
        if (typed.trim() !== (p?.name || '').trim()) { showToast('Nama tidak cocok, penghapusan dibatalkan.', 'error'); return; }
        force = true;
      } else {
        if (!confirm(`Hapus akun "${p?.name || ''}"? Tindakan ini tidak bisa dibatalkan.`)) return;
      }
      try {
        await api(`/api/admin/steam-accounts/${delBtn.dataset.id}${force ? '?force=true' : ''}`, { method: 'DELETE' });
        showToast('Akun berhasil dihapus.', 'success');
        // PERF FIX: buang dari state lokal & render ulang, tidak reload semua akun.
        _staAccountList = _staAccountList.filter(x => x.id !== delBtn.dataset.id);
        renderSteamAccountsTable(_staAccountList);
      } catch (err) { showToast('Gagal menghapus akun: ' + err.message, 'error'); }
      return;
    }

    if (toggleBtn) {
      const p = _staAccountList.find(x => x.id === toggleBtn.dataset.id);
      if (!p) return;
      const newStatus = p.status === 'available' ? 'disabled' : 'available';
      try {
        const { product } = await api(`/api/admin/steam-accounts/${p.id}`, { method: 'PUT', body: JSON.stringify({ status: newStatus }) });
        // PERF FIX: update baris ini saja di state lokal, bukan reload semua akun.
        Object.assign(p, product || { status: newStatus });
        renderSteamAccountsTable(_staAccountList);
      } catch (err) { showToast('Gagal mengubah status: ' + err.message, 'error'); }
    }
  });

  document.getElementById('staOrderStatusFilter').addEventListener('change', loadSteamAccountOrders);
  document.getElementById('staOrderSearchInput').addEventListener('input', () => {
    clearTimeout(_staOrderSearchDebounce);
    _staOrderSearchDebounce = setTimeout(loadSteamAccountOrders, 350);
  });
  document.getElementById('tableSteamAccountOrders').addEventListener('click', async (e) => {
    const refreshBtn = e.target.closest('.sta-order-refresh-btn');
    const cancelBtn = e.target.closest('.sta-order-cancel-btn');
    if (refreshBtn) {
      refreshBtn.disabled = true;
      try {
        await api(`/api/admin/steam-accounts/orders/${refreshBtn.dataset.id}/refresh`, { method: 'POST' });
        await loadSteamAccountOrders();
        await loadSteamAccounts();
      } catch (err) { showToast('Gagal refresh order: ' + err.message, 'error'); }
      finally { refreshBtn.disabled = false; }
    }
    if (cancelBtn) {
      if (!confirm(`Batalkan order ${cancelBtn.dataset.id}?`)) return;
      cancelBtn.disabled = true;
      try {
        await api(`/api/admin/steam-accounts/orders/${cancelBtn.dataset.id}/cancel`, { method: 'POST' });
        showToast('Order dibatalkan.', 'success');
        await loadSteamAccountOrders();
      } catch (err) { showToast('Gagal membatalkan order: ' + err.message, 'error'); }
      finally { cancelBtn.disabled = false; }
    }
  });

  // Upload gambar — validasi ukuran & preview di sisi client sebelum kirim ke server.
  document.getElementById('staProductImageFile').addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 4 * 1024 * 1024) {
      showToast('Ukuran gambar maksimal 4MB.', 'error');
      e.target.value = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      _staImagePayload = { imageUrl: '', imageData: reader.result };
      document.getElementById('staProductImageUrl').value = '';
      showStaImagePreview(reader.result);
    };
    reader.readAsDataURL(file);
  });
  document.getElementById('staProductImageUrl').addEventListener('input', (e) => {
    const url = e.target.value.trim();
    if (url) {
      _staImagePayload = { imageUrl: url, imageData: '' };
      document.getElementById('staProductImageFile').value = '';
      showStaImagePreview(url);
    } else if (!document.getElementById('staProductImageFile').files?.length) {
      clearStaImage();
    }
  });

  document.getElementById('btnStaContentBack').addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.page === 'steamaccounts'));
    loadPage('steamaccounts');
  });
  document.getElementById('btnStaSearchGame').addEventListener('click', searchStaGame);
  document.getElementById('staSearchAppId').addEventListener('keydown', (e) => { if (e.key === 'Enter') searchStaGame(); });
  document.getElementById('btnStaBulkAdd').addEventListener('click', bulkAddStaGames);
}

function setStaImageType(type) {
  document.querySelectorAll('.sta-image-type-btn').forEach(b => b.classList.toggle('active', b.dataset.type === type));
  document.getElementById('staProductImageFile').style.display = type === 'file' ? '' : 'none';
  document.getElementById('staProductImageUrl').style.display = type === 'url' ? '' : 'none';
}
window.setStaImageType = setStaImageType;

function showStaImagePreview(src) {
  const img = document.getElementById('staImagePreviewImg');
  img.onerror = () => { img.onerror = null; img.src = IMG_FALLBACK_SRC; };
  img.src = src;
  document.getElementById('staImagePreviewWrap').style.display = 'block';
}
function clearStaImage() {
  _staImagePayload = { imageUrl: '', imageData: '' };
  document.getElementById('staProductImageUrl').value = '';
  document.getElementById('staProductImageFile').value = '';
  document.getElementById('staImagePreviewWrap').style.display = 'none';
}
window.clearStaImage = clearStaImage;

async function loadSteamAccounts() {
  const table = document.getElementById('tableSteamAccounts');
  table.innerHTML = `<tbody><tr><td style="padding:20px;text-align:center;color:var(--text-3);"><svg class="icon icon-18"><use href="#ic-loader-circle"></use></svg> Memuat akun...</td></tr></tbody>`;
  try {
    const data = await api('/api/admin/steam-accounts');
    _staAccountList = data.products || [];
    renderSteamAccountsTable(_staAccountList);
  } catch (e) {
    table.innerHTML = `<tbody><tr><td style="padding:20px;text-align:center;color:var(--red);">Gagal memuat akun: ${escapeHtml(e.message)}</td></tr></tbody>`;
  }
}

function renderSteamAccountsTable(list) {
  const table = document.getElementById('tableSteamAccounts');
  if (!list.length) {
    table.innerHTML = `<tbody><tr><td style="padding:24px;text-align:center;color:var(--text-3);">Belum ada Steam Account. Klik "Tambah Steam Account" untuk membuat yang pertama.</td></tr></tbody>`;
    return;
  }
  table.innerHTML = `
    <thead>
      <tr>
        <th>Gambar</th>
        <th>Nama Produk</th>
        <th>Games</th>
        <th>Harga</th>
        <th>Status</th>
        <th>Owners</th>
        <th style="text-align:right;">Aksi</th>
      </tr>
    </thead>
    <tbody>${list.map(staAccountRowHtml).join('')}</tbody>`;
}

function staAccountRowHtml(p) {
  // PERF FIX: list /api/admin/steam-accounts sudah tidak bawa `imageData`
  // base64 lagi (lihat steamAccountManager.listAdmin) — pakai `hasImage` buat
  // ambil gambar lewat endpoint /image (di-cache browser) kalau memang ada.
  const img = p.imageUrl || p.imageData || (p.hasImage ? adminImageUrl(`/api/admin/steam-accounts/${p.id}/image`) : '');
  const cls = STA_STATUS_CLASS[p.status] || 'info';
  const label = STA_STATUS_LABEL[p.status] || p.status;
  const gamesPreview = (p.games || []).slice(0, 3).map(g => escapeHtml(g.name)).join(' • ') + (p.games.length > 3 ? ` +${p.games.length - 3}` : '');
  const ownersCount = p.ownersCount || 0;
  return `
    <tr>
      <td>${img ? `<img src="${escapeHtml(img)}" loading="lazy" ${IMG_ONERROR_ATTR} style="width:64px;height:36px;object-fit:cover;border-radius:6px;">` : '<span style="color:var(--text-3);">-</span>'}</td>
      <td><b>${escapeHtml(p.name)}</b>${p.games.length ? `<div style="color:var(--text-faint);font-size:11px;margin-top:2px;">${gamesPreview}</div>` : ''}</td>
      <td>${p.gamesCount} Games</td>
      <td>Rp${Number(p.price).toLocaleString('id-ID')}</td>
      <td>
        <span class="log-badge log-badge--${cls} sta-status-toggle" data-id="${p.id}" style="cursor:pointer;" title="Klik untuk ubah status">
          ${label}
        </span>
      </td>
      <td>${ownersCount > 0 ? `<span title="Jumlah user yang memiliki akun ini">${ownersCount} user</span>` : '<span style="color:var(--text-3);">Belum ada</span>'}</td>
      <td style="text-align:right;">
        <button class="btn btn-secondary btn-sm sta-content-btn" data-id="${p.id}"><svg class="icon icon-16"><use href="#ic-package"></use></svg> Kelola Game</button>
        <button class="btn btn-secondary btn-sm sta-edit-btn" data-id="${p.id}"><svg class="icon icon-16"><use href="#ic-pencil"></use></svg> Edit</button>
        <button class="btn btn-secondary btn-sm sta-delete-btn" data-id="${p.id}" data-owners="${ownersCount}" style="color:var(--red);" ${ownersCount > 0 ? 'title="Sudah dimiliki user — akan meminta konfirmasi Hapus Paksa"' : ''}><svg class="icon icon-16"><use href="#ic-trash-2"></use></svg> ${ownersCount > 0 ? 'Hapus Paksa' : 'Hapus'}</button>
      </td>
    </tr>`;
}

async function openSteamAccountModal(id) {
  _staEditId = id || null;
  let p = null;
  if (id) {
    // PERF FIX: sebelumnya SELALU fetch ulang detail akun ke server tiap buka
    // modal Edit, padahal /api/admin/steam-accounts (loadSteamAccounts, sudah
    // jalan duluan buat isi tabel) sudah mengembalikan data LENGKAP yang sama
    // persis (termasuk credentials) per akun — tinggal pakai dari cache.
    // Fallback fetch cuma kalau entah kenapa belum ada di cache.
    p = _staAccountList.find(x => x.id === id) || null;
    if (!p) {
      try { p = (await api(`/api/admin/steam-accounts/${id}`)).product; }
      catch (e) { return showToast('Gagal memuat detail akun: ' + e.message, 'error'); }
    }
  }

  document.getElementById('staModalTitle').textContent = p ? 'Edit Steam Account' : 'Tambah Steam Account';
  document.getElementById('staNewProductHint').style.display = p ? 'none' : 'flex';
  document.getElementById('staEditCredsHint').style.display = p ? 'block' : 'none';
  document.getElementById('staProductId').value = id || '';
  document.getElementById('staProductName').value = p?.name || '';
  document.getElementById('staProductPrice').value = p?.price || '';
  document.getElementById('staProductStatus').value = p?.status || 'available';
  document.getElementById('staProductStatus').disabled = false;
  document.getElementById('staProductDescription').value = p?.description || '';
  document.getElementById('staProductCaraBermain').value = p?.caraBermain || '';
  document.getElementById('staProductImportantInfo').value = p?.importantInfo || '';
  document.getElementById('staProductUsername').value = p ? (p.credentials?.username || '') : '';
  document.getElementById('staProductPassword').value = p ? (p.credentials?.password || '') : '';

  // PERF FIX: jangan prefill imageData lama (biar
  // tidak resend base64 tiap Simpan tanpa ganti gambar), preview pakai
  // endpoint /image langsung kalau hasImage true.
  _staImagePayload = { imageUrl: p?.imageUrl || '', imageData: '' };
  document.getElementById('staProductImageUrl').value = p?.imageUrl || '';
  document.getElementById('staProductImageFile').value = '';
  if (p?.imageUrl) {
    setStaImageType('url');
    showStaImagePreview(p.imageUrl);
  } else if (p?.imageData) {
    setStaImageType('file');
    showStaImagePreview(p.imageData);
  } else if (p?.hasImage) {
    setStaImageType('file');
    showStaImagePreview(adminImageUrl(`/api/admin/steam-accounts/${id}/image`));
  } else {
    setStaImageType('file');
    document.getElementById('staImagePreviewWrap').style.display = 'none';
  }

  document.getElementById('steamAccountModalBackdrop').style.display = 'flex';
}
window.openSteamAccountModal = openSteamAccountModal;

function closeSteamAccountModal() {
  document.getElementById('steamAccountModalBackdrop').style.display = 'none';
  document.getElementById('staProductStatus').disabled = false;
  _staEditId = null;
}
window.closeSteamAccountModal = closeSteamAccountModal;

async function saveSteamAccount() {
  const btn = document.getElementById('btnSaveSteamAccount');
  const username = document.getElementById('staProductUsername').value.trim();
  const password = document.getElementById('staProductPassword').value.trim();
  const payload = {
    name: document.getElementById('staProductName').value.trim(),
    price: Number(document.getElementById('staProductPrice').value),
    status: document.getElementById('staProductStatus').value,
    description: document.getElementById('staProductDescription').value.trim(),
    caraBermain: document.getElementById('staProductCaraBermain').value.trim(),
    importantInfo: document.getElementById('staProductImportantInfo').value.trim(),
    imageData: _staImagePayload.imageData || undefined,
    imageUrl: _staImagePayload.imageUrl || undefined
  };
  if (!_staEditId || username) payload.username = username;
  if (!_staEditId || password) payload.password = password;

  if (!payload.name) return showToast('Nama produk wajib diisi.', 'error');
  if (!payload.price || payload.price <= 0) return showToast('Harga produk tidak valid.', 'error');
  if (!_staEditId && (!username || !password)) return showToast('Username & password akun Steam wajib diisi.', 'error');

  btn.disabled = true;
  btn.textContent = 'Menyimpan...';
  try {
    if (_staEditId) {
      const { product } = await api(`/api/admin/steam-accounts/${_staEditId}`, { method: 'PUT', body: JSON.stringify(payload) });
      showToast('Akun berhasil diperbarui.', 'success');
      closeSteamAccountModal();
      // PERF FIX: update akun ini saja di state lokal & render ulang tabel —
      // TIDAK fetch ulang semua akun (+ semua gambar/credentials) buat 1 perubahan.
      const idx = _staAccountList.findIndex(x => x.id === _staEditId);
      if (idx !== -1 && product) _staAccountList[idx] = product;
      renderSteamAccountsTable(_staAccountList);
    } else {
      const created = (await api('/api/admin/steam-accounts', { method: 'POST', body: JSON.stringify(payload) })).product;
      showToast('Akun berhasil ditambahkan! Sekarang tambahkan game lewat Steam App ID.', 'success');
      closeSteamAccountModal();
      // PERF FIX: tambahkan akun baru ke state lokal langsung, tidak reload semua.
      _staAccountList.push(created);
      renderSteamAccountsTable(_staAccountList);
      openSteamAccountContentPage(created.id);
    }
  } catch (e) {
    showToast('Gagal menyimpan akun: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Simpan Akun';
  }
}
window.saveSteamAccount = saveSteamAccount;

// ── Kelola Game (search App ID -> preview -> add) ──
function openSteamAccountContentPage(id) {
  _staContentProductId = id;
  document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
  loadPage('steamaccountscontent');
}
window.openSteamAccountContentPage = openSteamAccountContentPage;

async function renderSteamAccountsContentPage() {
  document.getElementById('staSearchAppId').value = '';
  document.getElementById('staSearchPreviewWrap').innerHTML = '';
  document.getElementById('staBulkAppIds').value = '';
  document.getElementById('staBulkResultWrap').innerHTML = '';
  _staSearchedGame = null;
  const wrap = document.getElementById('staGamesListWrap');
  if (!_staContentProductId) { wrap.innerHTML = '<p style="color:var(--text-3);">Akun tidak dipilih.</p>'; return; }
  wrap.innerHTML = `<p style="padding:20px;text-align:center;color:var(--text-3);"><svg class="icon icon-18"><use href="#ic-loader-circle"></use></svg> Memuat...</p>`;
  try {
    _staContentProduct = (await api(`/api/admin/steam-accounts/${_staContentProductId}`)).product;
    document.getElementById('staContentTitle').textContent = `Kelola Game — ${_staContentProduct.name}`;
    renderStaGamesList();
  } catch (e) {
    wrap.innerHTML = `<p style="color:var(--red);">Gagal memuat: ${escapeHtml(e.message)}</p>`;
  }
}

function renderStaGamesList() {
  const wrap = document.getElementById('staGamesListWrap');
  const games = _staContentProduct?.games || [];
  if (!games.length) {
    wrap.innerHTML = `<div style="color:var(--text-3);text-align:center;padding:20px;">Belum ada game. Cari lewat Steam App ID di atas.</div>`;
    return;
  }
  wrap.innerHTML = `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px;">
    ${games.map((g, idx) => `
      <div style="border:1px solid var(--line-hi);border-radius:12px;overflow:hidden;background:rgba(255,255,255,.02);position:relative;">
        ${idx === 0 && typeof g.price === 'number' ? `<div style="position:absolute;top:8px;left:8px;background:var(--accent, #f5a623);color:#1a1a1a;font-size:10.5px;font-weight:800;padding:2px 8px;border-radius:20px;z-index:1;">TERMAHAL</div>` : ''}
        ${g.headerImage ? `<img src="${escapeHtml(g.headerImage)}" style="width:100%;height:110px;object-fit:cover;">` : ''}
        <div style="padding:10px 12px;">
          <div style="font-weight:700;">${escapeHtml(g.name)}</div>
          <div style="color:var(--text-faint);font-size:11.5px;margin:2px 0 4px;">App ID: ${escapeHtml(g.appId)}</div>
          <div style="color:var(--text-dim);font-size:11.5px;margin-bottom:8px;">${g.priceFormatted ? escapeHtml(g.priceFormatted) : (typeof g.price === 'number' ? '$' + (g.price / 100).toFixed(2) : 'Harga tidak diketahui')}</div>
          <button class="btn btn-secondary btn-sm sta-remove-game-btn" data-appid="${escapeHtml(g.appId)}" style="width:100%;color:var(--red);"><svg class="icon icon-16"><use href="#ic-trash-2"></use></svg> Hapus dari Akun</button>
        </div>
      </div>`).join('')}
  </div>`;
  wrap.querySelectorAll('.sta-remove-game-btn').forEach(b => b.addEventListener('click', () => removeStaGame(b.dataset.appid)));
}

async function searchStaGame() {
  const appId = document.getElementById('staSearchAppId').value.trim();
  const previewWrap = document.getElementById('staSearchPreviewWrap');
  if (!appId) return showToast('Isi Steam App ID dulu.', 'error');
  previewWrap.innerHTML = `<p style="padding:16px;color:var(--text-3);"><svg class="icon icon-18"><use href="#ic-loader-circle"></use></svg> Mencari...</p>`;
  try {
    const data = await api(`/api/admin/steam-accounts/search-game?appId=${encodeURIComponent(appId)}`);
    _staSearchedGame = data.game;
    const g = data.game;
    const reqMin = g.minimumRequirements || g.pcRequirements?.minimum || '';
    const reqRec = g.recommendedRequirements || g.pcRequirements?.recommended || '';
    previewWrap.innerHTML = `
      <div style="margin-top:14px;border:1px solid var(--line-hi);border-radius:12px;overflow:hidden;max-width:520px;">
        ${g.headerImage ? `<img src="${escapeHtml(g.headerImage)}" style="width:100%;height:150px;object-fit:cover;">` : ''}
        <div style="padding:14px;">
          <div style="font-weight:700;font-size:15px;">${escapeHtml(g.name)}</div>
          <div style="color:var(--text-faint);font-size:11.5px;margin:2px 0 10px;">Steam App ID: ${escapeHtml(String(g.appId))}</div>
          ${(g.genres || []).length ? `<div style="color:var(--text-dim);font-size:12px;margin-bottom:8px;">${(g.genres || []).join(' • ')}</div>` : ''}
          ${g.shortDescription ? `<div style="color:var(--text-dim);font-size:12.5px;line-height:1.5;margin-bottom:10px;">${escapeHtml(g.shortDescription)}</div>` : ''}
          ${reqMin ? `<div style="font-size:11.5px;color:var(--text-faint);margin-bottom:10px;"><b>Min. Requirements:</b> tersedia otomatis dari Steam saat ditampilkan di App.</div>` : ''}
          <button class="btn btn-primary" id="btnStaAddToAccount" style="width:100%;"><svg class="icon icon-16"><use href="#ic-plus"></use></svg> Add to Steam Account</button>
        </div>
      </div>`;
    document.getElementById('btnStaAddToAccount').addEventListener('click', addStaGame);
  } catch (e) {
    previewWrap.innerHTML = `<p style="padding:16px;color:var(--red);">${escapeHtml(e.message)}</p>`;
  }
}

async function addStaGame() {
  if (!_staSearchedGame) return;
  const btn = document.getElementById('btnStaAddToAccount');
  btn.disabled = true;
  try {
    _staContentProduct = (await api(`/api/admin/steam-accounts/${_staContentProductId}/games`, {
      method: 'POST', body: JSON.stringify({ appId: _staSearchedGame.appId })
    })).product;
    showToast(`${_staSearchedGame.name} ditambahkan ke akun.`, 'success');
    document.getElementById('staSearchAppId').value = '';
    document.getElementById('staSearchPreviewWrap').innerHTML = '';
    _staSearchedGame = null;
    renderStaGamesList();
  } catch (e) {
    showToast('Gagal menambahkan game: ' + e.message, 'error');
    btn.disabled = false;
  }
}

// ── FITUR BARU: Tambah Banyak Sekaligus — panggil endpoint /games/bulk yang
// terpisah dari addStaGame() di atas (endpoint & fungsi lama tidak disentuh).
// Textarea boleh diisi banyak App ID dipisah baris baru/koma/spasi. Hasil
// (berhasil/dilewati/gagal) ditampilkan supaya admin tahu App ID mana yang
// bermasalah tanpa harus menebak-nebak.
async function bulkAddStaGames() {
  const textarea = document.getElementById('staBulkAppIds');
  const resultWrap = document.getElementById('staBulkResultWrap');
  const raw = textarea.value.trim();
  if (!raw) return showToast('Isi minimal 1 App ID dulu.', 'error');

  const btn = document.getElementById('btnStaBulkAdd');
  btn.disabled = true;
  const originalHtml = btn.innerHTML;
  btn.innerHTML = `<svg class="icon icon-16"><use href="#ic-loader-circle"></use></svg> Memproses...`;
  resultWrap.innerHTML = `<p style="color:var(--text-3);"><svg class="icon icon-18"><use href="#ic-loader-circle"></use></svg> Mencari & menambahkan game satu per satu, mohon tunggu...</p>`;

  try {
    const data = await api(`/api/admin/steam-accounts/${_staContentProductId}/games/bulk`, {
      method: 'POST', body: JSON.stringify({ appIds: raw })
    });
    _staContentProduct = data.product;
    renderStaGamesList();

    const { added, skipped, failed } = data;
    let html = '';
    if (added.length) {
      html += `<div style="margin-bottom:10px;">
        <div style="font-weight:700;color:var(--green);margin-bottom:6px;"><svg class="icon icon-16"><use href="#ic-check"></use></svg> Berhasil ditambahkan (${added.length}) — sudah diurutkan termahal duluan:</div>
        ${added.map(a => `<div style="font-size:12.5px;color:var(--text-dim);padding:3px 0;">• ${escapeHtml(a.name || a.appId)} <span style="color:var(--text-faint);">(App ID: ${escapeHtml(a.appId)}${a.priceFormatted ? ' — ' + escapeHtml(a.priceFormatted) : ''})</span></div>`).join('')}
      </div>`;
    }
    if (skipped.length) {
      html += `<div style="margin-bottom:10px;">
        <div style="font-weight:700;color:var(--yellow, #d4a017);margin-bottom:6px;"><svg class="icon icon-16"><use href="#ic-info"></use></svg> Dilewati (${skipped.length}):</div>
        ${skipped.map(s => `<div style="font-size:12.5px;color:var(--text-dim);padding:3px 0;">• App ID ${escapeHtml(s.appId)} — ${escapeHtml(s.reason)}</div>`).join('')}
      </div>`;
    }
    if (failed.length) {
      html += `<div>
        <div style="font-weight:700;color:var(--red);margin-bottom:6px;"><svg class="icon icon-16"><use href="#ic-circle-x"></use></svg> Gagal (${failed.length}):</div>
        ${failed.map(f => `<div style="font-size:12.5px;color:var(--text-dim);padding:3px 0;">• App ID ${escapeHtml(f.appId)} — ${escapeHtml(f.reason)}</div>`).join('')}
      </div>`;
    }
    resultWrap.innerHTML = html || `<p style="color:var(--text-3);">Tidak ada yang diproses.</p>`;

    if (added.length) {
      textarea.value = '';
      showToast(`${added.length} game berhasil ditambahkan & diurutkan.`, 'success');
    } else {
      showToast('Tidak ada game baru yang ditambahkan — cek detail di bawah tombol.', 'error');
    }
  } catch (e) {
    resultWrap.innerHTML = `<p style="color:var(--red);">Gagal memproses: ${escapeHtml(e.message)}</p>`;
    showToast('Gagal menambahkan game: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalHtml;
  }
}

// Refresh RINGAN — dipanggil oleh event realtime steamAccounts:products:update
// waktu halaman "Kelola Game" (Steam Account) lagi dibuka, supaya daftar game
// ikut sinkron kalau ada perubahan dari sesi Admin lain (atau tab lain punya
// Admin yang sama), TANPA reset input pencarian App ID yang sedang diketik.
async function reloadStaContentProductOnly() {
  if (!_staContentProductId) return;
  try {
    _staContentProduct = (await api(`/api/admin/steam-accounts/${_staContentProductId}`)).product;
    document.getElementById('staContentTitle').textContent = `Kelola Game — ${_staContentProduct.name}`;
    renderStaGamesList();
  } catch (e) { /* noop — biarkan data lama, coba lagi di update berikutnya */ }
}

async function removeStaGame(appId) {
  if (!confirm('Hapus game ini dari akun?')) return;
  try {
    _staContentProduct = (await api(`/api/admin/steam-accounts/${_staContentProductId}/games/${encodeURIComponent(appId)}`, { method: 'DELETE' })).product;
    showToast('Game dihapus dari akun.', 'success');
    renderStaGamesList();
  } catch (e) {
    showToast('Gagal menghapus game: ' + e.message, 'error');
  }
}

async function loadSteamAccountOrders() {
  const table = document.getElementById('tableSteamAccountOrders');
  table.innerHTML = `<tbody><tr><td style="padding:20px;text-align:center;color:var(--text-3);"><svg class="icon icon-18"><use href="#ic-loader-circle"></use></svg> Memuat order...</td></tr></tbody>`;
  try {
    const status = document.getElementById('staOrderStatusFilter').value;
    const q = document.getElementById('staOrderSearchInput').value.trim();
    const params = new URLSearchParams();
    if (status) params.set('status', status);
    if (q) params.set('q', q);
    const data = await api('/api/admin/steam-accounts/orders/list?' + params.toString());
    renderSteamAccountOrdersTable(data.orders || []);
  } catch (e) {
    table.innerHTML = `<tbody><tr><td style="padding:20px;text-align:center;color:var(--red);">Gagal memuat order: ${escapeHtml(e.message)}</td></tr></tbody>`;
  }
}

function renderSteamAccountOrdersTable(list) {
  const table = document.getElementById('tableSteamAccountOrders');
  if (!list.length) {
    table.innerHTML = `<tbody><tr><td style="padding:24px;text-align:center;color:var(--text-3);"><svg class="icon icon-18"><use href="#ic-receipt"></use></svg> Belum ada order Steam Account.</td></tr></tbody>`;
    return;
  }
  table.innerHTML = `
    <thead>
      <tr>
        <th>Invoice</th>
        <th>User</th>
        <th>Akun</th>
        <th>Nominal</th>
        <th>Metode</th>
        <th>Status</th>
        <th>Waktu Order</th>
        <th style="text-align:right;">Aksi</th>
      </tr>
    </thead>
    <tbody>${list.map(staOrderRowHtml).join('')}</tbody>`;
}

function staOrderRowHtml(o) {
  const cls = TX_STATUS_CLASS[o.status] || 'info';
  const label = TX_STATUS_LABEL[o.status] || o.status;
  return `
    <tr>
      <td><code style="font-weight:700;letter-spacing:.02em;">${escapeHtml(o.orderId)}</code></td>
      <td>${escapeHtml(o.username || o.discordId || '—')}</td>
      <td>${escapeHtml(o.productName)}</td>
      <td>Rp${Number(o.totalPayment || o.amount).toLocaleString('id-ID')}</td>
      <td>${escapeHtml(String(o.paymentMethod || '-').toUpperCase())}</td>
      <td><span class="log-badge log-badge--${cls}">${label}</span></td>
      <td>${fmtDateShort(o.createdAt)}</td>
      <td style="text-align:right;">
        <button class="btn btn-secondary btn-sm sta-order-refresh-btn" data-id="${escapeHtml(o.orderId)}" ${o.status !== 'pending' ? 'disabled' : ''}>
          <svg class="icon icon-16"><use href="#ic-refresh-cw"></use></svg> Refresh
        </button>
        <button class="btn btn-secondary btn-sm sta-order-cancel-btn" data-id="${escapeHtml(o.orderId)}" style="color:var(--red);" ${o.status !== 'pending' ? 'disabled' : ''}>
          <svg class="icon icon-16"><use href="#ic-circle-x"></use></svg> Batalkan
        </button>
      </td>
    </tr>`;
}

// ══════════════════════════════════════════════════════════════════════════
// APP UPDATE PAGE — Auto Update & Force Update (GitHub Releases)
// ══════════════════════════════════════════════════════════════════════════
async function renderAppUpdatePage() {
  const statusEl = document.getElementById('auStatus');
  statusEl.textContent = 'Memuat...';
  try {
    const cfg = await api('/api/admin/app-update');
    document.getElementById('auLatestVersion').value = cfg.latestVersion || '';
    document.getElementById('auDownloadUrl').value = cfg.downloadUrl || '';
    document.getElementById('auReleaseUrl').value = cfg.releaseUrl || '';
    document.getElementById('auFileSizeLabel').value = cfg.fileSizeLabel || '';
    document.getElementById('auChangelog').value = cfg.changelog || '';
    document.getElementById('auAutoUpdateEnabled').checked = !!cfg.autoUpdateEnabled;
    document.getElementById('auForceUpdateEnabled').checked = !!cfg.forceUpdateEnabled;
    document.getElementById('auForceMessage').value = cfg.forceUpdateMessage || '';
    statusEl.textContent = cfg.updatedAt ? `Terakhir diubah: ${fmtDateShort(cfg.updatedAt)} oleh ${escapeHtml(cfg.updatedBy || 'Admin')}` : '';
    renderAppUpdateHistory(cfg.history || []);
  } catch (e) {
    statusEl.textContent = '';
    showToast(e.message, 'error');
  }
}

function renderAppUpdateHistory(history) {
  const el = document.getElementById('auHistoryList');
  if (!history.length) {
    el.innerHTML = `<div style="color:var(--text-faint);">Belum ada riwayat versi.</div>`;
    return;
  }
  el.innerHTML = history.map(h => `
    <div style="padding:10px 0;border-bottom:1px solid rgba(255,255,255,.06);">
      <div style="display:flex;justify-content:space-between;gap:10px;">
        <strong style="color:var(--text-1,#fff);">v${escapeHtml(h.version)}</strong>
        <span style="color:var(--text-faint);font-size:11.5px;">${h.releasedAt ? fmtDateShort(h.releasedAt) : ''}</span>
      </div>
      ${h.changelog ? `<div style="margin-top:4px;white-space:pre-wrap;color:var(--text-3);">${escapeHtml(h.changelog)}</div>` : ''}
    </div>
  `).join('');
}

document.getElementById('btnSaveAppUpdate')?.addEventListener('click', async () => {
  const btn = document.getElementById('btnSaveAppUpdate');
  const statusEl = document.getElementById('auStatus');
  const forceUpdateEnabled = document.getElementById('auForceUpdateEnabled').checked;
  const autoUpdateEnabled = document.getElementById('auAutoUpdateEnabled').checked || forceUpdateEnabled;
  const downloadUrl = document.getElementById('auDownloadUrl').value.trim();

  if (autoUpdateEnabled && !downloadUrl) {
    showToast('Link installer (GitHub Release) wajib diisi kalau Auto Update / Force Update aktif.', 'error');
    return;
  }
  if (forceUpdateEnabled && !confirm('Aktifkan Force Update? Seluruh user dengan versi lama TIDAK BISA memakai app sama sekali sampai mereka update. Lanjutkan?')) {
    return;
  }

  btn.disabled = true;
  const original = btn.innerHTML;
  btn.innerHTML = 'Menyimpan...';
  try {
    const payload = {
      latestVersion: document.getElementById('auLatestVersion').value.trim(),
      downloadUrl,
      releaseUrl: document.getElementById('auReleaseUrl').value.trim(),
      fileSizeLabel: document.getElementById('auFileSizeLabel').value.trim(),
      changelog: document.getElementById('auChangelog').value,
      autoUpdateEnabled,
      forceUpdateEnabled,
      forceUpdateMessage: document.getElementById('auForceMessage').value.trim()
    };
    const cfg = await api('/api/admin/app-update', { method: 'PUT', body: JSON.stringify(payload) });
    showToast('Pengaturan App Update disimpan & langsung diterapkan ke App.', 'success');
    statusEl.textContent = `Terakhir diubah: ${fmtDateShort(cfg.updatedAt)} oleh ${escapeHtml(cfg.updatedBy || 'Admin')}`;
    renderAppUpdateHistory(cfg.history || []);
  } catch (e) {
    showToast(e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = original;
  }
});

// ─── MAINTENANCE MODE ───
let _moWhitelist = []; // working copy di memori, dikirim utuh saat Simpan

// Konversi ISO datetime (disimpan di DB) <-> value input type="datetime-local"
// (butuh format "YYYY-MM-DDTHH:mm", tanpa detik/timezone).
function isoToDatetimeLocal(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function datetimeLocalToIso(val) {
  if (!val) return '';
  const d = new Date(val);
  if (isNaN(d.getTime())) return '';
  return d.toISOString();
}

async function renderMaintenancePage() {
  const statusEl = document.getElementById('moStatus');
  statusEl.textContent = 'Memuat...';
  try {
    const cfg = await api('/api/admin/maintenance');
    document.getElementById('moEnabled').checked = !!cfg.enabled;
    document.getElementById('moTitle').value = cfg.title || '';
    document.getElementById('moDescription').value = cfg.description || '';
    document.getElementById('moMessage').value = cfg.message || '';
    document.getElementById('moBannerUrl').value = cfg.bannerUrl || '';
    document.getElementById('moEstimatedCompletion').value = isoToDatetimeLocal(cfg.estimatedCompletion);
    _moWhitelist = Array.isArray(cfg.whitelist) ? [...cfg.whitelist] : [];
    renderMoWhitelistList();
    statusEl.textContent = cfg.updatedAt ? `Terakhir diubah: ${fmtDateShort(cfg.updatedAt)} oleh ${escapeHtml(cfg.updatedBy || 'Admin')}` : '';
  } catch (e) {
    statusEl.textContent = '';
    showToast(e.message, 'error');
  }
}

function renderMoWhitelistList() {
  const el = document.getElementById('moWhitelistList');
  if (!_moWhitelist.length) {
    el.innerHTML = `<div style="color:var(--text-faint);font-size:12px;">Belum ada user di whitelist.</div>`;
    return;
  }
  el.innerHTML = _moWhitelist.map((w, i) => `
    <div style="display:flex;align-items:center;gap:8px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.06);border-radius:8px;padding:8px 10px;">
      <div style="flex:1;min-width:0;">
        <div style="font-size:12.5px;font-weight:700;color:var(--text-1,#fff);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(w.discordId)}</div>
        ${w.note ? `<div style="font-size:11px;color:var(--text-faint);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(w.note)}</div>` : ''}
      </div>
      <button class="rc-btn-icon danger" title="Hapus" data-mo-remove="${i}" style="flex-shrink:0;"><svg class="icon icon-16"><use href="#ic-trash-2"></use></svg></button>
    </div>
  `).join('');
}

document.getElementById('moWhitelistList')?.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-mo-remove]');
  if (!btn) return;
  const i = parseInt(btn.dataset.moRemove, 10);
  _moWhitelist.splice(i, 1);
  renderMoWhitelistList();
});

document.getElementById('btnMoWhitelistAdd')?.addEventListener('click', () => {
  const idInput = document.getElementById('moWhitelistDiscordId');
  const noteInput = document.getElementById('moWhitelistNote');
  const discordId = idInput.value.trim();
  const note = noteInput.value.trim();
  if (!discordId) {
    showToast('Discord ID wajib diisi.', 'error');
    return;
  }
  if (_moWhitelist.some(w => w.discordId === discordId)) {
    showToast('Discord ID itu sudah ada di whitelist.', 'error');
    return;
  }
  _moWhitelist.push({ discordId, note });
  idInput.value = '';
  noteInput.value = '';
  renderMoWhitelistList();
});

document.getElementById('btnSaveMaintenance')?.addEventListener('click', async () => {
  const btn = document.getElementById('btnSaveMaintenance');
  const statusEl = document.getElementById('moStatus');
  const enabled = document.getElementById('moEnabled').checked;

  if (enabled && !confirm('Aktifkan Maintenance Mode? Seluruh user (kecuali Admin & yang di-whitelist) TIDAK BISA memakai App sama sekali sampai dimatikan lagi. Lanjutkan?')) {
    return;
  }

  btn.disabled = true;
  const original = btn.innerHTML;
  btn.innerHTML = 'Menyimpan...';
  try {
    const payload = {
      enabled,
      title: document.getElementById('moTitle').value.trim(),
      description: document.getElementById('moDescription').value,
      message: document.getElementById('moMessage').value,
      bannerUrl: document.getElementById('moBannerUrl').value.trim(),
      estimatedCompletion: datetimeLocalToIso(document.getElementById('moEstimatedCompletion').value),
      whitelist: _moWhitelist
    };
    const cfg = await api('/api/admin/maintenance', { method: 'PUT', body: JSON.stringify(payload) });
    showToast('Pengaturan Maintenance Mode disimpan & langsung diterapkan ke App.', 'success');
    statusEl.textContent = `Terakhir diubah: ${fmtDateShort(cfg.updatedAt)} oleh ${escapeHtml(cfg.updatedBy || 'Admin')}`;
    _moWhitelist = Array.isArray(cfg.whitelist) ? [...cfg.whitelist] : [];
    renderMoWhitelistList();
  } catch (e) {
    showToast(e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = original;
  }
});

// ─── WELCOME POPUP ───
let _wpItems = []; // working copy di memori, dikirim utuh saat Simpan

async function renderWelcomePopupPage() {
  const statusEl = document.getElementById('wpStatus');
  statusEl.textContent = 'Memuat...';
  try {
    const cfg = await api('/api/admin/welcome-popup');
    document.getElementById('wpEnabled').checked = !!cfg.enabled;
    document.getElementById('wpTitle').value = cfg.title || '';
    document.getElementById('wpDescription').value = cfg.description || '';
    document.getElementById('wpBannerUrl').value = cfg.bannerUrl || '';
    document.getElementById('wpPrimaryButtonText').value = cfg.primaryButtonText || '';
    document.getElementById('wpSecondaryButtonText').value = cfg.secondaryButtonText || '';
    _wpItems = Array.isArray(cfg.items) ? [...cfg.items] : [];
    renderWpItemsList();
    statusEl.textContent = cfg.updatedAt
      ? `Terakhir diubah: ${fmtDateShort(cfg.updatedAt)} oleh ${escapeHtml(cfg.updatedBy || 'Admin')} · Versi ${cfg.version || 1}`
      : `Versi ${cfg.version || 1}`;
  } catch (e) {
    statusEl.textContent = '';
    showToast(e.message, 'error');
  }
}

function renderWpItemsList() {
  const el = document.getElementById('wpItemsList');
  if (!_wpItems.length) {
    el.innerHTML = `<div style="color:var(--text-faint);font-size:12px;">Belum ada informasi ditambahkan.</div>`;
    return;
  }
  el.innerHTML = _wpItems.map((item, i) => `
    <div style="display:flex;align-items:center;gap:8px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.06);border-radius:8px;padding:8px 10px;">
      <div style="flex:1;min-width:0;font-size:12.5px;color:var(--text-1,#fff);">${escapeHtml(item)}</div>
      <button class="rc-btn-icon danger" title="Hapus" data-wp-remove="${i}" style="flex-shrink:0;"><svg class="icon icon-16"><use href="#ic-trash-2"></use></svg></button>
    </div>
  `).join('');
}

document.getElementById('wpItemsList')?.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-wp-remove]');
  if (!btn) return;
  const i = parseInt(btn.dataset.wpRemove, 10);
  _wpItems.splice(i, 1);
  renderWpItemsList();
});

function wpAddItem() {
  const input = document.getElementById('wpItemInput');
  const val = input.value.trim();
  if (!val) {
    showToast('Isi informasi tidak boleh kosong.', 'error');
    return;
  }
  _wpItems.push(val);
  input.value = '';
  renderWpItemsList();
}

document.getElementById('btnWpItemAdd')?.addEventListener('click', wpAddItem);
document.getElementById('wpItemInput')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); wpAddItem(); }
});

document.getElementById('btnSaveWelcomePopup')?.addEventListener('click', async () => {
  const btn = document.getElementById('btnSaveWelcomePopup');
  const statusEl = document.getElementById('wpStatus');
  btn.disabled = true;
  const original = btn.innerHTML;
  btn.innerHTML = 'Menyimpan...';
  try {
    const payload = {
      enabled: document.getElementById('wpEnabled').checked,
      title: document.getElementById('wpTitle').value.trim(),
      description: document.getElementById('wpDescription').value,
      bannerUrl: document.getElementById('wpBannerUrl').value.trim(),
      primaryButtonText: document.getElementById('wpPrimaryButtonText').value.trim(),
      secondaryButtonText: document.getElementById('wpSecondaryButtonText').value.trim(),
      items: _wpItems
    };
    const cfg = await api('/api/admin/welcome-popup', { method: 'PUT', body: JSON.stringify(payload) });
    showToast('Pengaturan Welcome Popup disimpan & langsung diterapkan.', 'success');
    statusEl.textContent = `Terakhir diubah: ${fmtDateShort(cfg.updatedAt)} oleh ${escapeHtml(cfg.updatedBy || 'Admin')} · Versi ${cfg.version || 1}`;
    _wpItems = Array.isArray(cfg.items) ? [...cfg.items] : [];
    renderWpItemsList();
  } catch (e) {
    showToast(e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = original;
  }
});

document.getElementById('btnWpForceReshow')?.addEventListener('click', async () => {
  if (!confirm('Paksa tampil kembali ke SEMUA user? Popup ini akan muncul lagi walau user sudah pernah menutupnya sebelumnya.')) {
    return;
  }
  const btn = document.getElementById('btnWpForceReshow');
  const statusEl = document.getElementById('wpStatus');
  btn.disabled = true;
  const original = btn.innerHTML;
  btn.innerHTML = 'Memproses...';
  try {
    const cfg = await api('/api/admin/welcome-popup/force-reshow', { method: 'POST' });
    showToast('Welcome Popup akan tampil kembali ke semua user.', 'success');
    statusEl.textContent = `Terakhir diubah: ${fmtDateShort(cfg.updatedAt)} oleh ${escapeHtml(cfg.updatedBy || 'Admin')} · Versi ${cfg.version || 1}`;
  } catch (e) {
    showToast(e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = original;
  }
});

// ── TEST WELCOME POPUP KE USER TERTENTU — cari user by Discord ID (GET
// /api/admin/welcome-popup/lookup), tampilkan hasil + tombol konfirmasi kirim
// (POST /api/admin/welcome-popup/test). Memakai konfigurasi yang SEDANG
// TERSIMPAN di DB (bukan draft form ini kalau belum di-Save), TIDAK PERNAH
// mengubah config/version Welcome Popup global maupun status dismiss user. ──
let _wpTestTarget = null;

async function searchWelcomePopupTestUser() {
  const input = document.getElementById('wpTestDiscordId');
  const resultEl = document.getElementById('wpTestResult');
  const btn = document.getElementById('btnWpTestSearch');
  const discordId = input.value.trim();
  _wpTestTarget = null;
  if (!discordId) { showToast('Masukkan Discord ID.', 'error'); return; }

  btn.disabled = true;
  resultEl.innerHTML = `<div style="font-size:12px;color:var(--text-3);"><svg class="icon icon-16"><use href="#ic-loader-circle"></use></svg> Mencari user...</div>`;
  try {
    const data = await api('/api/admin/welcome-popup/lookup?discordId=' + encodeURIComponent(discordId));
    _wpTestTarget = data.user;
    resultEl.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:14px;padding:12px 14px;border:1px solid var(--line);border-radius:10px;background:rgba(255,255,255,.03);flex-wrap:wrap;">
        <div>
          <div style="font-weight:600;">${escapeHtml(data.user.username)}</div>
          <div style="font-size:12px;color:var(--text-3);margin-top:2px;"><code>${escapeHtml(data.user.discordId)}</code> · Paket: ${escapeHtml(data.user.role)}</div>
        </div>
        <button class="btn btn-primary" id="btnWpTestSend"><svg class="icon icon-18"><use href="#ic-bell"></use></svg> Kirim Test</button>
      </div>`;
    document.getElementById('btnWpTestSend').addEventListener('click', sendWelcomePopupTest);
  } catch (e) {
    if (e.message === 'not_found') {
      resultEl.innerHTML = `<div style="font-size:13px;color:var(--text-3);padding:10px 0;">User tidak ditemukan.</div>`;
    } else {
      resultEl.innerHTML = `<div style="font-size:13px;color:var(--red);padding:10px 0;">Gagal mencari user: ${escapeHtml(e.message)}</div>`;
    }
  } finally {
    btn.disabled = false;
  }
}

async function sendWelcomePopupTest() {
  if (!_wpTestTarget) return;
  const btn = document.getElementById('btnWpTestSend');
  btn.disabled = true;
  try {
    await api('/api/admin/welcome-popup/test', { method: 'POST', body: JSON.stringify({ discordId: _wpTestTarget.discordId }) });
    showToast(`Welcome Popup test terkirim ke ${_wpTestTarget.username}.`, 'success');
  } catch (e) {
    showToast('Gagal mengirim test: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

document.getElementById('btnWpTestSearch')?.addEventListener('click', searchWelcomePopupTestUser);
document.getElementById('wpTestDiscordId')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); searchWelcomePopupTestUser(); }
});


// ─── ACTIVE TOOLS (halaman Settings App) ───
async function renderActiveToolsPage() {
  const statusEl = document.getElementById('atStatus');
  statusEl.textContent = 'Memuat...';
  try {
    const cfg = await api('/api/admin/active-tools');
    document.getElementById('atMethod').value = cfg.activationMethod === 'powershell' ? 'powershell' : 'link';
    document.getElementById('atZipUrl').value = cfg.zipUrl || '';
    document.getElementById('atVersion').value = cfg.version || '';
    document.getElementById('atPsCommand').value = cfg.powershellCommand || '';
    document.getElementById('atDescription').value = cfg.description || '';
    document.getElementById('atEnabled').checked = !!cfg.enabled;
    updateActiveToolsMethodFields();
    statusEl.textContent = cfg.updatedAt ? `Terakhir diubah: ${fmtDateShort(cfg.updatedAt)} oleh ${escapeHtml(cfg.updatedBy || 'Admin')}` : '';
  } catch (e) {
    statusEl.textContent = '';
    showToast(e.message, 'error');
  }
  renderCloudFixSection();
}

// Tampilkan field "Link ZIP GitHub + Versi" ATAU "PowerShell Command" sesuai
// Activation Method yang dipilih — dua-duanya tetap disimpan di form (tidak
// di-reset) walau lagi disembunyikan, supaya admin bisa gonta-ganti metode
// tanpa kehilangan isian yang sudah diketik di metode satunya.
function updateActiveToolsMethodFields() {
  const isPs = document.getElementById('atMethod').value === 'powershell';
  document.getElementById('atLinkFields').style.display = isPs ? 'none' : '';
  document.getElementById('atPsFields').style.display = isPs ? '' : 'none';
}
document.getElementById('atMethod')?.addEventListener('change', updateActiveToolsMethodFields);

// CLOUD FIX — sama strukturnya dengan Active Tools, di halaman yang sama.
async function renderCloudFixSection() {
  const statusEl = document.getElementById('cfStatus');
  statusEl.textContent = 'Memuat...';
  try {
    const cfg = await api('/api/admin/cloud-fix');
    document.getElementById('cfZipUrl').value = cfg.zipUrl || '';
    document.getElementById('cfVersion').value = cfg.version || '';
    document.getElementById('cfDescription').value = cfg.description || '';
    document.getElementById('cfEnabled').checked = !!cfg.enabled;
    statusEl.textContent = cfg.updatedAt ? `Terakhir diubah: ${fmtDateShort(cfg.updatedAt)} oleh ${escapeHtml(cfg.updatedBy || 'Admin')}` : '';
  } catch (e) {
    statusEl.textContent = '';
    showToast(e.message, 'error');
  }
}

document.getElementById('btnSaveCloudFix')?.addEventListener('click', async () => {
  const btn = document.getElementById('btnSaveCloudFix');
  const statusEl = document.getElementById('cfStatus');
  const enabled = document.getElementById('cfEnabled').checked;
  const zipUrl = document.getElementById('cfZipUrl').value.trim();
  const version = document.getElementById('cfVersion').value.trim();

  if (enabled && !zipUrl) {
    showToast('Link ZIP GitHub wajib diisi kalau fitur ini diaktifkan.', 'error');
    return;
  }
  if (enabled && !version) {
    showToast('Versi wajib diisi kalau fitur ini diaktifkan.', 'error');
    return;
  }

  btn.disabled = true;
  const original = btn.innerHTML;
  btn.innerHTML = 'Menyimpan...';
  try {
    const payload = {
      enabled,
      zipUrl,
      version,
      description: document.getElementById('cfDescription').value.trim()
    };
    const cfg = await api('/api/admin/cloud-fix', { method: 'PUT', body: JSON.stringify(payload) });
    showToast('Pengaturan Cloud FIX disimpan & langsung diterapkan ke App.', 'success');
    statusEl.textContent = `Terakhir diubah: ${fmtDateShort(cfg.updatedAt)} oleh ${escapeHtml(cfg.updatedBy || 'Admin')}`;
  } catch (e) {
    showToast(e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = original;
  }
});

document.getElementById('btnSaveActiveTools')?.addEventListener('click', async () => {
  const btn = document.getElementById('btnSaveActiveTools');
  const statusEl = document.getElementById('atStatus');
  const enabled = document.getElementById('atEnabled').checked;
  const activationMethod = document.getElementById('atMethod').value === 'powershell' ? 'powershell' : 'link';
  const zipUrl = document.getElementById('atZipUrl').value.trim();
  const version = document.getElementById('atVersion').value.trim();
  const powershellCommand = document.getElementById('atPsCommand').value.trim();

  if (enabled && activationMethod === 'link') {
    if (!zipUrl) { showToast('Link ZIP GitHub wajib diisi kalau fitur Active Tools diaktifkan (metode Link).', 'error'); return; }
    if (!version) { showToast('Versi Tools wajib diisi kalau fitur Active Tools diaktifkan (metode Link).', 'error'); return; }
  }
  if (enabled && activationMethod === 'powershell' && !powershellCommand) {
    showToast('PowerShell Command wajib diisi kalau fitur Active Tools diaktifkan (metode PowerShell).', 'error');
    return;
  }

  btn.disabled = true;
  const original = btn.innerHTML;
  btn.innerHTML = 'Menyimpan...';
  try {
    const payload = {
      enabled,
      activationMethod,
      zipUrl,
      version,
      powershellCommand,
      description: document.getElementById('atDescription').value.trim()
    };
    const cfg = await api('/api/admin/active-tools', { method: 'PUT', body: JSON.stringify(payload) });
    showToast('Pengaturan Active Tools disimpan & langsung diterapkan ke App.', 'success');
    statusEl.textContent = `Terakhir diubah: ${fmtDateShort(cfg.updatedAt)} oleh ${escapeHtml(cfg.updatedBy || 'Admin')}`;
  } catch (e) {
    showToast(e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = original;
  }
});

// ══════════════════════════════════════════════════════════════════════════
// PENGATURAN REQUEST GAME — aktif/nonaktif fitur, limit harian per paket, jam reset.
// ══════════════════════════════════════════════════════════════════════════
let _rgsWired = false;

function wireRequestGameSettingsOnce() {
  if (_rgsWired) return;
  _rgsWired = true;
  const resetSelect = document.getElementById('rgsResetHour');
  resetSelect.innerHTML = Array.from({ length: 24 }).map((_, h) => `<option value="${h}">${String(h).padStart(2, '0')}:00 WIB</option>`).join('');
  document.getElementById('btnRgsSave').addEventListener('click', saveRequestGameSettings);
}

async function loadRequestGameSettings() {
  wireRequestGameSettingsOnce();
  const statusEl = document.getElementById('rgsStatus');
  try {
    const cfg = await api('/api/admin/request-game-settings');
    document.getElementById('rgsEnabled').checked = !!cfg.enabled;
    document.getElementById('rgsLimitPublic').value = cfg.dailyLimits?.public ?? 0;
    document.getElementById('rgsLimitGold').value = cfg.dailyLimits?.gold ?? 1;
    document.getElementById('rgsLimitPlatinum').value = cfg.dailyLimits?.platinum ?? 2;
    document.getElementById('rgsLimitAdmin').value = cfg.dailyLimits?.admin ?? 999;
    document.getElementById('rgsResetHour').value = String(cfg.resetHour ?? 0);
    statusEl.textContent = cfg.updatedAt ? `Terakhir diubah: ${fmtDateShort(cfg.updatedAt)} oleh ${escapeHtml(cfg.updatedBy || 'Admin')}` : '';
  } catch (e) {
    statusEl.textContent = '';
    showToast('Gagal memuat pengaturan Request Game: ' + e.message, 'error');
  }
}

async function saveRequestGameSettings() {
  const btn = document.getElementById('btnRgsSave');
  const original = btn.innerHTML;
  btn.disabled = true; btn.innerHTML = 'Menyimpan...';
  try {
    const payload = {
      enabled: document.getElementById('rgsEnabled').checked,
      resetHour: parseInt(document.getElementById('rgsResetHour').value, 10),
      dailyLimits: {
        public: parseInt(document.getElementById('rgsLimitPublic').value, 10) || 0,
        gold: parseInt(document.getElementById('rgsLimitGold').value, 10) || 0,
        platinum: parseInt(document.getElementById('rgsLimitPlatinum').value, 10) || 0,
        admin: parseInt(document.getElementById('rgsLimitAdmin').value, 10) || 0
      }
    };
    const cfg = await api('/api/admin/request-game-settings', { method: 'PUT', body: JSON.stringify(payload) });
    showToast('Pengaturan Request Game disimpan & langsung diterapkan ke App.', 'success');
    document.getElementById('rgsStatus').textContent = `Terakhir diubah: ${fmtDateShort(cfg.updatedAt)} oleh ${escapeHtml(cfg.updatedBy || 'Admin')}`;
  } catch (e) {
    showToast('Gagal menyimpan: ' + e.message, 'error');
  } finally {
    btn.disabled = false; btn.innerHTML = original;
  }
}

// ══════════════════════════════════════════════════════════════════════════
// WEBSITE SETTINGS PAGE (Landing Page Netlify)
// ══════════════════════════════════════════════════════════════════════════
let wsFaqList = []; // { id, question, answer, order } — diedit di memori, dikirim utuh saat Simpan

async function renderWebsiteSettingsPage() {
  const statusEl = document.getElementById('wsStatus');
  statusEl.textContent = 'Memuat...';
  try {
    const cfg = await api('/api/admin/website-settings');
    document.getElementById('wsHeroTitle').value = cfg.heroTitle || '';
    document.getElementById('wsHeroSubtitle').value = cfg.heroSubtitle || '';
    document.getElementById('wsHeroBanner').value = cfg.heroBannerUrl || '';
    document.getElementById('wsLogoUrl').value = cfg.logoUrl || '';
    document.getElementById('wsDiscordUrl').value = cfg.discordInviteUrl || '';
    document.getElementById('wsDiscordText').value = cfg.discordCommunityText || '';
    document.getElementById('wsWebsiteVersion').value = cfg.websiteVersion || '';
    document.getElementById('wsSystemRequirements').value = (cfg.systemRequirements || []).join('\n');
    document.getElementById('wsStatsMode').value = cfg.statsMode || 'auto';
    document.getElementById('wsStatGames').value = cfg.manualStats?.totalGames ?? 0;
    document.getElementById('wsStatUsers').value = cfg.manualStats?.totalUsers ?? 0;
    document.getElementById('wsStatDownloads').value = cfg.manualStats?.totalDownloads ?? 0;
    toggleWsManualStats();

    wsFaqList = (cfg.faq || []).map(f => ({ ...f }));
    drawWsFaqList();

    statusEl.textContent = cfg.updatedAt ? `Terakhir diubah: ${fmtDateShort(cfg.updatedAt)} oleh ${escapeHtml(cfg.updatedBy || 'Admin')}` : '';
  } catch (e) {
    statusEl.textContent = '';
    showToast(e.message, 'error');
  }
}

function toggleWsManualStats() {
  const wrap = document.getElementById('wsManualStatsWrap');
  wrap.style.display = document.getElementById('wsStatsMode').value === 'manual' ? 'block' : 'none';
}
document.getElementById('wsStatsMode')?.addEventListener('change', toggleWsManualStats);

function drawWsFaqList() {
  const wrap = document.getElementById('wsFaqList');
  if (!wrap) return;
  if (!wsFaqList.length) {
    wrap.innerHTML = `<div style="padding:20px;text-align:center;color:var(--text-faint);font-size:12.5px;">Belum ada FAQ. Klik "Tambah FAQ" untuk membuat yang pertama.</div>`;
    return;
  }
  wrap.innerHTML = wsFaqList.map((f, i) => `
    <div style="border:1px solid var(--border,rgba(255,255,255,.09));border-radius:12px;padding:14px;display:flex;flex-direction:column;gap:8px;">
      <div style="display:flex;gap:8px;align-items:center;">
        <input class="form-input" style="margin:0;flex:1;" type="text" placeholder="Pertanyaan" value="${escapeHtml(f.question || '')}" oninput="wsFaqList[${i}].question = this.value">
        <button class="btn btn-danger btn-sm" type="button" onclick="wsFaqRemove(${i})"><svg class="icon icon-18"><use href="#ic-trash-2"></use></svg></button>
      </div>
      <textarea class="form-input" rows="2" placeholder="Jawaban" oninput="wsFaqList[${i}].answer = this.value">${escapeHtml(f.answer || '')}</textarea>
    </div>
  `).join('');
}

function wsFaqRemove(i) {
  wsFaqList.splice(i, 1);
  drawWsFaqList();
}

document.getElementById('btnWsFaqAdd')?.addEventListener('click', () => {
  wsFaqList.push({ id: null, question: '', answer: '', order: wsFaqList.length });
  drawWsFaqList();
});

document.getElementById('btnSaveWebsiteSettings')?.addEventListener('click', async () => {
  const btn = document.getElementById('btnSaveWebsiteSettings');
  const statusEl = document.getElementById('wsStatus');
  btn.disabled = true;
  const original = btn.innerHTML;
  btn.innerHTML = 'Menyimpan...';
  try {
    const payload = {
      heroTitle: document.getElementById('wsHeroTitle').value.trim(),
      heroSubtitle: document.getElementById('wsHeroSubtitle').value.trim(),
      heroBannerUrl: document.getElementById('wsHeroBanner').value.trim(),
      logoUrl: document.getElementById('wsLogoUrl').value.trim(),
      discordInviteUrl: document.getElementById('wsDiscordUrl').value.trim(),
      discordCommunityText: document.getElementById('wsDiscordText').value.trim(),
      websiteVersion: document.getElementById('wsWebsiteVersion').value.trim(),
      systemRequirements: document.getElementById('wsSystemRequirements').value.split('\n').map(s => s.trim()).filter(Boolean),
      statsMode: document.getElementById('wsStatsMode').value,
      manualStats: {
        totalGames: parseInt(document.getElementById('wsStatGames').value, 10) || 0,
        totalUsers: parseInt(document.getElementById('wsStatUsers').value, 10) || 0,
        totalDownloads: parseInt(document.getElementById('wsStatDownloads').value, 10) || 0
      },
      faq: wsFaqList.filter(f => f.question.trim() && f.answer.trim())
    };
    const cfg = await api('/api/admin/website-settings', { method: 'PUT', body: JSON.stringify(payload) });
    showToast('Website Settings disimpan & langsung tampil di Landing Page.', 'success');
    statusEl.textContent = `Terakhir diubah: ${fmtDateShort(cfg.updatedAt)} oleh ${escapeHtml(cfg.updatedBy || 'Admin')}`;
    wsFaqList = (cfg.faq || []).map(f => ({ ...f }));
    drawWsFaqList();
  } catch (e) {
    showToast('Gagal menyimpan: ' + e.message, 'error');
  } finally {
    btn.disabled = false; btn.innerHTML = original;
  }
});
// ══════════════════════════════════════════════════════════════════════════
// PACKAGE NOTIFICATION EMBED BUILDER — Admin Web
// (Notification Package → Embed Builder). Lihat packageEmbedManager.js untuk
// mesin template & validasi di sisi server; file ini murni UI (editor +
// live preview ala Discord + palet dynamic variables + save/reset/test).
// ══════════════════════════════════════════════════════════════════════════
let _pebEvents = [];        // daftar kategori dari GET /api/admin/package-embeds
let _pebVariables = [];
let _pebLimits = { title: 256, description: 4096, fieldName: 256, fieldValue: 1024, footerText: 2048, authorName: 256, maxFields: 25, totalEmbed: 6000 };
let _pebSelected = null;    // event key yang lagi dibuka
let _pebTemplate = null;    // working copy (yang diedit)
let _pebSavedJson = null;   // JSON string terakhir yang tersimpan/di-load — buat deteksi unsaved changes
let _pebPreviewMode = 'desktop';
let _pebLastFocusedInput = null; // input/textarea terakhir difokus — target klik tombol variable
let _pebDragFromIdx = null;

function pebDebounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

async function renderPackageEmbedsPage() {
  const root = document.getElementById('pebRoot');
  root.innerHTML = `<div class="nc-skeleton-grid"><div class="nc-skeleton-card"></div><div class="nc-skeleton-card"></div><div class="nc-skeleton-card"></div></div>`;
  try {
    const data = await api('/api/admin/package-embeds');
    _pebEvents = data.events || [];
    _pebVariables = data.variables || [];
    _pebLimits = data.limits || _pebLimits;
    root.innerHTML = `
      <div class="peb-layout">
        <div class="peb-sidebar" id="pebSidebar"></div>
        <div class="peb-editor-wrap">
          <div class="peb-editor-toolbar">
            <div class="peb-unsaved" id="pebUnsaved" style="display:none;">● Unsaved changes</div>
            <div class="peb-toolbar-actions">
              <button class="btn btn-secondary btn-sm" id="pebBtnReset"><svg class="icon icon-16"><use href="#ic-rotate-ccw"></use></svg> Reset to Default</button>
              <button class="btn btn-secondary btn-sm" id="pebBtnTest"><svg class="icon icon-16"><use href="#ic-rocket"></use></svg> Send Test</button>
              <button class="btn btn-primary btn-sm" id="pebBtnSave"><svg class="icon icon-16"><use href="#ic-save"></use></svg> Save Template</button>
            </div>
          </div>
          <div class="peb-body" id="pebBody"></div>
        </div>
        <div class="peb-preview-wrap">
          <div class="peb-preview-toolbar">
            <div class="peb-preview-title"><svg class="icon icon-16"><use href="#ic-message-circle"></use></svg> Live Discord Preview</div>
            <div class="peb-preview-toggle">
              <button class="peb-toggle-btn active" data-mode="desktop"><svg class="icon icon-14"><use href="#ic-monitor"></use></svg> Desktop</button>
              <button class="peb-toggle-btn" data-mode="mobile"><svg class="icon icon-14"><use href="#ic-app-window"></use></svg> Mobile</button>
            </div>
          </div>
          <div class="peb-preview-scroll">
            <div class="peb-discord-frame" id="pebPreview"></div>
          </div>
        </div>
      </div>`;
    pebRenderSidebar();
    document.querySelectorAll('.peb-toggle-btn').forEach(b => b.addEventListener('click', () => {
      document.querySelectorAll('.peb-toggle-btn').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      _pebPreviewMode = b.dataset.mode;
      document.getElementById('pebPreview').classList.toggle('mobile', _pebPreviewMode === 'mobile');
    }));
    document.getElementById('pebBtnSave').addEventListener('click', pebSaveTemplate);
    document.getElementById('pebBtnReset').addEventListener('click', pebResetTemplate);
    document.getElementById('pebBtnTest').addEventListener('click', pebSendTest);

    const firstKey = _pebEvents[0]?.key;
    if (firstKey) await pebSelectEvent(firstKey, true);
  } catch (e) {
    root.innerHTML = `<div class="empty-cell"><span class="empty-icon"><svg class="icon icon-18"><use href="#ic-triangle-alert"></use></svg></span>Gagal memuat Package Embed Builder: ${escapeHtml(e.message)}</div>`;
  }
}

function pebRenderSidebar() {
  const groups = {};
  for (const ev of _pebEvents) { (groups[ev.group] || (groups[ev.group] = [])).push(ev); }
  const html = Object.keys(groups).map(g => `
    <div class="peb-sidebar-group">
      <div class="peb-sidebar-group-label">${escapeHtml(g)}</div>
      ${groups[g].map(ev => `
        <button class="peb-sidebar-item${ev.key === _pebSelected ? ' active' : ''}" data-event="${ev.key}">
          <span class="peb-sidebar-icon">${ev.icon}</span>
          <span class="peb-sidebar-text">
            <span class="peb-sidebar-name">${escapeHtml(ev.label)}</span>
            ${!ev.liveTrigger ? '<span class="peb-sidebar-badge">tidak ada trigger aktif</span>' : (ev.isCustomized ? '<span class="peb-sidebar-badge custom">disesuaikan</span>' : '')}
          </span>
        </button>`).join('')}
    </div>`).join('');
  document.getElementById('pebSidebar').innerHTML = html;
  document.querySelectorAll('.peb-sidebar-item').forEach(btn => {
    btn.addEventListener('click', () => pebSelectEvent(btn.dataset.event));
  });
}

function pebIsDirty() {
  return _pebTemplate && _pebSavedJson !== JSON.stringify(_pebTemplate);
}

async function pebSelectEvent(key, skipConfirm) {
  if (!skipConfirm && pebIsDirty()) {
    if (!confirm('Ada perubahan yang belum disimpan pada kategori ini. Pindah kategori dan buang perubahan?')) return;
  }
  _pebSelected = key;
  document.querySelectorAll('.peb-sidebar-item').forEach(b => b.classList.toggle('active', b.dataset.event === key));
  document.getElementById('pebBody').innerHTML = `<div class="peb-loading">Memuat template...</div>`;
  try {
    const data = await api(`/api/admin/package-embeds/${encodeURIComponent(key)}`);
    _pebTemplate = data.template;
    _pebSavedJson = JSON.stringify(_pebTemplate);
    pebRenderEditor();
    pebUpdatePreview();
    pebUpdateUnsavedBadge();
  } catch (e) {
    document.getElementById('pebBody').innerHTML = `<div class="empty-cell">Gagal memuat: ${escapeHtml(e.message)}</div>`;
  }
}

function pebUpdateUnsavedBadge() {
  document.getElementById('pebUnsaved').style.display = pebIsDirty() ? '' : 'none';
}

function pebOnChange() {
  pebUpdateUnsavedBadge();
  pebUpdatePreview();
}

// ─── VARIABLE PALETTE ───
function pebVariablePaletteHtml() {
  return `<div class="peb-varlist">${_pebVariables.map(v => `<button type="button" class="peb-var-chip" data-var="${v.key}" title="${escapeHtml(v.example)}">+ ${escapeHtml(v.label)}</button>`).join('')}</div>`;
}
function pebWireVariableButtons(scopeEl) {
  scopeEl.querySelectorAll('.peb-var-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = _pebLastFocusedInput;
      if (!target || !document.body.contains(target)) { showToast('Klik dulu di kolom input yang mau diisi, baru klik variable.', 'default'); return; }
      const token = `{{${btn.dataset.var}}}`;
      const start = target.selectionStart ?? target.value.length;
      const end = target.selectionEnd ?? target.value.length;
      target.value = target.value.slice(0, start) + token + target.value.slice(end);
      target.focus();
      target.selectionStart = target.selectionEnd = start + token.length;
      target.dispatchEvent(new Event('input', { bubbles: true }));
    });
  });
}

// ─── EDITOR ───
function pebRenderEditor() {
  const t = _pebTemplate;
  const body = document.getElementById('pebBody');
  body.innerHTML = `
    <div class="peb-card">
      <div class="peb-card-title">Variables</div>
      <div class="peb-card-desc">Klik kolom input yang ingin diisi, lalu klik salah satu variable di bawah untuk menyisipkannya otomatis. Variable yang datanya tidak tersedia pada suatu event akan otomatis disembunyikan (tidak tampil kosong).</div>
      ${pebVariablePaletteHtml()}
    </div>

    <div class="peb-card">
      <div class="peb-card-title">Content</div>
      <div class="form-group">
        <label class="form-label">Title <span class="peb-count" data-count-for="title">${(t.title||'').length}/${_pebLimits.title}</span></label>
        <input class="form-input" id="pebTitle" maxlength="${_pebLimits.title}" value="${escapeHtml(t.title||'')}" placeholder="Judul embed (opsional)">
      </div>
      <div class="form-group">
        <label class="form-label">Description <span class="peb-count" data-count-for="description">${(t.description||'').length}/${_pebLimits.description}</span></label>
        <textarea class="form-input" id="pebDescription" rows="3" maxlength="${_pebLimits.description}" placeholder="Deskripsi embed (opsional)">${escapeHtml(t.description||'')}</textarea>
      </div>
      <div class="peb-row-2">
        <div class="form-group" style="margin:0;">
          <label class="form-label">Color</label>
          <div class="peb-color-row">
            <input type="color" id="pebColorPicker" value="${pebNormalizeHex(t.color)}">
            <input class="form-input" id="pebColorHex" value="${pebNormalizeHex(t.color)}" maxlength="7">
          </div>
        </div>
        <div class="form-group" style="margin:0;">
          <label class="form-label">Title URL (opsional)</label>
          <input class="form-input" id="pebUrl" value="${escapeHtml(t.url||'')}" placeholder="https://...">
        </div>
      </div>
      <div class="peb-inline-toggle">
        <label class="peb-switch"><input type="checkbox" id="pebTimestamp" ${t.timestamp !== false ? 'checked' : ''}><span class="peb-switch-track"></span></label>
        <span>Tampilkan Timestamp</span>
      </div>
    </div>

    <div class="peb-card">
      <div class="peb-card-title">Author</div>
      <div class="peb-row-2">
        <div class="form-group" style="margin:0;"><label class="form-label">Author Name</label><input class="form-input" id="pebAuthorName" value="${escapeHtml(t.author?.name||'')}"></div>
        <div class="form-group" style="margin:0;"><label class="form-label">Author Icon URL</label><input class="form-input" id="pebAuthorIcon" value="${escapeHtml(t.author?.iconUrl||'')}" placeholder="{{avatar_url}}"></div>
      </div>
      <div class="form-group"><label class="form-label">Author URL</label><input class="form-input" id="pebAuthorUrl" value="${escapeHtml(t.author?.url||'')}"></div>
    </div>

    <div class="peb-card">
      <div class="peb-card-title">Thumbnail &amp; Image</div>
      <div class="peb-row-2">
        <div class="form-group" style="margin:0;"><label class="form-label">Thumbnail URL</label><input class="form-input" id="pebThumbnail" value="${escapeHtml(t.thumbnail?.url||'')}" placeholder="{{avatar_url}}"></div>
        <div class="form-group" style="margin:0;"><label class="form-label">Image URL</label><input class="form-input" id="pebImage" value="${escapeHtml(t.image?.url||'')}"></div>
      </div>
    </div>

    <div class="peb-card">
      <div class="peb-card-title-row">
        <div class="peb-card-title">Fields <span class="peb-count">(${(t.fields||[]).length}/${_pebLimits.maxFields})</span></div>
        <button class="btn btn-secondary btn-sm" id="pebAddField"><svg class="icon icon-14"><use href="#ic-plus"></use></svg> Add Field</button>
      </div>
      <div class="peb-card-desc">Drag ikon <svg class="icon icon-14"><use href="#ic-move-horizontal"></use></svg> untuk mengubah urutan field.</div>
      <div id="pebFieldsList" class="peb-fields-list"></div>
    </div>

    <div class="peb-card">
      <div class="peb-card-title">Footer</div>
      <div class="peb-row-2">
        <div class="form-group" style="margin:0;"><label class="form-label">Footer Text <span class="peb-count" data-count-for="footerText">${(t.footer?.text||'').length}/${_pebLimits.footerText}</span></label><input class="form-input" id="pebFooterText" maxlength="${_pebLimits.footerText}" value="${escapeHtml(t.footer?.text||'')}"></div>
        <div class="form-group" style="margin:0;"><label class="form-label">Footer Icon URL</label><input class="form-input" id="pebFooterIcon" value="${escapeHtml(t.footer?.iconUrl||'')}"></div>
      </div>
    </div>

    <div class="peb-card">
      <div class="peb-card-title-row">
        <div class="peb-card-title">Buttons</div>
        <button class="btn btn-secondary btn-sm" id="pebAddButton" ${(t.buttons||[]).length >= 5 ? 'disabled' : ''}><svg class="icon icon-14"><use href="#ic-plus"></use></svg> Add Button</button>
      </div>
      <div class="peb-card-desc">Maksimal 5 tombol. Tombol berupa Link Button (membuka URL), tidak butuh interaksi bot.</div>
      <div id="pebButtonsList" class="peb-buttons-list"></div>
    </div>

    <div class="peb-validation" id="pebValidation" style="display:none;"></div>
  `;

  pebWireVariableButtons(body);
  pebRenderFields();
  pebRenderButtons();
  pebWireContentInputs();
}

function pebNormalizeHex(c) {
  if (!c) return '#8f96a3';
  const s = String(c).trim();
  return /^#[0-9a-fA-F]{6}$/.test(s) ? s : '#8f96a3';
}

function pebWireContentInputs() {
  const track = (el, path, isCheckbox) => {
    el.addEventListener('focus', () => { _pebLastFocusedInput = el; });
    el.addEventListener('input', pebDebounce(() => {
      pebSetPath(path, isCheckbox ? el.checked : el.value);
      const counter = document.querySelector(`[data-count-for="${path.split('.').pop() === 'text' ? 'footerText' : path}"]`);
      if (counter && el.maxLength > 0) counter.textContent = `${el.value.length}/${el.maxLength}`;
      pebOnChange();
    }, 150));
  };
  track(document.getElementById('pebTitle'), 'title');
  track(document.getElementById('pebDescription'), 'description');
  track(document.getElementById('pebUrl'), 'url');
  track(document.getElementById('pebAuthorName'), 'author.name');
  track(document.getElementById('pebAuthorIcon'), 'author.iconUrl');
  track(document.getElementById('pebAuthorUrl'), 'author.url');
  track(document.getElementById('pebThumbnail'), 'thumbnail.url');
  track(document.getElementById('pebImage'), 'image.url');
  track(document.getElementById('pebFooterText'), 'footer.text');
  track(document.getElementById('pebFooterIcon'), 'footer.iconUrl');

  const colorPicker = document.getElementById('pebColorPicker');
  const colorHex = document.getElementById('pebColorHex');
  colorPicker.addEventListener('input', () => { colorHex.value = colorPicker.value; pebSetPath('color', colorPicker.value); pebOnChange(); });
  colorHex.addEventListener('input', pebDebounce(() => {
    if (/^#[0-9a-fA-F]{6}$/.test(colorHex.value)) { colorPicker.value = colorHex.value; pebSetPath('color', colorHex.value); pebOnChange(); }
  }, 150));

  document.getElementById('pebTimestamp').addEventListener('change', (e) => { pebSetPath('timestamp', e.target.checked); pebOnChange(); });
  document.getElementById('pebAddField').addEventListener('click', pebAddField);
  document.getElementById('pebAddButton').addEventListener('click', pebAddButton);
}

function pebSetPath(path, value) {
  const parts = path.split('.');
  let obj = _pebTemplate;
  while (parts.length > 1) {
    const k = parts.shift();
    if (!obj[k]) obj[k] = {};
    obj = obj[k];
  }
  obj[parts[0]] = value;
}

// ─── FIELDS (add/edit/delete/inline/reorder) ───
function pebAddField() {
  if (!_pebTemplate.fields) _pebTemplate.fields = [];
  if (_pebTemplate.fields.length >= _pebLimits.maxFields) { showToast(`Maksimal ${_pebLimits.maxFields} fields.`, 'error'); return; }
  _pebTemplate.fields.push({ name: '', value: '', inline: false });
  pebRenderFields();
  pebOnChange();
}
function pebRenderFields() {
  const list = document.getElementById('pebFieldsList');
  const fields = _pebTemplate.fields || [];
  list.innerHTML = fields.map((f, i) => `
    <div class="peb-field-row" draggable="true" data-idx="${i}">
      <span class="peb-drag-handle"><svg class="icon icon-14"><use href="#ic-move-horizontal"></use></svg></span>
      <div class="peb-field-inputs">
        <input class="form-input peb-field-name" data-idx="${i}" maxlength="${_pebLimits.fieldName}" placeholder="Field name" value="${escapeHtml(f.name||'')}">
        <input class="form-input peb-field-value" data-idx="${i}" maxlength="${_pebLimits.fieldValue}" placeholder="Field value" value="${escapeHtml(f.value||'')}">
      </div>
      <label class="peb-inline-mini"><input type="checkbox" class="peb-field-inline" data-idx="${i}" ${f.inline ? 'checked' : ''}> Inline</label>
      <button class="peb-icon-btn danger peb-field-del" data-idx="${i}" title="Delete field"><svg class="icon icon-14"><use href="#ic-x"></use></svg></button>
    </div>`).join('') || `<div class="peb-empty-hint">Belum ada field. Klik "Add Field".</div>`;

  list.querySelectorAll('.peb-field-name, .peb-field-value').forEach(inp => {
    inp.addEventListener('focus', () => { _pebLastFocusedInput = inp; });
    inp.addEventListener('input', pebDebounce((e) => {
      const idx = +e.target.dataset.idx;
      const key = e.target.classList.contains('peb-field-name') ? 'name' : 'value';
      _pebTemplate.fields[idx][key] = e.target.value;
      pebOnChange();
    }, 150));
  });
  list.querySelectorAll('.peb-field-inline').forEach(cb => {
    cb.addEventListener('change', (e) => { _pebTemplate.fields[+e.target.dataset.idx].inline = e.target.checked; pebOnChange(); });
  });
  list.querySelectorAll('.peb-field-del').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const idx = +e.currentTarget.dataset.idx;
      _pebTemplate.fields.splice(idx, 1);
      pebRenderFields();
      pebOnChange();
    });
  });
  list.querySelectorAll('.peb-field-row').forEach(row => {
    row.addEventListener('dragstart', (e) => { _pebDragFromIdx = +row.dataset.idx; row.classList.add('dragging'); });
    row.addEventListener('dragend', () => { row.classList.remove('dragging'); });
    row.addEventListener('dragover', (e) => e.preventDefault());
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      const toIdx = +row.dataset.idx;
      if (_pebDragFromIdx === null || _pebDragFromIdx === toIdx) return;
      const [moved] = _pebTemplate.fields.splice(_pebDragFromIdx, 1);
      _pebTemplate.fields.splice(toIdx, 0, moved);
      _pebDragFromIdx = null;
      pebRenderFields();
      pebOnChange();
    });
  });
}

// ─── BUTTONS ───
function pebAddButton() {
  if (!_pebTemplate.buttons) _pebTemplate.buttons = [];
  if (_pebTemplate.buttons.length >= 5) return;
  _pebTemplate.buttons.push({ label: '', url: '', style: 'link', enabled: true });
  pebRenderButtons();
  pebOnChange();
}
function pebRenderButtons() {
  const list = document.getElementById('pebButtonsList');
  const buttons = _pebTemplate.buttons || [];
  list.innerHTML = buttons.map((b, i) => `
    <div class="peb-button-row" data-idx="${i}">
      <label class="peb-switch"><input type="checkbox" class="peb-btn-enabled" data-idx="${i}" ${b.enabled !== false ? 'checked' : ''}><span class="peb-switch-track"></span></label>
      <input class="form-input peb-btn-label" data-idx="${i}" placeholder="Label" value="${escapeHtml(b.label||'')}" maxlength="80">
      <input class="form-input peb-btn-url" data-idx="${i}" placeholder="https://..." value="${escapeHtml(b.url||'')}">
      <button class="peb-icon-btn danger peb-btn-del" data-idx="${i}" title="Delete button"><svg class="icon icon-14"><use href="#ic-x"></use></svg></button>
    </div>`).join('') || `<div class="peb-empty-hint">Belum ada button.</div>`;

  list.querySelectorAll('.peb-btn-label, .peb-btn-url').forEach(inp => {
    inp.addEventListener('focus', () => { _pebLastFocusedInput = inp; });
    inp.addEventListener('input', pebDebounce((e) => {
      const idx = +e.target.dataset.idx;
      const key = e.target.classList.contains('peb-btn-label') ? 'label' : 'url';
      _pebTemplate.buttons[idx][key] = e.target.value;
      pebOnChange();
    }, 150));
  });
  list.querySelectorAll('.peb-btn-enabled').forEach(cb => {
    cb.addEventListener('change', (e) => { _pebTemplate.buttons[+e.target.dataset.idx].enabled = e.target.checked; pebOnChange(); });
  });
  list.querySelectorAll('.peb-btn-del').forEach(btn => {
    btn.addEventListener('click', (e) => {
      _pebTemplate.buttons.splice(+e.currentTarget.dataset.idx, 1);
      pebRenderButtons();
      pebOnChange();
      document.getElementById('pebAddButton').disabled = _pebTemplate.buttons.length >= 5;
    });
  });
  document.getElementById('pebAddButton').disabled = buttons.length >= 5;
}

// ─── LIVE PREVIEW (client-side render mirroring packageEmbedManager.renderTemplate) ───
function pebPreviewVars() {
  const map = {};
  for (const v of _pebVariables) map[v.key] = v.example;
  return map;
}
function pebReplaceVars(str, vars) {
  if (typeof str !== 'string' || !str) return '';
  return str.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (m, k) => vars[k.toLowerCase()] ?? '').trim();
}
function pebUpdatePreview() {
  const t = _pebTemplate;
  const vars = pebPreviewVars();
  const el = document.getElementById('pebPreview');
  if (!el) return;
  const title = pebReplaceVars(t.title, vars);
  const description = pebReplaceVars(t.description, vars);
  const authorName = pebReplaceVars(t.author?.name, vars);
  const authorIcon = pebReplaceVars(t.author?.iconUrl, vars);
  const thumb = pebReplaceVars(t.thumbnail?.url, vars);
  const image = pebReplaceVars(t.image?.url, vars);
  const footerText = pebReplaceVars(t.footer?.text, vars);
  const footerIcon = pebReplaceVars(t.footer?.iconUrl, vars);
  const fields = (t.fields||[]).map(f => ({ name: pebReplaceVars(f.name, vars), value: pebReplaceVars(f.value, vars), inline: f.inline }))
    .filter(f => f.name && f.value);
  const buttons = (t.buttons||[]).filter(b => b.enabled !== false && b.label);

  el.className = 'peb-discord-frame' + (_pebPreviewMode === 'mobile' ? ' mobile' : '');
  el.innerHTML = `
    <div class="peb-discord-msg">
      <div class="peb-discord-avatar"><svg class="icon icon-20"><use href="#ic-bot"></use></svg></div>
      <div class="peb-discord-msg-body">
        <div class="peb-discord-msg-header"><span class="peb-discord-botname">31 Tools</span><span class="peb-discord-bot-tag">BOT</span><span class="peb-discord-time">Today</span></div>
        <div class="peb-discord-embed" style="border-left-color:${pebNormalizeHex(t.color)}">
          <div class="peb-discord-embed-main">
            ${authorName ? `<div class="peb-embed-author">${authorIcon ? `<img src="${escapeHtml(authorIcon)}" onerror="this.style.display='none'">` : ''}<span>${escapeHtml(authorName)}</span></div>` : ''}
            ${title ? `<div class="peb-embed-title">${escapeHtml(title)}</div>` : ''}
            ${description ? `<div class="peb-embed-desc">${escapeHtml(description)}</div>` : ''}
            ${fields.length ? `<div class="peb-embed-fields">${fields.map(f => `<div class="peb-embed-field${f.inline ? ' inline' : ''}"><div class="peb-embed-field-name">${escapeHtml(f.name)}</div><div class="peb-embed-field-value">${escapeHtml(f.value)}</div></div>`).join('')}</div>` : ''}
            ${image ? `<img class="peb-embed-image" src="${escapeHtml(image)}" onerror="this.style.display='none'">` : ''}
            ${(footerText || t.timestamp !== false) ? `<div class="peb-embed-footer">${footerIcon ? `<img src="${escapeHtml(footerIcon)}" onerror="this.style.display='none'">` : ''}<span>${escapeHtml(footerText || '')}${footerText && t.timestamp !== false ? ' • ' : ''}${t.timestamp !== false ? 'Hari ini pukul ' + new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }) : ''}</span></div>` : ''}
          </div>
          ${thumb ? `<img class="peb-embed-thumb" src="${escapeHtml(thumb)}" onerror="this.style.display='none'">` : ''}
        </div>
        ${buttons.length ? `<div class="peb-embed-buttons">${buttons.map(b => `<button class="peb-discord-linkbtn" type="button" disabled>${escapeHtml(b.label)} <svg class="icon icon-12"><use href="#ic-link"></use></svg></button>`).join('')}</div>` : ''}
      </div>
    </div>`;
}

// ─── VALIDATION (mirrors packageEmbedManager.validateTemplate — client-side pre-check) ───
function pebValidateLocal(t) {
  const errors = [];
  if ((t.title||'').length > _pebLimits.title) errors.push(`Title melebihi ${_pebLimits.title} karakter.`);
  if ((t.description||'').length > _pebLimits.description) errors.push(`Description melebihi ${_pebLimits.description} karakter.`);
  if ((t.fields||[]).length > _pebLimits.maxFields) errors.push(`Maksimal ${_pebLimits.maxFields} fields.`);
  (t.fields||[]).forEach((f,i) => {
    if ((f.name||'').length > _pebLimits.fieldName) errors.push(`Field #${i+1}: nama melebihi ${_pebLimits.fieldName} karakter.`);
    if ((f.value||'').length > _pebLimits.fieldValue) errors.push(`Field #${i+1}: value melebihi ${_pebLimits.fieldValue} karakter.`);
  });
  let total = (t.title||'').length + (t.description||'').length + (t.footer?.text||'').length + (t.author?.name||'').length;
  for (const f of (t.fields||[])) total += (f.name||'').length + (f.value||'').length;
  if (total > _pebLimits.totalEmbed) errors.push(`Total karakter embed melebihi ${_pebLimits.totalEmbed}.`);
  return errors;
}
function pebShowValidation(errors) {
  const el = document.getElementById('pebValidation');
  if (!el) return;
  if (!errors.length) { el.style.display = 'none'; el.innerHTML = ''; return; }
  el.style.display = '';
  el.innerHTML = `<svg class="icon icon-16"><use href="#ic-triangle-alert"></use></svg> ${errors.map(escapeHtml).join('<br>')}`;
}

// ─── SAVE / RESET / TEST ───
async function pebSaveTemplate() {
  const errors = pebValidateLocal(_pebTemplate);
  pebShowValidation(errors);
  if (errors.length) { showToast('Template melewati batas Discord — perbaiki dulu.', 'error'); return; }
  const btn = document.getElementById('pebBtnSave');
  const original = btn.innerHTML;
  btn.disabled = true; btn.innerHTML = '<svg class="icon icon-16"><use href="#ic-loader-circle"></use></svg> Menyimpan...';
  try {
    const res = await api(`/api/admin/package-embeds/${encodeURIComponent(_pebSelected)}`, { method: 'PUT', body: JSON.stringify({ template: _pebTemplate }) });
    _pebTemplate = res.template;
    _pebSavedJson = JSON.stringify(_pebTemplate);
    pebUpdateUnsavedBadge();
    const ev = _pebEvents.find(e => e.key === _pebSelected);
    if (ev) ev.isCustomized = true;
    pebRenderSidebar();
    showToast('Template berhasil disimpan.', 'success');
  } catch (e) {
    pebShowValidation(e.validation || [e.message]);
    showToast('Gagal menyimpan: ' + e.message, 'error');
  } finally {
    btn.disabled = false; btn.innerHTML = original;
  }
}

async function pebResetTemplate() {
  if (!confirm('Reset template kategori ini ke desain default? Perubahan yang belum disimpan akan hilang.')) return;
  const btn = document.getElementById('pebBtnReset');
  const original = btn.innerHTML;
  btn.disabled = true; btn.innerHTML = '<svg class="icon icon-16"><use href="#ic-loader-circle"></use></svg> Mereset...';
  try {
    const res = await api(`/api/admin/package-embeds/${encodeURIComponent(_pebSelected)}/reset`, { method: 'POST' });
    _pebTemplate = res.template;
    _pebSavedJson = JSON.stringify(_pebTemplate);
    pebRenderEditor();
    pebUpdatePreview();
    pebUpdateUnsavedBadge();
    const ev = _pebEvents.find(e => e.key === _pebSelected);
    if (ev) ev.isCustomized = false;
    pebRenderSidebar();
    showToast('Template dikembalikan ke default.', 'success');
  } catch (e) {
    showToast('Gagal reset: ' + e.message, 'error');
  } finally {
    btn.disabled = false; btn.innerHTML = original;
  }
}

async function pebSendTest() {
  const errors = pebValidateLocal(_pebTemplate);
  pebShowValidation(errors);
  if (errors.length) { showToast('Template melewati batas Discord — perbaiki dulu.', 'error'); return; }
  const btn = document.getElementById('pebBtnTest');
  const original = btn.innerHTML;
  btn.disabled = true; btn.innerHTML = '<svg class="icon icon-16"><use href="#ic-loader-circle"></use></svg> Mengirim...';
  try {
    await api(`/api/admin/package-embeds/${encodeURIComponent(_pebSelected)}/test`, { method: 'POST', body: JSON.stringify({ template: _pebTemplate }) });
    showToast('Test notification terkirim ke channel Paket, cek Discord kamu.', 'success');
  } catch (e) {
    showToast('Gagal kirim test: ' + e.message, 'error');
  } finally {
    btn.disabled = false; btn.innerHTML = original;
  }
}

// Peringatkan sebelum pindah page (nav sidebar utama) kalau ada perubahan
// Package Embed yang belum disimpan.
document.querySelectorAll('.nav-item').forEach(btn => {
  btn.addEventListener('click', (e) => {
    if (currentPage === 'packageembeds' && btn.dataset.page !== 'packageembeds' && pebIsDirty()) {
      if (!confirm('Ada perubahan Package Embed yang belum disimpan. Tinggalkan halaman ini?')) {
        e.stopImmediatePropagation();
      }
    }
  }, true);
});
// ══════════════════════════════════════════════════════════════════════════
// MARKETPLACE (Admin Web) — Product bundel Game/Bypass, dibeli via KlikQRIS
// atau di-whitelist manual. Endpoint: /api/admin/marketplace/*. Kelola Konten
// (Add Game/Bypass) REUSE endpoint /api/admin/games & /api/admin/bypasses
// yang sudah ada (bukan sistem katalog baru) — lihat marketplaceManager.js.
// ══════════════════════════════════════════════════════════════════════════
const MKT_BADGE_PRESETS = ['HOT', 'NEW', 'SALE'];
let _mktWired = false;
let _mktProducts = [];
let _mktEditId = null;
// State gambar di modal Add/Edit Product. TIDAK ada base64 di sini: file dipilih
// disimpan sebagai File (preview pakai object URL lokal) dan baru di-upload
// biner ke backend -> R2 SETELAH product tersimpan.
const MKT_MAX_ADDITIONAL = 5;
const MKT_IMG_MAX_BYTES = 5 * 1024 * 1024;
const MKT_IMG_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
let _mktImg = null;
function mktImgReset() {
  (_mktImg?.additional || []).forEach(a => a.preview && a.file && URL.revokeObjectURL(a.preview));
  if (_mktImg?.mainPreview) URL.revokeObjectURL(_mktImg.mainPreview);
  _mktImg = { mainExistingUrl: null, mainFile: null, mainPreview: null, mainRemove: false, additional: [], removedAdditionalIds: [] };
}
mktImgReset();
let _mktSearchDebounce = null;
let _mktDrawerProductId = null;
let _mktDrawerProduct = null;
let _mktPickerType = null; // 'game' | 'bypass'
let _mktPickerDebounce = null;

async function renderMarketplaceAdmin() {
  wireMarketplacePageOnce();
  await Promise.all([loadMktStats(), loadMktProducts()]);
}

function wireMarketplacePageOnce() {
  if (_mktWired) return;
  _mktWired = true;

  document.getElementById('btnAddMktProduct').addEventListener('click', () => openMktProductModal(null));
  document.getElementById('mktSearchInput').addEventListener('input', () => {
    clearTimeout(_mktSearchDebounce);
    _mktSearchDebounce = setTimeout(loadMktProducts, 350);
  });
  document.getElementById('mktStatusFilter').addEventListener('change', loadMktProducts);

  document.getElementById('mktProductGridWrap').addEventListener('click', (e) => {
    const editBtn = e.target.closest('.mktadm-btn-edit');
    const contentBtn = e.target.closest('.mktadm-btn-content');
    const delBtn = e.target.closest('.mktadm-btn-delete');
    const restoreBtn = e.target.closest('.mktadm-btn-restore');
    if (editBtn) {
      const p = _mktProducts.find(x => x.id === editBtn.dataset.id);
      if (p) openMktProductModal(p);
    } else if (contentBtn) {
      openMktContentDrawer(contentBtn.dataset.id);
    } else if (delBtn) {
      deleteOrDisableMktProduct(delBtn.dataset.id);
    } else if (restoreBtn) {
      restoreMktProduct(restoreBtn.dataset.id);
    }
  });

  document.getElementById('mktProductBadge').addEventListener('change', (e) => {
    const customInput = document.getElementById('mktProductBadgeCustom');
    customInput.style.display = e.target.value === '__custom' ? '' : 'none';
  });

  document.getElementById('mktProductImageFile').addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const err = mktValidateImageFile(file);
    if (err) { showToast(err, 'error'); e.target.value = ''; return; }
    if (_mktImg.mainPreview) URL.revokeObjectURL(_mktImg.mainPreview);
    _mktImg.mainFile = file;
    _mktImg.mainRemove = false;
    _mktImg.mainPreview = URL.createObjectURL(file);
    showMktImagePreview(_mktImg.mainPreview);
  });
  document.getElementById('mktAddImageFile').addEventListener('change', (e) => {
    for (const file of Array.from(e.target.files || [])) {
      if (_mktImg.additional.length >= MKT_MAX_ADDITIONAL) { showToast(`Maksimal ${MKT_MAX_ADDITIONAL} gambar tambahan.`, 'error'); break; }
      const err = mktValidateImageFile(file);
      if (err) { showToast(err, 'error'); continue; }
      _mktImg.additional.push({ id: null, url: null, file, preview: URL.createObjectURL(file), replaceId: null });
    }
    e.target.value = '';
    renderMktAdditionalImages();
  });
  document.getElementById('mktAddImageList').addEventListener('click', (e) => {
    const rm = e.target.closest('[data-mkt-add-remove]');
    const rp = e.target.closest('[data-mkt-add-replace]');
    if (rm) mktRemoveAdditional(Number(rm.dataset.mktAddRemove));
    if (rp) mktReplaceAdditional(Number(rp.dataset.mktAddReplace));
  });

  document.getElementById('btnMktWhitelistSearch').addEventListener('click', searchMktWhitelistUser);
  document.getElementById('mktWhitelistDiscordId').addEventListener('keydown', (e) => { if (e.key === 'Enter') searchMktWhitelistUser(); });

  document.getElementById('mktPickerSearch').addEventListener('input', () => {
    clearTimeout(_mktPickerDebounce);
    _mktPickerDebounce = setTimeout(() => loadMktPickerResults(document.getElementById('mktPickerSearch').value.trim()), 300);
  });
}

function mktValidateImageFile(file) {
  if (!MKT_IMG_TYPES.includes(file.type)) return 'Format gambar harus JPG, PNG, WEBP, atau GIF.';
  if (file.size > MKT_IMG_MAX_BYTES) return 'Ukuran gambar maksimal 5MB.';
  return null;
}

function showMktImagePreview(src) {
  const img = document.getElementById('mktImagePreviewImg');
  img.onerror = () => { img.onerror = null; img.src = IMG_FALLBACK_SRC; };
  img.src = src;
  document.getElementById('mktImagePreviewWrap').style.display = 'block';
}
// "Hapus" pada gambar utama: tandai untuk dihapus saat Simpan (R2 dibersihkan backend).
function clearMktImage() {
  if (_mktImg.mainPreview) URL.revokeObjectURL(_mktImg.mainPreview);
  _mktImg.mainFile = null;
  _mktImg.mainPreview = null;
  _mktImg.mainRemove = !!_mktImg.mainExistingUrl;
  document.getElementById('mktProductImageFile').value = '';
  document.getElementById('mktImagePreviewWrap').style.display = 'none';
}
window.clearMktImage = clearMktImage;

function renderMktAdditionalImages() {
  const list = document.getElementById('mktAddImageList');
  const items = _mktImg.additional;
  document.getElementById('mktAddCount').textContent = `(${items.length}/${MKT_MAX_ADDITIONAL})`;
  document.getElementById('mktAddImageFile').disabled = items.length >= MKT_MAX_ADDITIONAL;
  list.innerHTML = items.map((a, i) => `
    <div style="position:relative;border:1px solid var(--line-hi);border-radius:10px;overflow:hidden;background:var(--navy-900,#0b1020);">
      <img src="${escapeHtml(a.preview || a.url)}" ${IMG_ONERROR_ATTR} style="width:100%;aspect-ratio:16/9;object-fit:cover;display:block;">
      <div style="display:flex;gap:4px;padding:4px;justify-content:space-between;">
        <button type="button" class="btn btn-secondary btn-sm" style="padding:2px 8px;font-size:11px;" data-mkt-add-replace="${i}">Ganti</button>
        <button type="button" class="btn btn-secondary btn-sm" style="padding:2px 8px;font-size:11px;" data-mkt-add-remove="${i}">Hapus</button>
      </div>
      ${a.file ? '<span style="position:absolute;top:4px;left:4px;font-size:10px;padding:1px 6px;border-radius:6px;background:#7b5cff;color:#fff;">baru</span>' : ''}
    </div>`).join('');
}

function mktRemoveAdditional(i) {
  const a = _mktImg.additional[i];
  if (!a) return;
  if (a.file && a.preview) URL.revokeObjectURL(a.preview);
  _mktImg.additional.splice(i, 1);
  const rid = a.id || a.replaceId; // entri hasil "Ganti" yang dihapus = hapus juga gambar aslinya di server
  if (rid) _mktImg.removedAdditionalIds.push(rid);
  renderMktAdditionalImages();
}

function mktReplaceAdditional(i) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = MKT_IMG_TYPES.join(',');
  input.onchange = () => {
    const file = input.files?.[0];
    if (!file) return;
    const err = mktValidateImageFile(file);
    if (err) { showToast(err, 'error'); return; }
    const a = _mktImg.additional[i];
    if (a.file && a.preview) URL.revokeObjectURL(a.preview);
    // Entri existing diganti file baru: upload baru dulu (replaceId), lama dihapus backend SETELAH DB sukses.
    _mktImg.additional[i] = { id: null, url: null, file, preview: URL.createObjectURL(file), replaceId: a.id || a.replaceId || null };
    renderMktAdditionalImages();
  };
  input.click();
}

// Upload biner mentah (bukan base64/JSON) ke backend -> R2.
async function apiUploadMktImage(path, file) {
  const token = localStorage.getItem('adminToken');
  const res = await fetch(SERVER_URL + path, {
    method: 'POST',
    headers: { 'Content-Type': file.type, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: file
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const err = new Error(data.error || 'Upload gambar gagal.'); err.code = data.code; throw err; }
  return data;
}

async function loadMktStats() {
  try {
    const data = await api('/api/admin/marketplace/stats');
    document.getElementById('mktStatTotalProducts').textContent = data.totalProducts;
    document.getElementById('mktStatActiveProducts').textContent = `${data.activeProducts} aktif`;
    document.getElementById('mktStatActive').textContent = data.activeProducts;
    document.getElementById('mktStatOrders').textContent = data.totalOrders;
    document.getElementById('mktStatOrdersCompleted').textContent = `${data.totalCompletedOrders} completed`;
    document.getElementById('mktStatSales').textContent = 'Rp' + Number(data.totalSales || 0).toLocaleString('id-ID');
    renderMktMiniPanels(data);
  } catch (e) {
    showToast('Gagal memuat statistik Marketplace: ' + e.message, 'error');
  }
}

function renderMktMiniPanels(data) {
  const wrap = document.getElementById('mktMiniPanels');
  const panel = (title, iconId, items) => `
    <div class="table-wrap">
      <div class="table-toolbar"><div class="table-toolbar-title"><svg class="icon icon-16"><use href="#${iconId}"></use></svg> ${title}</div></div>
      <div style="padding:6px 16px 14px;display:flex;flex-direction:column;gap:6px;">
        ${items.length ? items.map(p => `
          <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 0;border-bottom:1px solid var(--line);font-size:12.5px;">
            <span style="color:var(--text);font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(p.name)}</span>
            <span style="color:var(--text-faint);white-space:nowrap;">Rp${Number(p.price).toLocaleString('id-ID')}</span>
          </div>`).join('') : `<div style="color:var(--text-faint);font-size:12px;padding:10px 0;">Belum ada data.</div>`}
      </div>
    </div>`;
  wrap.innerHTML = panel('Product Terbaru', 'ic-package', data.newestProducts || []) + panel('Product Terlaris', 'ic-trophy', data.bestSellers || []);
}

async function loadMktProducts() {
  const wrap = document.getElementById('mktProductGridWrap');
  wrap.innerHTML = `<div class="mktadm-empty"><svg class="icon"><use href="#ic-loader-circle"></use></svg><div>Memuat produk...</div></div>`;
  try {
    const status = document.getElementById('mktStatusFilter').value;
    const q = document.getElementById('mktSearchInput').value.trim();
    const params = new URLSearchParams();
    if (status) params.set('status', status);
    if (q) params.set('q', q);
    const data = await api('/api/admin/marketplace/products?' + params.toString());
    _mktProducts = data.products || [];
    renderMktProductGrid(_mktProducts);
  } catch (e) {
    wrap.innerHTML = `<div class="mktadm-empty" style="color:var(--red);">Gagal memuat produk: ${escapeHtml(e.message)}</div>`;
  }
}

function mktBadgeHtml(badge) {
  if (!badge) return '';
  const upper = String(badge).toUpperCase();
  const cls = upper === 'HOT' ? 'hot' : upper === 'NEW' ? 'new' : upper === 'SALE' ? 'sale' : 'custom';
  return `<span class="mktadm-badge mktadm-badge--${cls}">${escapeHtml(badge)}</span>`;
}

function renderMktProductGrid(list) {
  const wrap = document.getElementById('mktProductGridWrap');
  if (!list.length) {
    wrap.innerHTML = `<div class="mktadm-empty"><svg class="icon"><use href="#ic-package"></use></svg><div>Belum ada produk Marketplace. Klik "Add Product" untuk menambahkan.</div></div>`;
    return;
  }
  wrap.innerHTML = `<div class="mktadm-grid">${list.map(mktProductCardHtml).join('')}</div>`;
}

function mktProductCardHtml(p) {
  const imgSrc = p.imageUrl || IMG_FALLBACK_SRC; // URL publik R2 (canonical)
  const isDeleted = p.status === 'deleted';
  const statusCls = p.status === 'active' ? 'active' : isDeleted ? 'deleted' : 'inactive';
  const statusLabel = p.status === 'active' ? 'Aktif' : isDeleted ? 'Dihapus' : 'Nonaktif';
  const contentCount = p.contentCount || 0;
  const accessCount = p.accessCount || 0;
  // Produk yang sudah soft-deleted tidak bisa di-Edit/Kelola Konten lagi dari
  // sini — pulihkan dulu lewat tombol Restore, atau hapus permanen.
  const actionsHtml = isDeleted ? `
        <button class="mktadm-icon-btn mktadm-btn-restore" data-id="${p.id}" title="Pulihkan"><svg class="icon icon-16"><use href="#ic-refresh-cw"></use></svg></button>
        <button class="mktadm-icon-btn mktadm-icon-btn--danger mktadm-btn-delete" data-id="${p.id}" title="Hapus Permanen"><svg class="icon icon-16"><use href="#ic-trash-2"></use></svg></button>` : `
        <button class="mktadm-icon-btn mktadm-btn-edit" data-id="${p.id}" title="Edit"><svg class="icon icon-16"><use href="#ic-pencil"></use></svg></button>
        <button class="mktadm-icon-btn mktadm-btn-content" data-id="${p.id}" title="Kelola Konten"><svg class="icon icon-16"><use href="#ic-package"></use></svg></button>
        <button class="mktadm-icon-btn mktadm-icon-btn--danger mktadm-btn-delete" data-id="${p.id}" title="Hapus"><svg class="icon icon-16"><use href="#ic-trash-2"></use></svg></button>`;
  return `
    <div class="mktadm-card">
      <div class="mktadm-card-img">
        <img src="${escapeHtml(imgSrc)}" ${IMG_ONERROR_ATTR} style="width:100%;height:100%;object-fit:cover;display:block;">
        <div class="mktadm-card-badge-slot">${mktBadgeHtml(p.badge)}</div>
        <div class="mktadm-card-status-slot"><span class="mktadm-status-pill mktadm-status-pill--${statusCls}">${statusLabel}</span></div>
      </div>
      <div class="mktadm-card-body">
        <div class="mktadm-card-title" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</div>
        <div class="mktadm-card-meta-row">
          <span class="mktadm-card-price">Rp${Number(p.price).toLocaleString('id-ID')}</span>
        </div>
        <div class="mktadm-card-stats">
          <span><svg class="icon icon-14"><use href="#ic-shopping-bag"></use></svg> ${accessCount} pembeli</span>
          <span><svg class="icon icon-14"><use href="#ic-package"></use></svg> ${contentCount} konten</span>
        </div>
      </div>
      <div class="mktadm-card-actions">${actionsHtml}
      </div>
    </div>`;
}

function openMktProductModal(p) {
  _mktEditId = p ? p.id : null;
  document.getElementById('mktModalTitle').textContent = p ? 'Edit Product' : 'Add Product';
  document.getElementById('mktProductId').value = p ? p.id : '';
  document.getElementById('mktProductName').value = p ? p.name : '';
  document.getElementById('mktProductPrice').value = p ? p.price : '';
  document.getElementById('mktProductStatus').value = p ? p.status : 'active';
  document.getElementById('mktProductDescription').value = p ? (p.description || '') : '';
  populateMktRequirementOptions(p ? p.id : null, p ? p.requiredProductId : null);

  const badgeSel = document.getElementById('mktProductBadge');
  const badgeCustom = document.getElementById('mktProductBadgeCustom');
  if (p && p.badge && !MKT_BADGE_PRESETS.includes(String(p.badge).toUpperCase())) {
    badgeSel.value = '__custom';
    badgeCustom.value = p.badge;
    badgeCustom.style.display = '';
  } else {
    badgeSel.value = p && p.badge ? String(p.badge).toUpperCase() : '';
    badgeCustom.value = '';
    badgeCustom.style.display = 'none';
  }

  mktImgReset();
  document.getElementById('mktProductImageFile').value = '';
  document.getElementById('mktImagePreviewWrap').style.display = 'none';
  if (p && p.imageUrl) {
    _mktImg.mainExistingUrl = p.imageUrl;
    showMktImagePreview(p.imageUrl);
  }
  _mktImg.additional = (p?.additionalImages || []).map(a => ({ id: a.id, url: a.url, file: null, preview: null, replaceId: null }));
  renderMktAdditionalImages();

  document.getElementById('mktProductModalBackdrop').style.display = 'flex';
}
window.openMktProductModal = openMktProductModal;

// Isi dropdown "Requirement" dengan semua Product AKTIF lain (exclude diri
// sendiri saat edit, supaya tidak bisa mensyaratkan diri sendiri — validasi
// yang sama juga ditegakkan ULANG di backend/marketplaceManager.js). Fetch
// terpisah dari _mktProducts (yang bisa saja lagi ke-filter status/search di
// grid) supaya daftar requirement selalu lengkap & konsisten.
async function populateMktRequirementOptions(excludeId, selectedId) {
  const sel = document.getElementById('mktProductRequiredId');
  if (!sel) return;
  sel.innerHTML = '<option value="">Memuat...</option>';
  try {
    const data = await api('/api/admin/marketplace/products?status=active');
    const items = (data.products || []).filter(x => !excludeId || x.id !== excludeId);
    sel.innerHTML = '<option value="">Tanpa requirement</option>' +
      items.map(x => `<option value="${x.id}">${escapeHtml(x.name)}</option>`).join('');
    sel.value = selectedId || '';
  } catch (e) {
    sel.innerHTML = '<option value="">Tanpa requirement</option>';
  }
}

function closeMktProductModal() {
  document.getElementById('mktProductModalBackdrop').style.display = 'none';
}
window.closeMktProductModal = closeMktProductModal;

async function saveMktProduct() {
  const name = document.getElementById('mktProductName').value.trim();
  const price = Number(document.getElementById('mktProductPrice').value);
  const status = document.getElementById('mktProductStatus').value;
  const description = document.getElementById('mktProductDescription').value.trim();
  const badgeSel = document.getElementById('mktProductBadge').value;
  const badge = badgeSel === '__custom' ? document.getElementById('mktProductBadgeCustom').value.trim() : badgeSel;
  const requiredProductId = document.getElementById('mktProductRequiredId').value || null;

  if (!name) { showToast('Nama produk wajib diisi.', 'error'); return; }
  if (!price || price <= 0) { showToast('Harga produk tidak valid.', 'error'); return; }

  const btn = document.getElementById('btnSaveMktProduct');
  btn.disabled = true;
  btn.textContent = 'Menyimpan...';
  try {
    const payload = { name, price, status, description, badge: badge || null, requiredProductId };
    let productId = _mktEditId;
    if (productId) {
      await api(`/api/admin/marketplace/products/${productId}`, { method: 'PUT', body: JSON.stringify(payload) });
    } else {
      const created = await api('/api/admin/marketplace/products', { method: 'POST', body: JSON.stringify(payload) });
      productId = created.product.id;
      _mktEditId = productId; // kalau upload gambar gagal, Simpan berikutnya = edit produk yang sama (tidak duplikat)
    }

    // Gambar: hapus dulu (bebaskan slot), lalu upload. Backend memvalidasi ulang
    // maks 5, format, ukuran, dan memverifikasi URL publik R2 tiap upload.
    const failures = [];
    const base = `/api/admin/marketplace/products/${productId}`;
    const step = async (label, fn) => { try { await fn(); } catch (e) { failures.push(`${label}: ${e.message}`); } };
    for (const id of _mktImg.removedAdditionalIds.splice(0)) {
      await step('Hapus gambar tambahan', () => api(`${base}/images/${id}`, { method: 'DELETE' }));
    }
    if (_mktImg.mainRemove && !_mktImg.mainFile) {
      await step('Hapus gambar utama', () => api(`${base}/image/main`, { method: 'DELETE' }));
      _mktImg.mainExistingUrl = null; _mktImg.mainRemove = false;
    }
    if (_mktImg.mainFile) {
      await step('Gambar utama', async () => {
        await apiUploadMktImage(`${base}/image/main`, _mktImg.mainFile);
        _mktImg.mainFile = null;
      });
    }
    for (const a of _mktImg.additional.filter(x => x.file)) {
      await step('Gambar tambahan', async () => {
        await apiUploadMktImage(`${base}/images${a.replaceId ? `?replaceId=${encodeURIComponent(a.replaceId)}` : ''}`, a.file);
        a.uploaded = true;
      });
    }
    if (failures.length) {
      showToast('Product tersimpan, tetapi ada gambar yang gagal: ' + failures.join(' | '), 'error');
      await loadMktProducts();
      const fresh = _mktProducts.find(x => x.id === productId);
      if (fresh) openMktProductModal(fresh); // muat ulang state dari server supaya bisa dicoba lagi
      return;
    }
    showToast(_mktEditId && !failures.length ? 'Product berhasil disimpan.' : 'Product berhasil ditambahkan.', 'success');
    closeMktProductModal();
    await Promise.all([loadMktStats(), loadMktProducts()]);
  } catch (e) {
    showToast('Gagal menyimpan product: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Simpan Product';
  }
}
window.saveMktProduct = saveMktProduct;

// ROOT CAUSE FIX: sebelumnya fungsi ini selalu jatuh ke "nonaktifkan" saja
// begitu backend membalas 409 (produk sudah punya order/akses) dan TIDAK
// PERNAH memakai jalur hard-delete yang sebenarnya sudah ada di backend —
// jadi produk lama (yang keburu punya order/whitelist dari pemakaian
// sebelumnya) kelihatan "permanen tidak bisa dihapus", padahal produk baru
// yang belum pernah dipakai berhasil terhapus lewat code path yang sama.
// Sekarang backend DELETE selalu benar-benar menghilangkan produk dari
// listing (hard delete kalau belum pernah dipakai, soft-delete/status
// 'deleted' kalau sudah — lihat server.js) dalam SATU aksi, jadi tidak perlu
// lagi round-trip 409 -> confirm -> PUT status:'inactive' di sini.
async function deleteOrDisableMktProduct(id) {
  const p = _mktProducts.find(x => x.id === id);
  const name = p ? p.name : 'produk ini';

  // Produk yang sedang dilihat lewat filter "Dihapus" -> tombol delete di
  // sini berarti Hapus Permanen (hard delete beneran, butuh ketik ulang nama
  // supaya tidak kepencet tidak sengaja — pola sama seperti Hapus Paksa Steam
  // Account).
  if (p && p.status === 'deleted') {
    const typed = prompt(`Produk "${name}" akan dihapus PERMANEN dari database (akses/whitelist ikut terhapus, histori transaksi di menu Transaksi tetap aman). Tindakan ini tidak bisa dibatalkan.\n\nKetik ulang nama produk untuk konfirmasi:`);
    if (typed === null) return;
    if (typed.trim() !== name.trim()) { showToast('Nama tidak cocok, penghapusan dibatalkan.', 'error'); return; }
    try {
      await api(`/api/admin/marketplace/products/${id}?force=true`, { method: 'DELETE' });
      showToast('Product berhasil dihapus permanen.', 'success');
      await Promise.all([loadMktStats(), loadMktProducts()]);
    } catch (e) {
      showToast('Gagal menghapus product: ' + e.message, 'error');
    }
    return;
  }

  const hasHistory = p && ((p.accessCount || 0) > 0 || (p.orderCount || 0) > 0);
  const confirmMsg = hasHistory
    ? `Hapus "${name}"? Produk ini sudah pernah dibeli/di-whitelist, jadi akan disembunyikan dari App & Admin Web (histori transaksinya tetap aman dan tidak hilang).`
    : `Hapus "${name}"? Produk akan langsung hilang dari App & Admin Web.`;
  if (!confirm(confirmMsg)) return;

  try {
    const res = await api(`/api/admin/marketplace/products/${id}`, { method: 'DELETE' });
    showToast(res.softDeleted ? 'Product dihapus (histori transaksi tetap aman).' : 'Product berhasil dihapus.', 'success');
    await Promise.all([loadMktStats(), loadMktProducts()]);
  } catch (e) {
    showToast('Gagal menghapus product: ' + e.message, 'error');
  }
}

async function restoreMktProduct(id) {
  const p = _mktProducts.find(x => x.id === id);
  const name = p ? p.name : 'produk ini';
  if (!confirm(`Pulihkan "${name}"? Produk akan muncul lagi di Admin Web dengan status Nonaktif (aktifkan lagi lewat Edit kalau mau dijual).`)) return;
  try {
    await api(`/api/admin/marketplace/products/${id}/restore`, { method: 'POST' });
    showToast('Product berhasil dipulihkan.', 'success');
    await Promise.all([loadMktStats(), loadMktProducts()]);
  } catch (e) {
    showToast('Gagal memulihkan product: ' + e.message, 'error');
  }
}

// ─── KELOLA KONTEN DRAWER (Game/Bypass + Whitelist) ───
// Refresh RINGAN drawer Kelola Konten yang lagi kebuka (dipanggil dari
// listener 'marketplace:products:update' di atas) — cuma re-fetch & re-render
// konten drawer produk yang aktif, TANPA nutup-buka drawer (biar tidak
// mengganggu admin yang lagi kerja di dalamnya, mis. lagi scroll/isi form
// picker). Best-effort: kalau gagal (mis. drawer barusan ditutup di tengah
// jalan), biarkan saja, tidak perlu toast error untuk refresh pasif begini.
async function reloadMktDrawerContentOnly() {
  if (!_mktDrawerProductId) return;
  try {
    const data = await api(`/api/admin/marketplace/products/${_mktDrawerProductId}`);
    _mktDrawerProduct = data.product;
    document.getElementById('mktDrawerTitle').textContent = `Kelola Konten — ${data.product.name}`;
    renderMktDrawerContent(data.content);
    renderMktWhitelist(data.access);
  } catch (e) { /* noop — drawer mungkin sudah ditutup/produk dihapus admin lain */ }
}

async function openMktContentDrawer(productId) {
  _mktDrawerProductId = productId;
  document.getElementById('mktDrawerBackdrop').style.display = 'block';
  document.getElementById('mktDrawerGames').innerHTML = `<div style="color:var(--text-faint);font-size:12px;">Memuat...</div>`;
  document.getElementById('mktDrawerBypasses').innerHTML = '';
  document.getElementById('mktWhitelistList').innerHTML = '';
  document.getElementById('mktWhitelistSearchResult').innerHTML = '';
  document.getElementById('mktWhitelistDiscordId').value = '';
  try {
    const data = await api(`/api/admin/marketplace/products/${productId}`);
    _mktDrawerProduct = data.product;
    document.getElementById('mktDrawerTitle').textContent = `Kelola Konten — ${data.product.name}`;
    renderMktDrawerContent(data.content);
    renderMktWhitelist(data.access);
  } catch (e) {
    showToast('Gagal memuat konten produk: ' + e.message, 'error');
    closeMktContentDrawer();
  }
}
window.openMktContentDrawer = openMktContentDrawer;

function closeMktContentDrawer() {
  document.getElementById('mktDrawerBackdrop').style.display = 'none';
  _mktDrawerProductId = null;
  _mktDrawerProduct = null;
}
window.closeMktContentDrawer = closeMktContentDrawer;

function mktContentRowHtml(contentType, item) {
  const img = item.imageUrl || IMG_FALLBACK_SRC;
  return `
    <div class="mktadm-content-row">
      <img src="${escapeHtml(img)}" ${IMG_ONERROR_ATTR}>
      <span class="mktadm-content-row-name">${escapeHtml(item.name)}</span>
      <button class="btn btn-secondary btn-sm" onclick="editMktContentItem('${contentType}','${item._id}')">Edit</button>
      <button class="mktadm-remove-btn" onclick="removeMktContent('${contentType}','${item._id}')">Remove</button>
    </div>`;
}

function renderMktDrawerContent(content) {
  const games = content.games || [];
  const bypasses = content.bypasses || [];
  document.getElementById('mktDrawerGames').innerHTML = games.length
    ? games.map(g => mktContentRowHtml('game', g)).join('')
    : `<div style="color:var(--text-faint);font-size:12px;">Belum ada Game di produk ini.</div>`;
  document.getElementById('mktDrawerBypasses').innerHTML = bypasses.length
    ? bypasses.map(b => mktContentRowHtml('bypass', b)).join('')
    : `<div style="color:var(--text-faint);font-size:12px;">Belum ada Bypass di produk ini.</div>`;
}

async function removeMktContent(contentType, itemId) {
  if (!_mktDrawerProductId) return;
  if (!confirm(`Hapus hubungan ${contentType === 'bypass' ? 'Bypass' : 'Game'} ini dari produk? (${contentType === 'bypass' ? 'Bypass' : 'Game'} aslinya TIDAK dihapus.)`)) return;
  try {
    const data = await api(`/api/admin/marketplace/products/${_mktDrawerProductId}/content/${contentType}/${itemId}`, { method: 'DELETE' });
    renderMktDrawerContent(data.content);
    showToast('Konten berhasil dihapus dari produk.', 'success');
    loadMktProducts();
  } catch (e) {
    showToast('Gagal menghapus konten: ' + e.message, 'error');
  }
}
window.removeMktContent = removeMktContent;

// ─── PICKER MODAL (pilih Game/Bypass existing) ───
function openMktPicker(contentType) {
  _mktPickerType = contentType;
  document.getElementById('mktPickerTitle').textContent = contentType === 'bypass' ? 'Hubungkan Bypass Existing' : 'Hubungkan Game Existing';
  document.getElementById('mktPickerSearch').value = '';
  document.getElementById('mktPickerModalBackdrop').style.display = 'flex';
  loadMktPickerResults('');
}
window.openMktPicker = openMktPicker;

function closeMktPicker() {
  document.getElementById('mktPickerModalBackdrop').style.display = 'none';
  _mktPickerType = null;
}
window.closeMktPicker = closeMktPicker;

async function loadMktPickerResults(query) {
  const wrap = document.getElementById('mktPickerResults');
  wrap.innerHTML = `<div style="color:var(--text-faint);font-size:12px;">Memuat...</div>`;
  try {
    const endpoint = _mktPickerType === 'bypass' ? '/api/admin/bypasses' : '/api/admin/games';
    const params = new URLSearchParams({ perPage: '50' });
    if (query) params.set('search', query);
    const data = await api(`${endpoint}?${params.toString()}`);
    const rows = data.rows || [];
    if (!rows.length) {
      wrap.innerHTML = `<div class="mktadm-empty"><svg class="icon"><use href="#ic-search"></use></svg><div>Tidak ada hasil.</div></div>`;
      return;
    }
    wrap.innerHTML = rows.map(item => `
      <div class="mktadm-picker-item" onclick="addMktContentFromPicker('${item._id}')">
        <img src="${escapeHtml(item.imageUrl || IMG_FALLBACK_SRC)}" ${IMG_ONERROR_ATTR}>
        <span class="mktadm-picker-item-name">${escapeHtml(item.name)}</span>
        <svg class="icon icon-16" style="color:var(--violet);flex-shrink:0;"><use href="#ic-plus"></use></svg>
      </div>`).join('');
  } catch (e) {
    wrap.innerHTML = `<div class="mktadm-empty" style="color:var(--red);">Gagal memuat: ${escapeHtml(e.message)}</div>`;
  }
}

async function addMktContentFromPicker(itemId) {
  if (!_mktDrawerProductId || !_mktPickerType) return;
  try {
    const data = await api(`/api/admin/marketplace/products/${_mktDrawerProductId}/content`, {
      method: 'POST', body: JSON.stringify({ contentType: _mktPickerType, itemId })
    });
    renderMktDrawerContent(data.content);
    showToast(`${_mktPickerType === 'bypass' ? 'Bypass' : 'Game'} berhasil ditambahkan ke produk.`, 'success');
    closeMktPicker();
    loadMktProducts();
  } catch (e) {
    showToast('Gagal menambahkan konten: ' + e.message, 'error');
  }
}
window.addMktContentFromPicker = addMktContentFromPicker;

// ─── WHITELIST (product-specific) ───
// FIX: sebelumnya tombol "Cabut" DISABLED untuk akses yang sumbernya
// 'purchase' — jadi user yang beli produk lalu di-"Cabut Akses" oleh admin
// tetap bisa Install/Download selamanya. Sekarang kedua sumber ('purchase'
// maupun 'whitelist') bisa dicabut lewat tombol yang sama; teks konfirmasi
// dibedakan supaya admin tetap sadar kalau yang dicabut adalah akses hasil
// pembelian (bukan cuma whitelist manual) — lihat revokeMktWhitelist().
function mktWhitelistRowHtml(a) {
  const sourceLabel = a.source === 'purchase' ? 'Purchase' : 'Whitelist';
  return `
    <div class="mktadm-content-row">
      <span class="mktadm-content-row-name">${escapeHtml(a.username || a.discordId)}<br><span style="color:var(--text-faint);font-size:11px;">${escapeHtml(a.discordId)}</span></span>
      <span class="mktadm-source-pill mktadm-source-pill--${a.source}">${sourceLabel}</span>
      <button class="mktadm-remove-btn" onclick="revokeMktWhitelist('${a.discordId}', '${a.source}')">Cabut</button>
    </div>`;
}

function renderMktWhitelist(list) {
  const wrap = document.getElementById('mktWhitelistList');
  wrap.innerHTML = list.length
    ? list.map(mktWhitelistRowHtml).join('')
    : `<div style="color:var(--text-faint);font-size:12px;">Belum ada user dengan akses ke produk ini.</div>`;
}

async function searchMktWhitelistUser() {
  const discordId = document.getElementById('mktWhitelistDiscordId').value.trim();
  const resultWrap = document.getElementById('mktWhitelistSearchResult');
  if (!discordId) { showToast('Masukkan Discord ID terlebih dahulu.', 'error'); return; }
  resultWrap.innerHTML = `<div style="color:var(--text-faint);font-size:12px;">Mencari...</div>`;
  try {
    const data = await api(`/api/admin/marketplace/products/${_mktDrawerProductId}/whitelist/lookup?discordId=${encodeURIComponent(discordId)}`);
    const hasAccess = !!data.access;
    resultWrap.innerHTML = `
      <div class="mktadm-content-row">
        <span class="mktadm-content-row-name">${escapeHtml(data.username)}<br><span style="color:var(--text-faint);font-size:11px;">${escapeHtml(data.discordId)} · ${escapeHtml(data.status)}</span></span>
        ${hasAccess
          ? `<span class="mktadm-source-pill mktadm-source-pill--${data.access.source}">Sudah punya akses (${data.access.source})</span>`
          : `<button class="btn btn-primary btn-sm" onclick="grantMktWhitelist('${escapeHtml(data.discordId)}')">Berikan Akses</button>`}
      </div>`;
  } catch (e) {
    resultWrap.innerHTML = `<div style="color:var(--red);font-size:12px;">${escapeHtml(e.message)}</div>`;
  }
}

async function grantMktWhitelist(discordId) {
  try {
    const data = await api(`/api/admin/marketplace/products/${_mktDrawerProductId}/whitelist`, {
      method: 'POST', body: JSON.stringify({ discordId })
    });
    renderMktWhitelist(data.access);
    document.getElementById('mktWhitelistSearchResult').innerHTML = '';
    document.getElementById('mktWhitelistDiscordId').value = '';
    showToast('Whitelist berhasil ditambahkan.', 'success');
    loadMktProducts();
  } catch (e) {
    showToast('Gagal menambahkan whitelist: ' + e.message, 'error');
  }
}
window.grantMktWhitelist = grantMktWhitelist;

async function revokeMktWhitelist(discordId, source) {
  const confirmMsg = source === 'purchase'
    ? 'Cabut akses PEMBELIAN user ini? Akses ke Game/Bypass produk ini akan langsung hilang (tidak bisa Install/Download lagi). Ini BUKAN pembatalan/refund transaksi — kalau user membeli produk ini lagi, akses akan diberikan kembali.'
    : 'Cabut whitelist user ini? Akses ke Game/Bypass produk ini akan langsung hilang.';
  if (!confirm(confirmMsg)) return;
  try {
    const data = await api(`/api/admin/marketplace/products/${_mktDrawerProductId}/whitelist/${discordId}`, { method: 'DELETE' });
    renderMktWhitelist(data.access);
    showToast(source === 'purchase' ? 'Akses pembelian berhasil dicabut.' : 'Whitelist berhasil dicabut.', 'success');
    loadMktProducts();
  } catch (e) {
    showToast('Gagal mencabut akses: ' + e.message, 'error');
  }
}
window.revokeMktWhitelist = revokeMktWhitelist;

// CATATAN: tabel "Order Marketplace" terpisah yang sebelumnya ada di sini
// (di bawah tabel Transaksi Upgrade Paket) sudah DIHAPUS — datanya sekarang
// SUDAH ikut tampil sebagai baris di tabel utama "Daftar Transaksi" halaman
// Transaksi (kolom Jenis = "Marketplace"), lihat listUnifiedAdminTransactions
// di server.js dan txRowHtml() di atas. Endpoint
// /api/admin/marketplace/orders (list/refresh/cancel) TIDAK dihapus & tetap
// dipakai — cuma sekarang dipanggil lewat routing TX_KIND_ENDPOINT di atas.
// ══════════════════════════════════════════════════════════════════════════
// APP CUSTOMIZATION — Background & Branding App Desktop (Admin Web).
// Backend SUDAH ADA (appCustomizationManager.js + server.js, endpoint
// GET/PUT /api/admin/app-customization) — halaman ini murni UI, tidak
// menyentuh sistem lain. Pola api()/showToast() reuse yang sudah ada di atas.
//
// Arsitektur: satu state object `aczConfig` adalah SATU-SATUNYA sumber
// kebenaran. Tiap interaksi (klik pill, geser slider, pilih warna, upload
// gambar) MENGUBAH aczConfig lalu memanggil aczRenderAll() yang menggambar
// ulang seluruh UI + Live Preview dari state itu. Ini yang bikin "live
// preview realtime tanpa Save" gampang dan konsisten (poin #6 permintaan).
// ══════════════════════════════════════════════════════════════════════════
let aczConfig = null;
let _aczListenersBound = false;
let _aczSelectedStopIndex = 0;
// PERF (Save lambat) — dua flag ini nge-track apakah admin BENAR-BENAR
// mengganti background image / logo di sesi edit sekarang (lihat
// aczBindEvents: cuma di-set true dari handler upload file/isi URL/hapus
// gambar, BUKAN dari slider/pill/warna lain). aczSave() pakai flag ini
// buat MEMUTUSKAN mau ikut kirim field `url` (bisa berisi base64 sampai
// 10MB background / 5MB logo) atau tidak — kalau admin cuma ganti warna,
// gradient, overlay, ukuran, atau teks, field url TIDAK ikut dikirim sama
// sekali, jadi request PUT tetap kecil & cepat walau gambar/logo yang
// tersimpan besar. Di-reset ke false tiap kali halaman dibuka
// (renderAppCustomizationPage) dan tiap kali Save berhasil.
let _aczImageTouched = false;
let _aczLogoTouched = false;

const ACZ_DEFAULT_CONFIG = {
  background: {
    mode: 'gradient',
    color: '#0B1020',
    gradient: { type: 'linear', angle: 135, stops: [{ color: '#0B1020', pos: 0 }, { color: '#101F55', pos: 100 }] },
    image: { source: 'upload', url: '', fit: 'cover', position: 'center', opacity: 1, blur: 0 },
    overlay: { enabled: false, color: '#000000', opacity: 0.4 }
  },
  branding: {
    logo: { enabled: false, url: '', size: 20, opacity: 1 },
    text: { enabled: true, value: '31 Tools', fontFamily: 'Inter', fontSize: 16, fontWeight: 600 }
  }
};

// Fallback whitelist kalau backend belum sempat kirim `fonts` (mis. gagal
// fetch) — SAMA PERSIS isinya dengan FONT_WHITELIST di
// appCustomizationManager.js, cuma dipakai sebagai jaring pengaman render.
let ACZ_FONTS = [
  { id: 'Inter', label: 'Inter', stack: "'Inter', 'Segoe UI', sans-serif" },
  { id: 'Poppins', label: 'Poppins', stack: "'Poppins', 'Segoe UI', sans-serif" },
  { id: 'Roboto', label: 'Roboto', stack: "'Roboto', 'Segoe UI', sans-serif" },
  { id: 'Montserrat', label: 'Montserrat', stack: "'Montserrat', 'Segoe UI', sans-serif" },
  { id: 'Space Grotesk', label: 'Space Grotesk', stack: "'Space Grotesk', 'Segoe UI', sans-serif" },
  { id: 'Orbitron', label: 'Orbitron', stack: "'Orbitron', 'Segoe UI', sans-serif" },
  { id: 'Rajdhani', label: 'Rajdhani', stack: "'Rajdhani', 'Segoe UI', sans-serif" },
  { id: 'Bebas Neue', label: 'Bebas Neue', stack: "'Bebas Neue', Impact, sans-serif" },
  { id: 'Oswald', label: 'Oswald', stack: "'Oswald', 'Segoe UI', sans-serif" },
  { id: 'Plus Jakarta Sans', label: 'Plus Jakarta Sans', stack: "'Plus Jakarta Sans', 'Segoe UI', sans-serif" }
];
function aczFontStack(id) {
  return (ACZ_FONTS.find(f => f.id === id) || ACZ_FONTS[0]).stack;
}
function aczRenderFontOptions() {
  const sel = document.getElementById('aczFontFamily');
  if (!sel) return;
  sel.innerHTML = ACZ_FONTS.map(f => `<option value="${escapeHtml(f.id)}" style="font-family:${f.stack}">${escapeHtml(f.label)}</option>`).join('');
}

async function renderAppCustomizationPage() {
  if (!_aczListenersBound) {
    aczBindEvents();
    _aczListenersBound = true;
  }
  const statusEl = document.getElementById('aczStatus');
  try {
    const cfg = await api('/api/admin/app-customization');
    // structuredClone (bukan JSON.parse(JSON.stringify(...))) — fix "halaman
    // App Customization lambat": objek ini bisa berisi background image
    // (base64, maks 10MB) + logo (base64, maks 5MB), jadi serialize+parse
    // ulang lewat JSON dobel-kerja (encode ke teks JSON lalu decode lagi)
    // buat data yang sudah berbentuk objek JS. structuredClone menyalin
    // langsung tanpa lewat teks, jauh lebih cepat untuk objek besar begini
    // — hasil clone-nya identik (deep copy biasa), tidak mengubah data.
    aczConfig = structuredClone({ background: cfg.background, branding: cfg.branding });
    if (Array.isArray(cfg.fonts) && cfg.fonts.length) ACZ_FONTS = cfg.fonts;
    if (statusEl) {
      statusEl.textContent = cfg.updatedAt ? `Terakhir disimpan: ${new Date(cfg.updatedAt).toLocaleString('id-ID')} oleh ${cfg.updatedBy || 'Admin'}` : '';
    }
  } catch (e) {
    aczConfig = structuredClone(ACZ_DEFAULT_CONFIG);
    if (statusEl) statusEl.textContent = 'Gagal memuat config tersimpan, menampilkan default.';
    showToast('Gagal memuat App Customization: ' + e.message, 'error');
  }
  _aczSelectedStopIndex = 0;
  _aczImageTouched = false; // reset — config baru saja dimuat ulang dari server, belum ada perubahan gambar/logo di sesi ini
  _aczLogoTouched = false;
  aczRenderFontOptions();
  aczRenderAll();
}

// ── Semua listener statis (dipasang SEKALI, lihat guard _aczListenersBound
// di atas) — supaya tidak dobel ke-bind kalau Admin bolak-balik ke halaman
// ini. Perubahan data selalu lewat aczRenderAll(), bukan baca-tulis DOM
// langsung, jadi aman dipasang sekali di awal. ──
function aczBindEvents() {
  // Mode Background (Solid/Gradient/Image)
  document.getElementById('aczModeGroup').addEventListener('click', (e) => {
    const btn = e.target.closest('.acz-pill[data-mode]');
    if (!btn) return;
    aczConfig.background.mode = btn.dataset.mode;
    aczRenderAll();
  });

  // Solid color
  document.getElementById('aczSolidSwatch').addEventListener('click', (e) => {
    aczOpenColorPicker(e.currentTarget, aczConfig.background.color, (hex) => {
      aczConfig.background.color = hex;
      aczRenderAll();
    });
  });
  document.getElementById('aczSolidHex').addEventListener('input', (e) => {
    const v = aczNormalizeHexInput(e.target.value);
    if (v) { aczConfig.background.color = v; aczRenderAll({ skipSolidHexInput: true }); }
  });

  // Gradient type (Linear/Radial)
  document.getElementById('aczGradTypeGroup').addEventListener('click', (e) => {
    const btn = e.target.closest('.acz-pill[data-gradtype]');
    if (!btn) return;
    aczConfig.background.gradient.type = btn.dataset.gradtype;
    aczRenderAll();
  });
  document.getElementById('aczAngleSlider').addEventListener('input', (e) => {
    aczConfig.background.gradient.angle = Number(e.target.value);
    aczRenderAll({ skipAngleSlider: true });
  });
  document.getElementById('aczAddStopBtn').addEventListener('click', () => {
    const stops = aczConfig.background.gradient.stops;
    if (stops.length >= 3) { showToast('Maksimal 3 Color Stop.', 'error'); return; }
    // Sisipkan di tengah, warna interpolasi kasar dari stop pertama & terakhir.
    const newPos = 50;
    stops.push({ color: stops[stops.length - 1].color, pos: newPos });
    stops.sort((a, b) => a.pos - b.pos);
    _aczSelectedStopIndex = stops.findIndex(s => s.pos === newPos);
    aczRenderAll();
  });

  // Image Source toggle (Upload Image / Image URL) — SAMA POLA dengan
  // aczModeGroup/aczGradTypeGroup di atas, bukan sistem baru.
  document.getElementById('aczImageSourceGroup').addEventListener('click', (e) => {
    const btn = e.target.closest('.acz-pill[data-imgsource]');
    if (!btn) return;
    aczConfig.background.image.source = btn.dataset.imgsource;
    aczRenderAll();
  });

  // Image upload (maks 10MB, PNG/JPG/JPEG/WEBP — divalidasi ulang di
  // backend, lihat validateBackgroundImageUrl() di appCustomizationManager.js,
  // karena validasi frontend ini bisa di-bypass).
  const ACZ_IMAGE_MIME_WHITELIST = ['image/png', 'image/jpeg', 'image/webp'];
  document.getElementById('aczImageFile').addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!ACZ_IMAGE_MIME_WHITELIST.includes(file.type)) {
      showToast('Format gambar tidak didukung. Gunakan PNG, JPG/JPEG, atau WEBP.', 'error');
      e.target.value = '';
      return;
    }
    if (file.size > 10 * 1024 * 1024) { showToast('Ukuran gambar maksimal 10 MB.', 'error'); e.target.value = ''; return; }
    const reader = new FileReader();
    reader.onload = () => {
      aczConfig.background.image.source = 'upload';
      aczConfig.background.image.url = reader.result;
      _aczImageTouched = true; // PERF: cuma tandai gambar "berubah" kalau admin BENAR-BENAR upload file baru — dipakai aczSave() supaya base64 (bisa puluhan MB) tidak ikut dikirim ulang kalau cuma warna/slider lain yang diedit.
      aczRenderAll();
    };
    reader.readAsDataURL(file);
  });

  // Image URL — preview langsung dari URL yang dimasukkan (sama seperti
  // preview Upload di atas), tanpa download/resize apapun di sisi Admin
  // Web; App nanti pakai URL yang SAMA PERSIS (lihat applyAppBackground()
  // di app.js) jadi tidak ada duplikasi/downscale.
  document.getElementById('aczImageUrlInput').addEventListener('input', (e) => {
    const statusEl = document.getElementById('aczImageUrlStatus');
    const v = e.target.value.trim();
    aczConfig.background.image.source = 'url';
    aczConfig.background.image.url = v;
    _aczImageTouched = true; // PERF: sama seperti upload — dianggap "berubah" begitu admin mengetik/menghapus isi field URL ini.
    if (!v) { statusEl.textContent = ''; aczRenderAll({ skipImageUrlInput: true }); return; }
    if (!/^https?:\/\//i.test(v)) {
      statusEl.textContent = 'Gunakan link yang diawali http:// atau https://';
      statusEl.style.color = '#ff7eb3';
      aczRenderAll({ skipImageUrlInput: true });
      return;
    }
    statusEl.textContent = '';
    aczRenderAll({ skipImageUrlInput: true });
  });
  document.getElementById('aczImagePreviewImg').addEventListener('error', () => {
    if (aczConfig.background.image.source !== 'url') return;
    document.getElementById('aczImageUrlStatus').textContent = 'Gambar gagal dimuat dari URL ini — cek kembali link-nya.';
    document.getElementById('aczImageUrlStatus').style.color = '#ff7eb3';
  });
  document.getElementById('aczImagePreviewImg').addEventListener('load', () => {
    if (aczConfig.background.image.source !== 'url') return;
    document.getElementById('aczImageUrlStatus').textContent = '';
  });

  document.getElementById('aczRemoveImageBtn').addEventListener('click', () => {
    aczConfig.background.image.url = '';
    _aczImageTouched = true; // PERF: menghapus gambar juga "perubahan nyata" pada url, harus ikut terkirim saat Save.
    document.getElementById('aczImageFile').value = '';
    document.getElementById('aczImageUrlInput').value = '';
    document.getElementById('aczImageUrlStatus').textContent = '';
    aczRenderAll();
  });
  document.getElementById('aczImageFit').addEventListener('change', (e) => { aczConfig.background.image.fit = e.target.value; aczRenderAll(); });
  document.getElementById('aczImagePosition').addEventListener('change', (e) => { aczConfig.background.image.position = e.target.value; aczRenderAll(); });
  document.getElementById('aczImageOpacitySlider').addEventListener('input', (e) => {
    aczConfig.background.image.opacity = Number(e.target.value) / 100;
    aczRenderAll({ skipImageOpacitySlider: true });
  });
  document.getElementById('aczImageBlurSlider').addEventListener('input', (e) => {
    aczConfig.background.image.blur = Number(e.target.value);
    aczRenderAll({ skipImageBlurSlider: true });
  });
  document.getElementById('aczOverlayEnabled').addEventListener('change', (e) => { aczConfig.background.overlay.enabled = e.target.checked; aczRenderAll(); });
  document.getElementById('aczOverlaySwatch').addEventListener('click', (e) => {
    aczOpenColorPicker(e.currentTarget, aczConfig.background.overlay.color, (hex) => {
      aczConfig.background.overlay.color = hex;
      aczRenderAll();
    });
  });
  document.getElementById('aczOverlayHex').addEventListener('input', (e) => {
    const v = aczNormalizeHexInput(e.target.value);
    if (v) { aczConfig.background.overlay.color = v; aczRenderAll({ skipOverlayHexInput: true }); }
  });
  document.getElementById('aczOverlayOpacitySlider').addEventListener('input', (e) => {
    aczConfig.background.overlay.opacity = Number(e.target.value) / 100;
    aczRenderAll({ skipOverlayOpacitySlider: true });
  });

  // Branding — logo
  document.getElementById('aczLogoEnabled').addEventListener('change', (e) => { aczConfig.branding.logo.enabled = e.target.checked; aczRenderAll(); });
  document.getElementById('aczLogoFile').addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { showToast('Ukuran logo maksimal 5MB.', 'error'); e.target.value = ''; return; }
    const reader = new FileReader();
    reader.onload = () => {
      aczConfig.branding.logo.url = reader.result;
      _aczLogoTouched = true; // PERF: sama seperti gambar background — tandai "berubah" HANYA saat admin benar-benar upload logo baru.
      aczRenderAll();
    };
    reader.readAsDataURL(file);
  });
  document.getElementById('aczRemoveLogoBtn').addEventListener('click', () => {
    aczConfig.branding.logo.url = '';
    _aczLogoTouched = true; // PERF: hapus logo juga perubahan nyata pada url.
    document.getElementById('aczLogoFile').value = '';
    aczRenderAll();
  });
  document.getElementById('aczLogoSizeSlider').addEventListener('input', (e) => {
    aczConfig.branding.logo.size = Number(e.target.value);
    aczRenderAll({ skipLogoSizeSlider: true });
  });
  document.getElementById('aczLogoOpacitySlider').addEventListener('input', (e) => {
    aczConfig.branding.logo.opacity = Number(e.target.value) / 100;
    aczRenderAll({ skipLogoOpacitySlider: true });
  });

  // Branding — text
  document.getElementById('aczTextEnabled').addEventListener('change', (e) => { aczConfig.branding.text.enabled = e.target.checked; aczRenderAll(); });
  document.getElementById('aczTextValue').addEventListener('input', (e) => {
    aczConfig.branding.text.value = e.target.value;
    aczRenderAll({ skipTextInput: true });
  });

  // Branding — Font Style (poin #8-#12: dropdown premium, preview langsung
  // tanpa Save, realtime ke App lewat Save yang sudah ada — TIDAK ada flow
  // baru, cuma field baru di branding.text yang sudah ikut ke aczSave()).
  document.getElementById('aczFontFamily').addEventListener('change', (e) => {
    aczConfig.branding.text.fontFamily = e.target.value;
    aczRenderAll();
  });
  document.getElementById('aczFontSizeSlider').addEventListener('input', (e) => {
    aczConfig.branding.text.fontSize = Number(e.target.value);
    aczRenderAll({ skipFontSizeSlider: true });
  });
  document.getElementById('aczFontWeight').addEventListener('change', (e) => {
    aczConfig.branding.text.fontWeight = Number(e.target.value);
    aczRenderAll();
  });

  // Save
  document.getElementById('btnSaveAppCustomization').addEventListener('click', aczSave);

  // Color picker popover — Selesai / klik di luar buat nutup
  document.getElementById('aczCpDoneBtn').addEventListener('click', () => aczCloseColorPicker());
  document.addEventListener('mousedown', (e) => {
    const pop = document.getElementById('aczColorPopover');
    if (pop.style.display === 'none') return;
    if (!pop.contains(e.target) && !e.target.closest('.acz-swatch') && !e.target.closest('.acz-gradient-stop-handle')) {
      aczCloseColorPicker();
    }
  });
}

function aczNormalizeHexInput(v) {
  let s = (v || '').trim();
  if (!s) return null;
  if (!s.startsWith('#')) s = '#' + s;
  return /^#[0-9a-fA-F]{6}$/.test(s) ? s : null;
}

// ── Satu fungsi render besar: baca aczConfig, gambar ulang SEMUA bagian UI
// + Live Preview. `opts.skipXxx` dipakai supaya slider/input yang LAGI
// di-drag user sendiri tidak ke-reset value-nya di tengah drag (browser
// biasanya sudah benar tanpa ini, tapi aman kalau ada re-render dari sumber
// lain di saat bersamaan). ──
function aczRenderAll(opts = {}) {
  if (!aczConfig) return;
  const bg = aczConfig.background;
  const br = aczConfig.branding;

  // Mode pills + panel visibility
  document.querySelectorAll('#aczModeGroup .acz-pill').forEach(b => b.classList.toggle('active', b.dataset.mode === bg.mode));
  document.getElementById('aczPanelSolid').style.display = bg.mode === 'solid' ? '' : 'none';
  document.getElementById('aczPanelGradient').style.display = bg.mode === 'gradient' ? '' : 'none';
  document.getElementById('aczPanelImage').style.display = bg.mode === 'image' ? '' : 'none';

  // Solid
  document.getElementById('aczSolidSwatch').style.setProperty('--acz-swatch-color', bg.color);
  if (!opts.skipSolidHexInput) document.getElementById('aczSolidHex').value = bg.color;

  // Gradient
  document.querySelectorAll('#aczGradTypeGroup .acz-pill').forEach(b => b.classList.toggle('active', b.dataset.gradtype === bg.gradient.type));
  document.getElementById('aczAngleWrap').style.display = bg.gradient.type === 'linear' ? '' : 'none';
  if (!opts.skipAngleSlider) document.getElementById('aczAngleSlider').value = bg.gradient.angle;
  document.getElementById('aczAngleValue').textContent = bg.gradient.angle + '°';
  aczRenderGradientBar();
  document.getElementById('aczAddStopBtn').disabled = bg.gradient.stops.length >= 3;
  document.getElementById('aczAddStopBtn').style.opacity = bg.gradient.stops.length >= 3 ? '.5' : '1';

  // Image — Source (Upload / URL): dua sumber, satu field penyimpanan
  // (background.image.url). Toggle cuma nentuin panel mana yang tampil di
  // Admin Web; App tetap cuma baca img.url apa adanya (lihat app.js).
  const img = bg.image;
  const imgSource = img.source === 'url' ? 'url' : 'upload';
  document.querySelectorAll('#aczImageSourceGroup .acz-pill').forEach(b => b.classList.toggle('active', b.dataset.imgsource === imgSource));
  document.getElementById('aczImageUploadWrap').style.display = imgSource === 'upload' ? '' : 'none';
  document.getElementById('aczImageUrlWrap').style.display = imgSource === 'url' ? '' : 'none';
  if (!opts.skipImageUrlInput) {
    // Hanya isi kotak input kalau nilainya benar link http(s) asli — kalau
    // img.url adalah endpoint ringan hasil optimasi load (lihat toAdminPayload
    // di appCustomizationManager.js, dipakai saat mode-nya sebenarnya
    // 'upload'), jangan ditampilkan di sini supaya admin tidak salah kira itu
    // Image URL yang bisa diedit.
    document.getElementById('aczImageUrlInput').value = (imgSource === 'url' && /^https?:\/\//i.test(img.url || '')) ? img.url : '';
  }
  const hasImg = !!img.url;
  document.getElementById('aczImagePreviewWrap').style.display = hasImg ? '' : 'none';
  if (hasImg) document.getElementById('aczImagePreviewImg').src = img.url;
  aczRenderStorageBadge('aczImageStorageBadge', img.storageStatus);
  document.getElementById('aczImageFit').value = img.fit;
  document.getElementById('aczImagePosition').value = img.position;
  if (!opts.skipImageOpacitySlider) document.getElementById('aczImageOpacitySlider').value = Math.round(img.opacity * 100);
  document.getElementById('aczImageOpacityValue').textContent = Math.round(img.opacity * 100) + '%';
  if (!opts.skipImageBlurSlider) document.getElementById('aczImageBlurSlider').value = img.blur;
  document.getElementById('aczImageBlurValue').textContent = img.blur + 'px';

  document.getElementById('aczOverlayEnabled').checked = bg.overlay.enabled;
  document.getElementById('aczOverlayFields').style.opacity = bg.overlay.enabled ? '1' : '.4';
  document.getElementById('aczOverlayFields').style.pointerEvents = bg.overlay.enabled ? '' : 'none';
  document.getElementById('aczOverlaySwatch').style.setProperty('--acz-swatch-color', bg.overlay.color);
  if (!opts.skipOverlayHexInput) document.getElementById('aczOverlayHex').value = bg.overlay.color;
  if (!opts.skipOverlayOpacitySlider) document.getElementById('aczOverlayOpacitySlider').value = Math.round(bg.overlay.opacity * 100);
  document.getElementById('aczOverlayOpacityValue').textContent = Math.round(bg.overlay.opacity * 100) + '%';

  // Branding — logo
  document.getElementById('aczLogoEnabled').checked = br.logo.enabled;
  document.getElementById('aczLogoFields').style.opacity = br.logo.enabled ? '1' : '.4';
  document.getElementById('aczLogoFields').style.pointerEvents = br.logo.enabled ? '' : 'none';
  const hasLogo = !!br.logo.url;
  document.getElementById('aczLogoPreviewWrap').style.display = hasLogo ? 'flex' : 'none';
  if (hasLogo) document.getElementById('aczLogoPreviewImg').src = br.logo.url;
  aczRenderStorageBadge('aczLogoStorageBadge', br.logo.storageStatus);
  if (!opts.skipLogoSizeSlider) document.getElementById('aczLogoSizeSlider').value = br.logo.size;
  document.getElementById('aczLogoSizeValue').textContent = br.logo.size + 'px';
  if (!opts.skipLogoOpacitySlider) document.getElementById('aczLogoOpacitySlider').value = Math.round(br.logo.opacity * 100);
  document.getElementById('aczLogoOpacityValue').textContent = Math.round(br.logo.opacity * 100) + '%';

  // Branding — text
  document.getElementById('aczTextEnabled').checked = br.text.enabled;
  if (!opts.skipTextInput) document.getElementById('aczTextValue').value = br.text.value;

  // Branding — Font Style
  document.getElementById('aczFontFamily').value = br.text.fontFamily || 'Inter';
  if (!opts.skipFontSizeSlider) document.getElementById('aczFontSizeSlider').value = br.text.fontSize || 16;
  document.getElementById('aczFontSizeValue').textContent = (br.text.fontSize || 16) + 'px';
  document.getElementById('aczFontWeight').value = String(br.text.fontWeight || 600);

  aczRenderPreview();
}

function aczCssGradient(grad) {
  const stops = grad.stops.slice().sort((a, b) => a.pos - b.pos).map(s => `${s.color} ${s.pos}%`).join(', ');
  return grad.type === 'radial' ? `radial-gradient(circle at center, ${stops})` : `linear-gradient(${grad.angle}deg, ${stops})`;
}
function aczHexToRgba(hex, opacity) {
  const h = (hex || '#000000').replace('#', '');
  const r = parseInt(h.slice(0, 2), 16) || 0, g = parseInt(h.slice(2, 4), 16) || 0, b = parseInt(h.slice(4, 6), 16) || 0;
  return `rgba(${r}, ${g}, ${b}, ${opacity ?? 1})`;
}

// ── Live Preview — SAMA PERSIS logikanya dengan applyAppBackground()/
// applyAppBranding() di app/app.js (App Desktop asli), supaya apa yang
// Admin lihat di sini benar-benar merepresentasikan tampilan App. ──
// Badge kecil di pojok preview gambar App Customization (background/logo)
// yang menunjukkan status storage-nya — dipakai juga oleh renderBannersPage
// (lihat public/admin.js bagian Setting Banner) lewat elementId yang beda.
// 'r2' -> sudah di Cloudflare R2 (hijau). 'legacy' -> MASIH base64 lama di
// MongoDB, belum dimigrasi (kuning, jalankan `npm run migrate:images` di
// server). 'external' -> URL gambar eksternal, bukan upload (abu-abu).
// 'none' (tidak ada gambar) -> badge disembunyikan.
const ACZ_STORAGE_LABEL = { r2: 'R2', legacy: 'Belum dimigrasi', external: 'URL eksternal' };
function aczRenderStorageBadge(elId, status) {
  const el = document.getElementById(elId);
  if (!el) return;
  if (!status || status === 'none' || !ACZ_STORAGE_LABEL[status]) {
    el.style.display = 'none';
    return;
  }
  el.textContent = ACZ_STORAGE_LABEL[status];
  el.dataset.status = status;
  el.style.display = '';
}

function aczRenderPreview() {
  const bg = aczConfig.background, br = aczConfig.branding;
  const bgEl = document.getElementById('aczPreviewBg');
  const overlayEl = document.getElementById('aczPreviewOverlay');

  if (bg.mode === 'solid') {
    bgEl.style.background = bg.color;
    bgEl.style.filter = 'none';
    overlayEl.style.background = 'transparent';
  } else if (bg.mode === 'gradient') {
    bgEl.style.background = aczCssGradient(bg.gradient);
    bgEl.style.filter = 'none';
    overlayEl.style.background = 'transparent';
  } else if (bg.mode === 'image') {
    if (bg.image.url) {
      bgEl.style.background = `${{ center: 'center center', top: 'center top', bottom: 'center bottom', left: 'left center', right: 'right center' }[bg.image.position] || 'center'} / ${{ cover: 'cover', contain: 'contain', fill: '100% 100%' }[bg.image.fit] || 'cover'} no-repeat url("${bg.image.url}")`;
      bgEl.style.opacity = String(bg.image.opacity ?? 1);
      bgEl.style.filter = bg.image.blur ? `blur(${bg.image.blur}px)` : 'none';
    } else {
      bgEl.style.background = 'var(--grad-dark)';
      bgEl.style.filter = 'none';
    }
    overlayEl.style.background = bg.overlay.enabled ? aczHexToRgba(bg.overlay.color, bg.overlay.opacity) : 'transparent';
  }

  const logoEl = document.getElementById('aczPreviewLogo');
  if (br.logo.enabled && br.logo.url) {
    logoEl.src = br.logo.url;
    logoEl.style.display = '';
    logoEl.style.width = br.logo.size + 'px';
    logoEl.style.height = br.logo.size + 'px';
    logoEl.style.opacity = String(br.logo.opacity ?? 1);
  } else {
    logoEl.style.display = 'none';
  }
  const textEl = document.getElementById('aczPreviewText');
  if (br.text.enabled && br.text.value) {
    textEl.textContent = br.text.value;
    textEl.style.display = '';
    textEl.style.fontFamily = aczFontStack(br.text.fontFamily);
    textEl.style.fontSize = (br.text.fontSize || 16) + 'px';
    textEl.style.fontWeight = String(br.text.fontWeight || 600);
  } else {
    textEl.style.display = 'none';
  }
}

// ── Gradient bar: render handle tiap stop, drag horizontal buat ubah posisi,
// klik buat pilih (baru bisa diedit warnanya lewat aczStopEditor). ──
function aczRenderGradientBar() {
  const bar = document.getElementById('aczGradientBar');
  const stops = aczConfig.background.gradient.stops;
  bar.style.background = aczCssGradient({ ...aczConfig.background.gradient, type: 'linear', angle: 90 }); // preview bar selalu linear kiri-kanan, biar gampang diedit
  if (_aczSelectedStopIndex >= stops.length) _aczSelectedStopIndex = stops.length - 1;

  bar.innerHTML = '';
  stops.forEach((stop, i) => {
    const handle = document.createElement('div');
    handle.className = 'acz-gradient-stop-handle' + (i === _aczSelectedStopIndex ? ' selected' : '');
    handle.style.left = stop.pos + '%';
    handle.style.setProperty('--acz-stop-color', stop.color);
    handle.dataset.index = String(i);

    handle.addEventListener('mousedown', (downEvt) => {
      downEvt.preventDefault();
      _aczSelectedStopIndex = i;
      aczRenderGradientBar();
      aczRenderStopEditor();
      const barRect = bar.getBoundingClientRect();
      const onMove = (moveEvt) => {
        let pct = ((moveEvt.clientX - barRect.left) / barRect.width) * 100;
        pct = Math.max(0, Math.min(100, Math.round(pct)));
        stops[i].pos = pct;
        aczRenderGradientBar();
        aczRenderPreview();
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        aczRenderStopEditor();
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    bar.appendChild(handle);
  });

  aczRenderStopEditor();
}

function aczRenderStopEditor() {
  const stops = aczConfig.background.gradient.stops;
  const editor = document.getElementById('aczStopEditor');
  const stop = stops[_aczSelectedStopIndex];
  if (!stop) { editor.innerHTML = '<span class="acz-stop-editor-empty">Pilih salah satu titik di gradient bar di atas.</span>'; return; }

  editor.innerHTML = `
    <button type="button" class="acz-swatch" id="aczStopSwatch" style="--acz-swatch-color:${stop.color};" title="Klik untuk pilih warna"></button>
    <div class="acz-stop-editor-fields">
      <label class="form-label">Stop ${_aczSelectedStopIndex + 1} — Posisi: ${stop.pos}%</label>
      <span style="font-size:11.5px;color:var(--text-faint);font-family:'SFMono-Regular',Consolas,monospace;">${stop.color}</span>
    </div>
    ${stops.length > 2 ? '<button type="button" class="btn btn-danger btn-sm" id="aczRemoveStopBtn"><svg class="icon icon-16"><use href="#ic-trash-2"></use></svg></button>' : ''}
  `;
  document.getElementById('aczStopSwatch').addEventListener('click', (e) => {
    aczOpenColorPicker(e.currentTarget, stop.color, (hex) => {
      stop.color = hex;
      aczRenderGradientBar();
      aczRenderPreview();
    });
  });
  const removeBtn = document.getElementById('aczRemoveStopBtn');
  if (removeBtn) {
    removeBtn.addEventListener('click', () => {
      stops.splice(_aczSelectedStopIndex, 1);
      _aczSelectedStopIndex = 0;
      aczRenderAll();
    });
  }
}

// ── VISUAL COLOR PICKER (Saturation/Brightness area + Hue slider) ──
// Konversi HSV<->RGB<->HEX manual (tanpa library tambahan, sesuai instruksi
// "gunakan library existing kalau ada, kalau tidak buat sendiri yang ringan").
function aczHexToHsv(hex) {
  const h = (hex || '#000000').replace('#', '');
  const r = (parseInt(h.slice(0, 2), 16) || 0) / 255;
  const g = (parseInt(h.slice(2, 4), 16) || 0) / 255;
  const b = (parseInt(h.slice(4, 6), 16) || 0) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let hue = 0;
  if (d !== 0) {
    if (max === r) hue = ((g - b) / d) % 6;
    else if (max === g) hue = (b - r) / d + 2;
    else hue = (r - g) / d + 4;
    hue *= 60;
    if (hue < 0) hue += 360;
  }
  const sat = max === 0 ? 0 : d / max;
  return { h: hue, s: sat, v: max };
}
function aczHsvToHex(h, s, v) {
  const c = v * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = v - c;
  let r, g, b;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const toHex = (n) => Math.round((n + m) * 255).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`.toUpperCase();
}

let _aczCpHsv = { h: 0, s: 0, v: 0 };
let _aczCpOnChange = null;

function aczOpenColorPicker(anchorEl, initialHex, onChange) {
  const pop = document.getElementById('aczColorPopover');
  _aczCpOnChange = onChange;
  _aczCpHsv = aczHexToHsv(initialHex || '#000000');

  // Posisikan popover dekat anchor, tetap di dalam viewport.
  const rect = anchorEl.getBoundingClientRect();
  pop.style.display = 'block'; // supaya offsetWidth/Height terukur
  const popW = pop.offsetWidth, popH = pop.offsetHeight;
  let left = rect.left;
  let top = rect.bottom + 8;
  if (left + popW > window.innerWidth - 12) left = window.innerWidth - popW - 12;
  if (top + popH > window.innerHeight - 12) top = rect.top - popH - 8;
  pop.style.left = Math.max(12, left) + 'px';
  pop.style.top = Math.max(12, top) + 'px';

  aczCpRenderFromHsv();
  aczCpBindDragHandlers();
}
function aczCloseColorPicker() {
  document.getElementById('aczColorPopover').style.display = 'none';
  _aczCpOnChange = null;
}
function aczCpRenderFromHsv() {
  const { h, s, v } = _aczCpHsv;
  const hex = aczHsvToHex(h, s, v);
  const svEl = document.getElementById('aczCpSv');
  svEl.style.backgroundColor = aczHsvToHex(h, 1, 1);
  document.getElementById('aczCpSvHandle').style.left = (s * 100) + '%';
  document.getElementById('aczCpSvHandle').style.top = ((1 - v) * 100) + '%';
  document.getElementById('aczCpHueHandle').style.left = (h / 360 * 100) + '%';
  document.getElementById('aczCpSwatchPreview').style.background = hex;
  document.getElementById('aczCpHexInput').value = hex;
}
function aczCpEmitChange() {
  const hex = aczHsvToHex(_aczCpHsv.h, _aczCpHsv.s, _aczCpHsv.v);
  document.getElementById('aczCpSwatchPreview').style.background = hex;
  document.getElementById('aczCpHexInput').value = hex;
  if (_aczCpOnChange) _aczCpOnChange(hex);
}
let _aczCpDragBound = false;
function aczCpBindDragHandlers() {
  if (_aczCpDragBound) return; // pointer handlers dipasang sekali, logic baca elemen terbaru tiap event
  _aczCpDragBound = true;

  const svEl = document.getElementById('aczCpSv');
  const hueEl = document.getElementById('aczCpHue');

  function pointFromEvent(el, evt) {
    const r = el.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (evt.clientX - r.left) / r.width));
    const y = Math.max(0, Math.min(1, (evt.clientY - r.top) / r.height));
    return { x, y };
  }
  function dragSv(evt) {
    const { x, y } = pointFromEvent(svEl, evt);
    _aczCpHsv.s = x;
    _aczCpHsv.v = 1 - y;
    aczCpRenderFromHsv();
    aczCpEmitChange();
  }
  function dragHue(evt) {
    const { x } = pointFromEvent(hueEl, evt);
    _aczCpHsv.h = x * 360;
    aczCpRenderFromHsv();
    aczCpEmitChange();
  }
  svEl.addEventListener('mousedown', (e) => {
    e.preventDefault();
    dragSv(e);
    const onMove = (me) => dragSv(me);
    const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
  hueEl.addEventListener('mousedown', (e) => {
    e.preventDefault();
    dragHue(e);
    const onMove = (me) => dragHue(me);
    const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
  document.getElementById('aczCpHexInput').addEventListener('input', (e) => {
    const v = aczNormalizeHexInput(e.target.value);
    if (v) { _aczCpHsv = aczHexToHsv(v); aczCpRenderFromHsv(); aczCpEmitChange(); }
  });
}

async function aczSave() {
  const btn = document.getElementById('btnSaveAppCustomization');
  const statusEl = document.getElementById('aczStatus');
  btn.disabled = true;
  const originalHtml = btn.innerHTML;
  btn.innerHTML = '<svg class="icon icon-18"><use href="#ic-loader-circle"></use></svg> Menyimpan...';
  try {
    // PERF (Save lambat) — background.image.url / branding.logo.url TIDAK
    // ikut dikirim kalau admin tidak menyentuh gambar/logo di sesi edit ini
    // (lihat _aczImageTouched/_aczLogoTouched, di-set true HANYA dari
    // handler upload/URL/hapus gambar-logo di aczBindEvents). Field lain
    // (mode, warna, gradient, overlay, ukuran, opacity, font, teks, dst)
    // tetap selalu dikirim apa adanya karena ukurannya kecil. Backend
    // (appCustomizationManager.updateConfig) SUDAH mendukung PATCH parsial
    // seperti ini sejak awal — field yang tidak dikirim otomatis
    // dipertahankan dari config tersimpan (shallow-merge per bagian), jadi
    // tidak ada perubahan logika backend yang dibutuhkan untuk ini.
    const backgroundPatch = { ...aczConfig.background, image: { ...aczConfig.background.image } };
    const brandingPatch = { ...aczConfig.branding, logo: { ...aczConfig.branding.logo } };
    if (!_aczImageTouched) delete backgroundPatch.image.url;
    if (!_aczLogoTouched) delete brandingPatch.logo.url;

    const res = await api('/api/admin/app-customization', {
      method: 'PUT',
      body: JSON.stringify({ background: backgroundPatch, branding: brandingPatch })
    });
    aczConfig = structuredClone({ background: res.config.background, branding: res.config.branding });
    _aczImageTouched = false; // tersimpan — sinkron lagi dengan server, sesi "belum ada perubahan gambar/logo" dimulai ulang
    _aczLogoTouched = false;
    aczRenderAll();
    showToast('App Customization disimpan & langsung diterapkan realtime ke semua App.', 'success');
    if (statusEl) statusEl.textContent = `Terakhir disimpan: ${new Date(res.config.updatedAt).toLocaleString('id-ID')} oleh ${res.config.updatedBy || 'Admin'}`;
  } catch (e) {
    showToast('Gagal menyimpan: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalHtml;
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   SETTING BANNER — CRUD Banner Dashboard App Desktop (lihat bannerManager.js
   & app/index.html #dashBannerRoot). Struktur/desain banner APP TIDAK
   diubah — halaman ini menyambungkan Admin Web ke banner yang sudah ada di
   App. Realtime lewat WebSocket existing (wsBroadcastAll, event
   'banners:update' — server.js) — TIDAK ada sistem realtime baru.

   State satu halaman ini SENGAJA disimpan di memori (bukan re-fetch tiap
   ganti tab), supaya pindah antar "Banner 1 | Banner 2 | ..." instan tanpa
   round-trip network — sesuai target performa halaman (poin #10: 1-3
   detik usable, ganti tab harus terasa instan).
   ══════════════════════════════════════════════════════════════════════════ */
let _bnrListenersBound = false;
let _bnrBanners = [];       // daftar banner (payload ringan dari /api/admin/banners)
let _bnrFonts = [];
let _bnrRoutes = [];
let _bnrActiveId = null;    // _id banner yang sedang dipilih di tab
let _bnrImageTouched = false;   // true kalau admin upload/hapus gambar BARU di sesi ini
let _bnrPendingImageDataUrl = null; // data URI baru (belum disimpan) — '' berarti "hapus gambar"
let _bnrDragFromId = null;

const BNR_FONT_WEIGHT_LABELS = { 400: 'Regular (400)', 500: 'Medium (500)', 600: 'Semibold (600)', 700: 'Bold (700)', 800: 'Extrabold (800)' };

function bnrActiveBanner() {
  return _bnrBanners.find(b => b.id === _bnrActiveId) || null;
}

async function renderSettingBannerPage() {
  if (!_bnrListenersBound) {
    bnrBindEvents();
    _bnrListenersBound = true;
  }
  const loadingEl = document.getElementById('bnrLoading');
  const emptyEl = document.getElementById('bnrEmpty');
  const bodyEl = document.getElementById('bnrBody');
  loadingEl.style.display = '';
  emptyEl.style.display = 'none';
  bodyEl.style.display = 'none';

  try {
    // Metadata (fonts/routes) + list banner dalam SATU request (pola sama
    // dengan `fonts` di GET /api/admin/app-customization) — halaman ini
    // tidak perlu request terpisah untuk whitelist font/route.
    const res = await api('/api/admin/banners');
    _bnrBanners = Array.isArray(res.items) ? res.items : [];
    _bnrFonts = Array.isArray(res.fonts) ? res.fonts : [];
    _bnrRoutes = Array.isArray(res.routes) ? res.routes : [];
  } catch (e) {
    loadingEl.style.display = 'none';
    showToast('Gagal memuat Banner: ' + e.message, 'error');
    return;
  }

  loadingEl.style.display = 'none';

  if (!_bnrBanners.length) {
    emptyEl.style.display = '';
    _bnrActiveId = null;
    return;
  }

  bodyEl.style.display = '';
  // Pertahankan tab yang sedang aktif kalau masih ada (mis. setelah Save),
  // kalau tidak (pertama kali buka / banner aktif barusan dihapus), pilih
  // banner PERTAMA sesuai urutan (`order`).
  if (!_bnrActiveId || !_bnrBanners.some(b => b.id === _bnrActiveId)) {
    _bnrActiveId = _bnrBanners[0].id;
  }
  bnrRenderTabs();
  bnrRenderFontDropdowns();
  bnrRenderRouteDropdown();
  bnrSelectBanner(_bnrActiveId);
}

function bnrRenderFontDropdowns() {
  const opts = _bnrFonts.map(f => `<option value="${escapeHtml(f.id)}">${escapeHtml(f.label)}</option>`).join('');
  ['bnrEyebrowFont', 'bnrTitleFont', 'bnrDescFont'].forEach(id => {
    document.getElementById(id).innerHTML = opts;
  });
  const weightOpts = Object.entries(BNR_FONT_WEIGHT_LABELS).map(([w, label]) => `<option value="${w}">${label}</option>`).join('');
  ['bnrEyebrowWeight', 'bnrTitleWeight', 'bnrDescWeight'].forEach(id => {
    document.getElementById(id).innerHTML = weightOpts;
  });
}

function bnrRenderRouteDropdown() {
  const opts = ['<option value="">— Pilih halaman —</option>']
    .concat(_bnrRoutes.map(r => `<option value="${escapeHtml(r.id)}">${escapeHtml(r.label)}</option>`))
    .join('');
  document.getElementById('bnrButtonTarget').innerHTML = opts;
}

// ── TABS "Banner 1 | Banner 2 | ..." — jumlah & urutan mengikuti data
// SEBENARNYA di database (bukan angka statis), drag & drop untuk ubah
// urutan (pola sama dengan drag-reorder Kelola Kategori). ──
function bnrRenderTabs() {
  const wrap = document.getElementById('bnrTabs');
  wrap.innerHTML = _bnrBanners.map((b, idx) => `
    <div class="bnr-tab ${b.id === _bnrActiveId ? 'active' : ''} ${b.status === 'inactive' ? 'is-inactive' : ''}" draggable="true" data-id="${b.id}" title="Geser untuk ubah urutan">
      <span class="bnr-tab-drag">⠿</span>
      <span class="bnr-tab-status-dot"></span>
      <span>Banner ${idx + 1}</span>
    </div>
  `).join('');

  wrap.querySelectorAll('.bnr-tab').forEach(el => {
    el.addEventListener('click', (e) => {
      // Klik biasa (bukan hasil drag) -> pindah tab. bnrMaybeSaveDirty()
      // TIDAK dipanggil di sini secara otomatis (sengaja) — admin harus
      // klik "Simpan Banner" eksplisit, supaya tidak ada perubahan yang
      // "ke-save diam-diam" cuma karena pindah tab tanpa sadar.
      bnrSelectBanner(el.dataset.id);
    });
    el.addEventListener('dragstart', () => { _bnrDragFromId = el.dataset.id; el.classList.add('dragging'); });
    el.addEventListener('dragend', () => { el.classList.remove('dragging'); });
    el.addEventListener('dragover', (e) => e.preventDefault());
    el.addEventListener('drop', async (e) => {
      e.preventDefault();
      const toId = el.dataset.id;
      if (!_bnrDragFromId || _bnrDragFromId === toId) return;
      const ids = _bnrBanners.map(b => b.id);
      const fromIdx = ids.indexOf(_bnrDragFromId);
      const toIdx = ids.indexOf(toId);
      if (fromIdx === -1 || toIdx === -1) return;
      ids.splice(toIdx, 0, ids.splice(fromIdx, 1)[0]);
      // Optimistic reorder di UI dulu supaya terasa instan, lalu commit ke
      // server (database jadi source of truth, sama seperti reorder
      // Kategori) — kalau gagal, muat ulang dari server.
      _bnrBanners.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
      bnrRenderTabs();
      try {
        const res = await api('/api/admin/banners/reorder', { method: 'PUT', body: JSON.stringify({ orderedIds: ids }) });
        _bnrBanners = res.items;
        bnrRenderTabs();
      } catch (err) {
        showToast('Gagal menyimpan urutan: ' + err.message, 'error');
        renderSettingBannerPage();
      }
    });
  });
}

// ── Pilih 1 banner -> isi seluruh form + preview dengan data banner itu.
// TIDAK PERNAH mencampur data antar banner (poin #3) — form selalu di-
// render ULANG PENUH dari objek banner yang dipilih, bukan menyisakan
// value lama di input. ──
function bnrSelectBanner(id) {
  _bnrActiveId = id;
  _bnrImageTouched = false;
  _bnrPendingImageDataUrl = null;
  bnrRenderTabs();

  const b = bnrActiveBanner();
  if (!b) return;

  document.getElementById('bnrEyebrowText').value = b.eyebrow.text;
  document.getElementById('bnrEyebrowFont').value = b.eyebrow.fontFamily;
  document.getElementById('bnrEyebrowSize').value = b.eyebrow.fontSize;
  document.getElementById('bnrEyebrowWeight').value = b.eyebrow.fontWeight;
  document.getElementById('bnrEyebrowSpacing').value = b.eyebrow.letterSpacing;

  document.getElementById('bnrTitleText').value = b.title.text;
  document.getElementById('bnrTitleFont').value = b.title.fontFamily;
  document.getElementById('bnrTitleSize').value = b.title.fontSize;
  document.getElementById('bnrTitleWeight').value = b.title.fontWeight;
  document.getElementById('bnrTitleSpacing').value = b.title.letterSpacing;

  document.getElementById('bnrDescText').value = b.description.text;
  document.getElementById('bnrDescFont').value = b.description.fontFamily;
  document.getElementById('bnrDescSize').value = b.description.fontSize;
  document.getElementById('bnrDescWeight').value = b.description.fontWeight;
  document.getElementById('bnrDescSpacing').value = b.description.letterSpacing;
  document.getElementById('bnrDescMaxWidth').value = b.description.maxWidth;

  document.querySelectorAll('#bnrPositionGroup .acz-pill').forEach(pill => {
    pill.classList.toggle('active', pill.dataset.position === b.position);
  });

  document.getElementById('bnrButtonEnabled').checked = !!b.button.enabled;
  document.getElementById('bnrButtonLabel').value = b.button.label || '';
  document.getElementById('bnrButtonTarget').value = b.button.target || '';
  bnrUpdateButtonFieldsVisibility();

  bnrRenderImagePreview();
  bnrRenderPreview();
}

function bnrUpdateButtonFieldsVisibility() {
  const enabled = document.getElementById('bnrButtonEnabled').checked;
  document.getElementById('bnrButtonFields').style.opacity = enabled ? '1' : '.45';
  document.getElementById('bnrButtonFields').style.pointerEvents = enabled ? '' : 'none';
}

// ── IMAGE — preview ringan (thumbnail via background-image lewat endpoint
// PUBLIK /api/banners/:id/image — lihat toAdminList()/toLightPayload() di
// bannerManager.js — BUKAN base64 utuh dimuat di JS) supaya halaman tetap
// ringan (poin #4/#10: preview jangan bikin halaman berat). FIX 404: URL ini
// SEBELUMNYA sempat mengarah ke /api/admin/banners/:id/image yang tidak
// pernah terdaftar di server.js; sekarang selalu memakai endpoint publik
// yang benar-benar ada (image memang sengaja publik, sama seperti App
// Customization). Data URI base64 HANYA ada di memori sesaat kalau admin
// baru upload gambar baru (belum disimpan). ──
function bnrRenderImagePreview() {
  const el = document.getElementById('bnrImagePreview');
  const b = bnrActiveBanner();
  const url = _bnrImageTouched ? _bnrPendingImageDataUrl : (b ? b.image.url : '');
  if (url) {
    el.style.backgroundImage = `url("${url}")`;
  } else {
    el.style.backgroundImage = '';
  }
  // Placeholder teks "Belum ada gambar" — pakai <span> terpisah (bukan
  // el.textContent langsung) supaya #bnrImageStorageBadge (anak elemen ini,
  // lihat admin.html) tidak ikut terhapus tiap kali preview dirender ulang.
  let placeholder = document.getElementById('bnrImagePreviewPlaceholder');
  if (!placeholder) {
    placeholder = document.createElement('span');
    placeholder.id = 'bnrImagePreviewPlaceholder';
    el.appendChild(placeholder);
  }
  placeholder.textContent = url ? '' : 'Belum ada gambar';
  // Badge status storage R2/legacy/eksternal — disembunyikan selama ada
  // upload baru yang belum di-Save (_bnrImageTouched), karena status
  // sebenarnya baru diketahui setelah Save berhasil (lihat
  // resolveImagePatch() di bannerManager.js).
  aczRenderStorageBadge('bnrImageStorageBadge', (!_bnrImageTouched && b) ? b.image.storageStatus : null);
}

function bnrCurrentFormState() {
  return {
    eyebrow: {
      text: document.getElementById('bnrEyebrowText').value.trim(),
      fontFamily: document.getElementById('bnrEyebrowFont').value,
      fontSize: Number(document.getElementById('bnrEyebrowSize').value) || 13,
      fontWeight: Number(document.getElementById('bnrEyebrowWeight').value) || 700,
      letterSpacing: Number(document.getElementById('bnrEyebrowSpacing').value) || 0
    },
    title: {
      text: document.getElementById('bnrTitleText').value.trim(),
      fontFamily: document.getElementById('bnrTitleFont').value,
      fontSize: Number(document.getElementById('bnrTitleSize').value) || 30,
      fontWeight: Number(document.getElementById('bnrTitleWeight').value) || 800,
      letterSpacing: Number(document.getElementById('bnrTitleSpacing').value) || 0
    },
    description: {
      text: document.getElementById('bnrDescText').value.trim(),
      fontFamily: document.getElementById('bnrDescFont').value,
      fontSize: Number(document.getElementById('bnrDescSize').value) || 14,
      fontWeight: Number(document.getElementById('bnrDescWeight').value) || 500,
      letterSpacing: Number(document.getElementById('bnrDescSpacing').value) || 0,
      maxWidth: Number(document.getElementById('bnrDescMaxWidth').value) || 520
    },
    position: document.querySelector('#bnrPositionGroup .acz-pill.active')?.dataset.position || 'left',
    button: {
      enabled: document.getElementById('bnrButtonEnabled').checked,
      label: document.getElementById('bnrButtonLabel').value.trim(),
      target: document.getElementById('bnrButtonTarget').value
    }
  };
}

// ── PREVIEW — pakai class CSS BANNER APP APA ADANYA (.dash-banner/
// .dash-banner-eyebrow/dst, lihat app/styles.css) supaya representasi di
// Admin Web benar-benar sama dengan tampilan di App (poin #21), bukan
// styling terpisah yang gampang "ngaco" beda dari App. ──
function bnrRenderPreview() {
  const state = bnrCurrentFormState();
  const root = document.getElementById('bnrPreviewRoot');
  const overlay = document.getElementById('bnrPreviewOverlay');
  const eyebrowEl = document.getElementById('bnrPvEyebrow');
  const titleEl = document.getElementById('bnrPvTitle');
  const descEl = document.getElementById('bnrPvDesc');
  const btnEl = document.getElementById('bnrPvButton');

  const b = bnrActiveBanner();
  const imgUrl = _bnrImageTouched ? _bnrPendingImageDataUrl : (b ? b.image.url : '');
  root.style.backgroundImage = imgUrl ? `url("${imgUrl}")` : '';

  const alignMap = { left: 'flex-start', center: 'center', right: 'flex-end' };
  const textAlignMap = { left: 'left', center: 'center', right: 'right' };
  overlay.style.alignItems = alignMap[state.position] || 'flex-start';
  overlay.style.textAlign = textAlignMap[state.position] || 'left';

  eyebrowEl.textContent = state.eyebrow.text;
  eyebrowEl.style.fontFamily = bnrFontStack(state.eyebrow.fontFamily);
  eyebrowEl.style.fontSize = state.eyebrow.fontSize + 'px';
  eyebrowEl.style.fontWeight = state.eyebrow.fontWeight;
  eyebrowEl.style.letterSpacing = state.eyebrow.letterSpacing + 'px';

  titleEl.textContent = state.title.text;
  titleEl.style.fontFamily = bnrFontStack(state.title.fontFamily);
  titleEl.style.fontSize = state.title.fontSize + 'px';
  titleEl.style.fontWeight = state.title.fontWeight;
  titleEl.style.letterSpacing = state.title.letterSpacing + 'px';

  descEl.textContent = state.description.text;
  descEl.style.fontFamily = bnrFontStack(state.description.fontFamily);
  descEl.style.fontSize = state.description.fontSize + 'px';
  descEl.style.fontWeight = state.description.fontWeight;
  descEl.style.letterSpacing = state.description.letterSpacing + 'px';
  descEl.style.maxWidth = state.description.maxWidth + 'px';
  descEl.style.display = state.description.text ? '' : 'none';

  if (state.button.enabled && state.button.label) {
    // Markup SAMA PERSIS dengan _dashBannerSlideHTML() di app/app.js (label +
    // ikon panah #ic-arrow-right) — supaya preview Admin Web benar-benar
    // merepresentasikan tampilan CTA di App, bukan cuma teks polos tanpa ikon.
    btnEl.innerHTML = `${escapeHtml(state.button.label)} <svg class="icon"><use href="#ic-arrow-right"></use></svg>`;
    btnEl.classList.add('is-active');
  } else {
    btnEl.textContent = '';
    btnEl.classList.remove('is-active');
  }
}

function bnrFontStack(id) {
  const found = _bnrFonts.find(f => f.id === id);
  return found ? found.stack : "'Inter', 'Segoe UI', sans-serif";
}

// ── Semua listener statis (dipasang SEKALI, guard _bnrListenersBound di
// atas). Preview diperbarui LANGSUNG tiap ketikan/ganti opsi (poin #4 —
// preview harus update saat image/eyebrow/judul/deskripsi berubah), tanpa
// nunggu Save. ──
function bnrBindEvents() {
  document.getElementById('btnBnrAdd').addEventListener('click', bnrCreateBanner);
  document.getElementById('btnBnrSave').addEventListener('click', bnrSaveActiveBanner);
  document.getElementById('btnBnrDelete').addEventListener('click', bnrDeleteActiveBanner);

  // Semua field teks/tipografi -> live preview (input/change dua-duanya
  // supaya dropdown & angka juga langsung ke-refresh, bukan cuma teks).
  [
    'bnrEyebrowText', 'bnrEyebrowFont', 'bnrEyebrowSize', 'bnrEyebrowWeight', 'bnrEyebrowSpacing',
    'bnrTitleText', 'bnrTitleFont', 'bnrTitleSize', 'bnrTitleWeight', 'bnrTitleSpacing',
    'bnrDescText', 'bnrDescFont', 'bnrDescSize', 'bnrDescWeight', 'bnrDescSpacing', 'bnrDescMaxWidth',
    'bnrButtonLabel', 'bnrButtonTarget'
  ].forEach(id => {
    const el = document.getElementById(id);
    el.addEventListener('input', bnrRenderPreview);
    el.addEventListener('change', bnrRenderPreview);
  });

  document.getElementById('bnrButtonEnabled').addEventListener('change', () => {
    bnrUpdateButtonFieldsVisibility();
    bnrRenderPreview();
  });

  document.getElementById('bnrPositionGroup').addEventListener('click', (e) => {
    const pill = e.target.closest('.acz-pill[data-position]');
    if (!pill) return;
    document.querySelectorAll('#bnrPositionGroup .acz-pill').forEach(p => p.classList.remove('active'));
    pill.classList.add('active');
    bnrRenderPreview();
  });

  document.getElementById('bnrImageUploadBtn').addEventListener('click', () => document.getElementById('bnrImageFile').click());
  document.getElementById('bnrImageFile').addEventListener('change', bnrHandleImageFile);
  document.getElementById('bnrImageRemoveBtn').addEventListener('click', () => {
    _bnrImageTouched = true;
    _bnrPendingImageDataUrl = '';
    bnrRenderImagePreview();
    bnrRenderPreview();
  });
}

// Disamakan dengan MAX_IMAGE_BYTES di bannerManager.js (10 MB) — lihat
// komentar di sana (Final Test poin #4/#14: "Upload image 5–10 MB").
const BNR_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const BNR_IMAGE_MIME_WHITELIST = ['image/png', 'image/jpeg', 'image/webp'];

function bnrHandleImageFile(e) {
  const file = e.target.files && e.target.files[0];
  e.target.value = ''; // reset supaya file yang sama bisa dipilih ulang kalau perlu
  if (!file) return;
  if (!BNR_IMAGE_MIME_WHITELIST.includes(file.type)) {
    showToast('Format gambar harus PNG, JPG/JPEG, atau WEBP.', 'error');
    return;
  }
  if (file.size > BNR_IMAGE_MAX_BYTES) {
    showToast('Ukuran gambar maksimal 10 MB.', 'error');
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    _bnrImageTouched = true;
    _bnrPendingImageDataUrl = reader.result;
    bnrRenderImagePreview();
    bnrRenderPreview();
  };
  reader.onerror = () => showToast('Gagal membaca file gambar.', 'error');
  reader.readAsDataURL(file);
}

// ── TAMBAH BANNER — benar-benar create lewat API (poin #5), BUKAN cuma
// push ke state React/JS lokal. Tab & setting banner baru langsung
// tersedia begitu response sukses, dan APP menerima realtime lewat
// broadcastUpdate() di server (dipanggil backend, bukan di sini). ──
async function bnrCreateBanner() {
  const btn = document.getElementById('btnBnrAdd');
  const originalHtml = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<svg class="icon icon-18"><use href="#ic-loader-circle"></use></svg> Menambah…';
  try {
    const res = await api('/api/admin/banners', { method: 'POST', body: JSON.stringify({}) });
    _bnrBanners.push(res.item);
    _bnrActiveId = res.item.id;
    bnrRenderTabs();
    bnrSelectBanner(_bnrActiveId);
    document.getElementById('bnrEmpty').style.display = 'none';
    document.getElementById('bnrBody').style.display = '';
    showToast('Banner baru ditambahkan.', 'success');
  } catch (e) {
    showToast('Gagal menambah Banner: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalHtml;
  }
}

// ── SIMPAN — PATCH parsial (gambar HANYA dikirim kalau benar-benar
// diganti/dihapus di sesi ini, pola sama dengan App Customization di atas)
// supaya request Save tetap kecil & cepat kalau admin cuma ganti teks
// (poin #11: Save cepat, jangan reload seluruh halaman). ──
async function bnrSaveActiveBanner() {
  const b = bnrActiveBanner();
  if (!b) return;
  const btn = document.getElementById('btnBnrSave');
  const originalHtml = btn.innerHTML;
  const statusEl = document.getElementById('bnrSaveStatus');
  btn.disabled = true;
  btn.innerHTML = '<svg class="icon icon-18"><use href="#ic-loader-circle"></use></svg> Menyimpan…';
  try {
    const patch = bnrCurrentFormState();
    if (_bnrImageTouched) patch.image = { url: _bnrPendingImageDataUrl };

    const res = await api(`/api/admin/banners/${b.id}`, { method: 'PUT', body: JSON.stringify(patch) });
    const idx = _bnrBanners.findIndex(x => x.id === b.id);
    if (idx !== -1) _bnrBanners[idx] = res.item;
    _bnrImageTouched = false;
    _bnrPendingImageDataUrl = null;
    bnrRenderTabs();
    bnrSelectBanner(b.id);
    showToast('Banner disimpan & langsung diterapkan realtime ke App.', 'success');
    if (statusEl) statusEl.textContent = `Terakhir disimpan: ${new Date(res.item.updatedAt).toLocaleString('id-ID')}`;
  } catch (e) {
    showToast('Gagal menyimpan Banner: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalHtml;
  }
}

// ── HAPUS — benar-benar delete dari database (poin #6), tab langsung
// hilang & urutan dirapikan otomatis (lihat deleteBanner() di
// bannerManager.js), APP menerima realtime lewat broadcastUpdate(). ──
async function bnrDeleteActiveBanner() {
  const b = bnrActiveBanner();
  if (!b) return;
  if (!confirm(`Hapus "Banner ${_bnrBanners.findIndex(x => x.id === b.id) + 1}" ini? Tindakan ini tidak bisa dibatalkan.`)) return;

  const btn = document.getElementById('btnBnrDelete');
  const originalHtml = btn.innerHTML;
  btn.disabled = true;
  try {
    const res = await api(`/api/admin/banners/${b.id}`, { method: 'DELETE' });
    _bnrBanners = res.items;
    _bnrActiveId = null;
    showToast('Banner dihapus.', 'success');
    if (!_bnrBanners.length) {
      document.getElementById('bnrBody').style.display = 'none';
      document.getElementById('bnrEmpty').style.display = '';
    } else {
      _bnrActiveId = _bnrBanners[0].id;
      bnrRenderTabs();
      bnrSelectBanner(_bnrActiveId);
    }
  } catch (e) {
    showToast('Gagal menghapus Banner: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalHtml;
  }
}
