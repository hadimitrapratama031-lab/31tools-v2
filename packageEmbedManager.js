// ══════════════════════════════════════════════════════════════════════════
// PACKAGE EMBED MANAGER — mesin template untuk SEMUA notification Discord
// yang berkaitan dengan PAKET (Package Activated/Expired/Purchase/Upgrade/
// Renewal/Reset/Expiring/Gold Trial/Voucher, dst).
//
// Dipakai oleh:
//   - server.js  → notifyUser() (packageCard branch) — kirim embed final
//     (DM & Webhook) memakai template TERBARU dari database.
//   - server.js  → route /api/admin/package-embeds/* — CRUD dari Admin Web
//     (Package Notification → Embed Builder).
//
// KOLEKSI DATABASE: `package_embed_templates`, satu dokumen per event
// (_id = event key). Field:
//   - event, template (bentuk editable — lihat DEFAULT_TEMPLATES di bawah)
//   - previousTemplate (backup versi sebelum edit terakhir — dipakai kalau
//     template aktif ternyata invalid, lihat renderPackageEmbed())
//   - updatedAt, updatedBy
//
// PENTING (sesuai requirement):
//   - Template TIDAK di-hardcode di source — selalu diambil dari DB kalau
//     admin sudah pernah menyimpan; kalau belum, dipakai DEFAULT_TEMPLATES
//     di bawah (yang juga bisa di-"Reset to Default"-kan admin kapan saja).
//   - Variable yang datanya tidak tersedia pada event tertentu TIDAK PERNAH
//     ditampilkan sebagai teks kosong/"undefined" — placeholder-nya dibuang
//     bersih, dan field yang isinya jadi kosong ikut dibuang.
// ══════════════════════════════════════════════════════════════════════════

const { packageRoleLabel, fmtDateTimeWIB, discordTimestamp, PACKAGE_COLORS } = require('./notifTemplates');

const COLLECTION = 'package_embed_templates';

// ── DAFTAR EVENT PAKET — SATU-SATUNYA sumber kebenaran kategori yang tampil
// di Package Embed Builder. Setiap key di sini punya minimal SATU titik
// pemanggilan nyata di server.js (notifyUser({ packageCard: { event: ... } }))
// KECUALI yang ditandai `liveTrigger:false` — key tersebut memang sudah
// disiapkan di notifTemplates.js (PACKAGE_EVENT) untuk dipakai sistem paket,
// tapi belum ada alur yang memanggilnya saat ini (lihat laporan audit).
// Tidak ada kategori yang dibuat-buat di luar ini.
const EVENTS = [
  {
    key: 'activated', label: 'Package Activated', icon: '💎', group: 'Lifecycle',
    desc: 'Paket user diaktifkan (mis. admin set-role langsung).', liveTrigger: false,
    defaultColor: PACKAGE_COLORS.gold
  },
  {
    key: 'purchase', label: 'Package Purchase', icon: '💎', group: 'Lifecycle',
    desc: 'User berhasil membeli/upgrade paket lewat Payment Gateway (KlikQRIS).', liveTrigger: true,
    defaultColor: PACKAGE_COLORS.gold
  },
  {
    key: 'upgrade', label: 'Package Upgrade', icon: '⭐', group: 'Lifecycle',
    desc: 'Paket user di-upgrade ke tier lebih tinggi (Public→Gold→Platinum).', liveTrigger: false,
    defaultColor: 0x9b59b6
  },
  {
    key: 'renewed', label: 'Package Renewal', icon: '🔄', group: 'Lifecycle',
    desc: 'Admin memperpanjang masa aktif paket user.', liveTrigger: true,
    defaultColor: 0xa78bfa
  },
  {
    key: 'reset', label: 'Package Reset', icon: '♻️', group: 'Lifecycle',
    desc: 'Admin mereset masa aktif paket user.', liveTrigger: true,
    defaultColor: 0x8f96a3
  },
  {
    key: 'expiring', label: 'Package Expiring Soon', icon: '⏳', group: 'Lifecycle',
    desc: 'Masa aktif paket Gold/Platinum user tersisa < 24 jam (scan otomatis).', liveTrigger: true,
    defaultColor: 0xffb84d
  },
  {
    key: 'expired', label: 'Package Expired', icon: '⚠️', group: 'Lifecycle',
    desc: 'Masa aktif paket user habis & otomatis diturunkan ke Public.', liveTrigger: true,
    defaultColor: PACKAGE_COLORS.expired
  },
  {
    key: 'updated', label: 'Package Failed / Cancelled', icon: '📦', group: 'Lifecycle',
    desc: 'Perubahan paket lain di luar kategori di atas.', liveTrigger: false,
    defaultColor: 0x8f96a3
  },
  {
    key: 'public', label: 'Public Activated', icon: '🔷', group: 'Tier',
    desc: 'Alias tampilan untuk Package Activated saat tier = Public.', liveTrigger: false,
    defaultColor: PACKAGE_COLORS.public
  },
  {
    key: 'gold', label: 'Gold Activated', icon: '🟡', group: 'Tier',
    desc: 'Alias tampilan untuk Package Activated saat tier = Gold.', liveTrigger: false,
    defaultColor: PACKAGE_COLORS.gold
  },
  {
    key: 'platinum', label: 'Platinum Activated', icon: '⚪', group: 'Tier',
    desc: 'Alias tampilan untuk Package Activated saat tier = Platinum.', liveTrigger: false,
    defaultColor: PACKAGE_COLORS.platinum
  },
  {
    key: 'gold_trial', label: 'Gold Trial Claimed', icon: '🎁', group: 'Tier',
    desc: 'User berhasil klaim Gold Trial gratis.', liveTrigger: true,
    defaultColor: PACKAGE_COLORS.gold_trial
  },
  {
    key: 'voucher', label: 'Voucher Redeemed', icon: '🎟️', group: 'Tier',
    desc: 'User berhasil klaim voucher paket.', liveTrigger: true,
    defaultColor: PACKAGE_COLORS.gold
  }
];
const EVENT_KEYS = EVENTS.map(e => e.key);
const EVENT_MAP = Object.fromEntries(EVENTS.map(e => [e.key, e]));

