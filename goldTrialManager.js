// ══════════════════════════════════════════════════════════════════════════
// GOLD TRIAL — paket Gold gratis, 1x per akun, KHUSUS untuk user yang benar-
// benar baru bergabung ke Discord Server SETELAH fitur ini pertama kali
// diaktifkan admin. Dipakai dari server.js:
//
//   const goldTrialManager = require('./goldTrialManager')({ getDb: () => db });
//   await goldTrialManager.ensureIndexes();
//   const status = await goldTrialManager.getEligibility({ discordId, discordJoinedAt, deviceId });
//   const claim  = await goldTrialManager.claimTrial({ discordId, username, discordJoinedAt, deviceId });
//   // `deviceId` = fingerprint dari Device Lock yang sudah ada, lihat deviceLock.js
//   // (getDevice()/computeComponents()) — bukan sistem identitas perangkat baru.
//
// Pola disimpan SAMA seperti voucherManager.js/packageManager.js di project ini:
//   - Settings 1 dokumen di collection `settings` (_id: 'goldTrial'), dibaca ulang
//     dari DB tiap kali dibutuhkan (tanpa cache memori) supaya perubahan dari
//     Admin Web langsung berlaku realtime tanpa restart server.
//   - Riwayat klaim di collection terpisah `goldTrialClaims`, dengan UNIQUE INDEX
//     {discordId:1} — inilah yang BENERAN mencegah klaim ganda secara atomic
//     (bukan sekadar "cek dulu baru insert" yang rawan race kalau user klik 2x
//     / 2 device bersamaan). Index ini jugalah yang membuat Gold Trial cuma
//     bisa dipakai 1 KALI SEUMUR HIDUP per akun — dokumen klaim TIDAK PERNAH
//     dihapus walau masa trial-nya sudah habis, jadi user yang trial-nya sudah
//     berakhir tetap tidak bisa klaim lagi.
//   - ANTI MULTI-AKUN (1 PERANGKAT = 1x KLAIM): `deviceId` disimpan di setiap
//     dokumen klaim + UNIQUE INDEX {deviceId:1} (partial, cuma berlaku untuk
//     dokumen yg punya deviceId string — jadi klaim lama sebelum fitur ini
//     tetap aman/tidak kena index). `deviceId` di sini SELALU fingerprint yang
//     SAMA persis dgn Device Lock (lihat deviceLock.js `getDevice()` /
//     `computeComponents()` — SATU sumber kebenaran, TIDAK ada sistem identitas
//     perangkat baru). Server.js mengambilnya dari perangkat yang SUDAH terikat
//     ke akun lewat Device Lock (didaftarkan otomatis pas login, sebelum masuk
//     dashboard), lalu meneruskannya ke getEligibility()/claimTrial() di bawah.
//     Efeknya: ganti akun/email/username tapi masih di PC yang sama -> fingerprint
//     Device Lock-nya identik -> unique index {deviceId:1} menolak klaim kedua,
//     SEBELUM cek "member baru" atau cek lain sekalipun.
//
// `activatedAt` (kapan admin PERTAMA KALI mengaktifkan Gold Trial) dicatat
// SEKALI dan tidak pernah berubah lagi walau admin nonaktif/aktifkan lagi
// berkali-kali setelahnya — inilah cutoff resmi buat nentuin "member baru":
// hanya user yang tanggal join Discord-nya (`discordJoinedAt`, diambil dari
// Discord API pas login/link akun) SETELAH `activatedAt` yang berhak claim.
// User yang sudah jadi member Discord SEBELUM cutoff ini tidak akan pernah
// eligible walau baru pertama kali login/connect ke App setelah itu.
// ══════════════════════════════════════════════════════════════════════════

const SETTINGS_ID = 'goldTrial';
const CLAIMS = 'goldTrialClaims';
const DURATION_UNIT_MS = { minutes: 60 * 1000, hours: 60 * 60 * 1000, days: 24 * 60 * 60 * 1000 };
const DURATION_UNIT_LABEL = { minutes: 'Menit', hours: 'Jam', days: 'Hari' };

