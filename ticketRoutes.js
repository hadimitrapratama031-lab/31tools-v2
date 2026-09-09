// ══════════════════════════════════════════════════════════════════════════
// TICKET ROUTES — seluruh endpoint REST untuk halaman Website Admin:
// Ticket Management, Ticket Panel, Embed Editor, Bot Channel Configuration,
// Transcript, Logs, Rating. Semua route WAJIB requireAdmin (dipasang dari
// server.js), supaya konsisten dengan proteksi fitur admin lain.
// ══════════════════════════════════════════════════════════════════════════

const express = require('express');

module.exports = function createTicketRoutes({ ticketManager, requireAdmin }) {
  const router = express.Router();

  function actorFrom(req) {
    return { discordId: req.admin?.discordId, username: req.admin?.username || (req.admin?.via === 'password' ? 'Admin' : 'Admin') };
  }

  // ── Ticket Management ──
  router.get('/tickets', requireAdmin, async (req, res) => {
    try {
      const { status, category, staff, search } = req.query;
      const tickets = await ticketManager.listTickets({ status, category, staff, search });
      res.json({ tickets });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/tickets/:id', requireAdmin, async (req, res) => {
    try {
      const ticket = await ticketManager.getTicket(req.params.id);
      if (!ticket) return res.status(404).json({ error: 'Ticket tidak ditemukan' });
      res.json({ ticket });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/tickets/:id/close', requireAdmin, async (req, res) => {
    try {
      const ticket = await ticketManager.closeTicket(req.params.id, actorFrom(req));
      res.json({ ticket });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  router.post('/tickets/:id/reopen', requireAdmin, async (req, res) => {
    try {
      const ticket = await ticketManager.reopenTicket(req.params.id, actorFrom(req));
      res.json({ ticket });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // Kirim transcript HTML langsung via Bot Discord ke channel Transcript yang
  // sudah diatur di Notification Channel Settings — tidak pernah sebagai file
  // download (beda dengan GET /tickets/:id/transcript di bawah yang memang
  // untuk lihat/unduh).
  router.post('/tickets/:id/send-transcript', requireAdmin, async (req, res) => {
    try {
      const result = await ticketManager.sendTranscriptToChannel(req.params.id, actorFrom(req));
      res.json(result);
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  router.delete('/tickets/:id', requireAdmin, async (req, res) => {
    try {
      await ticketManager.deleteTicket(req.params.id, actorFrom(req));
      res.json({ ok: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  router.put('/tickets/:id/staff', requireAdmin, async (req, res) => {
    try {
      const ticket = await ticketManager.setStaff(req.params.id, req.body.staffIds || [], actorFrom(req));
      res.json({ ticket });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // Transcript: tampilkan sebagai HTML langsung (untuk "Download") atau JSON (untuk preview di modal)
  router.get('/tickets/:id/transcript', requireAdmin, async (req, res) => {
    try {
      const ticket = await ticketManager.getTicket(req.params.id);
      if (!ticket || !ticket.transcriptHtml) return res.status(404).send('Transcript belum tersedia untuk ticket ini.');
      if (req.query.format === 'json') return res.json({ html: ticket.transcriptHtml });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      if (req.query.download === '1') {
        res.setHeader('Content-Disposition', `attachment; filename="transcript-${ticket.ticketNumberLabel}.html"`);
      }
      res.send(ticket.transcriptHtml);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Ticket Panel ──
  router.get('/panels', requireAdmin, async (req, res) => {
    try { res.json({ panels: await ticketManager.listPanels() }); } catch (e) { res.status(500).json({ error: e.message }); }
  });
  router.get('/panels/:id', requireAdmin, async (req, res) => {
    try {
      const panel = await ticketManager.getPanel(req.params.id);
      if (!panel) return res.status(404).json({ error: 'Panel tidak ditemukan' });
      res.json({ panel });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  router.post('/panels', requireAdmin, async (req, res) => {
    try { res.json({ panel: await ticketManager.createPanel(req.body, actorFrom(req)) }); } catch (e) { res.status(400).json({ error: e.message }); }
  });
  router.put('/panels/:id', requireAdmin, async (req, res) => {
    try { res.json({ panel: await ticketManager.updatePanel(req.params.id, req.body, actorFrom(req)) }); } catch (e) { res.status(400).json({ error: e.message }); }
  });
  router.delete('/panels/:id', requireAdmin, async (req, res) => {
    try { await ticketManager.deletePanel(req.params.id, actorFrom(req)); res.json({ ok: true }); } catch (e) { res.status(400).json({ error: e.message }); }
  });
  router.post('/panels/:id/publish', requireAdmin, async (req, res) => {
    try { res.json({ panel: await ticketManager.publishPanel(req.params.id, actorFrom(req)) }); } catch (e) { res.status(400).json({ error: e.message }); }
  });
  // Preview: tidak menyentuh Discord API sama sekali, cuma render payload embed dari body request saat ini
  router.post('/panels/preview', requireAdmin, async (req, res) => {
    try { res.json(ticketManager.previewPanel(req.body)); } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // ── Bot Channel Configuration ──
  router.get('/config', requireAdmin, async (req, res) => {
    try { res.json({ config: await ticketManager.getConfig() }); } catch (e) { res.status(500).json({ error: e.message }); }
  });
  router.put('/config', requireAdmin, async (req, res) => {
    try { res.json({ config: await ticketManager.saveConfig(req.body, actorFrom(req)) }); } catch (e) { res.status(400).json({ error: e.message }); }
  });
  router.get('/discord/guilds', requireAdmin, async (req, res) => {
    try { res.json({ guilds: await ticketManager.listGuilds() }); } catch (e) { res.status(400).json({ error: e.message }); }
  });
  router.get('/discord/guilds/:guildId/channels', requireAdmin, async (req, res) => {
    try { res.json(await ticketManager.listChannels(req.params.guildId)); } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // ── Logs ──
  router.get('/logs', requireAdmin, async (req, res) => {
    try { res.json({ logs: await ticketManager.listLogs({ ticketId: req.query.ticketId }) }); } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Rating ──
  router.get('/ratings', requireAdmin, async (req, res) => {
    try { res.json(await ticketManager.listRatings()); } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Status modul (dipakai frontend buat kasih tau kalau bot token belum diset)
  router.get('/status', requireAdmin, async (req, res) => {
    res.json({ configured: ticketManager.isBotConfigured() });
  });

  return router;
};