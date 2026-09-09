// ══════════════════════════════════════════════════════════════════════════
// DISCORD SLASH COMMANDS — /setpaket, /cekpaket, /createvoucher
// ══════════════════════════════════════════════════════════════════════════
// SEMUA logic inti (ganti paket, baca data user, buat voucher) SENGAJA REUSE
// fungsi yang SUDAH ADA & sudah dipakai Admin Web (applyRoleChange di
// server.js, voucherManager.js, roleSync.js) — bukan implementasi baru yang
// terpisah — supaya hasil dari Discord & Admin Web DIJAMIN identik: sinkron
// Database, App (realtime lewat pushAccountUpdate/broadcastAdmin), Admin Web,
// dan Role Discord, TANPA restart apapun.
//
// PENTING soal 2 JALUR PENGIRIMAN INTERACTION DISCORD:
//   Begitu sebuah Discord Application punya "Interactions Endpoint URL" yang
//   valid (project ini punya, lihat /api/discord/interactions di server.js —
//   dipakai fitur Ticket System & Auto Order), Discord BERHENTI TOTAL
//   mengirim application command interaction lewat Gateway (WebSocket) untuk
//   application itu — SEMUA interaction (termasuk slash command) hanya
//   dikirim lewat HTTP endpoint itu. Ini perilaku resmi Discord, bukan bug.
//   Makanya command ini WAJIB bisa dijalankan dari DUA jalur:
//     1) Gateway — client.on('interactionCreate') di bawah. Disisakan untuk
//        skenario kalau suatu saat Interactions Endpoint URL dilepas.
//     2) HTTP — handleHttpInteraction(), dipanggil dari
//        /api/discord/interactions di server.js persis dengan pola yang
//        SUDAH DIPAKAI & terbukti jalan di discordAutoOrderManager.js /
//        ticketSystemManager.js: server.js ACK duluan (type 5, deferred +
//        ephemeral) karena proses aslinya (tulis DB, sync Role Discord,
//        webhook) bisa lebih dari batas 3 detik Discord, lalu modul ini
//        mengisi jawaban aslinya lewat PATCH .../messages/@original.
//   Supaya logic (handleSetPaket/handleCekPaket/handleCreateVoucher) TIDAK
//   dobel ditulis untuk masing-masing jalur, keduanya dibungkus jadi satu
//   "ctx" (lihat buildCtxFromGateway/buildCtxFromRaw) dengan bentuk yang
//   sama persis (ctx.getUser/getString/getInteger/actor/respond) — jadi
//   ketiga handler command cukup ditulis SEKALI, jalan di kedua jalur.
//
// Tidak ada satupun sistem lain yang diubah oleh modul ini — file ini CUMA
// memanggil fungsi yang sudah ada lewat dependency injection dari server.js.
// ══════════════════════════════════════════════════════════════════════════

