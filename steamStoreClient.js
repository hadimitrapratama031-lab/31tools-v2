// ══════════════════════════════════════════════════════════════════════════
// STEAM STORE CLIENT — SATU-SATUNYA tempat project ini memanggil Steam Store
// appdetails API (store.steampowered.com/api/appdetails). Sebelum file ini
// ada, logic yang PERSIS SAMA ditulis ULANG di 3 tempat berbeda di server.js
// (lookupAppIdInfo untuk Add Game/Auto-Isi, fetchSteamDetailsForAppId untuk
// Game Detail/Steam Account, fetchSteamAppSummary untuk Request Game) — bug
// fix (variasi cc/locale + User-Agent) sempat cuma kepasang di 2 dari 3
// tempat itu karena harus ditempel manual satu-satu. SEKARANG hanya ada SATU
// implementasi; ketiga pemanggil di server.js tinggal memetakan hasilnya ke
// bentuk field masing-masing (nama field beda-beda sesuai kebutuhan tiap
// fitur), TIDAK ada lagi logic request/retry yang diduplikasi.
//
// ROOT CAUSE bug "App ID ditemukan Hubcap tapi Steam Store bilang tidak
// ditemukan" (App ID yang sebenarnya VALID & punya Store page):
//
//   Steam appdetails MEWAJIBKAN cookie age-verification (birthtime, dst)
//   untuk App ID yang diberi rating DEWASA/mature oleh Steam. Tanpa cookie
//   ini, Steam membalas `success:false` untuk App ID tersebut — PERSIS
//   seolah-olah App ID itu tidak ada sama sekali — padahal Store page-nya
//   ada & valid, cuma "digembok" age-gate karena request dianggap datang
//   dari browser yang belum pernah konfirmasi umur. Ini kesalahan integrasi
//   Steam Store API yang sangat umum (Steam mengasumsikan pemanggilnya
//   browser yang sudah lolos age-check sekali sebelumnya, bukan server-to-
//   server). Perbaikan sebelumnya (variasi `cc`/locale + User-Agent browser)
//   TIDAK menyentuh masalah ini sama sekali — App ID mature-rated akan TETAP
//   gagal di ke-2 variant cc manapun selama cookie age-gate belum dikirim.
//
//   Fix: kirim header `Cookie: birthtime=0; ...` di SETIAP request —
//   birthtime=0 = lahir 1 Januari 1970 (Unix epoch), otomatis lolos semua
//   batas umur yang dipakai Steam di negara manapun (termasuk 21+).
//
// Selain itu ditambah 1 variasi region (`sg`) sebagai jaring pengaman ketiga
// untuk App ID yang di-region-lock spesifik di `us`/`id` tapi terbuka di
// kawasan Asia Tenggara lainnya — TIDAK menghapus 2 variant lama, cuma
// nambah satu percobaan lagi sebelum benar-benar dianggap "tidak ditemukan".
//
// PENTING — pemisahan status HASIL (dipakai SEMUA pemanggil untuk membedakan
// "App ID memang tidak ada" dari "Steam API lagi bermasalah", sesuai
// permintaan: jangan menyatukan semua kegagalan jadi satu pesan generik):
//   status 'ok'        — data ditemukan, `data` = objek `data` mentah dari
//                         Steam appdetails (field asli Steam: name,
//                         header_image, about_the_game, developers, dst),
//                         dipetakan sendiri oleh tiap pemanggil.
//   status 'not_found' — SEMUA variant cc/locale membalas `success:false`
//                         secara EKSPLISIT (Steam benar-benar menjawab,
//                         cuma jawabannya "tidak ada") -> App ID ini
//                         genuinely tidak punya Store page (game non-Steam,
//                         appid tools/DLC tanpa page publik, dihapus dari
//                         Store, atau App ID salah ketik).
//   status 'error'     — SEMUA variant gagal karena masalah JARINGAN/API
//                         (timeout, rate-limit 429 yang gagal setelah
//                         retry, 5xx, dst) — Steam TIDAK PERNAH benar-benar
//                         menjawab "tidak ada". Pemanggil WAJIB memperlakukan
//                         ini beda dari 'not_found' (jangan menggagalkan Add
//                         Game / jangan menandai App ID sebagai invalid
//                         hanya karena Steam sedang lambat/limit).
// ══════════════════════════════════════════════════════════════════════════

const axios = require('axios');

const STEAM_REQUEST_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept': 'application/json',
  // Age-gate bypass — lihat catatan ROOT CAUSE di atas file ini. Tanpa header
  // ini, App ID mature-rated akan SELALU `success:false` apapun variant
  // cc/locale yang dicoba.
  'Cookie': 'birthtime=0; lastagecheckage=1-January-1970; wants_mature_content=1; mature_content=1'
};

