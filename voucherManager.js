// ══════════════════════════════════════════════════════════════════════════
// VOUCHER PAKET GOLD/PLATINUM — kelola voucher dari Admin Web, diklaim user
// lewat menu "Claim Voucher" di App. Modul ini CUMA ngurus data voucher +
// logika klaim yang aman dari race condition; efek ke akun user (ubah role,
// tambah masa aktif, notifikasi, dsb) tetap dilakukan server.js supaya bisa
// reuse helper yang sudah ada (notifyUser, logActivity, pushAccountUpdate, dst).
// ══════════════════════════════════════════════════════════════════════════
// Kenapa dipisah collection `voucherRedemptions` dari `vouchers`:
//   - Unique index {voucherId,discordId} di situ itulah yang BENERAN mencegah
//     1 user klaim voucher yang sama dua kali, atomic, aman dari race (dua
//     klik/dua device barengan) — bukan sekadar "cek dulu baru insert" yang
//     rawan race.
//   - Kuota voucher (usedCount) dikurangi via findOneAndUpdate dengan filter
//     langsung di query (`usedCount < quota`) — atomic juga, jadi kuota TIDAK
//     PERNAH oversold walau banyak user klaim voucher yang sama persis di
//     waktu yang sama.
//
// Cara pakai dari server.js:
//   const voucherManager = require('./voucherManager')({ getDb: () => db });
//   await voucherManager.ensureIndexes();
//   const result = await voucherManager.claimVoucher({ code, discordId, username });
// ══════════════════════════════════════════════════════════════════════════

const { ObjectId } = require('mongodb');

const VOUCHERS = 'vouchers';
const REDEMPTIONS = 'voucherRedemptions';
const DURATION_UNIT_MS = { minutes: 60 * 1000, hours: 60 * 60 * 1000, days: 24 * 60 * 60 * 1000 };
const DURATION_UNIT_LABEL = { minutes: 'Menit', hours: 'Jam', days: 'Hari' };

