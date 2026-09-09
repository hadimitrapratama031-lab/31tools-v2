// ══════════════════════════════════════════════════════════════════════════
// WATERMARK DETECTION — halaman Admin Web "Watermark Detection". File
// TERPISAH (pola sama dgn discordAutoOrder.js) supaya tidak menyentuh
// admin.js yang sudah besar. Dimuat SETELAH admin.js, jadi bebas memakai
// api()/showToast()/escapeHtml() yang sudah ada di sana.
//
// PENTING: halaman ini CUMA menampilkan informasi & log. Tidak ada tombol
// ban/suspend di sini — kalau admin mau bertindak ke suatu akun, itu tetap
// lewat halaman Users yang sudah ada (manual, sesuai requirement).
// ══════════════════════════════════════════════════════════════════════════

let _wmAlerts = [];
let _wmSkip = 0;
const WM_PAGE_SIZE = 50;

async function renderWatermarkPage() {
  _wmAlerts = [];
  _wmSkip = 0;
  document.getElementById('wmAlertsBody').innerHTML = `<tr><td colspan="8" style="text-align:center;color:var(--text-3);">Memuat...</td></tr>`;
  document.getElementById('btnWmLoadMore').onclick = () => loadWatermarkAlerts(true);

  try {
    const stats = await api('/api/admin/watermark-alerts/stats');
    document.getElementById('wmStatTotal').textContent = (stats.totalWatermarks ?? 0).toLocaleString('id-ID');
    document.getElementById('wmStatAlerts').textContent = (stats.totalAlerts ?? 0).toLocaleString('id-ID');
    document.getElementById('wmStatUsers').textContent = (stats.uniqueUsersFlagged ?? 0).toLocaleString('id-ID');
  } catch (e) { /* biarkan tampil '-' kalau gagal, jangan blokir tabel di bawahnya */ }

  await loadWatermarkAlerts(false);
}

async function loadWatermarkAlerts(append) {
  const btnMore = document.getElementById('btnWmLoadMore');
  try {
    const { alerts, total } = await api(`/api/admin/watermark-alerts?limit=${WM_PAGE_SIZE}&skip=${_wmSkip}`);
    _wmAlerts = append ? _wmAlerts.concat(alerts) : alerts;
    _wmSkip += alerts.length;
    renderWmTable(_wmAlerts);
    btnMore.style.display = _wmSkip < total ? '' : 'none';
  } catch (e) {
    document.getElementById('wmAlertsBody').innerHTML = `<tr><td colspan="8" style="text-align:center;color:var(--red);">Gagal memuat: ${escapeHtml(e.message)}</td></tr>`;
  }
}

function wmDeviceLabel(fingerprint) {
  if (!fingerprint) return '-';
  return `<code title="${escapeHtml(fingerprint)}">${escapeHtml(fingerprint.slice(0, 10))}…</code>`;
}

function wmFmtDate(d) {
  if (!d) return '-';
  try { return new Date(d).toLocaleString('id-ID'); } catch (e) { return '-'; }
}

function renderWmTable(alerts) {
  const tbody = document.getElementById('wmAlertsBody');
  if (!alerts.length) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;color:var(--text-3);">Belum ada indikasi perangkat berbeda. 👍</td></tr>`;
    return;
  }
  tbody.innerHTML = alerts.map(a => `
    <tr>
      <td>${escapeHtml(a.username || a.discordId || '-')}</td>
      <td>${escapeHtml(a.productName || '-')} <span style="color:var(--text-faint);">(${a.productType === 'game' ? 'Game' : 'Bypass'})</span></td>
      <td><code>${escapeHtml(String(a.downloadId || '').slice(0, 8))}…</code></td>
      <td>${wmDeviceLabel(a.deviceIdAtDownload)}</td>
      <td>${wmDeviceLabel(a.deviceIdDetected)}</td>
      <td>${wmFmtDate(a.downloadedAt)}</td>
      <td>${wmFmtDate(a.detectedAt || a.firstDetectedAt)}</td>
      <td><span class="log-badge log-badge--warning">Perangkat Berbeda</span></td>
    </tr>`).join('');
}

// Dipanggil dari admin.js saat event realtime `watermark:alert` masuk sementara
// halaman ini sedang dibuka — taruh di paling atas tabel tanpa perlu reload penuh.
function prependWatermarkAlert(data) {
  if (!data) return;
  _wmAlerts = _wmAlerts.filter(a => !(a.downloadId === data.downloadId && a.deviceIdDetected === data.deviceIdDetected));
  _wmAlerts.unshift({
    downloadId: data.downloadId, discordId: data.discordId, username: data.username,
    productType: data.productType, productName: data.productName,
    deviceIdAtDownload: data.deviceIdAtDownload, deviceIdDetected: data.deviceIdDetected,
    downloadedAt: data.downloadedAt, detectedAt: data.detectedAt
  });
  renderWmTable(_wmAlerts);

  const totalEl = document.getElementById('wmStatAlerts');
  if (totalEl && totalEl.textContent !== '-') {
    totalEl.textContent = (Number(totalEl.textContent.replace(/\D/g, '')) + 1).toLocaleString('id-ID');
  }
}
