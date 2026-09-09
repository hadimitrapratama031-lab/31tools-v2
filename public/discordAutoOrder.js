// ══════════════════════════════════════════════════════════════════════════
// DISCORD AUTO ORDER — halaman Admin Web "Auto Order (Discord Bot)".
// Sengaja ditulis di FILE TERPISAH (bukan ditempel ke admin.js yang sudah
// besar) supaya penambahan fitur ini TIDAK menyentuh/berisiko merusak kode
// admin.js yang sudah ada. File ini dimuat SETELAH admin.js (lihat tag
// <script> di admin.html) sehingga bebas memakai helper global yang sudah
// ada di sana: api(), showToast(), escapeHtml().
//
// CATATAN PENTING (bug fix): kartu tier di sini TIDAK BOLEH memakai class
// `pkg-card` — class itu dipakai admin.js (wirePkgCards, halaman Upgrade
// Paket) lewat `document.querySelectorAll('.pkg-card')` yang GLOBAL (bukan
// discoped ke #pkgFormGrid). Kalau dipakai ulang di sini, begitu halaman
// Auto Order pernah dibuka sekali (elemennya tetap ada di DOM walau
// halamannya di-switch/disembunyikan), halaman Upgrade Paket jadi ikut
// mendeteksi kartu di sini sebagai `.pkg-card` juga lalu crash mencari
// `.pkg-save-btn` yang tidak ada di kartu ini (`Cannot read properties of
// null (reading 'addEventListener')`). Makanya kartu tier di bawah cuma
// pakai class `dao-tier-card`, TIDAK bagi class apapun dengan halaman lain.
// ══════════════════════════════════════════════════════════════════════════

const DAO_TIER_META = {
  gold:     { label: 'Gold',     icon: 'ic-trophy' },
  platinum: { label: 'Platinum', icon: 'ic-gem' }
};

let _daoSettings = null;
let _daoDirty = false;

async function renderAutoOrderPage() {
  document.getElementById('daoBotWarning').style.display = 'none';
  document.getElementById('daoTierGrid').innerHTML = `<div style="padding:20px;color:var(--text-3);"><svg class="icon icon-18"><use href="#ic-loader-circle"></use></svg> Memuat pengaturan Auto Order...</div>`;
  document.getElementById('daoOrdersBody').innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--text-3);">Memuat...</td></tr>`;

  try {
    const [{ settings, roleMap, botConfigured }, { channels }] = await Promise.all([
      api('/api/admin/discord-autoorder/settings'),
      api('/api/admin/discord-autoorder/channels').catch(() => ({ channels: [] }))
    ]);
    _daoSettings = settings;
    _daoDirty = false;

    if (!botConfigured) {
      const warn = document.getElementById('daoBotWarning');
      warn.style.display = 'block';
      warn.textContent = '⚠️ Bot Discord belum terkonfigurasi lengkap (DISCORD_BOT_TOKEN / DISCORD_GUILD_ID / DISCORD_CLIENT_ID di .env). Isi dulu sebelum mengaktifkan Auto Order.';
    }

    document.getElementById('daoEnabled').checked = !!settings.enabled;
    document.getElementById('daoFooter').value = settings.footer || '';
    document.getElementById('daoMenuTitle').value = settings.menuTitle || '';
    document.getElementById('daoMenuDescription').value = settings.menuDescription || '';
    document.getElementById('daoBanner').value = settings.banner || '';
    document.getElementById('daoThumbnail').value = settings.thumbnail || '';
    document.getElementById('daoColor').value = '#' + (Number(settings.color) || 0).toString(16).padStart(6, '0');
    document.getElementById('daoCaraOrder').value = (settings.caraOrderSteps || []).join('\n');
    document.getElementById('daoInfoNotes').value = (settings.infoNotes || []).join('\n');

    const chSel = document.getElementById('daoChannelId');
    chSel.innerHTML = '<option value="">— pilih channel —</option>' +
      channels.map(c => `<option value="${c.id}" ${c.id === settings.channelId ? 'selected' : ''}>#${escapeHtml(c.name)}</option>`).join('');
    if (settings.channelId && !channels.some(c => c.id === settings.channelId)) {
      chSel.innerHTML += `<option value="${settings.channelId}" selected>#${settings.channelId} (channel tidak ditemukan lagi)</option>`;
    }

    const roleInfo = ['gold', 'platinum'].map(t => `${DAO_TIER_META[t].label}: ${roleMap?.[t] ? `<code>${roleMap[t]}</code>` : '<span style="color:var(--text-faint);">belum diatur</span>'}`).join(' &nbsp;·&nbsp; ');
    document.getElementById('daoTierGrid').innerHTML =
      daoTierCardHtml('gold', settings.gold) + daoTierCardHtml('platinum', settings.platinum) +
      `<div class="card" style="grid-column:1/-1;"><div class="card-body" style="font-size:12px;color:var(--text-3);">🎭 Role Discord per paket (dari halaman <b>Verify Role</b>): ${roleInfo}</div></div>`;

    wireDaoTierCards();
    wireDaoGeneral();
    loadDaoOrders();
  } catch (e) {
    document.getElementById('daoTierGrid').innerHTML = `<div style="padding:20px;color:var(--red);">Gagal memuat pengaturan Auto Order: ${escapeHtml(e.message)}</div>`;
  }
}

