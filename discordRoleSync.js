// ══════════════════════════════════════════════════════════════════════════
// VERIFY ROLE — sinkronisasi role App ⇄ Discord + webhook notif
// ══════════════════════════════════════════════════════════════════════════
// Modul ini berdiri sendiri (dipisah dari server.js biar gak nambah panjang
// file yang udah gede) dan di-require dari server.js dengan cara:
//
//    const roleSync = require('./discordRoleSync')({ getDb: () => db, ROLE_LEVEL });
//    roleSync.startGateway();
//
// Tanggung jawab modul ini:
//   1. syncAppRoleToDiscord()  → dipanggil pas admin ganti role di app (set
//      paket). Nge-add role Discord yang sesuai & nge-remove role tier lain,
//      jadi role Discord user SELALU cerminan role app-nya (satu tier aktif).
//   2. Gateway listener (guildMemberUpdate / guildMemberRemove) → kebalikannya:
//      kalau role Discord user diubah manual dari Discord (add/remove role
//      lewat server Discord langsung), role di app ikut disesuaikan otomatis.
//   3. Notifikasi Discord (lewat Discord Bot, kategori 'role_change' di
//      discordNotifyManager.js — channel diatur di Admin Web > Notifications
//      Channel Setting) → kirim notif tiap kali role/paket user berubah,
//      dari admin panel ATAUPUN dari sinkronisasi balik Discord→app. Webhook
//      URL manual legacy SUDAH TIDAK DIPAKAI LAGI.
//   4. Full resync 2 arah + endpoint bantu admin (list role guild, dsb).
//
// CATATAN PENTING buat yang setup:
//   - Bot Discord WAJIB punya intent "SERVER MEMBERS INTENT" yang diaktifkan
//     di Discord Developer Portal > Application kamu > Bot > Privileged
//     Gateway Intents. Tanpa ini, gateway.login() bakal gagal terus
//     (disallowed intents) dan fitur sinkron Discord→App tidak akan jalan
//     (tapi App→Discord & webhook tetap jalan normal karena itu cuma REST).
//   - Role Discord yang mau dipakai untuk "gold" / "platinum" WAJIB posisinya
//     di BAWAH role bot di daftar role server (Discord ngatur hierarchy gini,
//     bot gak bisa kasih/cabut role yang levelnya di atas dia sendiri).
// ══════════════════════════════════════════════════════════════════════════

const axios = require('axios');

const DISCORD_API = 'https://discord.com/api/v10';
const SETTINGS_ID = 'roleSync';

