// ══════════════════════════════════════════════════════════════════════════
// LIVE CHAT ROUTES — seluruh endpoint REST untuk fitur Live Chat Support.
// Dipisah jadi 2 router (pola sama dengan ticketRoutes.js untuk modul lain):
//   - userRouter  → dipakai App Desktop, WAJIB requireUser (mount di
//                   /api/livechat).
//   - adminRouter → dipakai Admin Web (halaman Live Chat), WAJIB requireAdmin
//                   (mount di /api/admin/livechat).
// ══════════════════════════════════════════════════════════════════════════

const express = require('express');

module.exports = function createLiveChatRoutes({ liveChatManager, requireUser, requireAdmin, broadcastAdmin, wsSendToUser }) {
  // ── USER (App Desktop) ──
  const userRouter = express.Router();

  // Riwayat chat milik user yang sedang login + status online Admin (buat
  // header Floating Chat Widget: 🟢 Online / ⚪ Offline).
  userRouter.get('/messages', requireUser, async (req, res) => {
    try {
      const messages = await liveChatManager.getUserMessages(req.user.discordId);
      res.json({ messages, adminOnline: liveChatManager.isAdminOnline() });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  userRouter.get('/status', requireUser, async (req, res) => {
    try {
      const unreadCount = await liveChatManager.getUnreadCountForUser(req.user.discordId);
      res.json({ adminOnline: liveChatManager.isAdminOnline(), unreadCount });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  userRouter.post('/send', requireUser, async (req, res) => {
    try {
      const message = await liveChatManager.sendUserMessage(req.user, {
        text: req.body?.text,
        imageData: req.body?.imageData
      });
      res.json({ message });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // Ditandai terbaca ketika User membuka/fokus Floating Chat Widget.
  userRouter.post('/read', requireUser, async (req, res) => {
    try {
      await liveChatManager.markReadByUser(req.user.discordId);
      res.json({ ok: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // Typing Indicator — TIDAK disimpan ke DB sama sekali (murni event realtime
  // sekali pakai), cukup diteruskan ke Admin yang sedang membuka percakapan ini.
  userRouter.post('/typing', requireUser, async (req, res) => {
    try {
      broadcastAdmin('livechat:typing', { discordId: req.user.discordId, typing: !!req.body?.typing, from: 'user' });
      res.json({ ok: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // ── ADMIN (Admin Web) ──
  const adminRouter = express.Router();

  function actorFrom(req) {
    return { discordId: req.admin?.discordId, username: req.admin?.username || 'Admin' };
  }

  adminRouter.get('/conversations', requireAdmin, async (req, res) => {
    try {
      const list = await liveChatManager.listConversations({ filter: req.query.filter, search: req.query.search });
      res.json({ conversations: list });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  adminRouter.get('/conversations/:discordId/messages', requireAdmin, async (req, res) => {
    try {
      const messages = await liveChatManager.getUserMessages(req.params.discordId);
      res.json({ messages });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  adminRouter.post('/conversations/:discordId/send', requireAdmin, async (req, res) => {
    try {
      const message = await liveChatManager.sendAdminMessage(req.params.discordId, {
        text: req.body?.text,
        imageData: req.body?.imageData
      }, actorFrom(req));
      res.json({ message });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // Ditandai terbaca ketika Admin membuka panel chat user ini.
  adminRouter.post('/conversations/:discordId/read', requireAdmin, async (req, res) => {
    try {
      await liveChatManager.markReadByAdmin(req.params.discordId);
      res.json({ ok: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  adminRouter.post('/conversations/:discordId/typing', requireAdmin, async (req, res) => {
    try {
      wsSendToUser(req.params.discordId, 'livechat:typing', { typing: !!req.body?.typing, from: 'admin' });
      res.json({ ok: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  return { userRouter, adminRouter };
};