// Dicoba berurutan sampai salah satu berhasil. `us`/`id` dipertahankan dari
// fix sebelumnya (terbukti stabil), `sg` ditambah sebagai jaring pengaman
// ketiga (lihat catatan region-lock di atas).
const STEAM_PARAM_VARIANTS = [
  { cc: 'us', l: 'english' },
  { cc: 'id', l: 'indonesian' },
  { cc: 'sg', l: 'english' }
];

const STEAM_STATUS = Object.freeze({ OK: 'ok', NOT_FOUND: 'not_found', ERROR: 'error' });

async function requestVariant(appId, variantParams) {
  try {
    const res = await axios.get('https://store.steampowered.com/api/appdetails', {
      params: { appids: appId, ...variantParams },
      headers: STEAM_REQUEST_HEADERS,
      timeout: 10000
    });
    return { res, err: null };
  } catch (err) {
    return { res: null, err };
  }
}

// DIAGNOSTIK — dicetak tiap kali Search App ID dipanggil (bukan hot path,
// ini aksi manual admin, jadi aman selalu nyala tanpa perlu env flag).
// Tunjukkan PERSIS variant mana yang dicoba, status HTTP/`success` yang
// dibalas Steam per variant, dan alasan akhir kalau semuanya gagal — supaya
// kalau App ID tertentu masih gagal walau sudah lolos age-gate, langsung
// kelihatan dari Railway logs apakah ini soal IP server diblokir Steam
// (network error/timeout di SEMUA variant) atau App ID memang tidak listed
// (SEMUA variant balas success:false secara eksplisit).
function logSteamAttempt(appId, variant, outcome) {
  try { console.log(`[SteamStoreClient] appId=${appId} variant=${JSON.stringify(variant)} ->`, outcome); } catch (e) { /* noop */ }
}

// fetchSteamAppDetails(appId) -> Promise<{ status, data, errorReason }>
// TIDAK melakukan caching sama sekali — caching (in-memory/DB, TTL beda
// untuk hasil sukses vs gagal) tetap jadi tanggung jawab masing-masing
// pemanggil di server.js (kebutuhan tiap fitur beda: Request Game butuh
// cache 30 menit + persist DB 24 jam, Add Game/Auto-Isi sengaja TIDAK
// caching sama sekali karena admin mengharapkan data terbaru tiap Search).
async function fetchSteamAppDetails(appId) {
  let sawNetworkError = false;

  for (const variant of STEAM_PARAM_VARIANTS) {
    let { res, err } = await requestVariant(appId, variant);

    if (err && err.response?.status === 429) {
      // Rate-limited — retry SEKALI dengan jeda kecil sebelum menyerah ke
      // variant ini (bukan langsung lompat ke variant berikutnya, supaya
      // tidak menghajar Steam lebih sering saat memang lagi dibatasi).
      await new Promise(r => setTimeout(r, 600));
      ({ res, err } = await requestVariant(appId, variant));
    }

    if (err) {
      sawNetworkError = true;
      logSteamAttempt(appId, variant, { networkError: true, httpStatus: err.response?.status ?? null, message: err.message });
      continue; // timeout/network/5xx -> coba variant berikutnya, BUKAN not_found
    }

    const candidate = res.data?.[String(appId)];
    if (candidate?.success && candidate.data) {
      logSteamAttempt(appId, variant, { httpStatus: res.status, steamSuccess: true });
      return { status: STEAM_STATUS.OK, data: candidate.data, errorReason: null };
    }
    logSteamAttempt(appId, variant, { httpStatus: res.status, steamSuccess: candidate?.success ?? null, rawKeys: candidate ? Object.keys(candidate) : (res.data ? Object.keys(res.data) : null) });
    // `success:false` eksplisit dari Steam -> tetap lanjut coba variant lain
    // (cc/age-gate berikutnya) sebelum benar-benar menyerah.
  }

  if (sawNetworkError) {
    logSteamAttempt(appId, 'FINAL', { result: 'error', reason: 'network error di semua variant — kemungkinan besar IP server diblokir/dibatasi Steam, BUKAN soal App ID' });
    return {
      status: STEAM_STATUS.ERROR, data: null,
      errorReason: 'Steam Store API sedang tidak bisa dihubungi (timeout/rate-limit) — coba lagi sebentar lagi.'
    };
  }
  logSteamAttempt(appId, 'FINAL', { result: 'not_found', reason: 'semua variant balas success:false secara eksplisit' });
  return {
    status: STEAM_STATUS.NOT_FOUND, data: null,
    errorReason: 'App ID ini tidak memiliki Store page publik di Steam (delisted, bukan game utama, atau App ID salah).'
  };
}

module.exports = { fetchSteamAppDetails, STEAM_STATUS };
