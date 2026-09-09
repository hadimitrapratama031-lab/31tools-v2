// ══════════════════════════════════════════════════════════════════════════
// NOTIF DEDUP — anti-spam untuk Discord Webhook & DM.
// ══════════════════════════════════════════════════════════════════════════
// Tujuan: SATU event hanya mengirim SATU Webhook dan SATU DM.
//   - Dedup berdasarkan Event ID (kalau pemanggil kasih `eventId` eksplisit,
//     mis. ID transaksi/riwayat/log) — event yang sama persis tidak dikirim
//     ulang selama cooldown.
//   - Kalau tidak ada `eventId`, fallback ke hash konten (key + judul +
//     deskripsi + fields) — supaya "kalau data tidak berubah, jangan kirim
//     notifikasi lagi" tetap berlaku walau pemanggil lupa kasih eventId.
//   - Cooldown 5–10 detik per key (default 8 detik) — event SAMA yang terjadi
//     berkali-kali dalam window ini digabung jadi satu (yang pertama saja
//     yang terkirim), sisanya cukup dihitung (`count`) supaya kalau perlu
//     pemanggil bisa tampilkan "×N" di pesan berikutnya.
//   - State di memori (Map) — cukup untuk 1 proses Node yang berjalan terus
//     (server.js jalan sebagai satu proses long-running, bukan serverless),
//     dibersihkan otomatis (entri kadaluarsa dihapus tiap kali dicek + sweep
//     berkala) supaya memori tidak terus bertambah.
// ══════════════════════════════════════════════════════════════════════════

const DEFAULT_COOLDOWN_MS = 8000; // 8 detik — di tengah rentang 5-10 detik yang diminta

// key -> { hash, expiresAt, count, firstAt }
const store = new Map();

function simpleHash(input) {
  const str = typeof input === 'string' ? input : JSON.stringify(input);
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  }
  return h.toString(36) + ':' + str.length;
}

// Bersihkan entri yang sudah kadaluarsa supaya Map tidak membengkak selamanya.
function sweep() {
  const now = Date.now();
  for (const [k, v] of store) {
    if (v.expiresAt <= now) store.delete(k);
  }
}
setInterval(sweep, 60 * 1000).unref?.();

// shouldSend — dipanggil SEBELUM kirim webhook/DM.
//   key         : identitas "saluran" notifikasi ini, mis. `webhook:purchase`
//                 atau `dm:123456789012345678`. WAJIB, supaya event beda
//                 kategori/user tidak saling numpuk cooldown-nya.
//   eventId     : ID unik event kalau ada (ID transaksi/riwayat/log/dll) —
//                 dipakai sebagai bagian dari hash supaya lebih presisi.
//   content     : data yang mau dibandingkan ("kalau data tidak berubah,
//                 jangan kirim lagi") — biasanya title+description+fields.
//   cooldownMs  : lama cooldown (default 8000ms, dalam rentang 5-10 detik).
//
// Return { send: boolean, count: number, firstAt: Date }.
//   send=false berarti event ini DUPLIKAT (event id sama & konten sama, masih
//   dalam cooldown) — pemanggil WAJIB skip pengiriman.
function shouldSend({ key, eventId, content, cooldownMs = DEFAULT_COOLDOWN_MS }) {
  if (!key) return { send: true, count: 1, firstAt: new Date() };
  const hash = simpleHash({ eventId: eventId || null, content: content || null });
  const now = Date.now();
  const existing = store.get(key);

  if (existing && existing.expiresAt > now && existing.hash === hash) {
    existing.count += 1;
    existing.expiresAt = now + cooldownMs; // perpanjang cooldown selama event sama terus terjadi
    return { send: false, count: existing.count, firstAt: existing.firstAt };
  }

  store.set(key, { hash, expiresAt: now + cooldownMs, count: 1, firstAt: new Date(now) });
  return { send: true, count: 1, firstAt: new Date(now) };
}

module.exports = { shouldSend, simpleHash, DEFAULT_COOLDOWN_MS };