const { REST, Routes, SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const axios = require('axios');

const DISCORD_API = 'https://discord.com/api/v10';
const COMMAND_NAMES = ['setpaket', 'cekpaket', 'createvoucher'];

module.exports = function createSlashCommands({
  getDb, ROLE_LEVEL, roleSync, voucherManager,
  applyRoleChange, logActivity, broadcastAdmin,
  computeUserStats, publicUser, voucherPublic,
  APP_NAME, APP_LOGO_URL
}) {
  const db = () => getDb();
  const BOT_TOKEN = process.env.DISCORD_SLASH_BOT_TOKEN || process.env.DISCORD_BOT_TOKEN || '';
  const GUILD_ID = process.env.DISCORD_SLASH_GUILD_ID || process.env.DISCORD_GUILD_ID || '';
  const CLIENT_ID = process.env.DISCORD_CLIENT_ID || '';

  // Owner/Admin yang boleh pakai command ini — DIPISAH dari sistem admin
  // Website (requireAdmin) karena ini murni gate di sisi Discord:
  //   DISCORD_SLASH_OWNER_IDS      = "111,222"  (User ID Discord, selalu boleh)
  //   DISCORD_SLASH_ADMIN_ROLE_IDS = "333,444"  (Role ID Discord, boleh juga)
  const OWNER_IDS = (process.env.DISCORD_SLASH_OWNER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  const ADMIN_ROLE_IDS = (process.env.DISCORD_SLASH_ADMIN_ROLE_IDS || '').split(',').map(s => s.trim()).filter(Boolean);

  let client = null;
  const status = { connected: false, error: null, botTag: null, commandsRegistered: false };

  function isConfigured() { return !!(BOT_TOKEN && GUILD_ID); }
  function getStatus() { return { ...status, configured: isConfigured(), ownerCount: OWNER_IDS.length, adminRoleCount: ADMIN_ROLE_IDS.length }; }

  // { userId, memberRoleIds } — bentuk netral yang sama dipakai kedua jalur (Gateway & HTTP).
  function isAuthorized({ userId, memberRoleIds }) {
    if (OWNER_IDS.includes(userId)) return true;
    return ADMIN_ROLE_IDS.some(id => (memberRoleIds || []).includes(id));
  }

  const ROLE_ICON = { public: '🌐', gold: '🥇', platinum: '💎', admin: '👑' };
  const ROLE_LABEL = { public: 'Public', gold: 'Gold', platinum: 'Platinum', admin: 'Admin' };

  function baseEmbed({ title, description, color = 0x7b5cff }) {
    return new EmbedBuilder()
      .setColor(color)
      .setTitle(title)
      .setDescription(description || null)
      .setFooter({ text: APP_NAME, iconURL: APP_LOGO_URL || undefined })
      .setTimestamp(new Date());
  }

  function fmtDate(d) {
    if (!d) return null;
    return new Date(d).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Jakarta' }) + ' WIB';
  }

  function fmtRemaining(activeUntil) {
    if (!activeUntil) return null;
    const ms = new Date(activeUntil).getTime() - Date.now();
    if (ms <= 0) return 'Sudah berakhir';
    const days = Math.floor(ms / 86400000);
    const hours = Math.floor((ms % 86400000) / 3600000);
    const mins = Math.floor((ms % 3600000) / 60000);
    if (days > 0) return `${days} hari ${hours} jam lagi`;
    if (hours > 0) return `${hours} jam ${mins} menit lagi`;
    return `${mins} menit lagi`;
  }

  async function auditLog({ command, actor, status: s, description, meta }) {
    logActivity({
      type: 'slash_command',
      username: actor.username,
      discordId: actor.id,
      admin: actor.username,
      status: s,
      description,
      meta: { command, ...meta }
    }).catch(() => {});
  }

  function generateVoucherCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 8; i++) code += chars[Math.floor(Math.random() * chars.length)];
    return `31-${code}`;
  }

  // ══════════════════════════════════════════════════════════════════════
  // CTX — abstraksi netral supaya handleSetPaket/handleCekPaket/handleCreateVoucher
  // di bawah cukup ditulis SEKALI dan jalan baik lewat Gateway maupun HTTP
  // Interactions Endpoint (lihat catatan panjang di atas).
  // ══════════════════════════════════════════════════════════════════════

  function discordUserFromRaw(id, resolved) {
    if (!id) return null;
    const u = resolved?.users?.[id];
    if (!u) return null;
    const tag = (u.discriminator && u.discriminator !== '0') ? `${u.username}#${u.discriminator}` : u.username;
    const avatarUrl = u.avatar
      ? `https://cdn.discordapp.com/avatars/${id}/${u.avatar}.${u.avatar.startsWith('a_') ? 'gif' : 'png'}`
      : `https://cdn.discordapp.com/embed/avatars/${Number((BigInt(id) >> 22n) % 6n)}.png`;
    return { id, tag, displayAvatarURL: () => avatarUrl };
  }

  function buildCtxFromGateway(interaction) {
    const memberRoleIds = interaction.member?.roles?.cache
      ? [...interaction.member.roles.cache.keys()]
      : (interaction.member?.roles || []);
    return {
      actor: { id: interaction.user.id, username: interaction.user.tag },
      memberRoleIds,
      getUser: (name) => interaction.options.getUser(name) || null,
      getString: (name) => interaction.options.getString(name),
      getInteger: (name) => interaction.options.getInteger(name),
      defer: () => interaction.deferReply(),
      respond: (embed) => interaction.editReply({ embeds: [embed] }),
      replyDenied: (embed) => interaction.reply({ embeds: [embed], ephemeral: true }).catch(() => {})
    };
  }

  function buildCtxFromRaw(raw) {
    const resolved = raw.data?.resolved || {};
    const optsByName = {};
    for (const o of (raw.data?.options || [])) optsByName[o.name] = o;
    const actorRaw = raw.member?.user || raw.user;
    const actorTag = (actorRaw.discriminator && actorRaw.discriminator !== '0') ? `${actorRaw.username}#${actorRaw.discriminator}` : actorRaw.username;

    async function editOriginal(payload) {
      return axios.patch(
        `${DISCORD_API}/webhooks/${CLIENT_ID}/${raw.token}/messages/@original`,
        payload, { timeout: 15000 }
      ).catch(e => console.warn('[SlashCommands] Gagal edit original response (HTTP):', e.message));
    }

    return {
      actor: { id: actorRaw.id, username: actorTag },
      memberRoleIds: raw.member?.roles || [],
      getUser: (name) => discordUserFromRaw(optsByName[name]?.value, resolved),
      getString: (name) => optsByName[name] ? String(optsByName[name].value) : null,
      getInteger: (name) => optsByName[name] !== undefined ? Number(optsByName[name].value) : null,
      defer: async () => {}, // server.js sudah ACK type 5 (deferred) SEBELUM handler ini dipanggil
      respond: (embed) => editOriginal({ embeds: [embed] }), // JSON.stringify otomatis pakai EmbedBuilder#toJSON()
      replyDenied: (embed) => editOriginal({ embeds: [embed] })
    };
  }

  // ══════════════════════════════════════════════════════════════════════
  // /setpaket
  // ══════════════════════════════════════════════════════════════════════
  async function handleSetPaket(ctx) {
    await ctx.defer();
    const targetUser = ctx.getUser('user');
    const paket = ctx.getString('paket'); // public|gold|platinum|admin
    const durasiJumlah = ctx.getInteger('durasi_jumlah');
    const durasiSatuan = ctx.getString('durasi_satuan') || 'days';
    const alasan = ctx.getString('alasan') || null;
    const actor = ctx.actor;

    if (!targetUser) {
      return ctx.respond(baseEmbed({ title: '❌ Gagal', description: 'User Discord tidak ditemukan/tidak valid.', color: 0xf87171 }));
    }

    const userDoc = await db().collection('users').findOne({ discordId: targetUser.id });
    if (!userDoc) {
      await auditLog({ command: 'setpaket', actor, status: 'failed', description: `Gagal /setpaket untuk ${targetUser.tag}: user belum pernah login ke App.` });
      return ctx.respond(baseEmbed({ title: '❌ Gagal', description: `**${targetUser.tag}** belum pernah login ke App, jadi belum ada datanya di database.`, color: 0xf87171 }));
    }

    try {
      if (!ROLE_LEVEL.hasOwnProperty(paket)) {
        return ctx.respond(baseEmbed({ title: '❌ Paket tidak valid', description: 'Pilih salah satu: Public, Gold, Platinum, atau Admin.', color: 0xf87171 }));
      }

      const oldRole = userDoc.role;
      const result = await applyRoleChange({
        discordId: targetUser.id,
        role: paket,
        activeUnit: durasiSatuan,
        activeAmount: durasiJumlah || undefined,
        adminName: actor.username,
        source: 'discord_slash'
      });

      await auditLog({
        command: 'setpaket', actor, status: 'success',
        description: `${actor.username} mengubah paket ${userDoc.username} dari ${oldRole.toUpperCase()} ke ${paket.toUpperCase()} lewat /setpaket.${alasan ? ` Alasan: ${alasan}` : ''}`,
        meta: { discordId: targetUser.id, oldRole, newRole: paket, alasan }
      });

      const durasiText = (paket === 'gold' || paket === 'platinum')
        ? (result.activeUntil ? `Sampai ${fmtDate(result.activeUntil)}` : 'Belum diatur (unlimited sampai diatur admin)')
        : 'Unlimited';

      const embed = baseEmbed({ title: '✅ Paket Berhasil Diubah', color: 0x4ade80 })
        .addFields(
          { name: '👤 User', value: `<@${targetUser.id}> (${userDoc.username})`, inline: true },
          { name: '📦 Paket Lama', value: `${ROLE_ICON[oldRole] || '❓'} ${ROLE_LABEL[oldRole] || oldRole.toUpperCase()}`, inline: true },
          { name: '📦 Paket Baru', value: `${ROLE_ICON[paket] || '📦'} ${ROLE_LABEL[paket] || paket.toUpperCase()}`, inline: true },
          { name: '⏳ Durasi', value: durasiText, inline: true },
          { name: '🛠️ Admin', value: actor.username, inline: true },
          { name: '🕒 Waktu', value: fmtDate(new Date()), inline: true },
          ...(alasan ? [{ name: '📝 Alasan', value: alasan, inline: false }] : []),
          { name: '🔗 Sinkron', value: `Database ✅ · App ✅ (realtime) · Admin Web ✅ (realtime)${result.discordSync ? ` · Role Discord ${result.discordSync.ok ? '✅' : '⚠️ ' + (result.discordSync.reason || '')}` : ' · Role Discord (sama, tidak berubah)'}`, inline: false }
        );
      return ctx.respond(embed);
    } catch (e) {
      await auditLog({ command: 'setpaket', actor, status: 'failed', description: `Error /setpaket: ${e.message}`, meta: { discordId: targetUser.id } });
      return ctx.respond(baseEmbed({ title: '❌ Gagal Mengubah Paket', description: e.message, color: 0xf87171 }));
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // /cekpaket
  // ══════════════════════════════════════════════════════════════════════
  async function handleCekPaket(ctx) {
    await ctx.defer();
    const targetUser = ctx.getUser('user');
    const actor = ctx.actor;

    if (!targetUser) {
      return ctx.respond(baseEmbed({ title: '❌ Gagal', description: 'User Discord tidak ditemukan/tidak valid.', color: 0xf87171 }));
    }

    const userDoc = await db().collection('users').findOne({ discordId: targetUser.id });
    if (!userDoc) {
      await auditLog({ command: 'cekpaket', actor, status: 'failed', description: `/cekpaket ${targetUser.tag}: user belum pernah login ke App.` });
      return ctx.respond(baseEmbed({ title: '❌ Tidak Ditemukan', description: `**${targetUser.tag}** belum pernah login ke App.`, color: 0xf87171 }));
    }

    const [voucherCount, roleHistory, memberTier] = await Promise.all([
      db().collection('voucherRedemptions').countDocuments({ discordId: targetUser.id }),
      db().collection('roleSyncLogs').find({ discordId: targetUser.id }).sort({ createdAt: -1 }).limit(5).toArray(),
      roleSync.getMemberTier(targetUser.id)
    ]);

    const role = userDoc.role;
    const isTimeLimited = role === 'gold' || role === 'platinum';
    const isExpired = isTimeLimited && userDoc.activeUntil && new Date(userDoc.activeUntil) <= new Date();
    const statusPaket = !isTimeLimited ? 'Unlimited' : isExpired ? '🔴 Expired' : userDoc.activeUntil ? '🟢 Aktif' : '🟡 Belum diatur masa aktifnya';

    let discordRoleStatus;
    if (!memberTier.ok) discordRoleStatus = memberTier.reason === 'bot_not_configured' ? '⚠️ Bot belum dikonfigurasi' : '⚠️ Gagal cek (' + (memberTier.reason || 'error') + ')';
    else if (!memberTier.isMember) discordRoleStatus = '⚠️ User tidak ada di server Discord';
    else discordRoleStatus = memberTier.tier === role ? `✅ Sinkron (${ROLE_LABEL[memberTier.tier] || memberTier.tier})` : `⚠️ Tidak sinkron — Discord: ${ROLE_LABEL[memberTier.tier] || memberTier.tier}, DB: ${ROLE_LABEL[role] || role}`;

    const statusAkun = userDoc.status === 'banned' ? '🚫 Banned' : userDoc.status === 'suspended' ? '⏸️ Suspended' : '✅ Active';

    const historyText = roleHistory.length
      ? roleHistory.map(h => `• ${ROLE_LABEL[h.oldRole] || h.oldRole || '—'} ➜ **${ROLE_LABEL[h.newRole] || h.newRole}** — ${fmtDate(h.createdAt)} _(${h.source || 'admin'})_`).join('\n')
      : '_Belum ada riwayat perubahan paket._';

    const embed = baseEmbed({ title: `📋 Info Paket — ${userDoc.username}`, color: 0x4d6bff })
      .setThumbnail(targetUser.displayAvatarURL())
      .addFields(
        { name: '👤 Username', value: userDoc.username, inline: true },
        { name: '🆔 Discord ID', value: targetUser.id, inline: true },
        { name: '📦 Paket Aktif', value: `${ROLE_ICON[role] || '📦'} ${ROLE_LABEL[role] || role.toUpperCase()}`, inline: true },
        { name: '📌 Status Paket', value: statusPaket, inline: true },
        { name: '📅 Tanggal Dibuat', value: userDoc.createdAt ? fmtDate(userDoc.createdAt) : '—', inline: true },
        { name: '📅 Tanggal Berakhir', value: isTimeLimited ? (userDoc.activeUntil ? fmtDate(userDoc.activeUntil) : 'Belum diatur') : 'Tidak ada (unlimited)', inline: true },
        { name: '⏳ Sisa Durasi', value: isTimeLimited ? (fmtRemaining(userDoc.activeUntil) || '—') : 'Unlimited', inline: true },
        { name: '🔗 Status Discord Role', value: discordRoleStatus, inline: true },
        { name: '🛡️ Status Akun', value: statusAkun, inline: true },
        { name: '🎟️ Total Redeem Voucher', value: `${voucherCount}x`, inline: true },
        { name: '🕘 Riwayat Perubahan Paket (5 Terakhir)', value: historyText, inline: false }
      );

    await auditLog({ command: 'cekpaket', actor, status: 'success', description: `${actor.username} mengecek paket ${userDoc.username} lewat /cekpaket.`, meta: { discordId: targetUser.id } });
    return ctx.respond(embed);
  }

  // ══════════════════════════════════════════════════════════════════════
  // /createvoucher
  // ══════════════════════════════════════════════════════════════════════
  async function handleCreateVoucher(ctx) {
    await ctx.defer();
    const actor = ctx.actor;
    let code = ctx.getString('kode') || '';
    const role = ctx.getString('paket'); // gold|platinum
    const durationAmount = ctx.getInteger('durasi');
    const durationUnit = ctx.getString('durasi_satuan');
    const quota = ctx.getInteger('maksimal_penggunaan');
    const expiresAtRaw = ctx.getString('kadaluarsa');
    const description = ctx.getString('deskripsi');

    let expiresAt = null;
    if (expiresAtRaw) {
      const d = new Date(expiresAtRaw);
      if (isNaN(d.getTime())) {
        return ctx.respond(baseEmbed({ title: '❌ Format Tanggal Salah', description: 'Gunakan format `YYYY-MM-DD` (contoh: `2026-12-31`).', color: 0xf87171 }));
      }
      expiresAt = d;
    }

    try {
      let voucher;
      if (!code.trim()) {
        // Auto-generate, retry beberapa kali kalau kebetulan bentrok kode yang sudah ada.
        let lastErr;
        for (let i = 0; i < 5; i++) {
          try {
            voucher = await voucherManager.createVoucher({ code: generateVoucherCode(), role, durationAmount, durationUnit, quota, expiresAt, description, createdBy: actor.username });
            lastErr = null;
            break;
          } catch (e) { lastErr = e; if (!/sudah dipakai/i.test(e.message)) throw e; }
        }
        if (lastErr) throw lastErr;
      } else {
        voucher = await voucherManager.createVoucher({ code, role, durationAmount, durationUnit, quota, expiresAt, description, createdBy: actor.username });
      }

      await auditLog({
        command: 'createvoucher', actor, status: 'success',
        description: `${actor.username} membuat voucher "${voucher.code}" (${role.toUpperCase()}, ${durationAmount} ${durationUnit}, kuota ${quota}) lewat /createvoucher.`,
        meta: { voucherId: String(voucher._id), code: voucher.code }
      });

      // Realtime — voucher baru langsung kelihatan di App (Claim Voucher) & Admin Web.
      voucherManager.listVouchers().then(list => broadcastAdmin('voucher:update', list.map(voucherPublic))).catch(() => {});

      const unitLabel = { minutes: 'Menit', hours: 'Jam', days: 'Hari' }[durationUnit] || durationUnit;
      const embed = baseEmbed({ title: '✅ Voucher Berhasil Dibuat', color: 0x4ade80 })
        .addFields(
          { name: '🎟️ Kode Voucher', value: `\`${voucher.code}\``, inline: true },
          { name: '📦 Paket', value: `${ROLE_ICON[role] || '📦'} ${ROLE_LABEL[role] || role.toUpperCase()}`, inline: true },
          { name: '⏳ Durasi', value: `${durationAmount} ${unitLabel}`, inline: true },
          { name: '🔢 Maksimal Penggunaan', value: `${quota}x`, inline: true },
          { name: '📅 Expired', value: expiresAt ? fmtDate(expiresAt) : 'Tidak ada batas', inline: true },
          { name: '📌 Status', value: '🟢 Aktif', inline: true },
          ...(description ? [{ name: '📝 Deskripsi', value: description, inline: false }] : []),
          { name: '🛠️ Dibuat oleh', value: actor.username, inline: true },
          { name: '🕒 Waktu', value: fmtDate(new Date()), inline: true }
        );
      return ctx.respond(embed);
    } catch (e) {
      await auditLog({ command: 'createvoucher', actor, status: 'failed', description: `Error /createvoucher: ${e.message}` });
      return ctx.respond(baseEmbed({ title: '❌ Gagal Membuat Voucher', description: e.message, color: 0xf87171 }));
    }
  }

  async function dispatch(ctx, commandName) {
    if (!isAuthorized({ userId: ctx.actor.id, memberRoleIds: ctx.memberRoleIds })) {
      await auditLog({ command: commandName, actor: ctx.actor, status: 'denied', description: `${ctx.actor.username} mencoba pakai /${commandName} tanpa izin.` });
      return ctx.replyDenied(baseEmbed({ title: '🚫 Tidak Diizinkan', description: 'Command ini khusus Owner/Admin.', color: 0xf87171 }));
    }
    try {
      if (commandName === 'setpaket') return await handleSetPaket(ctx);
      if (commandName === 'cekpaket') return await handleCekPaket(ctx);
      if (commandName === 'createvoucher') return await handleCreateVoucher(ctx);
    } catch (e) {
      console.error(`[SlashCommands] Error /${commandName}:`, e.message);
      return ctx.respond(baseEmbed({ title: '❌ Terjadi Kesalahan', description: e.message, color: 0xf87171 })).catch(() => {});
    }
  }

  // Dipanggil dari /api/discord/interactions di server.js — SETELAH server.js
  // ACK duluan (type 5, deferred+ephemeral). raw = payload JSON mentah dari
  // Discord (interaction.type === 2, application command).
  async function handleHttpInteraction(raw) {
    const commandName = raw.data?.name;
    if (!COMMAND_NAMES.includes(commandName)) return;
    return dispatch(buildCtxFromRaw(raw), commandName);
  }

  // Dipakai server.js buat mutuskan apakah sebuah Type 2 interaction perlu
  // di-ACK deferred (lalu diteruskan ke handleHttpInteraction), atau biarkan
  // jatuh ke fallback generik seperti sebelumnya (command lain di luar 3 ini).
  function isSlashCommandName(name) { return COMMAND_NAMES.includes(name); }

  // ══════════════════════════════════════════════════════════════════════
  // Registrasi command (per-guild — tayang instan, tidak perlu tunggu ~1 jam
  // seperti command global) + gateway listener.
  // ══════════════════════════════════════════════════════════════════════
  function buildCommandDefinitions() {
    const paketChoices = [
      { name: 'Public', value: 'public' },
      { name: 'Gold', value: 'gold' },
      { name: 'Platinum', value: 'platinum' },
      { name: 'Admin', value: 'admin' }
    ];
    const satuanChoices = [
      { name: 'Menit', value: 'minutes' },
      { name: 'Jam', value: 'hours' },
      { name: 'Hari', value: 'days' }
    ];

    const setpaket = new SlashCommandBuilder()
      .setName('setpaket')
      .setDescription('[Owner/Admin] Ubah paket seorang user')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addUserOption(o => o.setName('user').setDescription('User Discord yang mau diubah paketnya').setRequired(true))
      .addStringOption(o => { o.setName('paket').setDescription('Paket baru').setRequired(true); paketChoices.forEach(c => o.addChoices(c)); return o; })
      .addIntegerOption(o => o.setName('durasi_jumlah').setDescription('Jumlah durasi (khusus Gold/Platinum, opsional)').setMinValue(1))
      .addStringOption(o => { o.setName('durasi_satuan').setDescription('Satuan durasi (default: Hari)'); satuanChoices.forEach(c => o.addChoices(c)); return o; })
      .addStringOption(o => o.setName('alasan').setDescription('Alasan perubahan paket (opsional)'));

    const cekpaket = new SlashCommandBuilder()
      .setName('cekpaket')
      .setDescription('[Owner/Admin] Lihat info paket seorang user')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addUserOption(o => o.setName('user').setDescription('User Discord yang mau dicek').setRequired(true));

    const createvoucher = new SlashCommandBuilder()
      .setName('createvoucher')
      .setDescription('[Owner/Admin] Buat voucher paket Gold/Platinum baru')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addStringOption(o => { o.setName('paket').setDescription('Paket voucher').setRequired(true); [{ name: 'Gold', value: 'gold' }, { name: 'Platinum', value: 'platinum' }].forEach(c => o.addChoices(c)); return o; })
      .addIntegerOption(o => o.setName('durasi').setDescription('Jumlah durasi yang didapat user saat klaim').setRequired(true).setMinValue(1))
      .addStringOption(o => { o.setName('durasi_satuan').setDescription('Satuan durasi').setRequired(true); satuanChoices.forEach(c => o.addChoices(c)); return o; })
      .addIntegerOption(o => o.setName('maksimal_penggunaan').setDescription('Maksimal berapa kali voucher ini bisa diklaim').setRequired(true).setMinValue(1))
      .addStringOption(o => o.setName('kode').setDescription('Kode voucher custom (kosongkan untuk auto-generate)'))
      .addStringOption(o => o.setName('kadaluarsa').setDescription('Tanggal kadaluarsa, format YYYY-MM-DD (opsional)'))
      .addStringOption(o => o.setName('deskripsi').setDescription('Catatan/deskripsi voucher (opsional)'));

    return [setpaket, cekpaket, createvoucher].map(c => c.toJSON());
  }

  async function registerCommands() {
    if (!isConfigured() || !CLIENT_ID) {
      console.warn('[SlashCommands] DISCORD_CLIENT_ID/BOT_TOKEN/GUILD_ID belum lengkap — command tidak didaftarkan.');
      return;
    }
    try {
      const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
      // Per-guild (bukan global) supaya perubahan command langsung tayang instan
      // di Discord, tanpa nunggu propagasi sampai ~1 jam seperti command global.
      // Ini REST call biasa, TIDAK butuh koneksi Gateway aktif — jadi tetap jalan
      // walau Gateway interactionCreate sudah tidak pernah menerima event apapun
      // (lihat catatan HTTP Interactions Endpoint di atas).
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: buildCommandDefinitions() });
      status.commandsRegistered = true;
      console.log('✅ [SlashCommands] /setpaket, /cekpaket, /createvoucher terdaftar.');
    } catch (e) {
      status.commandsRegistered = false;
      console.error('[SlashCommands] Gagal registrasi command:', e.message);
    }
  }

  function startGateway() {
    if (!isConfigured()) {
      status.error = 'DISCORD_SLASH_BOT_TOKEN/DISCORD_BOT_TOKEN & GUILD_ID belum diisi — Slash Command tidak aktif.';
      console.warn('[SlashCommands]', status.error);
      return;
    }
    let Client, GatewayIntentBits;
    try { ({ Client, GatewayIntentBits } = require('discord.js')); }
    catch (e) { status.error = 'Package "discord.js" belum ter-install.'; return; }

    client = new Client({ intents: [GatewayIntentBits.Guilds] });

    client.once('ready', async () => {
      status.connected = true; status.error = null; status.botTag = client.user.tag;
      console.log(`✅ [SlashCommands] Terhubung sebagai ${client.user.tag}`);
      await registerCommands();
    });
    client.on('error', (e) => { status.error = e.message; status.connected = false; });

    // Disisakan sebagai fallback kalau Interactions Endpoint URL suatu saat
    // dilepas dari Developer Portal — SELAMA endpoint itu aktif (kondisi
    // project ini sekarang), Discord tidak akan pernah memicu listener ini
    // untuk command apapun, jalur yang benar-benar dipakai ada di
    // handleHttpInteraction() di atas (dipanggil dari server.js).
    client.on('interactionCreate', async (interaction) => {
      if (!interaction.isChatInputCommand()) return;
      if (!COMMAND_NAMES.includes(interaction.commandName)) return;
      await dispatch(buildCtxFromGateway(interaction), interaction.commandName);
    });

    client.login(BOT_TOKEN).catch(e => {
      status.error = e.message; status.connected = false;
      console.error('[SlashCommands] Gagal login:', e.message);
    });
  }

  return { startGateway, getStatus, isConfigured, handleHttpInteraction, isSlashCommandName };
};
