// ══════════════════════════════════════════════════════════════════════════
// NOTIF TEMPLATES — helper terpusat buat bikin Discord Embed & DM yang
// konsisten, lengkap, dan enak dibaca (Desktop & Mobile) untuk SEMUA jenis
// notifikasi (webhook per-kategori maupun Discord DM langsung ke user).
//
// Kenapa dipisah ke sini (bukan ditulis manual tiap tempat di server.js):
//   - Satu sumber kebenaran untuk warna/emoji per status (Success/Info/
//     Warning/Error/Update/Security) — ganti di sini otomatis berlaku ke
//     SEMUA notifikasi (Webhook & DM).
//   - Satu sumber kebenaran untuk "Badge Kategori" (Game/Bypass/User/Paket/
//     Voucher/Update/Admin/Security/System) yang tampil di setiap embed.
//   - `field()` otomatis membuang field yang datanya tidak ada (undefined/null/
//     '') supaya embed TIDAK PERNAH menampilkan baris kosong/"undefined" —
//     sesuai prinsip "hanya tampilkan data yang memang tersedia pada sistem".
//   - `buildEmbed()` selalu menyertakan Badge, Status, Waktu Kejadian, dan
//     Footer "31 Tools" secara konsisten di SEMUA notifikasi, tanpa perlu
//     diulang-ulang manual di tiap pemanggilan.
//   - `buildDM()` sama seperti buildEmbed tapi ditujukan buat pesan pribadi
//     (bisa nambah field "Langkah Berikutnya").
// ══════════════════════════════════════════════════════════════════════════

// Nama brand yang SELALU tampil di footer, terlepas dari APP_NAME internal
// (kalau admin ganti APP_NAME di .env) — sesuai permintaan: footer harus "31 Tools".
const BRAND = '31 Tools';

// Status generik yang dipakai di semua embed. Emoji ini SENGAJA dipakai baik
// di title (biar kelihatan dari notifikasi push/preview Discord) maupun di
// field "Status" (biar jelas juga pas embed-nya dibuka).
const STATUS = {
  success:  { color: 0x2ecc71, emoji: '🟢', label: 'Success' },
  info:     { color: 0x3498db, emoji: '🔵', label: 'Information' },
  warning:  { color: 0xf1c40f, emoji: '🟡', label: 'Warning' },
  error:    { color: 0xe74c3c, emoji: '🔴', label: 'Error' },
  update:   { color: 0x9b59b6, emoji: '🟣', label: 'Update' },
  security: { color: 0xe67e22, emoji: '🟠', label: 'Security' }
};

function statusMeta(status) {
  return STATUS[status] || STATUS.info;
}

// Badge kategori — ditampilkan sebagai field pertama tiap embed ("🏷️ Kategori")
// supaya sekilas lihat langsung tau notifikasi ini soal apa. SATU-SATUNYA
// sumber kebenaran badge di seluruh aplikasi.
const BADGE = {
  game:         { emoji: '🎮', label: 'Game' },
  bypass:       { emoji: '🛠️', label: 'Bypass' },
  game_bypass:  { emoji: '🎮🛠️', label: 'Game & Bypass' },
  user:         { emoji: '👤', label: 'User' },
  paket:        { emoji: '📦', label: 'Paket' },
  voucher:      { emoji: '🎟️', label: 'Voucher' },
  request_game: { emoji: '📥', label: 'Request Game' },
  payment:      { emoji: '💳', label: 'Payment' },
  update:       { emoji: '🚀', label: 'Update' },
  admin:        { emoji: '🛡️', label: 'Admin' },
  security:     { emoji: '🔐', label: 'Security' },
  system:       { emoji: '⚙️', label: 'System' }
};

function badgeMeta(badge) {
  return BADGE[badge] || null;
}

// Bikin satu field embed — return null (bukan object) kalau value-nya kosong,
// supaya gampang di-filter (lihat buildEmbed). Ini yang menjamin "hanya
// tampilkan data yang memang tersedia" di semua template notifikasi.
function field(name, value, inline = true) {
  if (value === undefined || value === null || value === '') return null;
  return { name, value: String(value), inline };
}