// Kartu ringkas per tier — cuma benefit override & label tombol. Judul,
// deskripsi, banner, warna, dsb sekarang SATU milik menu gabungan (form
// "Pengaturan Umum" di atas), bukan per-tier lagi, karena Gold & Platinum
// dikirim sebagai SATU pesan (2 field berdampingan), bukan 2 pesan terpisah.
function daoTierCardHtml(tier, data) {
  const meta = DAO_TIER_META[tier];
  return `
  <div class="card dao-tier-card" data-tier="${tier}">
    <div class="card-header">
      <div class="card-title"><svg class="icon icon-18"><use href="#${meta.icon}"></use></svg> ${meta.label}</div>
    </div>
    <div class="card-body">
      <div class="form-group">
        <label class="form-label">Benefit <span style="color:var(--text-faint);font-weight:400;">(satu baris = satu benefit, kosong = ambil otomatis dari Upgrade Paket)</span></label>
        <textarea class="form-input dao-benefits" rows="4" style="resize:vertical;">${escapeHtml((data.benefits || []).join('\n'))}</textarea>
      </div>
      <div class="form-group">
        <label class="form-label">Label Tombol Order</label>
        <input class="form-input dao-button-label" type="text" maxlength="80" value="${escapeHtml(data.buttonLabel || '')}">
      </div>
      ${tier === 'platinum' ? `
      <div class="form-group">
        <label class="form-label">Label Tombol Perpanjang <span style="color:var(--text-faint);font-weight:400;">(alur & harga sama dgn tombol Order — cuma beda label)</span></label>
        <input class="form-input dao-renew-button-label" type="text" maxlength="80" value="${escapeHtml(data.renewButtonLabel || '')}">
      </div>` : ''}
      <div style="font-size:12px;color:var(--text-3);">💰 Harga &amp; ⏳ Masa Aktif otomatis mengikuti halaman <b>Upgrade Paket</b> (supaya nominal yang ditampilkan Bot selalu sama dengan yang benar-benar ditagihkan).</div>
    </div>
  </div>`;
}

function wireDaoTierCards() {
  document.querySelectorAll('.dao-tier-card').forEach(card => {
    card.querySelectorAll('input, textarea').forEach(el => el.addEventListener('input', () => { _daoDirty = true; }));
  });
}

function wireDaoGeneral() {
  ['daoEnabled', 'daoChannelId', 'daoFooter', 'daoMenuTitle', 'daoMenuDescription', 'daoBanner', 'daoThumbnail', 'daoColor', 'daoCaraOrder', 'daoInfoNotes'].forEach(id => {
    const el = document.getElementById(id);
    el.removeEventListener('change', daoMarkDirty);
    el.addEventListener('change', daoMarkDirty);
    el.removeEventListener('input', daoMarkDirty);
    el.addEventListener('input', daoMarkDirty);
  });
  document.getElementById('btnSaveAutoOrder').onclick = saveDaoSettings;
  document.getElementById('btnPublishAutoOrder').onclick = publishDaoMenu;
}
function daoMarkDirty() { _daoDirty = true; }

