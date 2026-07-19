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
//   3. Webhook Discord → kirim notif ke channel tiap kali role/paket user
//      berubah (dari admin panel ATAU dari sinkronisasi balik Discord→app).
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

module.exports = function createRoleSync({ getDb, ROLE_LEVEL }) {
  const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || '';
  const GUILD_ID = process.env.DISCORD_GUILD_ID || '';
  const APP_NAME = process.env.APP_NAME || 'Nova Launcher';

  // Semua tier yang bisa disinkron — termasuk 'public' kalau roleId-nya di-set
  const ALL_TIERS = Object.keys(ROLE_LEVEL); // ['public','gold','platinum']
  const TIERS     = ALL_TIERS.filter(r => r !== 'public'); // ['gold','platinum'] — buat logika lama yg exclude public

  const gatewayStatus = { connected: false, error: null, guildName: null, guildId: GUILD_ID || null };
  let client = null;

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
      webhookUrl: process.env.DISCORD_WEBHOOK_URL || null,
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
      webhookUrl: patch.webhookUrl !== undefined ? (patch.webhookUrl || null) : (current.webhookUrl || null),
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

  async function sendWebhook({ title, description, color, fields }) {
    const settings = await getSettings();
    if (!settings.webhookUrl) return { sent: false, reason: 'not_configured' };
    try {
      await axios.post(settings.webhookUrl, {
        username: APP_NAME,
        embeds: [{
          title,
          description,
          color: color ?? 0xa78bfa,
          fields: fields || [],
          timestamp: new Date().toISOString(),
          footer: { text: `${APP_NAME} · Verify Role` }
        }]
      });
      return { sent: true };
    } catch (e) {
      console.error('[RoleSync Webhook] Gagal kirim webhook:', e.response?.data || e.message);
      return { sent: false, reason: 'request_failed', error: e.message };
    }
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

    const result = { ok: true, added: null, removed: [], errors: [] };

    for (const tier of configuredTiers) {
      const roleId = roleMap[tier];
      try {
        if (tier === newRole) {
          // Tambahkan role tier yang sesuai kalau belum punya
          if (!currentRoleIds.has(roleId)) {
            await addMemberRole(discordId, roleId);
          }
          result.added = tier;
        } else if (tier === 'public') {
          // Role public: JANGAN pernah dicabut saat upgrade (gold/platinum), hanya dicabut
          // kalau newRole memang 'public' dan kemudian gold/platinum yang dicabut.
          // Tapi kalau newRole = 'public', kita sudah tangani di blok tier === newRole di atas.
          // Jadi di sini: kalau tier = 'public' DAN newRole BUKAN 'public' → SKIP (tidak cabut).
          // (tidak ada aksi)
        } else {
          // Untuk gold dan platinum: cabut kalau user tidak berhak lagi.
          // Contoh: user naik ke platinum → gold dicabut. User turun ke public → gold & platinum dicabut.
          const tierLevel    = ROLE_LEVEL[tier]    ?? 0;
          const newRoleLevel = ROLE_LEVEL[newRole] ?? 0;
          // Cabut kalau tier ini LEBIH TINGGI dari newRole (downgrade) ATAU tier ini LEBIH RENDAH
          // tapi bukan public (contoh: sudah platinum, naik dari gold → gold dicabut).
          // Ringkasnya: cabut semua tier gold/platinum yang bukan newRole.
          if (tier !== newRole && currentRoleIds.has(roleId)) {
            await removeMemberRole(discordId, roleId);
            result.removed.push(tier);
          }
        }
      } catch (e) {
        result.errors.push(`${tier}: ${e.message}`);
      }
    }
    if (result.errors.length) result.ok = false;
    return result;
  }

  // ── Dipanggil server.js tiap kali role user berubah, apapun sumbernya ──
  // Nyatet log histori + kirim webhook. Sinkron ke Discord dipanggil terpisah
  // (biar caller bisa pilih: pas set dari ADMIN, arahnya app→discord; pas
  // terdeteksi dari GATEWAY, arahnya udah discord→app jadi gak perlu push balik).
  async function logRoleChange({ discordId, username, oldRole, newRole, source, discordSync, note, dmResult }) {
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
    await sendWebhook(roleChangeEmbed({ username, discordId, oldRole, newRole, source, note, discordSync, dmResult }));
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

        const settings = await getSettings();
        if (settings.autoSyncFromDiscord === false) return; // fitur ini boleh dimatikan admin

        const roleMap = settings.discordRoleMap || {};
        if (!TIERS.some(t => roleMap[t])) return; // belum ada role di-mapping sama sekali

        const newRoleIds = [...newMember.roles.cache.keys()];
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

    await sendWebhook({
      title: `🔄 Full Resync Selesai (${direction === 'app_to_discord' ? 'App → Discord' : 'Discord → App'})`,
      description: `Total diproses: **${summary.total}**\n✅ Diperbarui: **${summary.updated}**\n⏭️ Dilewati: **${summary.skipped}**\n❌ Gagal: **${summary.failed}**`,
      color: 0xa78bfa
    });

    return summary;
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
    sendTestWebhook: () => sendWebhook({
      title: '✅ Test Webhook Berhasil',
      description: `Webhook ini terhubung dengan benar ke ${APP_NAME}. Notifikasi perubahan role akan muncul di channel ini.`,
      color: 0x4ade80
    }),

    // helper murni, dipakai juga oleh route lain kalau perlu
    tierFromRoleIds
  };
};