function isValidEvent(key) { return EVENT_KEYS.includes(key); }

// ── DYNAMIC VARIABLES — daftar variable yang BENAR-BENAR tersedia di sistem
// paket saat ini (lihat packageCard di server.js). Tiap variable ditandai
// `events` (event mana saja yang biasanya punya datanya) supaya palet di
// Admin Web bisa kasih hint, tapi renderer tetap generik untuk semua event —
// kalau datanya kosong pada event tertentu, placeholder otomatis dibuang.
const VARIABLES = [
  { key: 'username', label: 'Username', example: 'RizkyGamers' },
  { key: 'user_id', label: 'Discord User ID', example: '123456789012345678' },
  { key: 'avatar_url', label: 'Avatar URL', example: '(avatar Discord user)' },
  { key: 'package_name', label: 'Nama Paket', example: 'Gold' },
  { key: 'package_type', label: 'Tipe Paket (raw)', example: 'gold' },
  { key: 'previous_package', label: 'Paket Sebelumnya', example: 'Public' },
  { key: 'package_duration', label: 'Durasi Paket', example: '30 Hari' },
  { key: 'expires_at', label: 'Aktif/Berakhir Hingga', example: '20 Jul 2026, 14.35 WIB' },
  { key: 'expires_at_relative', label: 'Aktif/Berakhir Hingga (relatif)', example: '2 hari lagi' },
  { key: 'package_price', label: 'Harga Paket', example: 'Rp50.000' },
  { key: 'order_id', label: 'Order ID', example: 'TRX-ABC123' },
  { key: 'package_status', label: 'Status Paket', example: '🟢 AKTIF' },
  { key: 'admin_name', label: 'Admin', example: 'Admin' },
  { key: 'server_name', label: 'Nama Aplikasi/Toko', example: '31 Tools' }
];