const DEFAULTS = {
  _id: SETTINGS_ID,
  active: false,
  durationAmount: 3,
  durationUnit: 'days',
  gameLimit: 2,
  bypassLimit: 2,
  // Deskripsi yang tampil di NOTIFIKASI TAWARAN Gold Trial (sebelum diklaim) — beda
  // dari successMessage (yang tampil SETELAH klaim berhasil). Dipakai oleh GET
  // /api/gold-trial (kartu di App) & notifikasi (normal/TEST/force send), supaya
  // admin bisa mengatur kalimat promosinya dari Admin Web tanpa hardcode di App.
  offerMessage: 'Nikmati akses penuh ke semua fitur Gold secara gratis untuk waktu terbatas.',
  successMessage: 'Selamat! Gold Trial kamu berhasil diaktifkan. Nikmati akses Gold gratis selama masa trial berlangsung.',
  activatedAt: null,
  updatedAt: null
};

module.exports = function createGoldTrialManager({ getDb }) {

  async function ensureIndexes() {
    const db = getDb();
    if (!db) return;
    // Unique per discordId -> 1 akun cuma bisa punya SATU dokumen klaim seumur
    // hidup, ini yang jadi penjamin atomic "1 kali per akun" (bukan cuma cek biasa).
    await db.collection(CLAIMS).createIndex({ discordId: 1 }, { unique: true }).catch(() => {});
    // Unique per deviceId (fingerprint Device Lock) -> 1 PERANGKAT cuma bisa
    // punya SATU dokumen klaim, walau discordId-nya beda-beda (ganti akun/email/
    // username di PC yang sama). PARTIAL index (cuma dokumen yg field deviceId-nya
    // string) supaya dokumen klaim LAMA (dibuat sebelum fitur ini ada, tidak
    // punya field deviceId) tidak ikut kena aturan unique dan tidak perlu migrasi data.
    await db.collection(CLAIMS).createIndex(
      { deviceId: 1 },
      { unique: true, partialFilterExpression: { deviceId: { $type: 'string' } } }
    ).catch(() => {});
  }

  async function getSettings() {
    const db = getDb();
    if (!db) return JSON.parse(JSON.stringify(DEFAULTS));
    const doc = await db.collection('settings').findOne({ _id: SETTINGS_ID });
    if (!doc) return JSON.parse(JSON.stringify(DEFAULTS));
    return { ...DEFAULTS, ...doc };
  }

  function validateInput(input = {}, { partial = false } = {}) {
    const out = {};

    if (input.active !== undefined) out.active = !!input.active;
    else if (!partial) out.active = false;

    if (input.durationAmount !== undefined || input.durationUnit !== undefined || !partial) {
      const unit = input.durationUnit !== undefined ? input.durationUnit : 'days';
      if (!DURATION_UNIT_MS.hasOwnProperty(unit)) throw new Error('Satuan durasi Gold Trial tidak valid (Menit/Jam/Hari).');
      out.durationUnit = unit;
      const amount = Number(input.durationAmount !== undefined ? input.durationAmount : DEFAULTS.durationAmount);
      if (!Number.isFinite(amount) || amount <= 0) throw new Error('Durasi Gold Trial harus lebih dari 0.');
      out.durationAmount = amount;
    }

    for (const key of ['gameLimit', 'bypassLimit']) {
      if (input[key] !== undefined) {
        const raw = input[key];
        if (raw === null || raw === '' || raw === 'unlimited') {
          out[key] = null; // unlimited
        } else {
          const num = Number(raw);
          if (!Number.isFinite(num) || num < 0 || !Number.isInteger(num)) {
            throw new Error(`${key === 'gameLimit' ? 'Limit Download Game' : 'Limit Download Bypass'} Gold Trial tidak valid.`);
          }
          out[key] = num;
        }
      } else if (!partial) {
        out[key] = DEFAULTS[key];
      }
    }

    if (input.successMessage !== undefined) {
      out.successMessage = String(input.successMessage || '').trim().slice(0, 500) || DEFAULTS.successMessage;
    } else if (!partial) {
      out.successMessage = DEFAULTS.successMessage;
    }

    if (input.offerMessage !== undefined) {
      out.offerMessage = String(input.offerMessage || '').trim().slice(0, 500) || DEFAULTS.offerMessage;
    } else if (!partial) {
      out.offerMessage = DEFAULTS.offerMessage;
    }

    return out;
  }

  async function updateSettings(input) {
    const db = getDb();
    if (!db) throw new Error('Database belum siap, coba lagi sebentar.');
    const current = await getSettings();
    const normalized = validateInput(input, { partial: true });

    const set = { ...normalized, updatedAt: new Date() };
    // `activatedAt` cuma di-set SEKALI, pas transisi nonaktif -> aktif yang
    // PERTAMA KALI terjadi. Setelah itu nilainya permanen (tidak pernah
    // ditimpa lagi walau di-nonaktifkan/diaktifkan lagi berkali-kali),
    // supaya cutoff "member baru" tetap konsisten & tidak bisa "direset"
    // tanpa sengaja oleh admin yang cuma toggle on/off.
    if (normalized.active === true && !current.active && !current.activatedAt) {
      set.activatedAt = new Date();
    }

    await db.collection('settings').updateOne({ _id: SETTINGS_ID }, { $set: set }, { upsert: true });
    return getSettings();
  }

  function durationMs(settings) {
    return settings.durationAmount * (DURATION_UNIT_MS[settings.durationUnit] || 0);
  }

  async function getClaimByDiscordId(discordId) {
    const db = getDb();
    if (!db) return null;
    return db.collection(CLAIMS).findOne({ discordId });
  }

  // Cek riwayat klaim berdasarkan Device ID (fingerprint Device Lock) — inilah
  // yang mencegah user bikin akun baru berulang kali untuk klaim ulang di
  // perangkat yang sama.
  async function getClaimByDeviceId(deviceId) {
    const db = getDb();
    if (!db || !deviceId) return null;
    return db.collection(CLAIMS).findOne({ deviceId });
  }

  // Cek apakah akun ini PERNAH punya paket Gold/Platinum lewat jalur manapun
  // (pembelian/voucher/di-set admin/trial sebelumnya) — dicek dari beberapa
  // sumber yang SUDAH ADA di project ini (tidak nambah write baru ke jalur-jalur
  // itu, murni QUERY tambahan) supaya "user yang sudah pernah punya Gold" tidak
  // bisa mengakalinya dengan downgrade dulu baru klaim trial.
  async function hasEverHadGold(discordId) {
    const db = getDb();
    if (!db) return false;

    const user = await db.collection('users').findOne({ discordId });
    if (user && (user.role === 'gold' || user.role === 'platinum')) return true;
    if (user && user.everHadGold) return true;

    const roleLog = await db.collection('roleSyncLogs').findOne({
      discordId, newRole: { $in: ['gold', 'platinum'] }
    });
    if (roleLog) return true;

    const voucherRedemption = await db.collection('voucherRedemptions').findOne({ discordId });
    if (voucherRedemption) {
      const voucher = await db.collection('vouchers').findOne({ _id: voucherRedemption.voucherId });
      if (voucher && (voucher.role === 'gold' || voucher.role === 'platinum')) return true;
    }

    const paidTx = await db.collection('transactions').findOne({
      discordId, status: 'success', 'packageSnapshot.tier': { $in: ['gold', 'platinum'] }
    }).catch(() => null);
    if (paidTx) return true;

    return false;
  }

  // `discordJoinedAt` WAJIB dikirim caller (diambil dari Discord API pas
  // login/OAuth callback — lihat server.js /auth/discord/callback), bukan
  // dari tanggal akun App dibuat, karena user bisa saja sudah lama jadi
  // member Discord tapi baru sekarang bikin akun App.
  //
  // `deviceId` WAJIB dikirim caller juga — ini fingerprint Device Lock milik
  // perangkat yang SEDANG dipakai akun ini (server.js mengambilnya dari
  // deviceLock.getDevice(discordId), BUKAN sistem identitas perangkat baru).
  // Kalau deviceId tidak ada (perangkat belum sempat diverifikasi Device Lock
  // sesi ini), klaim ditolak dulu — supaya proteksi 1-perangkat-1x-klaim di
  // bawah ini TIDAK BISA dilewati begitu saja.
  async function getEligibility({ discordId, discordJoinedAt, deviceId }) {
    const settings = await getSettings();
    if (!settings.active) return { eligible: false, reason: 'inactive', settings };
    if (!settings.activatedAt) return { eligible: false, reason: 'inactive', settings };

    // Admin BUKAN bagian dari hierarchy Gratis/Gold/Platinum (lihat aturan
    // ROLE ADMIN di server.js/app.js) — jadi tidak boleh ditawari ATAU bisa
    // klaim Gold Trial user biasa sama sekali, walau device/akunnya
    // memenuhi syarat "member baru". Dicek dari role ASLI di database
    // (bukan parameter dari caller) supaya aturan ini berlaku konsisten di
    // SEMUA pemanggil getEligibility()/claimTrial() (App maupun lookup
    // Admin Web), sama seperti pola hasEverHadGold() di atas.
    const db = getDb();
    if (db) {
      const user = await db.collection('users').findOne({ discordId }, { projection: { role: 1 } });
      if (user && user.role === 'admin') {
        return { eligible: false, reason: 'admin_account', settings };
      }
    }

    const existingClaim = await getClaimByDiscordId(discordId);
    if (existingClaim) return { eligible: false, reason: 'already_claimed', settings, claim: existingClaim };

    if (!deviceId) return { eligible: false, reason: 'device_not_verified', settings };

    // Device ID ini pernah dipakai klaim (akun manapun, termasuk akun yang
    // sudah dihapus/ganti username/email) -> tolak, walaupun akun SAAT INI
    // (discordId) belum pernah klaim sama sekali.
    const deviceClaim = await getClaimByDeviceId(deviceId);
    if (deviceClaim) return { eligible: false, reason: 'device_already_claimed', settings, claim: deviceClaim };

    if (!discordJoinedAt) return { eligible: false, reason: 'not_new_member', settings };
    const joinedAt = new Date(discordJoinedAt);
    if (isNaN(joinedAt.getTime()) || joinedAt < new Date(settings.activatedAt)) {
      return { eligible: false, reason: 'not_new_member', settings };
    }

    if (await hasEverHadGold(discordId)) {
      return { eligible: false, reason: 'had_gold_before', settings };
    }

    return { eligible: true, reason: null, settings };
  }

  // Klaim Gold Trial — dipanggil dari POST /api/gold-trial/claim di server.js.
  // Server.js WAJIB panggil getEligibility() dulu sebelum ini untuk pesan error
  // yang informatif; fungsi ini tetap validasi ulang semuanya sendiri (defense in
  // depth) supaya tidak mungkin ke-bypass walau caller-nya lupa validasi dulu.
  async function claimTrial({ discordId, username, discordJoinedAt, deviceId }) {
    const db = getDb();
    if (!db) return { ok: false, reason: 'inactive' };

    const eligibility = await getEligibility({ discordId, discordJoinedAt, deviceId });
    if (!eligibility.eligible) return { ok: false, reason: eligibility.reason, settings: eligibility.settings };

    const settings = eligibility.settings;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + durationMs(settings));

    const claimDoc = {
      discordId,
      username: username || discordId,
      deviceId,
      claimedAt: now,
      expiresAt,
      durationAmount: settings.durationAmount,
      durationUnit: settings.durationUnit,
      gameLimit: settings.gameLimit,
      bypassLimit: settings.bypassLimit,
      discordJoinedAt: new Date(discordJoinedAt),
      createdAt: now
    };

    try {
      // Insert INI yang atomic mencegah klaim ganda (unique index discordId
      // MAUPUN deviceId) — kalau ada 2 request klaim barengan (double klik,
      // atau 2 akun beda coba klaim dari perangkat yang sama nyaris bersamaan),
      // yang kedua pasti gagal di sini dengan error code 11000.
      await db.collection(CLAIMS).insertOne(claimDoc);
    } catch (e) {
      if (e.code === 11000) {
        // Tentukan index mana yang bentrok supaya pesan ke user tetap akurat.
        // Driver MongoDB (v6) menyertakan keyPattern pada error duplicate key
        // untuk operasi single-document seperti insertOne.
        const dupField = e.keyPattern ? Object.keys(e.keyPattern)[0]
          : (/deviceId/i.test(e.message || '') ? 'deviceId' : 'discordId');
        return { ok: false, reason: dupField === 'deviceId' ? 'device_already_claimed' : 'already_claimed', settings };
      }
      throw e;
    }

    return { ok: true, claim: claimDoc, settings };
  }

  // FORCE CLAIM — HANYA dipanggil dari Admin Web (POST /api/admin/gold-trial/force-claim
  // di server.js, di belakang requireAdmin). Sengaja TIDAK lewat getEligibility(): admin
  // memang harus bisa memberi Gold Trial ke akun yang sudah pernah klaim/device sudah
  // pernah klaim/tidak eligible normal (lihat spesifikasi FLOW C). Bedanya dengan
  // claimTrial() biasa:
  //   - claimTrial()  -> insertOne, GAGAL (by design) kalau discordId/deviceId sudah
  //                      punya dokumen klaim (itu justru proteksi normal claim).
  //   - forceClaim()  -> upsert berdasarkan discordId SAJA, jadi admin SELALU bisa
  //                      menimpa/membuat klaim baru untuk akun tsb, walau akun/device
  //                      itu sudah pernah klaim sebelumnya.
  // deviceId di sini tetap dicatat untuk histori/consistency dengan claim normal, TAPI
  // kalau deviceId itu ternyata sudah terpakai di dokumen klaim akun LAIN, field
  // deviceId SENGAJA tidak diikutkan ke $set (supaya tidak bentrok dengan unique
  // partial index {deviceId:1} milik akun lain itu) — dicatat di field terpisah
  // `forceClaimDeviceId` (bukan bagian constraint unique) supaya tetap ada jejaknya.
  async function forceClaim({ discordId, username, deviceId, durationAmount, durationUnit, gameLimit, bypassLimit, adminUsername }) {
    const db = getDb();
    if (!db) throw new Error('Database belum siap, coba lagi sebentar.');
    if (!discordId) throw new Error('Discord ID wajib diisi.');

    const settings = await getSettings();
    const unit = durationUnit || settings.durationUnit;
    if (!DURATION_UNIT_MS.hasOwnProperty(unit)) throw new Error('Satuan durasi Gold Trial tidak valid (Menit/Jam/Hari).');
    const amount = Number(durationAmount !== undefined && durationAmount !== null && durationAmount !== '' ? durationAmount : settings.durationAmount);
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('Durasi Gold Trial harus lebih dari 0.');

    const normLimit = (raw, fallback) => {
      if (raw === undefined) return fallback;
      if (raw === null || raw === '' || raw === 'unlimited') return null;
      const num = Number(raw);
      return (Number.isFinite(num) && num >= 0 && Number.isInteger(num)) ? num : fallback;
    };
    const gLimit = normLimit(gameLimit, settings.gameLimit);
    const bLimit = normLimit(bypassLimit, settings.bypassLimit);

    const now = new Date();
    const expiresAt = new Date(now.getTime() + amount * DURATION_UNIT_MS[unit]);

    let deviceConflict = false;
    if (deviceId) {
      const conflicting = await db.collection(CLAIMS).findOne({ deviceId, discordId: { $ne: discordId } });
      if (conflicting) deviceConflict = true;
    }

    const setDoc = {
      username: username || discordId,
      claimedAt: now,
      expiresAt,
      durationAmount: amount,
      durationUnit: unit,
      gameLimit: gLimit,
      bypassLimit: bLimit,
      forcedByAdmin: adminUsername || 'Admin',
      forcedAt: now
    };
    if (deviceId && !deviceConflict) setDoc.deviceId = deviceId;
    else if (deviceId) setDoc.forceClaimDeviceId = deviceId;

    const claimDoc = await db.collection(CLAIMS).findOneAndUpdate(
      { discordId },
      { $set: setDoc, $setOnInsert: { discordId, createdAt: now } },
      { upsert: true, returnDocument: 'after' }
    );

    return { ok: true, claim: claimDoc, settings, deviceConflict };
  }

  async function listClaims({ limit = 200 } = {}) {
    const db = getDb();
    if (!db) return [];
    const claims = await db.collection(CLAIMS).find({}).sort({ claimedAt: -1 }).limit(limit).toArray();
    const now = new Date();
    return claims.map(c => ({ ...c, status: new Date(c.expiresAt) > now ? 'active' : 'expired' }));
  }

  async function countActive() {
    const db = getDb();
    if (!db) return 0;
    return db.collection(CLAIMS).countDocuments({ expiresAt: { $gt: new Date() } });
  }

  return {
    SETTINGS_ID, DURATION_UNIT_MS, DURATION_UNIT_LABEL, DEFAULTS,
    ensureIndexes, getSettings, updateSettings, durationMs,
    getClaimByDiscordId, hasEverHadGold, getEligibility, claimTrial, forceClaim,
    listClaims, countActive
  };
};
