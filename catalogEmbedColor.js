// ══════════════════════════════════════════════════════════════════════════
// CATALOG EMBED ACCENT COLOR — dipakai KHUSUS oleh buildCatalogEmbed() di
// server.js (embed Add Game / Add Bypass / Game Update / Bypass Update) untuk
// menghitung warna embed yang menyesuaikan warna dominan/accent dari banner
// Game/Bypass yang sedang ditambahkan/di-update, sesuai permintaan:
//   "Untuk warna embed, buat agar warna menyesuaikan dengan warna dominan/
//    accent dari image game/bypass jika memungkinkan. Jika gagal mendapatkan
//    warna, gunakan fallback warna dari style 31 Tools."
//
// TIDAK membuat sistem pengambilan gambar baru — modul ini HANYA membaca
// ULANG gambar yang URL-nya sudah dipilih oleh pickCatalogBanner() (ambil
// dari heroImageUrl/imageUrl, yaitu field yang sudah diisi dari Steam Store
// API lewat fitur Auto-Isi yang SUDAH ADA di server.js). Tidak menyentuh,
// mengganti, atau menduplikasi logic Steam API sama sekali.
//
// TEKNIK: resize gambar ke 1x1 pixel (lewat `sharp`) — cara umum & murah
// untuk mendapatkan "warna rata-rata/dominan" dari keseluruhan gambar, tanpa
// perlu library clustering warna yang berat. `sharp` dipilih (bukan library
// pure-JS seperti jimp) karena jauh lebih ringan (~8 package tambahan,
// binary prebuilt) dan sudah sangat umum dipakai di server Node.js produksi.
//
// FALLBACK WARNA "STYLE 31 TOOLS": 0xA05BB4 — persis warna (`10509236`) yang
// dipakai di keempat template JSON (Add Game/Add Bypass/Game Update/Bypass
// Update) yang diberikan sebagai referensi. Dipakai setiap kali ekstraksi
// warna gagal (gambar tidak ada, gagal diunduh, format tak didukung, dll) —
// supaya notifikasi TETAP terkirim & tetap sesuai brand walau ekstraksi
// warna gagal.
// ══════════════════════════════════════════════════════════════════════════

const axios = require('axios');
// Require aman: kalau native binding `sharp` gagal dimuat di platform deploy
// tertentu (jarang terjadi, tapi bukan nol — beda arsitektur/OS), server
// TIDAK BOLEH ikut crash gara-gara fitur warna embed ini. Efeknya cuma warna
// embed katalog selalu pakai fallback "style 31 Tools" (lihat
// extractDominantColor di bawah) — sama sekali tidak mengganggu pengiriman
// notifikasi Add/Update Game/Bypass itu sendiri.
let sharp = null;
try {
  sharp = require('sharp');
} catch (e) {
  console.warn('[CatalogEmbedColor] Module "sharp" gagal dimuat — warna embed katalog akan selalu pakai fallback style 31 Tools:', e.message);
}

const FALLBACK_COLOR = 0xA05BB4; // = 10509236, warna default 4 template JSON ("style 31 Tools")
// Diturunkan dari 6000 -> 4000ms (fix "notifikasi Add/Update Game/Bypass
// delay"): ekstraksi warna ini jalan SEBELUM notif dikirim (lihat
// buildCatalogEmbed di server.js) — network lambat/timeout di sini menunda
// notifikasi Discord ikut lambat. 4 detik masih lebih dari cukup untuk
// unduh 1 gambar header/hero Steam, tapi memangkas skenario terburuk kalau
// koneksi ke CDN gambar lagi lambat.
const FETCH_TIMEOUT_MS = 4000;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8MB — cukup lega untuk hero/header image Steam
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 jam — banner utk App ID yang sama jarang berubah
const CACHE_MAX_ENTRIES = 500;

// Cache in-memory sederhana (bukan collection DB baru) — cuma optimisasi biar
// Add lalu Edit berturut-turut pada game/bypass yang sama tidak selalu
// mengunduh ulang banner yang sama buat hitung warna. Best-effort, boleh
// kosong lagi kapan saja (restart server dsb) tanpa efek samping apapun.
const colorCache = new Map(); // imageUrl -> { color, expiresAt }

function pruneCacheIfNeeded() {
  if (colorCache.size < CACHE_MAX_ENTRIES) return;
  const now = Date.now();
  for (const [key, val] of colorCache) {
    if (val.expiresAt < now) colorCache.delete(key);
  }
  // Masih kepenuhan (banyak entry belum expired) -> buang yang paling lama
  // ditambahkan supaya cache tidak tumbuh tanpa batas.
  if (colorCache.size >= CACHE_MAX_ENTRIES) {
    const oldestKey = colorCache.keys().next().value;
    if (oldestKey !== undefined) colorCache.delete(oldestKey);
  }
}

// Ambil warna rata-rata/dominan dari satu image URL -> integer warna Discord
// (0xRRGGBB), atau `null` kalau gagal di tahap manapun (URL kosong/tidak
// valid, gagal fetch, gagal decode gambar, dll). Pemanggil TIDAK PERNAH
// diharuskan menangani exception dari fungsi ini — semua kegagalan sudah
// ditangkap di sini dan cukup di-treat sebagai "tidak ada warna".
async function extractDominantColor(imageUrl) {
  if (!sharp) return null; // sharp gagal dimuat saat startup -> selalu fallback, lihat require di atas
  if (!imageUrl || typeof imageUrl !== 'string' || !/^https?:\/\//i.test(imageUrl)) return null;

  const cached = colorCache.get(imageUrl);
  if (cached && cached.expiresAt > Date.now()) return cached.color;

  try {
    const res = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      timeout: FETCH_TIMEOUT_MS,
      maxContentLength: MAX_IMAGE_BYTES,
      maxBodyLength: MAX_IMAGE_BYTES,
      validateStatus: (s) => s === 200
    });

    // flatten(): gambar ber-alpha (PNG/WebP transparan) -> alpha dikomposit
    // ke background hitam dulu, supaya tidak crash/salah warna pas di-raw().
    // resize(1,1): cara cepat untuk dapat 1 warna representatif (rata-rata)
    // dari seluruh gambar.
    const { data } = await sharp(res.data)
      .flatten({ background: '#000000' })
      .resize(1, 1, { fit: 'fill' })
      .raw()
      .toBuffer({ resolveWithObject: true });

    if (!data || data.length < 3) return null;
    const [r, g, b] = data;
    const color = ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff);

    pruneCacheIfNeeded();
    colorCache.set(imageUrl, { color, expiresAt: Date.now() + CACHE_TTL_MS });
    return color;
  } catch (e) {
    console.warn('[CatalogEmbedColor] Gagal ekstrak warna dari banner (pakai fallback style 31 Tools):', e.message);
    return null;
  }
}

// Dipakai LANGSUNG oleh buildCatalogEmbed() — versi yang SELALU me-resolve ke
// warna valid (tidak pernah null): fallback otomatis ke FALLBACK_COLOR kalau
// bannernya kosong atau ekstraksi gagal.
async function getCatalogAccentColor(imageUrl) {
  const color = await extractDominantColor(imageUrl);
  return color !== null ? color : FALLBACK_COLOR;
}

module.exports = { getCatalogAccentColor, extractDominantColor, FALLBACK_COLOR };