// Bangun map variable -> value dari `packageCard` (bentuk yang sudah dipakai
// notifyUser() di server.js) + avatarUrl yang sudah di-resolve + appName.
// Variable yang datanya tidak ada -> TIDAK dimasukkan ke map sama sekali
// (bukan string kosong), jadi replaceVars() otomatis membuangnya bersih.
function buildVariableMap(packageCard, { avatarUrl, appName } = {}) {
  const map = {};
  const set = (k, v) => { if (v !== undefined && v !== null && v !== '') map[k] = String(v); };

  set('username', packageCard.username);
  set('user_id', packageCard.discordId);
  set('avatar_url', avatarUrl);
  set('package_name', packageCard.role ? packageRoleLabel(packageCard.role) : undefined);
  set('package_type', packageCard.role);
  set('previous_package', packageCard.previousRole ? packageRoleLabel(packageCard.previousRole) : undefined);
  set('package_duration', packageCard.duration);
  set('expires_at', packageCard.activeUntil ? fmtDateTimeWIB(packageCard.activeUntil) : undefined);
  set('expires_at_relative', packageCard.activeUntil ? discordTimestamp(packageCard.activeUntil, 'R') : undefined);
  set('package_price', packageCard.price);
  set('order_id', packageCard.orderId);
  set('package_status', packageCard.status);
  set('admin_name', packageCard.admin);
  set('server_name', appName);

  return map;
}

// Ganti {{var}} di dalam string pakai isi `vars`. Kalau variable-nya tidak
// ada di `vars` (data tidak tersedia untuk event ini), placeholder dibuang
// bersih (jadi string kosong), BUKAN ditampilkan literal "undefined"/"{{..}}".
function replaceVars(str, vars) {
  if (typeof str !== 'string' || !str) return str;
  return str.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (match, key) => {
    const v = vars[key.toLowerCase()];
    return v !== undefined ? v : '';
  }).trim();
}

function cleanUrl(u) {
  const s = (u || '').trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) return null; // Discord menolak URL non-http(s) di embed
  return s;
}

// ── DISCORD LIMITS (poin 13) ──
const LIMITS = {
  title: 256, description: 4096, fieldName: 256, fieldValue: 1024,
  footerText: 2048, authorName: 256, maxFields: 25, totalEmbed: 6000
};

function embedCharCount(t) {
  let total = 0;
  total += (t.title || '').length;
  total += (t.description || '').length;
  total += (t.footer?.text || '').length;
  total += (t.author?.name || '').length;
  for (const f of (t.fields || [])) total += (f.name || '').length + (f.value || '').length;
  return total;
}

// Validasi batas Discord — dipanggil sebelum Save & sebelum kirim beneran.
// Return { ok, errors: [string] }.
function validateTemplate(t) {
  const errors = [];
  if ((t.title || '').length > LIMITS.title) errors.push(`Title melebihi ${LIMITS.title} karakter.`);
  if ((t.description || '').length > LIMITS.description) errors.push(`Description melebihi ${LIMITS.description} karakter.`);
  if ((t.footer?.text || '').length > LIMITS.footerText) errors.push(`Footer text melebihi ${LIMITS.footerText} karakter.`);
  if ((t.author?.name || '').length > LIMITS.authorName) errors.push(`Author name melebihi ${LIMITS.authorName} karakter.`);
  if ((t.fields || []).length > LIMITS.maxFields) errors.push(`Maksimal ${LIMITS.maxFields} fields (saat ini ${t.fields.length}).`);
  (t.fields || []).forEach((f, i) => {
    if ((f.name || '').length > LIMITS.fieldName) errors.push(`Field #${i + 1}: nama melebihi ${LIMITS.fieldName} karakter.`);
    if ((f.value || '').length > LIMITS.fieldValue) errors.push(`Field #${i + 1}: value melebihi ${LIMITS.fieldValue} karakter.`);
  });
  if (embedCharCount(t) > LIMITS.totalEmbed) errors.push(`Total karakter embed melebihi ${LIMITS.totalEmbed}.`);
  return { ok: errors.length === 0, errors };
}

function hexToInt(hex, fallback) {
  if (typeof hex === 'number') return hex;
  const s = String(hex || '').replace('#', '');
  const n = parseInt(s, 16);
  return Number.isFinite(n) ? n : fallback;
}