// Bungkus value field jadi "badge/tag" ala card (contoh: `Platinum`) memakai
// inline-code Discord, bukan teks polos — dipakai untuk DM (buildDM) MAUPUN
// Webhook (dibungkus di webhookManager.sendCategoryWebhook, satu tempat,
// berlaku untuk semua kategori webhook) supaya keduanya tampil konsisten.
function toBadgeValue(value) {
  const str = String(value);
  // Jangan bungkus kalau sudah ada backtick atau multi-baris (mis. deskripsi
  // panjang) — inline-code Discord tidak mendukung newline dengan rapi.
  if (str.includes('`') || str.includes('\n') || str.length > 200) return str;
  return `\`${str}\``;
}

// Format Date -> tag Discord dinamis, contoh: <t:1737590400:R> ("2 menit
// lalu", auto-update & otomatis menyesuaikan timezone device pembaca) atau
// gaya lain (f/F/d/D/t/T). Dipakai sebagai field "⏱️ Discord Timestamp"
// terpisah dari "🕒 Waktu" (yang fixed WIB) di buildEmbed().
function discordTimestamp(date = new Date(), style = 'R') {
  const unix = Math.floor(new Date(date).getTime() / 1000);
  if (!Number.isFinite(unix)) return null;
  return `<t:${unix}:${style}>`;
}

// Format Date -> "20 Jul 2026, 14.35 WIB" (locale Indonesia, zona Asia/Jakarta).
function fmtDateTimeWIB(date = new Date()) {
  const d = new Date(date);
  const datePart = d.toLocaleDateString('id-ID', { timeZone: 'Asia/Jakarta', day: '2-digit', month: 'short', year: 'numeric' });
  const timePart = d.toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit' });
  return `${datePart}, ${timePart} WIB`;
}