module.exports = function createVoucherManager({ getDb }) {

  async function ensureIndexes() {
    const db = getDb();
    if (!db) return;
    await db.collection(VOUCHERS).createIndex({ code: 1 }, { unique: true }).catch(() => {});
    await db.collection(REDEMPTIONS).createIndex({ voucherId: 1, discordId: 1 }, { unique: true }).catch(() => {});
  }

  function normalizeCode(code) {
    return String(code || '').trim().toUpperCase().replace(/\s+/g, '');
  }

  function unwrapFindOneAndUpdate(result) {
    // Driver mongodb v6 default balikin dokumennya langsung; versi lama/opsi lain
    // bisa balikin { value }. Ditangani dua-duanya biar tidak rapuh ke versi driver.
    if (result && typeof result === 'object' && 'value' in result) return result.value;
    return result || null;
  }

  async function listVouchers() {
    const db = getDb();
    if (!db) return [];
    return db.collection(VOUCHERS).find({}).sort({ createdAt: -1 }).toArray();
  }

  async function getVoucherById(id) {
    const db = getDb();
    if (!db || !ObjectId.isValid(id)) return null;
    return db.collection(VOUCHERS).findOne({ _id: new ObjectId(id) });
  }

  function validateCoreFields({ role, durationAmount, durationUnit, quota, expiresAt }, { partial = false } = {}) {
    const update = {};
    if (role !== undefined) {
      if (!['gold', 'platinum'].includes(role)) throw new Error('Paket voucher harus Gold atau Platinum.');
      update.role = role;
    } else if (!partial) {
      throw new Error('Paket voucher harus Gold atau Platinum.');
    }

    if (durationAmount !== undefined || durationUnit !== undefined || !partial) {
      const unit = durationUnit !== undefined ? durationUnit : null;
      if (!partial || durationUnit !== undefined) {
        if (!DURATION_UNIT_MS.hasOwnProperty(unit)) throw new Error('Satuan durasi voucher tidak valid (Menit/Jam/Hari).');
        update.durationUnit = unit;
      }
      if (!partial || durationAmount !== undefined) {
        const amount = Number(durationAmount);
        if (!Number.isFinite(amount) || amount <= 0) throw new Error('Durasi paket voucher harus lebih dari 0.');
        update.durationAmount = amount;
      }
    }

    if (quota !== undefined || !partial) {
      const quotaNum = Number(quota);
      if (!Number.isFinite(quotaNum) || quotaNum <= 0 || !Number.isInteger(quotaNum)) {
        throw new Error('Jumlah kuota voucher harus bilangan bulat lebih dari 0.');
      }
      update.quota = quotaNum;
    }

    if (expiresAt !== undefined) {
      if (!expiresAt) update.expiresAt = null;
      else {
        const d = new Date(expiresAt);
        if (isNaN(d.getTime())) throw new Error('Masa berlaku voucher tidak valid.');
        update.expiresAt = d;
      }
    } else if (!partial) {
      update.expiresAt = null; // default: tidak ada masa berlaku
    }

    return update;
  }

  async function createVoucher({ code, role, durationAmount, durationUnit, quota, expiresAt, createdBy }) {
    const db = getDb();
    if (!db) throw new Error('Database belum siap, coba lagi sebentar.');
    const normCode = normalizeCode(code);
    if (!normCode) throw new Error('Kode voucher wajib diisi.');
    if (!/^[A-Z0-9_-]{3,32}$/.test(normCode)) throw new Error('Kode voucher 3-32 karakter, hanya huruf/angka/-/_ (spasi tidak diperbolehkan).');

    const fields = validateCoreFields({ role, durationAmount, durationUnit, quota, expiresAt });

    const doc = {
      code: normCode,
      ...fields,
      usedCount: 0,
      active: true,
      createdAt: new Date(),
      createdBy: createdBy || null,
      updatedAt: new Date()
    };
    try {
      const result = await db.collection(VOUCHERS).insertOne(doc);
      return { ...doc, _id: result.insertedId };
    } catch (e) {
      if (e.code === 11000) throw new Error(`Kode voucher "${normCode}" sudah dipakai, pilih kode lain.`);
      throw e;
    }
  }

  async function updateVoucher(id, { code, role, durationAmount, durationUnit, quota, expiresAt, active }) {
    const db = getDb();
    if (!db) throw new Error('Database belum siap, coba lagi sebentar.');
    if (!ObjectId.isValid(id)) throw new Error('ID voucher tidak valid.');
    const existing = await db.collection(VOUCHERS).findOne({ _id: new ObjectId(id) });
    if (!existing) throw new Error('Voucher tidak ditemukan.');

    const update = validateCoreFields({ role, durationAmount, durationUnit, quota, expiresAt }, { partial: true });
    update.updatedAt = new Date();

    if (code !== undefined) {
      const normCode = normalizeCode(code);
      if (!normCode) throw new Error('Kode voucher wajib diisi.');
      if (!/^[A-Z0-9_-]{3,32}$/.test(normCode)) throw new Error('Kode voucher 3-32 karakter, hanya huruf/angka/-/_ (spasi tidak diperbolehkan).');
      update.code = normCode;
    }
    if (update.quota !== undefined && update.quota < existing.usedCount) {
      throw new Error(`Kuota tidak boleh lebih kecil dari jumlah yang sudah terpakai (${existing.usedCount}).`);
    }
    if (active !== undefined) update.active = !!active;

    try {
      await db.collection(VOUCHERS).updateOne({ _id: existing._id }, { $set: update });
    } catch (e) {
      if (e.code === 11000) throw new Error(`Kode voucher "${update.code}" sudah dipakai, pilih kode lain.`);
      throw e;
    }
    return db.collection(VOUCHERS).findOne({ _id: existing._id });
  }

  async function deleteVoucher(id) {
    const db = getDb();
    if (!db) throw new Error('Database belum siap, coba lagi sebentar.');
    if (!ObjectId.isValid(id)) throw new Error('ID voucher tidak valid.');
    const existing = await db.collection(VOUCHERS).findOne({ _id: new ObjectId(id) });
    if (!existing) throw new Error('Voucher tidak ditemukan.');
    await db.collection(VOUCHERS).deleteOne({ _id: existing._id });
    // Riwayat klaim voucher ini ikut dibersihkan juga, biar tidak ada redemption
    // "menggantung" yang nunjuk ke voucher yang sudah dihapus.
    await db.collection(REDEMPTIONS).deleteMany({ voucherId: existing._id }).catch(() => {});
    return existing;
  }

  function isVoucherUsable(v, now = new Date()) {
    if (!v) return { ok: false, reason: 'invalid_code' };
    if (v.active === false) return { ok: false, reason: 'inactive' };
    if (v.expiresAt && new Date(v.expiresAt) <= now) return { ok: false, reason: 'expired' };
    if (v.usedCount >= v.quota) return { ok: false, reason: 'quota_full' };
    return { ok: true };
  }

  // ── Klaim voucher — dipanggil dari POST /api/voucher/claim di server.js.
  // Mengembalikan { ok:true, voucher } kalau berhasil (server.js yang lanjut
  // ubah role/activeUntil user), atau { ok:false, reason, voucher? } kalau gagal.
  // `reason` salah satu: invalid_code | inactive | expired | quota_full | already_claimed
  async function claimVoucher({ code, discordId, username }) {
    const db = getDb();
    if (!db) return { ok: false, reason: 'invalid_code' };
    const normCode = normalizeCode(code);
    if (!normCode) return { ok: false, reason: 'invalid_code' };

    const voucher = await db.collection(VOUCHERS).findOne({ code: normCode });
    if (!voucher) return { ok: false, reason: 'invalid_code' };

    const usable = isVoucherUsable(voucher);
    if (!usable.ok) return { ok: false, reason: usable.reason, voucher };

    // 1) "Kunci" slot user ini DULU lewat unique index (voucherId+discordId) —
    //    inilah yang atomic mencegah double-claim, bukan sekadar cek-lalu-insert.
    let redemptionId;
    try {
      const insertResult = await db.collection(REDEMPTIONS).insertOne({
        voucherId: voucher._id, code: voucher.code, discordId, username: username || null,
        claimedAt: new Date()
      });
      redemptionId = insertResult.insertedId;
    } catch (e) {
      if (e.code === 11000) return { ok: false, reason: 'already_claimed', voucher };
      throw e;
    }

    // 2) Baru kurangi kuota SECARA ATOMIC (guard `usedCount < quota` ada di query
    //    filter-nya sendiri) — aman walau banyak user klaim voucher yang sama
    //    persis di waktu yang bersamaan, kuota tidak akan pernah oversold.
    const result = await db.collection(VOUCHERS).findOneAndUpdate(
      { _id: voucher._id, active: true, $expr: { $lt: ['$usedCount', '$quota'] } },
      { $inc: { usedCount: 1 }, $set: { updatedAt: new Date() } },
      { returnDocument: 'after' }
    );
    const updatedVoucher = unwrapFindOneAndUpdate(result);

    if (!updatedVoucher) {
      // Kuota kehabisan TEPAT di antara langkah 1 & 2 (race super jarang tapi
      // mungkin) -> rollback slot user supaya dia tidak "kehabisan jatah" sia-sia.
      await db.collection(REDEMPTIONS).deleteOne({ _id: redemptionId }).catch(() => {});
      return { ok: false, reason: 'quota_full', voucher };
    }

    return { ok: true, voucher: updatedVoucher };
  }

  async function hasClaimed(voucherId, discordId) {
    const db = getDb();
    if (!db || !ObjectId.isValid(voucherId)) return false;
    const doc = await db.collection(REDEMPTIONS).findOne({ voucherId: new ObjectId(voucherId), discordId });
    return !!doc;
  }

  return {
    DURATION_UNIT_MS, DURATION_UNIT_LABEL,
    ensureIndexes, normalizeCode,
    listVouchers, getVoucherById,
    createVoucher, updateVoucher, deleteVoucher,
    isVoucherUsable, claimVoucher, hasClaimed
  };
};