// ── DEFAULT TEMPLATE per event — dipakai kalau admin belum pernah menyimpan
// (atau setelah "Reset to Default"). Sudah "terlihat premium" sesuai poin 8,
// tapi SELURUH bagian tetap bisa diubah admin lewat Embed Builder.
function defaultTemplateFor(key) {
  const meta = EVENT_MAP[key];
  const color = '#' + (meta?.defaultColor ?? PACKAGE_COLORS.public).toString(16).padStart(6, '0');
  const base = {
    title: '', description: '', color,
    url: '', author: { name: '', iconUrl: '', url: '' },
    thumbnail: { url: '{{avatar_url}}' }, image: { url: '' },
    footer: { text: '31 Tools', iconUrl: '' }, timestamp: true,
    fields: [], buttons: []
  };
  const withFields = (title, description, fields) => ({ ...base, title, description, fields });

  switch (key) {
    case 'activated':
    case 'public': case 'gold': case 'platinum':
      return withFields('💎 PAKET DIAKTIFKAN', 'Paket {{package_name}} berhasil diaktifkan.', [
        { name: '👤 User', value: '{{username}}', inline: false },
        { name: '📦 Paket', value: '{{package_name}}', inline: false },
        { name: '⏳ Durasi', value: '{{package_duration}}', inline: false },
        { name: '📅 Aktif Hingga', value: '{{expires_at}}', inline: false },
        { name: '✅ Status', value: '{{package_status}}', inline: false }
      ]);
    case 'purchase':
      return withFields('💎 PEMBELIAN PAKET', 'Pembayaran untuk paket {{package_name}} berhasil.', [
        { name: '👤 User', value: '{{username}}', inline: false },
        { name: '🎁 Paket', value: '{{package_name}}', inline: false },
        { name: '⏱️ Durasi', value: '{{package_duration}}', inline: false },
        { name: '📅 Aktif Hingga', value: '{{expires_at}}', inline: false },
        { name: '💰 Harga', value: '{{package_price}}', inline: false },
        { name: '🧾 Order ID', value: '{{order_id}}', inline: false },
        { name: '✅ Status', value: '{{package_status}}', inline: false }
      ]);
    case 'upgrade':
      return withFields('⭐ PAKET DI-UPGRADE', '{{username}} upgrade dari {{previous_package}} ke {{package_name}}.', [
        { name: '👤 User', value: '{{username}}', inline: false },
        { name: '📦 Paket', value: '{{previous_package}} → {{package_name}}', inline: false },
        { name: '📅 Aktif Hingga', value: '{{expires_at}}', inline: false },
        { name: '✅ Status', value: '{{package_status}}', inline: false }
      ]);
    case 'renewed':
      return withFields('🔄 MASA AKTIF DIPERPANJANG', 'Masa aktif paket kamu telah diperpanjang oleh Admin.', [
        { name: '👤 User', value: '{{username}}', inline: false },
        { name: '🎁 Paket', value: '{{package_name}}', inline: false },
        { name: '📅 Aktif Hingga', value: '{{expires_at}}', inline: false },
        { name: '✅ Status', value: '{{package_status}}', inline: false }
      ]);
    case 'reset':
      return withFields('♻️ MASA AKTIF DIRESET', 'Masa aktif paket kamu telah direset oleh Admin.', [
        { name: '👤 User', value: '{{username}}', inline: false },
        { name: '🎁 Paket', value: '{{package_name}}', inline: false },
        { name: '✅ Status', value: '{{package_status}}', inline: false }
      ]);
    case 'expiring':
      return withFields('⏳ PAKET HAMPIR BERAKHIR', 'Masa aktif paket kamu tersisa {{package_duration}} lagi. Perpanjang sekarang biar tidak terputus.', [
        { name: '👤 User', value: '{{username}}', inline: false },
        { name: '🎁 Paket', value: '{{package_name}}', inline: false },
        { name: '📅 Berakhir Pada', value: '{{expires_at}}', inline: false },
        { name: '✅ Status', value: '{{package_status}}', inline: false }
      ]);
    case 'expired':
      return withFields('⚠️ PAKET BERAKHIR', 'Paket {{package_name}} sudah berakhir dan otomatis diturunkan ke Public.', [
        { name: '👤 User', value: '{{username}}', inline: false },
        { name: '📦 Paket', value: '{{package_name}}', inline: false },
        { name: '📅 Berakhir', value: '{{expires_at}}', inline: false },
        { name: '✅ Status', value: '{{package_status}}', inline: false }
      ]);
    case 'gold_trial':
      return withFields('🎁 GOLD TRIAL AKTIF', 'Gold Trial kamu berhasil diaktifkan.', [
        { name: '👤 User', value: '{{username}}', inline: false },
        { name: '🎁 Paket', value: '{{package_name}}', inline: false },
        { name: '⏱️ Durasi', value: '{{package_duration}}', inline: false },
        { name: '📅 Aktif Hingga', value: '{{expires_at}}', inline: false },
        { name: '✅ Status', value: '{{package_status}}', inline: false }
      ]);
    case 'voucher':
      return withFields('🎟️ VOUCHER DIKLAIM', 'Voucher berhasil diklaim — paket {{package_name}} kamu aktif.', [
        { name: '👤 User', value: '{{username}}', inline: false },
        { name: '🎁 Paket', value: '{{package_name}}', inline: false },
        { name: '⏱️ Durasi', value: '{{package_duration}}', inline: false },
        { name: '📅 Aktif Hingga', value: '{{expires_at}}', inline: false },
        { name: '✅ Status', value: '{{package_status}}', inline: false }
      ]);
    case 'updated':
    default:
      return withFields('📦 PAKET DIPERBARUI', 'Ada perubahan pada paket {{username}}.', [
        { name: '👤 User', value: '{{username}}', inline: false },
        { name: '🎁 Paket', value: '{{package_name}}', inline: false },
        { name: '✅ Status', value: '{{package_status}}', inline: false }
      ]);
  }
}