module.exports = function createRoleSync({ getDb, ROLE_LEVEL, pushAccountUpdate, broadcastAdmin, logActivity, webhookManager }) {
  const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || '';
  const GUILD_ID = process.env.DISCORD_GUILD_ID || '';

  // Semua tier yang bisa disinkron — termasuk 'public' kalau roleId-nya di-set
  const ALL_TIERS = Object.keys(ROLE_LEVEL); // ['public','gold','platinum']
  const TIERS     = ALL_TIERS.filter(r => r !== 'public'); // ['gold','platinum'] — buat logika lama yg exclude public

  const gatewayStatus = { connected: false, error: null, guildName: null, guildId: GUILD_ID || null };
  let client = null;

  // ══════════════════════════════════════════════════════════════════════
  // SELF-ECHO GUARD (fix bug baru: role flip-flop / "kedelete lagi") —
  //
  // syncAppRoleToDiscord() melakukan BEBERAPA panggilan Discord API terpisah
  // (add role baru, remove role lama) untuk SATU perubahan. Tiap panggilan
  // itu memicu event Gateway `guildMemberUpdate` SENDIRI-SENDIRI ke listener
  // di bawah — termasuk pada KEADAAN ANTARA (mis. sesaat setelah role lama
  // sudah dicabut tapi role baru belum sempat ditambahkan). Sebelumnya,
  // listener memperlakukan SETIAP event itu sebagai "role diubah manual dari
  // Discord" (padahal itu gema dari perubahan yang App sendiri lakukan),
  // membaca role Discord yang saat itu memang lagi tidak lengkap, lalu
  // MENIMPA BALIK role di database — menghasilkan notifikasi "Role
  // Diperbarui" berkali-kali yang saling bolak-balik (public → platinum →
  // public → platinum, dst), dan pada kasus sial role bisa berakhir salah
  // (turun balik ke public padahal baru saja di-set Platinum).
  //
  // Perbaikan: setiap kali App sendiri yang memulai perubahan role Discord
  // (syncAppRoleToDiscord), user tsb ditandai "in-flight" untuk beberapa
  // detik. Selama window itu, listener guildMemberUpdate MENGABAIKAN event
  // untuk user tsb sepenuhnya — karena event itu hampir pasti gema dari
  // perubahan App sendiri, bukan perubahan manual asli dari Discord. Begitu
  // window habis, listener normal kembali aktif seperti biasa untuk user itu.
  const inFlightAppSync = new Map(); // discordId -> expiresAt (ms)
  const SELF_ECHO_GUARD_MS = 10000; // 10 detik — cukup untuk propagasi gateway + beberapa panggilan REST berurutan
  function markSyncInFlight(discordId) {
    inFlightAppSync.set(discordId, Date.now() + SELF_ECHO_GUARD_MS);
  }
  function isSyncInFlight(discordId) {
    const exp = inFlightAppSync.get(discordId);
    if (exp === undefined) return false;
    if (exp <= Date.now()) { inFlightAppSync.delete(discordId); return false; }
    return true;
  }
  // Bersihkan entri kadaluarsa berkala supaya Map tidak membengkak selamanya.
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of inFlightAppSync) { if (v <= now) inFlightAppSync.delete(k); }
  }, 30 * 1000).unref?.();

  // ── HTTP helper ke Discord REST (bot token) ──
  async function discordRequest(method, url, data) {
    try {
      const res = await axios({
        method,
        url: `${DISCORD_API}${url}`,
        data,
        headers: { Authorization: `Bot ${BOT_TOKEN}`, 'Content-Type': 'application/json' },
        validateStatus: () => true
      });
      if (res.status === 429) {
        // Rate limited — tunggu sesuai retry_after lalu coba SEKALI lagi (jangan retry berkali-kali
        // biar gak bikin resync massal jadi lambat banget kalau memang lagi kena limit panjang)
        const retryAfterMs = Math.ceil((res.data?.retry_after || 1) * 1000);
        await new Promise(r => setTimeout(r, retryAfterMs));
        return discordRequest(method, url, data);
      }
      if (res.status >= 400) {
        const err = new Error(res.data?.message || `Discord API error (${res.status})`);
        err.discordStatus = res.status;
        throw err;
      }
      return res.data;
    } catch (e) {
      if (e.discordStatus) throw e;
      const err = new Error(e.message);
      err.discordStatus = e.response?.status || null;
      throw err;
    }
  }

  const addMemberRole    = (userId, roleId) => discordRequest('put',    `/guilds/${GUILD_ID}/members/${userId}/roles/${roleId}`);
  const removeMemberRole = (userId, roleId) => discordRequest('delete', `/guilds/${GUILD_ID}/members/${userId}/roles/${roleId}`);
  const getGuildMember   = (userId)         => discordRequest('get',   `/guilds/${GUILD_ID}/members/${userId}`);
  const getGuildRoles    = ()               => discordRequest('get',   `/guilds/${GUILD_ID}/roles`);

  async function listGuildMembers() {
    const members = [];
    let after = '0';
    // Discord batesin max 1000 per request — loop pake cursor `after` sampe habis
    for (;;) {
      const batch = await discordRequest('get', `/guilds/${GUILD_ID}/members?limit=1000&after=${after}`);
      if (!Array.isArray(batch) || batch.length === 0) break;
      members.push(...batch);
      after = batch[batch.length - 1].user.id;
      if (batch.length < 1000) break;
    }
    return members;
  }

  // ── SETTINGS (disimpan di DB, bisa diatur lewat admin panel — fallback ke .env kalau belum pernah diisi) ──
  async function getSettings() {
    const db = getDb();
    if (!db) return defaultSettings();
    let doc = await db.collection('settings').findOne({ _id: SETTINGS_ID });
    if (!doc) {
      doc = defaultSettings();
      await db.collection('settings').updateOne({ _id: SETTINGS_ID }, { $set: doc }, { upsert: true });
    }
    return doc;
  }

  function defaultSettings() {
    return {
      _id: SETTINGS_ID,
      discordRoleMap: {
        public:   process.env.DISCORD_ROLE_ID_PUBLIC   || null,
        gold:     process.env.DISCORD_ROLE_ID_GOLD     || null,
        platinum: process.env.DISCORD_ROLE_ID_PLATINUM || null,
        // Role Discord yang, kalau dipegang user, otomatis menjadikan role app-nya 'admin'
        // (dan sebaliknya: di-set 'admin' dari panel → role Discord ini ikut ditambahkan).
        admin:    process.env.DISCORD_ROLE_ID_ADMIN    || null
      },
      autoSyncFromDiscord: true, // kalau role Discord diubah manual, ikut update role di app
      resetRoleOnLeave: true,    // kalau user keluar dari server Discord, role app di-reset ke public
      updatedAt: new Date()
    };
  }

  async function updateSettings(patch) {
    const db = getDb();
    if (!db) throw new Error('Database belum siap.');
    const current = await getSettings();
    const next = {
      discordRoleMap: {
        public:   patch.discordRoleMap?.public   !== undefined ? (patch.discordRoleMap.public   || null) : current.discordRoleMap?.public   || null,
        gold:     patch.discordRoleMap?.gold      !== undefined ? (patch.discordRoleMap.gold     || null) : current.discordRoleMap?.gold     || null,
        platinum: patch.discordRoleMap?.platinum  !== undefined ? (patch.discordRoleMap.platinum || null) : current.discordRoleMap?.platinum  || null,
        admin:    patch.discordRoleMap?.admin     !== undefined ? (patch.discordRoleMap.admin    || null) : current.discordRoleMap?.admin     || null
      },
      autoSyncFromDiscord: patch.autoSyncFromDiscord !== undefined ? !!patch.autoSyncFromDiscord : (current.autoSyncFromDiscord !== false),
      resetRoleOnLeave: patch.resetRoleOnLeave !== undefined ? !!patch.resetRoleOnLeave : (current.resetRoleOnLeave !== false),
      updatedAt: new Date()
    };
    await db.collection('settings').updateOne({ _id: SETTINGS_ID }, { $set: next }, { upsert: true });
    return { _id: SETTINGS_ID, ...next };
  }

  // ── WEBHOOK ──
  const ROLE_COLOR = { public: 0x8f8ab0, gold: 0xffd76a, platinum: 0xa78bfa, admin: 0x4ade80 };
  const ROLE_ICON  = { public: '🌐', gold: '🥇', platinum: '💎', admin: '👑' };

  // Kirim notifikasi lewat Discord Bot (discordNotifyManager), BUKAN webhook URL
  // manual lagi. `category` menentukan channel mana yang dipakai (diatur admin
  // di halaman Notifications Channel Setting) — 'role_change' untuk perubahan
  // role/paket, 'admin_activity' untuk aksi manual admin seperti Full Resync.
  async function sendBotNotification(category, { title, description, color, fields, eventId }) {
    if (!webhookManager || typeof webhookManager.sendCategoryWebhook !== 'function') {
      return { sent: false, reason: 'webhook_manager_unavailable' };
    }
    return webhookManager.sendCategoryWebhook(category, { title, description, color, fields, eventId });
  }

  function roleChangeEmbed({ username, discordId, oldRole, newRole, source, note, discordSync, dmResult }) {
    const SOURCE_LABEL = {
      admin:      '🛠️ Diubah manual oleh Admin (set paket)',
      discord:    '💬 Mengikuti perubahan role di Discord',
      left_guild: '🚪 User keluar dari server Discord',
      resync:     '🔄 Full Resync'
    };
    const fields = [
      { name: '👤 User',        value: `\`${username || discordId}\``, inline: true },
      { name: '🆔 Discord ID',  value: `\`${discordId}\``,            inline: true },
      { name: '📤 Sumber',      value: SOURCE_LABEL[source] || source, inline: false },
      { name: '🔄 Perubahan Role', value: `${ROLE_ICON[oldRole] || '❓'} **${oldRole || '—'}** → ${ROLE_ICON[newRole] || '🌐'} **${newRole}**`, inline: false },
    ];

    // Tambah info Discord sync kalau ada
    if (discordSync) {
      const syncStatus = discordSync.ok
        ? `✅ Berhasil${discordSync.added ? ` (add: ${ROLE_ICON[discordSync.added]} ${discordSync.added})` : ''}${discordSync.removed?.length ? `, cabut: ${discordSync.removed.join(', ')}` : ''}`
        : `❌ Gagal — ${discordSync.reason || 'unknown'}${discordSync.errors?.length ? ` (${discordSync.errors.join('; ')})` : ''}`;
      fields.push({ name: '🔗 Sync Discord', value: syncStatus, inline: false });
    }

    // Tambah info DM kalau ada
    if (dmResult) {
      fields.push({ name: '💬 DM ke User', value: dmResult.success ? '✅ Terkirim' : `❌ Gagal (${dmResult.errMsg || dmResult.reason || 'unknown'})`, inline: true });
    }

    if (note) fields.push({ name: '📝 Catatan', value: note, inline: false });

    return {
      title: `${ROLE_ICON[newRole] || '🌐'} Role Diperbarui: ${username || discordId}`,
      description: `Paket user berhasil diubah menjadi **${newRole}**`,
      color: ROLE_COLOR[newRole] ?? 0xa78bfa,
      fields
    };
  }

  // ── Tentukan tier tertinggi dari daftar role ID yang dimiliki member ──
  function tierFromRoleIds(memberRoleIds, roleMap) {
    const idSet = new Set(memberRoleIds || []);
    // urutan dari level tertinggi ke rendah (ROLE_LEVEL: public 0, gold 1, platinum 2, dst)
    // Cek dari tier tertinggi ke terendah, termasuk 'public' kalau ada roleId-nya
    const sortedTiers = [...ALL_TIERS].sort((a, b) => (ROLE_LEVEL[b] ?? 0) - (ROLE_LEVEL[a] ?? 0));
    for (const tier of sortedTiers) {
      if (roleMap[tier] && idSet.has(roleMap[tier])) return tier;
    }
    return 'public';
  }

  // ══════════════════════════════════════════════════════════════════════
  // APP → DISCORD: dipanggil pas role user di app diubah (admin set paket,
  // atau proses resync). Nge-add role tier yang sesuai + nge-remove role
  // tier lain, supaya CUMA SATU role tier yang aktif di Discord (konsisten
  // sama role di app — gak ada tumpuk role gold+platinum bersamaan).
  // ══════════════════════════════════════════════════════════════════════
  async function syncAppRoleToDiscord(discordId, newRole) {
    if (!BOT_TOKEN || !GUILD_ID) {
      return { ok: false, reason: 'bot_not_configured', added: null, removed: [], errors: [] };
    }
    const settings = await getSettings();
    const roleMap = settings.discordRoleMap || {};

    const configuredTiers = ALL_TIERS.filter(t => roleMap[t]);
    if (configuredTiers.length === 0) {
      return { ok: false, reason: 'not_configured', added: null, removed: [], errors: [] };
    }

    let member;
    try {
      member = await getGuildMember(discordId);
    } catch (e) {
      if (e.discordStatus === 404) return { ok: false, reason: 'not_member', added: null, removed: [], errors: [] };
      return { ok: false, reason: 'discord_error', added: null, removed: [], errors: [e.message] };
    }
    const currentRoleIds = new Set(member.roles || []);

    // Tandai user ini "in-flight" SEBELUM melakukan panggilan Discord API apapun
    // di bawah — supaya gema guildMemberUpdate dari panggilan ini sendiri
    // diabaikan oleh listener (lihat komentar SELF-ECHO GUARD di atas).
    markSyncInFlight(discordId);

    // ── LOGIKA ROLE DISCORD (diperbaiki) ──
    //
    // ATURAN:
    //  • Role public (jika dikonfigurasi) → SELALU ada, tidak pernah dicabut saat upgrade.
    //    Ini biasanya dipakai sebagai "verified member" role — tidak ada alasan dicabut
    //    hanya karena user upgrade ke Gold/Platinum.
    //
    //  • Set ke public  → tambah role public (kalau belum), cabut gold & platinum.
    //  • Set ke gold    → tambah role gold, role public TETAP, role platinum dicabut.
    //  • Set ke platinum → tambah role platinum, role public TETAP, role gold DICABUT
    //    (karena platinum sudah mencakup semua hak gold — tidak perlu dobel role tier).
    //
    // Konsekuensi: user yang upgrade ke gold tetap punya role public di Discord,
    // dan saat naik ke platinum, gold-nya baru dicabut (diganti platinum).
    //
    // URUTAN OPERASI (fix bug flip-flop): role BARU ditambahkan DULU, role
    // LAMA baru dicabut SETELAHNYA — bukan sebaliknya. Sebelumnya urutannya
    // remove-dulu-baru-add, yang sempat membuat user berada di KEADAAN TANPA
    // role tier apapun (selain public) selama sepersekian detik di antara dua
    // panggilan API — jendela waktu itulah yang memicu race dengan Gateway
    // listener (lihat SELF-ECHO GUARD di atas). Dengan add-dulu, pada
    // keadaan antara user justru PUNYA KEDUA role tier sekaligus (bukan tidak
    // punya sama sekali) — jauh lebih aman digabung dengan guard di atas.

    const result = { ok: true, added: null, removed: [], errors: [] };

    // Tahap 1: TAMBAHKAN role tier yang sesuai (kalau belum punya) — DULUAN.
    if (roleMap[newRole] && configuredTiers.includes(newRole)) {
      try {
        if (!currentRoleIds.has(roleMap[newRole])) {
          await addMemberRole(discordId, roleMap[newRole]);
        }
        result.added = newRole;
      } catch (e) {
        result.errors.push(`${newRole}: ${e.message}`);
      }
    }

    // Tahap 2: CABUT role tier lain yang tidak lagi berhak (gold/platinum
    // selain newRole) — SETELAH role baru terpasang. Role public TIDAK
    // PERNAH dicabut di tahap ini (skip eksplisit).
    for (const tier of configuredTiers) {
      if (tier === newRole) continue; // sudah ditangani tahap 1
      if (tier === 'public') continue; // public tidak pernah dicabut oleh package sync
      const roleId = roleMap[tier];
      try {
        if (currentRoleIds.has(roleId)) {
          await removeMemberRole(discordId, roleId);
          result.removed.push(tier);
        }
      } catch (e) {
        result.errors.push(`${tier}: ${e.message}`);
      }
    }
    if (result.errors.length) result.ok = false;

    // ── RETRY / RECONCILIATION TRACKING (poin 18 & 19 audit) ──
    // Sebelumnya kalau panggilan Discord API di atas gagal (rate limit lama,
    // Discord API lagi down, bot kehilangan permission "Manage Roles" sesaat,
    // dll), kegagalan itu cuma tercatat di log — role Discord user jadi TIDAK
    // SESUAI database SELAMANYA sampai admin sadar & klik "Full Resync" manual.
    // Sekarang: tiap kegagalan (selain 'not_configured', yang berarti admin
    // memang belum atur role ID sama sekali — tidak ada gunanya diulang) DAN
    // selain 'not_member' (user belum join server, akan otomatis tersinkron
    // saat dia join lewat gateway) ditandai di dokumen user (`roleSyncPending`)
    // supaya reconcilePendingRoleSyncs() di bawah bisa otomatis MENGULANG
    // syncAppRoleToDiscord() ini secara berkala TANPA butuh aksi admin —
    // idempotent, aman dipanggil ulang berkali-kali (lihat komentar di atas).
    try {
      const db = getDb();
      if (db) {
        if (!result.ok && result.reason !== 'not_configured' && result.reason !== 'not_member') {
          await db.collection('users').updateOne({ discordId }, {
            $set: {
              roleSyncPending: true,
              roleSyncPendingRole: newRole,
              roleSyncPendingReason: result.reason || (result.errors[0] || 'unknown'),
              roleSyncPendingAt: new Date()
            }
          }).catch(() => {});
        } else if (result.ok) {
          // Berhasil (atau sudah benar sejak awal) — bersihkan flag kalau ada,
          // supaya reconciler tidak mengulang sesuatu yang sudah beres.
          await db.collection('users').updateOne({ discordId }, {
            $unset: { roleSyncPending: '', roleSyncPendingRole: '', roleSyncPendingReason: '', roleSyncPendingAt: '' }
          }).catch(() => {});
        }
      }
    } catch (e) { /* tracking best-effort, tidak boleh menggagalkan hasil sync utama */ }

    return result;
  }

  // ══════════════════════════════════════════════════════════════════════
  // RECONCILIATION — dipanggil berkala (lihat server.js, setInterval) untuk
  // MENGULANG OTOMATIS sinkronisasi role Discord user yang sempat gagal
  // (ditandai `roleSyncPending: true` oleh syncAppRoleToDiscord() di atas),
  // dan juga sebagai jaring pengaman terakhir: kalau user aktif Gold/Platinum
  // di DB tapi ternyata role Discord-nya hilang (mis. admin lain iseng cabut
  // manual dari Discord padahal autoSyncFromDiscord dimatikan, atau race lain
  // yang tidak sempat ke-track), tetap otomatis DITAMBAHKAN KEMBALI (poin 8
  // di audit: "Jika role Gold ternyata hilang tetapi database masih
  // menunjukkan Gold Active → otomatis ADD kembali Gold").
  //
  // Idempotent total (reuse syncAppRoleToDiscord yang sudah idempotent) dan
  // TIDAK PERNAH mengubah database package (source of truth tetap APP,
  // sesuai poin 18) — cuma menyamakan Discord supaya cerminan dari APP.
  // Dibatasi jumlah user per-jalan (batchLimit) + jeda antar-user supaya tidak
  // membanjiri Discord API kalau ada banyak user pending sekaligus.
  // ══════════════════════════════════════════════════════════════════════
  async function reconcilePendingRoleSyncs({ batchLimit = 25 } = {}) {
    const db = getDb();
    if (!db || !BOT_TOKEN || !GUILD_ID) return { checked: 0, fixed: 0, stillFailing: 0 };
    const settings = await getSettings();
    const roleMap = settings.discordRoleMap || {};
    if (!TIERS.some(t => roleMap[t])) return { checked: 0, fixed: 0, stillFailing: 0 }; // belum ada role di-mapping sama sekali

    // Kandidat: (a) yang eksplisit ditandai pending gara-gara Discord API gagal
    // sebelumnya, DAN (b) jaring pengaman — user Gold/Platinum aktif yang
    // belum pernah ditandai pending sama sekali TIDAK di-scan penuh di sini
    // (supaya ringan/tidak membanjiri Discord API tiap 5 menit untuk seluruh
    // user); jaring pengaman penuh tetap tersedia lewat "Full Resync" manual
    // admin (fullResync('app_to_discord')) untuk audit besar sesekali.
    const candidates = await db.collection('users')
      .find({ roleSyncPending: true })
      .limit(batchLimit)
      .toArray();

    let fixed = 0, stillFailing = 0;
    for (const u of candidates) {
      try {
        const r = await syncAppRoleToDiscord(u.discordId, u.role);
        if (r.ok) fixed++; else stillFailing++;
      } catch (e) {
        stillFailing++;
      }
      await new Promise(resolve => setTimeout(resolve, 300)); // jaga-jaga rate limit
    }
    if (candidates.length > 0) {
      console.log(`[RoleSync Reconcile] Diperiksa: ${candidates.length}, diperbaiki: ${fixed}, masih gagal: ${stillFailing}.`);
    }
    return { checked: candidates.length, fixed, stillFailing };
  }

  // ── Dipanggil server.js tiap kali role user berubah, apapun sumbernya ──
  // Nyatet log histori + kirim webhook. Sinkron ke Discord dipanggil terpisah
  // (biar caller bisa pilih: pas set dari ADMIN, arahnya app→discord; pas
  // terdeteksi dari GATEWAY, arahnya udah discord→app jadi gak perlu push balik).
  //
  // `skipWebhook` (default false): dulu fungsi ini SELALU kirim notifikasi
  // "Verify Role"-nya sendiri — tapi beberapa caller di server.js (auto-downgrade
  // masa aktif habis, aktivasi pembelian paket, admin set-paket manual) SUDAH
  // mengirim notifikasi kategori sendiri yang lebih lengkap lewat webhookManager
  // (badge/footer/template konsisten — lihat notifTemplates.js), jadi kalau
  // logRoleChange ikut kirim notifikasi 'role_change'-nya juga, SATU event yang
  // sama berakhir jadi 2-3 pesan Discord terpisah (bug "notif dobel"). Caller
  // yang SUDAH mengirim notifikasi kategorinya sendiri untuk event yang sama
  // WAJIB pasang `skipWebhook: true`. Gateway sync (Discord→App, lihat
  // startGateway() di bawah) TIDAK punya jalur notifikasi lain sama sekali,
  // jadi tetap default kirim (skipWebhook: false) lewat Discord Bot kategori
  // 'role_change', supaya perubahan role lewat Discord tetap ada jejak
  // notifikasinya — dan tetap muncul di channel yang sama dengan perubahan
  // role dari sumber lain (satu kategori, satu channel, tidak nyasar).
  async function logRoleChange({ discordId, username, oldRole, newRole, source, discordSync, note, dmResult, skipWebhook = false }) {
    const db = getDb();
    if (db) {
      await db.collection('roleSyncLogs').insertOne({
        discordId, username, oldRole: oldRole || null, newRole, source,
        discordSynced: discordSync ? !!discordSync.ok : null,
        discordSyncReason: discordSync?.reason || null,
        note: note || null,
        createdAt: new Date()
      });
    }
    if (!skipWebhook) {
      await sendBotNotification('role_change', {
        ...roleChangeEmbed({ username, discordId, oldRole, newRole, source, note, discordSync, dmResult }),
        eventId: `role_change:${discordId}:${oldRole || 'none'}:${newRole}:${source}`
      });
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // GATEWAY — dengerin perubahan role Discord secara real-time supaya bisa
  // sinkron balik ke app (Discord → App). Pakai discord.js, connect sekali
  // pas server start & auto-reconnect ditangani library-nya sendiri.
  // ══════════════════════════════════════════════════════════════════════
  function startGateway() {
    if (!BOT_TOKEN) {
      gatewayStatus.error = 'DISCORD_BOT_TOKEN belum diisi di .env — sinkron Discord→App tidak aktif (App→Discord & webhook tetap jalan).';
      console.warn('[RoleSync Gateway]', gatewayStatus.error);
      return;
    }
    let Client, GatewayIntentBits;
    try {
      ({ Client, GatewayIntentBits } = require('discord.js'));
    } catch (e) {
      gatewayStatus.error = 'Package "discord.js" belum ter-install. Jalankan `npm install` dulu.';
      console.error('[RoleSync Gateway]', gatewayStatus.error);
      return;
    }

    client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });

    client.once('ready', () => {
      gatewayStatus.connected = true;
      gatewayStatus.error = null;
      const guild = client.guilds.cache.get(GUILD_ID);
      gatewayStatus.guildName = guild?.name || null;
      console.log(`✅ [RoleSync Gateway] Terhubung sebagai ${client.user.tag}${guild ? ` — guild: ${guild.name}` : ''}`);
    });

    client.on('error', (e) => {
      gatewayStatus.error = e.message;
      console.error('[RoleSync Gateway] error:', e.message);
    });

    client.on('shardDisconnect', () => { gatewayStatus.connected = false; });
    client.on('shardReady', () => { gatewayStatus.connected = true; });

    // Role Discord user berubah manual (admin lain add/remove role langsung dari server Discord)
    client.on('guildMemberUpdate', async (oldMember, newMember) => {
      try {
        if (newMember.guild.id !== GUILD_ID) return;
        const db = getDb();
        if (!db) return;

        // SELF-ECHO GUARD — abaikan event ini kalau perubahan role member ini
        // baru saja (dalam beberapa detik terakhir) dipicu OLEH APP SENDIRI
        // (syncAppRoleToDiscord) — lihat komentar lengkap di
        // definisi inFlightAppSync di atas. Tanpa guard ini, event yang
        // sebenarnya cuma gema dari perubahan App sendiri bisa disalahartikan
        // sebagai "role diubah manual dari Discord" dan menimpa balik
        // database — menyebabkan role bolak-balik (flip-flop) & notifikasi
        // dobel/salah.
        if (isSyncInFlight(newMember.id)) return;

        const settings = await getSettings();
        if (settings.autoSyncFromDiscord === false) return; // fitur ini boleh dimatikan admin

        const roleMap = settings.discordRoleMap || {};
        const newRoleIds = [...newMember.roles.cache.keys()];

        if (!TIERS.some(t => roleMap[t])) return; // belum ada role tier di-mapping sama sekali

        const targetTier = tierFromRoleIds(newRoleIds, roleMap);

        const user = await db.collection('users').findOne({ discordId: newMember.id });
        if (!user) return; // user belum pernah login ke app, gak ada yang perlu disinkron
        if (user.role === targetTier) return; // gak ada perubahan yang relevan buat kita

        const oldRole = user.role;
        await db.collection('users').updateOne(
          { discordId: newMember.id },
          { $set: { role: targetTier, roleUpdatedAt: new Date() } }
        );

        // Rapikan Discord kalau ternyata user sempat pegang 2 role tier sekaligus
        // (misal admin nambahin role Platinum padahal masih pegang role Gold) —
        // dipaksa balik jadi cuma 1 role tier aktif, konsisten kayak dari app.
        const discordSync = await syncAppRoleToDiscord(newMember.id, targetTier);

        await logRoleChange({
          discordId: newMember.id,
          username: user.username || newMember.user?.username || newMember.id,
          oldRole, newRole: targetTier,
          source: 'discord',
          discordSync
        });
      } catch (e) {
        console.error('[RoleSync Gateway] Gagal proses guildMemberUpdate:', e.message);
      }
    });

    // User keluar (atau di-kick/ban) dari server Discord → role di app di-reset ke public,
    // karena syarat login app emang wajib jadi member server dulu.
    client.on('guildMemberRemove', async (member) => {
      try {
        if (member.guild.id !== GUILD_ID) return;
        const db = getDb();
        if (!db) return;

        const settings = await getSettings();

        if (settings.resetRoleOnLeave === false) return;

        const user = await db.collection('users').findOne({ discordId: member.id });
        if (!user || user.role === 'public') return;

        const oldRole = user.role;
        await db.collection('users').updateOne(
          { discordId: member.id },
          { $set: { role: 'public', roleUpdatedAt: new Date() } }
        );

        await logRoleChange({
          discordId: member.id,
          username: user.username || member.id,
          oldRole, newRole: 'public',
          source: 'left_guild',
          discordSync: null,
          note: 'User keluar/dikeluarkan dari server Discord.'
        });
      } catch (e) {
        console.error('[RoleSync Gateway] Gagal proses guildMemberRemove:', e.message);
      }
    });

    client.login(BOT_TOKEN).catch(e => {
      gatewayStatus.connected = false;
      gatewayStatus.error = `Gagal login gateway: ${e.message}. Pastikan "Server Members Intent" sudah diaktifkan di Discord Developer Portal > Bot.`;
      console.error('[RoleSync Gateway]', gatewayStatus.error);
    });
  }

  // ══════════════════════════════════════════════════════════════════════
  // FULL RESYNC — 2 arah, dipicu manual dari admin panel.
  // ══════════════════════════════════════════════════════════════════════
  async function fullResync(direction) {
    const db = getDb();
    if (!db) throw new Error('Database belum siap.');
    if (!BOT_TOKEN || !GUILD_ID) throw new Error('DISCORD_BOT_TOKEN / DISCORD_GUILD_ID belum diisi di .env.');

    const settings = await getSettings();
    const roleMap = settings.discordRoleMap || {};
    if (!TIERS.some(t => roleMap[t])) throw new Error('Belum ada role Discord yang di-mapping. Atur dulu di halaman Verify Role.');

    const summary = { direction, total: 0, updated: 0, failed: 0, skipped: 0, details: [] };

    if (direction === 'app_to_discord') {
      const users = await db.collection('users').find({}).toArray();
      summary.total = users.length;
      for (const u of users) {
        const r = await syncAppRoleToDiscord(u.discordId, u.role);
        if (r.ok) summary.updated++;
        else if (r.reason === 'not_member') summary.skipped++;
        else { summary.failed++; summary.details.push({ discordId: u.discordId, username: u.username, reason: r.reason, errors: r.errors }); }
        await new Promise(resolve => setTimeout(resolve, 250)); // jaga-jaga rate limit Discord kalau user-nya banyak
      }
    } else if (direction === 'discord_to_app') {
      const members = await listGuildMembers();
      summary.total = members.length;
      for (const m of members) {
        const user = await db.collection('users').findOne({ discordId: m.user.id });
        if (!user) { summary.skipped++; continue; } // belum pernah login ke app, gak ada yang disinkron

        const targetTier = tierFromRoleIds(m.roles, roleMap);
        if (user.role === targetTier) { summary.skipped++; continue; }
        const oldRole = user.role;
        await db.collection('users').updateOne({ discordId: m.user.id }, { $set: { role: targetTier, roleUpdatedAt: new Date() } });
        const discordSync = await syncAppRoleToDiscord(m.user.id, targetTier); // rapikan kalau ada role tier dobel
        await db.collection('roleSyncLogs').insertOne({
          discordId: m.user.id, username: user.username, oldRole, newRole: targetTier,
          source: 'resync', discordSynced: discordSync.ok, discordSyncReason: discordSync.reason || null,
          note: null, createdAt: new Date()
        });
        summary.updated++;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    } else {
      throw new Error('direction harus "app_to_discord" atau "discord_to_app".');
    }

    await sendBotNotification('admin_activity', {
      title: `🔄 Full Resync Selesai (${direction === 'app_to_discord' ? 'App → Discord' : 'Discord → App'})`,
      description: `Total diproses: **${summary.total}**\n✅ Diperbarui: **${summary.updated}**\n⏭️ Dilewati: **${summary.skipped}**\n❌ Gagal: **${summary.failed}**`,
      color: 0xa78bfa
    });

    return summary;
  }

  // Read-only: cek tier Discord SAAT INI seorang member (tanpa mengubah apapun) —
  // dipakai /cekpaket (Slash Command) buat nampilin "Status Discord Role" apa
  // adanya, beda dari syncAppRoleToDiscord yang aktif nambah/nyabut role.
  async function getMemberTier(discordId) {
    if (!BOT_TOKEN || !GUILD_ID) return { ok: false, reason: 'bot_not_configured', tier: null, isMember: false };
    try {
      const member = await getGuildMember(discordId);
      const settings = await getSettings();
      const tier = tierFromRoleIds(member.roles || [], settings.roleIds);
      return { ok: true, tier, isMember: true, roleIds: member.roles || [] };
    } catch (e) {
      if (e.discordStatus === 404) return { ok: true, tier: null, isMember: false };
      return { ok: false, reason: 'discord_error', tier: null, isMember: false, error: e.message };
    }
  }

  return {
    // dipanggil sekali pas server start
    startGateway,
    getGatewayStatus: () => ({ ...gatewayStatus }),

    // dipanggil server.js pas role user berubah dari admin panel
    syncAppRoleToDiscord,
    logRoleChange,

    // settings & data pendukung admin panel
    getSettings,
    updateSettings,
    getGuildRoles: async () => (GUILD_ID ? getGuildRoles() : []),

    // aksi manual dari admin panel
    fullResync,

    // dipanggil berkala dari server.js (setInterval) — retry otomatis buat
    // sinkronisasi role Discord yang sempat gagal (lihat komentar di atas)
    reconcilePendingRoleSyncs,

    // helper murni, dipakai juga oleh route lain kalau perlu
    tierFromRoleIds,
    getMemberTier
  };
};