// Format sisa durasi (ms) jadi teks singkat manusiawi, mis. "2 hari 3 jam" /
// "45 menit". Dipakai buat "Sisa Masa Aktif".
function fmtDurationMs(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const totalMinutes = Math.round(ms / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const parts = [];
  if (days > 0) parts.push(`${days} hari`);
  if (hours > 0) parts.push(`${hours} jam`);
  if (days === 0 && minutes > 0) parts.push(`${minutes} menit`);
  return parts.length ? parts.join(' ') : '< 1 menit';
}

// Builder utama. `fields` boleh berisi hasil field() yang null — otomatis
// dibuang di sini, jadi pemanggil tidak perlu filter manual satu-satu.
//
//   status      : 'success' | 'info' | 'warning' | 'error' | 'update' | 'security'
//   badge       : kunci BADGE ('game'|'bypass'|'user'|'paket'|'voucher'|'update'
//                 |'admin'|'security'|'system') — tampil sebagai field pertama.
//   title       : judul embed TANPA emoji (emoji status ditambah otomatis)
//   description : deskripsi singkat 1-2 kalimat (Detail Aktivitas)
//   username    : nama user terkait (opsional)
//   role        : role/paket user terkait (opsional)
//   userId      : Discord ID user terkait (opsional)
//   admin       : nama admin yang melakukan aksi, kalau ada (opsional)
//   fields      : array hasil field(...) tambahan (boleh ada null di dalamnya)
//   thumbnail   : URL gambar kecil (pojok kanan atas) — icon paket/logo app/
//                 logo bypass, dsb.
//   image       : URL gambar besar (full-width) — cover game / banner update.
//   appName     : nama aplikasi internal (fallback footer kalau footerNote kosong).
//   footerNote  : teks tambahan di footer sebelum nama brand (label kategori).
//   timestamp   : Date kejadian (default: sekarang).
function buildEmbed({
  status = 'info', badge, title, description,
  username, role, userId, admin,
  fields = [], thumbnail, image, appName, footerNote, timestamp
}) {
  const meta = statusMeta(status);
  const bMeta = badgeMeta(badge);
  const when = timestamp || new Date();

  const cleanFields = [
    bMeta ? field('🏷️ Kategori', `${bMeta.emoji} ${bMeta.label}`, true) : null,
    field('📌 Status', `${meta.emoji} ${meta.label}`, true),
    field('👤 Username', username, true),
    field('📦 Role/Paket', role ? String(role).toUpperCase() : null, true),
    field('🆔 ID User', userId, true),
    field('🛡️ Admin', admin, true),
    ...fields.filter(Boolean),
    field('🕒 Waktu', fmtDateTimeWIB(when), true),
    // Tag waktu dinamis Discord — tampil relatif ("2 menit lalu") & otomatis
    // ikut timezone tiap pembaca, melengkapi field "Waktu" (fixed WIB) di atas.
    field('⏱️ Discord Timestamp', discordTimestamp(when, 'R'), true)
  ].filter(Boolean);

  const footerText = footerNote ? `${footerNote} • ${BRAND}` : (appName ? `${appName} • ${BRAND}` : BRAND);

  const embed = {
    title: `${meta.emoji} ${title}`,
    description: description || undefined,
    color: meta.color,
    fields: cleanFields,
    timestamp: new Date(when).toISOString(),
    footer: { text: footerText }
  };

  if (thumbnail) embed.thumbnail = { url: thumbnail };
  if (image) embed.image = { url: image };

  return embed;
}

// Builder khusus DM — sama seperti buildEmbed, tapi mendukung `nextSteps`
// (Langkah Berikutnya) yang cuma relevan di pesan pribadi ke user, bukan di
// webhook channel admin.
// Ubah embed biasa (hasil buildEmbed) jadi gaya "card" DM — tiap value field
// dibungkus inline-code (badge/tag), persis contoh tampilan yang diminta
// (🏷️ User / `namauser`, 💎 Paket / `Platinum`, dst), bukan sekadar teks
// polos. Field "Discord Timestamp" dilewati karena tag <t:...> Discord tidak
// dirender kalau dibungkus inline-code. Diekspor terpisah supaya tempat yang
// sudah kadung punya satu embed jadi (mis. notifyUser() di server.js, dipakai
// bareng untuk Webhook & DM) bisa dapat versi DM-nya tanpa build ulang.
function toDmEmbed(embed) {
  return {
    ...embed,
    fields: (embed.fields || []).map(f => (
      f.name === '⏱️ Discord Timestamp' ? f : { ...f, value: toBadgeValue(f.value) }
    ))
  };
}

function buildDM({ nextSteps, ...rest }) {
  const embed = buildEmbed(rest);
  if (nextSteps) {
    // Selipkan sebelum field waktu terakhir supaya "Langkah Berikutnya" tetap
    // jadi salah satu baris terakhir yang dibaca user, bukan nyempil di tengah.
    const waktuIdx = embed.fields.findIndex(f => f.name === '🕒 Waktu');
    const stepField = { name: '➡️ Langkah Berikutnya', value: String(nextSteps), inline: false };
    if (waktuIdx === -1) embed.fields.push(stepField);
    else embed.fields.splice(waktuIdx, 0, stepField);
  }
  return toDmEmbed(embed);
}

// ══════════════════════════════════════════════════════════════════════════
// PACKAGE CARD — embed KHUSUS untuk semua notifikasi seputar PAKET user
// (Public/Gold/Platinum/Gold Trial: aktivasi, pembelian, upgrade, perpanjangan,
// reset, hampir berakhir, berakhir, voucher). Dipakai SAMA PERSIS untuk Webhook
// (channel admin) maupun DM (pesan pribadi user) supaya tampilannya konsisten
// di kedua tempat — beda dari buildEmbed/buildDM generik: field-nya dibuat
// "compact card" satu kolom (label di atas, value di bawah, TANPA inline-code)
// meniru referensi desain yang diminta, dan warnanya otomatis mengikuti jenis
// paket (bukan cuma status success/error generik).
// ══════════════════════════════════════════════════════════════════════════

// Warna premium per jenis paket — sengaja tidak terlalu terang/norak.
const PACKAGE_COLORS = {
  public:      0x8f96a3, // netral abu-abu
  gold:        0xd4af37, // emas elegan
  platinum:    0xa9b4c0, // silver/platinum
  gold_trial:  0xe8b923, // emas, sedikit beda dari Gold biasa
  admin:       0x4ade80,
  expired:     0xaf4448  // merah pudar untuk status berakhir
};

const PACKAGE_ROLE_LABEL = { public: 'Public', gold: 'Gold', platinum: 'Platinum', gold_trial: 'Gold Trial', admin: 'Admin' };

function packageRoleLabel(role) {
  if (!role) return role;
  return PACKAGE_ROLE_LABEL[role] || (String(role).charAt(0).toUpperCase() + String(role).slice(1));
}

function packageColor(role, event) {
  if (event === 'expired') return PACKAGE_COLORS.expired;
  return PACKAGE_COLORS[role] || PACKAGE_COLORS.public;
}

// Metadata (icon + title default) per jenis event paket.
const PACKAGE_EVENT = {
  activated:  { icon: '💎', title: 'PAKET DIAKTIFKAN' },
  purchase:   { icon: '💎', title: 'PEMBELIAN PAKET' },
  upgrade:    { icon: '⭐', title: 'PAKET DI-UPGRADE' },
  updated:    { icon: '📦', title: 'PAKET DIPERBARUI' },
  renewed:    { icon: '🔄', title: 'MASA AKTIF DIPERPANJANG' },
  reset:      { icon: '♻️', title: 'MASA AKTIF DIRESET' },
  expiring:   { icon: '⏳', title: 'PAKET HAMPIR BERAKHIR' },
  expired:    { icon: '⚠️', title: 'PAKET BERAKHIR' },
  gold_trial: { icon: '🎁', title: 'GOLD TRIAL AKTIF' },
  voucher:    { icon: '🎟️', title: 'VOUCHER DIKLAIM' }
};

// field() versi non-inline (satu kolom, "card style") — dipakai khusus di sini
// supaya tiap baris tampil "Label" lalu "Value" di bawahnya, persis referensi.
function cardField(name, value) {
  if (value === undefined || value === null || value === '') return null;
  return { name, value: String(value), inline: false };
}

// Builder utama package card. Dipakai LANGSUNG (tanpa dibungkus toDmEmbed) baik
// untuk Webhook maupun DM, supaya value field tampil sebagai teks biasa (bukan
// inline-code/badge) sama seperti referensi desain.
//
//   event        : salah satu key PACKAGE_EVENT di atas.
//   username     : nama user terkait.
//   avatarUrl    : URL avatar Discord user — dipakai sebagai thumbnail. Kalau
//                  tersedia SELALU dipakai (bukan logo aplikasi), sesuai
//                  permintaan "logo otomatis mengambil avatar user".
//   role         : paket saat ini/baru ('public'|'gold'|'platinum'|'gold_trial'|'admin').
//   previousRole : kalau diisi, field Paket ditampilkan sebagai "Sebelumnya → Baru".
//   duration     : teks durasi, mis. "30 Hari" (opsional, dilewati kalau kosong).
//   activeUntil  : Date — kapan paket aktif/berakhir.
//   activeLabel  : label field tanggal, default "Aktif Hingga" (dipakai "Berakhir"
//                  untuk event expired).
//   status       : teks status, default "🟢 AKTIF" (dipakai "🔴 EXPIRED" dst).
//   price/orderId/admin: opsional, field tambahan untuk Pembelian/Upgrade.
//   appName      : nama brand/toko — footer.
function buildPackageEmbed({
  event, description, username, avatarUrl, role, previousRole,
  duration, activeUntil, activeLabel = 'Aktif Hingga', status = '🟢 AKTIF',
  price, orderId, admin, appName, timestamp, extraFields = [], fallbackThumbnail
}) {
  const meta = PACKAGE_EVENT[event] || { icon: '📦', title: 'INFO PAKET' };
  const color = packageColor(role, event);
  const when = timestamp || new Date();

  const fields = [
    cardField('👤 User', username),
    previousRole
      ? cardField('📦 Paket', `${packageRoleLabel(previousRole)} → ${packageRoleLabel(role)}`)
      : cardField('🎁 Paket', packageRoleLabel(role)),
    cardField('⏱️ Durasi', duration),
    cardField(`📅 ${activeLabel}`, activeUntil ? fmtDateTimeWIB(activeUntil) : null),
    cardField('💰 Harga', price),
    cardField('🧾 Order ID', orderId),
    cardField('🛡️ Admin', admin),
    ...extraFields.filter(Boolean),
    cardField('✅ Status', status)
  ].filter(Boolean);

  const embed = {
    title: `${meta.icon} ${meta.title}`,
    description: description || undefined,
    color,
    fields,
    timestamp: new Date(when).toISOString(),
    footer: { text: appName || BRAND }
  };

  const thumb = avatarUrl || fallbackThumbnail;
  if (thumb) embed.thumbnail = { url: thumb };

  return embed;
}

module.exports = {
  STATUS, statusMeta, BADGE, badgeMeta, BRAND, field, toBadgeValue, discordTimestamp,
  fmtDateTimeWIB, fmtDurationMs, buildEmbed, buildDM, toDmEmbed,
  PACKAGE_COLORS, packageRoleLabel, packageColor, buildPackageEmbed
};