module.exports = function ({ getDb }) {
  const db = () => getDb();

  async function getDoc(event) {
    return db().collection(COLLECTION).findOne({ _id: event });
  }

  // Ambil template AKTIF (dari DB kalau ada, else default) — dipakai baik
  // oleh Admin Web (buka editor) maupun renderer notifikasi.
  async function getTemplate(event) {
    if (!isValidEvent(event)) throw new Error('Event paket tidak dikenal: ' + event);
    const doc = await getDoc(event);
    return doc?.template || defaultTemplateFor(event);
  }

  async function listAll() {
    const docs = await db().collection(COLLECTION).find({}).toArray();
    const byId = Object.fromEntries(docs.map(d => [d._id, d]));
    return EVENTS.map(e => ({
      ...e,
      isCustomized: !!byId[e.key],
      updatedAt: byId[e.key]?.updatedAt || null,
      updatedBy: byId[e.key]?.updatedBy || null
    }));
  }

  async function saveTemplate(event, template, adminName) {
    if (!isValidEvent(event)) throw new Error('Event paket tidak dikenal: ' + event);
    const validation = validateTemplate(template);
    if (!validation.ok) {
      const err = new Error(validation.errors[0]);
      err.validation = validation.errors;
      throw err;
    }
    const existing = await getDoc(event);
    const update = {
      $set: {
        event, template,
        updatedAt: new Date(), updatedBy: adminName || 'Admin',
        // Backup versi sebelumnya (poin 17 — Version/Template Safety) — kalau
        // sudah pernah ada dokumen, backup-nya = template lama; kalau ini
        // SIMPANAN PERTAMA, backup-nya = default, supaya "Reset to Default"
        // tetap konsisten hasilnya.
        previousTemplate: existing ? existing.template : defaultTemplateFor(event)
      }
    };
    // PENTING: jangan pernah kirim key modifier ($setOnInsert dkk) dengan
    // value `undefined` — driver MongoDB men-serialize `undefined` jadi BSON
    // `null`, dan Mongo menolaknya ("Modifiers operate on fields but we
    // found type null instead of an object"). Makanya field ini SELALU
    // diisi lewat $set di atas (bukan $setOnInsert kondisional) — aman baik
    // untuk insert (upsert pertama) maupun update biasa.
    await db().collection(COLLECTION).updateOne({ _id: event }, update, { upsert: true });
    return template;
  }

  async function resetTemplate(event) {
    if (!isValidEvent(event)) throw new Error('Event paket tidak dikenal: ' + event);
    await db().collection(COLLECTION).deleteOne({ _id: event });
    return defaultTemplateFor(event);
  }

  // Render template -> { embed, components } siap dikirim ke Discord (Bot API).
  // `packageCard` & `avatarUrl`/`appName` sama seperti yang dipakai
  // buildPackageEmbed() sebelumnya — supaya integrasi ke notifyUser() mulus.
  function renderTemplate(template, packageCard, { avatarUrl, appName } = {}) {
    const vars = buildVariableMap(packageCard, { avatarUrl, appName });
    const title = replaceVars(template.title, vars);
    const description = replaceVars(template.description, vars);

    const fields = (template.fields || [])
      .map(f => ({
        name: replaceVars(f.name, vars),
        value: replaceVars(f.value, vars),
        inline: !!f.inline
      }))
      // Field yang value-nya jadi kosong setelah substitusi (variable tidak
      // tersedia di event ini) dibuang total — tidak pernah tampil kosong.
      .filter(f => f.name && f.value);

    const embed = {
      title: title || undefined,
      description: description || undefined,
      color: hexToInt(template.color, 0x8f96a3),
      fields,
      timestamp: template.timestamp !== false ? new Date().toISOString() : undefined,
      footer: (template.footer?.text || replaceVars(template.footer?.text, vars))
        ? { text: replaceVars(template.footer.text, vars) || undefined, icon_url: cleanUrl(template.footer?.iconUrl) || undefined }
        : undefined
    };

    const url = cleanUrl(replaceVars(template.url, vars));
    if (url) embed.url = url;

    const authorName = replaceVars(template.author?.name, vars);
    if (authorName) {
      embed.author = { name: authorName };
      const aIcon = cleanUrl(replaceVars(template.author?.iconUrl, vars));
      const aUrl = cleanUrl(replaceVars(template.author?.url, vars));
      if (aIcon) embed.author.icon_url = aIcon;
      if (aUrl) embed.author.url = aUrl;
    }

    const thumbUrl = cleanUrl(replaceVars(template.thumbnail?.url, vars));
    if (thumbUrl) embed.thumbnail = { url: thumbUrl };

    const imgUrl = cleanUrl(replaceVars(template.image?.url, vars));
    if (imgUrl) embed.image = { url: imgUrl };

    // Buttons -> Discord Message Components (Link Button, style=5) — SATU-
    // SATUNYA jenis button yang tidak butuh interaction handler di Bot,
    // aman dikirim lewat REST API biasa.
    const linkButtons = (template.buttons || [])
      .filter(b => b.enabled !== false && b.label && cleanUrl(replaceVars(b.url, vars)))
      .slice(0, 5)
      .map(b => ({ type: 2, style: 5, label: String(b.label).slice(0, 80), url: cleanUrl(replaceVars(b.url, vars)) }));
    const components = linkButtons.length ? [{ type: 1, components: linkButtons }] : undefined;

    return { embed, components };
  }

  // Dipakai notifyUser() — ambil template terbaru dari DB (fallback default),
  // render, DAN kalau ternyata invalid (mis. admin sempat menyimpan template
  // yang melebihi limit lewat jalur lain) otomatis jatuh ke template
  // sebelumnya/default supaya notification TIDAK PERNAH gagal terkirim
  // hanya gara-gara template salah (poin 17).
  async function renderPackageEmbed(event, packageCard, opts) {
    let template;
    try {
      template = await getTemplate(event);
    } catch {
      template = defaultTemplateFor(event);
    }
    let validation = validateTemplate(template);
    if (!validation.ok) {
      try {
        const doc = await getDoc(event);
        template = doc?.previousTemplate || defaultTemplateFor(event);
        validation = validateTemplate(template);
        if (!validation.ok) template = defaultTemplateFor(event);
      } catch {
        template = defaultTemplateFor(event);
      }
    }
    return renderTemplate(template, packageCard, opts);
  }

  return {
    EVENTS, EVENT_MAP, VARIABLES, LIMITS,
    isValidEvent, getTemplate, listAll, saveTemplate, resetTemplate,
    validateTemplate, renderTemplate, renderPackageEmbed,
    defaultTemplateFor, buildVariableMap, replaceVars, embedCharCount
  };
};