function collectDaoTierPatch(tier) {
  const card = document.querySelector(`.dao-tier-card[data-tier="${tier}"]`);
  if (!card) return {};
  const patch = {
    buttonLabel: card.querySelector('.dao-button-label').value,
    benefits: card.querySelector('.dao-benefits').value.split('\n').map(s => s.trim()).filter(Boolean)
  };
  if (tier === 'platinum') {
    patch.renewButtonLabel = card.querySelector('.dao-renew-button-label')?.value || '';
  }
  return patch;
}

function linesFromTextarea(id) {
  return document.getElementById(id).value.split('\n').map(s => s.trim()).filter(Boolean);
}

async function saveDaoSettings() {
  const btn = document.getElementById('btnSaveAutoOrder');
  const statusEl = document.getElementById('daoStatus');
  btn.disabled = true;
  statusEl.textContent = 'Menyimpan...';
  try {
    const body = {
      enabled: document.getElementById('daoEnabled').checked,
      channelId: document.getElementById('daoChannelId').value,
      footer: document.getElementById('daoFooter').value,
      menuTitle: document.getElementById('daoMenuTitle').value,
      menuDescription: document.getElementById('daoMenuDescription').value,
      banner: document.getElementById('daoBanner').value,
      thumbnail: document.getElementById('daoThumbnail').value,
      color: document.getElementById('daoColor').value,
      caraOrderSteps: linesFromTextarea('daoCaraOrder'),
      infoNotes: linesFromTextarea('daoInfoNotes'),
      gold: collectDaoTierPatch('gold'),
      platinum: collectDaoTierPatch('platinum')
    };
    const res = await api('/api/admin/discord-autoorder/settings', { method: 'PUT', body: JSON.stringify(body) });
    _daoSettings = res.settings;
    _daoDirty = false;
    if (res.publish) {
      statusEl.textContent = res.publish.ok
        ? '✅ Tersimpan & menu di Discord sudah diperbarui.'
        : `✅ Tersimpan — tapi gagal update menu di Discord: ${res.publish.error}`;
    } else {
      statusEl.textContent = '✅ Tersimpan.';
    }
    showToast('Pengaturan Auto Order berhasil disimpan.', 'success');
  } catch (e) {
    statusEl.textContent = `❌ ${e.message}`;
    showToast(e.message || 'Gagal menyimpan pengaturan Auto Order.', 'error');
  } finally {
    btn.disabled = false;
  }
}

async function publishDaoMenu() {
  const btn = document.getElementById('btnPublishAutoOrder');
  const statusEl = document.getElementById('daoStatus');
  btn.disabled = true;
  statusEl.textContent = 'Mengirim/memperbarui pesan menu ke Discord...';
  try {
    const res = await api('/api/admin/discord-autoorder/publish', { method: 'POST' });
    if (res.result?.ok) {
      statusEl.textContent = '✅ Menu berhasil dipublish/diperbarui di Discord.';
      showToast('Menu Auto Order berhasil dipublish.', 'success');
    } else {
      statusEl.textContent = `⚠️ ${res.result?.error || 'Gagal publish menu.'}`;
    }
  } catch (e) {
    statusEl.textContent = `❌ ${e.message}`;
    showToast(e.message || 'Gagal publish menu.', 'error');
  } finally {
    btn.disabled = false;
  }
}

async function loadDaoOrders() {
  const tbody = document.getElementById('daoOrdersBody');
  try {
    const { orders } = await api('/api/admin/discord-autoorder/orders?limit=50');
    if (!orders.length) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--text-3);">Belum ada order lewat Discord Bot.</td></tr>`;
      return;
    }
    const statusBadge = {
      pending: '🟡 Pending', completed: '🟢 Lunas', failed: '🔴 Gagal',
      expired: '⚫ Kedaluwarsa', cancelled: '⚪ Dibatalkan'
    };
    tbody.innerHTML = orders.map(o => `
      <tr>
        <td>${escapeHtml(o.orderId)}</td>
        <td>${escapeHtml(o.username || o.discordId)}</td>
        <td>${DAO_TIER_META[o.tier]?.label || o.tier}</td>
        <td>${o.channelId ? `<code>${o.channelId}</code>` : '-'}</td>
        <td>${statusBadge[o.status] || o.status}</td>
        <td>${o.createdAt ? new Date(o.createdAt).toLocaleString('id-ID') : '-'}</td>
      </tr>`).join('');
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--red);">Gagal memuat riwayat: ${escapeHtml(e.message)}</td></tr>`;
  }
}
