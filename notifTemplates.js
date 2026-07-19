// ══════════════════════════════════════════════════════════════════════════
// NOTIF TEMPLATES — helper terpusat buat bikin Discord Embed yang konsisten,
// lengkap, dan enak dibaca (Desktop & Mobile) untuk SEMUA jenis notifikasi
// (webhook per-kategori maupun Discord DM langsung ke user).
//
// Kenapa dipisah ke sini (bukan ditulis manual tiap tempat di server.js):
//   - Satu sumber kebenaran untuk warna/emoji per status (Success/Warning/
//     Error/Info) — ganti di sini otomatis berlaku ke semua notifikasi.
//   - `field()` otomatis membuang field yang datanya tidak ada (undefined/null/
//     '') supaya embed TIDAK PERNAH menampilkan baris kosong/"undefined" —
//     sesuai prinsip "hanya tampilkan data yang memang tersedia pada sistem".
//   - `buildEmbed()` selalu menyertakan Status, Waktu Kejadian, dan Footer
//     aplikasi secara konsisten di SEMUA notifikasi, tanpa perlu diulang-ulang
//     manual di tiap pemanggilan.
// ══════════════════════════════════════════════════════════════════════════

// Status generik yang dipakai di semua embed. Emoji ini SENGAJA dipakai baik
// di title (biar kelihatan dari notifikasi push/preview Discord) maupun di
// field "Status" (biar jelas juga pas embed-nya dibuka).
const STATUS = {
  success: { color: 0x2ecc71, emoji: '🟢', label: 'Success' },
  warning: { color: 0xf1c40f, emoji: '🟡', label: 'Warning' },
  error:   { color: 0xe74c3c, emoji: '🔴', label: 'Error' },
  info:    { color: 0x3498db, emoji: '🔵', label: 'Information' }
};

function statusMeta(status) {
  return STATUS[status] || STATUS.info;
}

// Bikin satu field embed — return null (bukan object) kalau value-nya kosong,
// supaya gampang di-filter (lihat buildEmbed). Ini yang menjamin "hanya
// tampilkan data yang memang tersedia" di semua template notifikasi.
function field(name, value, inline = true) {
  if (value === undefined || value === null || value === '') return null;
  return { name, value: String(value), inline };
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
//   status      : 'success' | 'warning' | 'error' | 'info'
//   title       : judul embed TANPA emoji (emoji status ditambah otomatis)
//   description : deskripsi singkat 1-2 kalimat
//   fields      : array hasil field(...) (boleh ada null di dalamnya)
//   thumbnail   : URL gambar kecil (pojok kanan atas) — dipakai buat icon
//                 paket/logo aplikasi/icon warning, dsb.
//   image       : URL gambar besar (full-width) — dipakai buat cover/banner
//                 game supaya notifikasi terkait game lebih menarik.
//   appName     : nama aplikasi, dipakai di footer.
//   footerNote  : teks tambahan di footer setelah nama aplikasi (mis. label kategori).
//   timestamp   : Date kejadian (default: sekarang).
function buildEmbed({ status = 'info', title, description, fields = [], thumbnail, image, appName, footerNote, timestamp }) {
  const meta = statusMeta(status);
  const when = timestamp || new Date();

  const cleanFields = [
    field('📌 Status', `${meta.emoji} ${meta.label}`, true),
    ...fields.filter(Boolean),
    field('🕒 Waktu Kejadian', fmtDateTimeWIB(when), true)
  ].filter(Boolean);

  const embed = {
    title: `${meta.emoji} ${title}`,
    description: description || undefined,
    color: meta.color,
    fields: cleanFields,
    timestamp: new Date(when).toISOString(),
    footer: { text: footerNote ? `${appName} · ${footerNote}` : `${appName}` }
  };

  if (thumbnail) embed.thumbnail = { url: thumbnail };
  if (image) embed.image = { url: image };

  return embed;
}

module.exports = { STATUS, statusMeta, field, fmtDateTimeWIB, fmtDurationMs, buildEmbed };
