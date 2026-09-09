// ══════════════════════════════════════════════════════════════════════
// 31 TOOLS — Landing Page logic
// Semua data (stats, games, paket, FAQ, hero, discord, download info)
// diambil REALTIME dari backend lewat endpoint publik — TIDAK ADA hardcode.
// ══════════════════════════════════════════════════════════════════════
(function () {
  'use strict';

  const API_BASE = (window.SITE_CONFIG && window.SITE_CONFIG.API_BASE_URL || '').replace(/\/$/, '');

  // ── Helpers ──────────────────────────────────────────────────────────
  async function apiGet(path) {
    const res = await fetch(API_BASE + path, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error('Gagal memuat data (' + res.status + ')');
    return res.json();
  }

  function escapeHtml(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function showToast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => el.classList.remove('show'), 3200);
  }

  function setTopLoader(pct) {
    const el = document.getElementById('topLoader');
    if (!el) return;
    el.style.width = pct + '%';
    if (pct >= 100) setTimeout(() => { el.style.opacity = '0'; }, 300);
  }

  function fmtNumber(n) {
    n = Number(n) || 0;
    if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'jt';
    if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'rb';
    return String(n);
  }

  function animateCount(el, target) {
    const start = 0;
    const dur = 1100;
    const t0 = performance.now();
    function tick(now) {
      const p = Math.min(1, (now - t0) / dur);
      const eased = 1 - Math.pow(1 - p, 3);
      const val = Math.round(start + (target - start) * eased);
      el.textContent = fmtNumber(val);
      if (p < 1) requestAnimationFrame(tick);
      else el.textContent = fmtNumber(target);
    }
    requestAnimationFrame(tick);
  }

  function fmtDate(d) {
    if (!d) return '—';
    try {
      return new Intl.DateTimeFormat('id-ID', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(d));
    } catch (e) { return '—'; }
  }

  // ── Config gate: kalau admin belum ganti URL backend, kasih tau dengan jelas ──
  if (!API_BASE || API_BASE.includes('YOUR-BACKEND-URL')) {
    console.warn('[31 Tools] API_BASE_URL belum diatur di js/config.js — data realtime tidak akan tampil.');
    document.addEventListener('DOMContentLoaded', () => {
      showToast('Konfigurasi API_BASE_URL belum diisi di js/config.js');
    });
  }

  // ── Nav ──────────────────────────────────────────────────────────────
  const navEl = document.getElementById('siteNav');
  window.addEventListener('scroll', () => {
    navEl.classList.toggle('scrolled', window.scrollY > 12);
  }, { passive: true });

  const navToggle = document.getElementById('navToggle');
  const navLinks = document.getElementById('navLinks');
  navToggle?.addEventListener('click', () => navLinks.classList.toggle('open'));
  navLinks?.querySelectorAll('a').forEach(a => a.addEventListener('click', () => navLinks.classList.remove('open')));

  // ── Reveal on scroll ─────────────────────────────────────────────────
  const revealObserver = new IntersectionObserver((entries) => {
    entries.forEach(e => { if (e.isIntersecting) { e.target.classList.add('in'); revealObserver.unobserve(e.target); } });
  }, { threshold: 0.12 });
  function observeReveals(root = document) {
    root.querySelectorAll('.reveal:not(.in)').forEach(el => revealObserver.observe(el));
  }

  // ── Lazy load images ─────────────────────────────────────────────────
  const imgObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      const img = entry.target;
      const src = img.dataset.src;
      if (src) {
        img.src = src;
        img.addEventListener('load', () => img.classList.add('loaded'), { once: true });
        img.removeAttribute('data-src');
      }
      imgObserver.unobserve(img);
    });
  }, { rootMargin: '200px 0px' });

  // ══════════════════════════════════════════════════════════════════
  // WEBSITE SETTINGS (Hero, Logo, Discord, System Requirements, Versi)
  // ══════════════════════════════════════════════════════════════════
  async function loadWebsiteSettings() {
    try {
      const cfg = await apiGet('/api/public/website-settings');

      document.title = (cfg.heroTitle || '31 Tools') + ' — Akses Ribuan Game & Bypass Premium';
      document.getElementById('heroTitle').textContent = cfg.heroTitle || document.getElementById('heroTitle').textContent;
      document.getElementById('heroSubtitle').textContent = cfg.heroSubtitle || document.getElementById('heroSubtitle').textContent;
      document.getElementById('brandName').textContent = cfg.heroTitle || '31 Tools';
      document.getElementById('footerName').textContent = cfg.heroTitle || '31 Tools';
      document.getElementById('footerVersion').textContent = 'Website v' + (cfg.websiteVersion || '1.0.0');
      document.getElementById('footerCopyright').textContent = `© ${new Date().getFullYear()} ${escapeHtml(cfg.heroTitle || '31 Tools')}. All rights reserved.`;

      if (cfg.heroBannerUrl) {
        document.getElementById('heroBannerImg').style.backgroundImage = `url("${cfg.heroBannerUrl}")`;
      }

      const markText = (cfg.heroTitle || '31 Tools').replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || '31';
      if (cfg.logoUrl) {
        document.querySelectorAll('.brand-mark').forEach(el => { el.innerHTML = `<img src="${cfg.logoUrl}" alt="Logo">`; });
        document.getElementById('heroDiamondCore').innerHTML = `<img src="${cfg.logoUrl}" alt="Logo">`;
      } else {
        document.querySelectorAll('#brandMarkText, #footerMarkText').forEach(el => { el.textContent = markText; });
      }

      const discordUrl = cfg.discordInviteUrl || '#';
      ['btnHeroDiscord', 'btnDiscordJoin', 'footerDiscordLink'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.href = discordUrl;
      });
      if (!cfg.discordInviteUrl) {
        ['btnHeroDiscord', 'btnDiscordJoin'].forEach(id => document.getElementById(id)?.setAttribute('aria-disabled', 'true'));
      }
      document.getElementById('discordText').textContent = cfg.discordCommunityText || document.getElementById('discordText').textContent;

      // System Requirements
      const reqList = document.getElementById('reqList');
      if (Array.isArray(cfg.systemRequirements) && cfg.systemRequirements.length) {
        reqList.innerHTML = cfg.systemRequirements.map(r => `
          <div class="req-item">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="9"/></svg>
            <span>${escapeHtml(r)}</span>
          </div>`).join('');
      } else {
        reqList.innerHTML = `<div class="req-item"><span>Belum ada data persyaratan sistem.</span></div>`;
      }
    } catch (e) {
      console.error(e);
      showToast('Gagal memuat pengaturan website.');
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // STATS (Hero)
  // ══════════════════════════════════════════════════════════════════
  async function loadStats() {
    try {
      const stats = await apiGet('/api/public/stats');
      document.querySelectorAll('[data-stat]').forEach(el => {
        const key = el.dataset.stat;
        el.classList.remove('skeleton');
        animateCount(el, stats[key] || 0);
      });
    } catch (e) {
      document.querySelectorAll('[data-stat]').forEach(el => { el.textContent = '0'; el.classList.remove('skeleton'); });
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // DOWNLOAD APP (reuses existing public /api/app-update endpoint)
  // ══════════════════════════════════════════════════════════════════
  async function loadDownloadInfo() {
    try {
      const cfg = await apiGet('/api/app-update');
      document.getElementById('dlVersionBadge').textContent = 'Versi ' + (cfg.latestVersion || '-');
      document.getElementById('dlDateBadge').textContent = cfg.autoUpdateEnabled ? 'Auto Update Aktif' : 'Update Manual';
      document.getElementById('dlSize').textContent = cfg.fileSizeLabel || '—';
      const lastEntry = (cfg.history || [])[0];
      document.getElementById('dlDate').textContent = fmtDate(lastEntry?.releasedAt);
      document.getElementById('dlStatus').textContent = cfg.forceUpdateEnabled ? 'Wajib Update' : 'Tersedia';
      document.getElementById('dlChangelog').textContent = cfg.changelog || 'Belum ada catatan perubahan untuk versi ini.';

      const btn = document.getElementById('btnDownloadExe');
      if (cfg.downloadUrl) {
        btn.href = cfg.downloadUrl;
      } else {
        btn.removeAttribute('href');
        btn.setAttribute('disabled', 'true');
        btn.querySelector('svg')?.remove();
        btn.append(' Link Download Belum Tersedia');
      }
    } catch (e) {
      console.error(e);
      document.getElementById('dlChangelog').textContent = 'Gagal memuat informasi download.';
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // GAMES — search + genre filter + pagination + skeleton + lazy image
  // ══════════════════════════════════════════════════════════════════
  const gameState = { page: 1, limit: 12, search: '', genre: '', debounceT: null };

  function renderGameSkeletons(n) {
    const grid = document.getElementById('gameGrid');
    grid.innerHTML = Array.from({ length: n }).map(() => `
      <div class="panel game-card">
        <div class="skel skel-cover"></div>
        <div class="skel skel-line" style="width:70%"></div>
        <div class="skel skel-line" style="width:40%"></div>
      </div>
    `).join('');
  }

  function renderGames(data) {
    const grid = document.getElementById('gameGrid');
    if (!data.games || !data.games.length) {
      grid.innerHTML = `
        <div class="empty-state">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M9 9h.01M15 9h.01M8 15c1 1 2.5 1.5 4 1.5s3-.5 4-1.5"/></svg>
          <div>Tidak ada game yang cocok dengan pencarian kamu.</div>
        </div>`;
      renderPagination({ page: 1, totalPages: 1 });
      return;
    }
    grid.innerHTML = data.games.map(g => `
      <div class="panel game-card reveal in">
        <div class="game-cover">
          <img data-src="${g.cover || ''}" alt="${escapeHtml(g.name)}" loading="lazy" onerror="this.style.display='none'">
          <span class="game-status-dot ${g.status === 'online' ? '' : 'offline'}" title="${g.status === 'online' ? 'Online' : 'Offline'}"></span>
        </div>
        <div class="game-body">
          <div class="game-name" title="${escapeHtml(g.name)}">${escapeHtml(g.name)}</div>
          <div class="game-genres">
            ${(g.genres || []).slice(0, 3).map(gn => `<span class="game-genre-tag">${escapeHtml(gn)}</span>`).join('') || '<span class="game-genre-tag">Umum</span>'}
          </div>
          ${g.description ? `<div class="game-desc">${escapeHtml(g.description)}</div>` : ''}
        </div>
      </div>
    `).join('');
    grid.querySelectorAll('img[data-src]').forEach(img => imgObserver.observe(img));
    renderPagination(data);
  }

  function renderPagination(data) {
    const wrap = document.getElementById('gamePagination');
    const { page, totalPages } = data;
    if (!totalPages || totalPages <= 1) { wrap.innerHTML = ''; return; }

    const pages = [];
    const add = (p) => pages.push(p);
    add(1);
    for (let p = page - 1; p <= page + 1; p++) if (p > 1 && p < totalPages) add(p);
    if (totalPages > 1) add(totalPages);
    const uniq = [...new Set(pages)].sort((a, b) => a - b);

    let html = `<button class="page-btn" ${page <= 1 ? 'disabled' : ''} data-go="${page - 1}">‹</button>`;
    let prev = 0;
    uniq.forEach(p => {
      if (p - prev > 1) html += `<span class="page-btn" style="pointer-events:none;border:none;background:transparent;">…</span>`;
      html += `<button class="page-btn ${p === page ? 'active' : ''}" data-go="${p}">${p}</button>`;
      prev = p;
    });
    html += `<button class="page-btn" ${page >= totalPages ? 'disabled' : ''} data-go="${page + 1}">›</button>`;
    wrap.innerHTML = html;
    wrap.querySelectorAll('[data-go]').forEach(btn => {
      btn.addEventListener('click', () => { gameState.page = parseInt(btn.dataset.go, 10); loadGames(); window.scrollTo({ top: document.getElementById('games').offsetTop - 90, behavior: 'smooth' }); });
    });
  }

  async function loadGames() {
    renderGameSkeletons(gameState.limit);
    try {
      const qs = new URLSearchParams({
        page: gameState.page, limit: gameState.limit,
        search: gameState.search, genre: gameState.genre
      });
      const data = await apiGet('/api/public/games?' + qs.toString());
      renderGames(data);
    } catch (e) {
      console.error(e);
      document.getElementById('gameGrid').innerHTML = `
        <div class="error-state">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/></svg>
          <div>Gagal memuat daftar game. Coba lagi nanti.</div>
        </div>`;
    }
  }

  async function loadGenres() {
    try {
      const genres = await apiGet('/api/public/genres');
      const select = document.getElementById('genreFilter');
      genres.forEach(g => {
        const opt = document.createElement('option');
        opt.value = g.slug; opt.textContent = g.name;
        select.appendChild(opt);
      });
    } catch (e) { /* diamkan — filter genre optional */ }
  }

  document.getElementById('gameSearch')?.addEventListener('input', (e) => {
    clearTimeout(gameState.debounceT);
    gameState.debounceT = setTimeout(() => {
      gameState.search = e.target.value.trim();
      gameState.page = 1;
      loadGames();
    }, 380);
  });
  document.getElementById('genreFilter')?.addEventListener('change', (e) => {
    gameState.genre = e.target.value;
    gameState.page = 1;
    loadGames();
  });

  // ══════════════════════════════════════════════════════════════════
  // PAKET
  // ══════════════════════════════════════════════════════════════════
  const TIER_LABEL = { public: 'Public', gold: 'Gold', platinum: 'Platinum' };
  const TIER_ORDER = ['public', 'gold', 'platinum'];

  async function loadPackages() {
    const grid = document.getElementById('pkgGrid');
    try {
      const data = await apiGet('/api/public/packages');
      const pkgs = data.packages || {};
      const cards = TIER_ORDER.filter(t => pkgs[t]).map(tier => {
        const p = pkgs[tier];
        const isPaid = tier !== 'public';
        const featured = tier === 'platinum';
        const active = isPaid ? p.active !== false : true;
        return `
          <div class="panel pkg-card ${featured ? 'featured' : ''} reveal in">
            ${p.badge ? `<span class="pkg-badge">${escapeHtml(p.badge)}</span>` : ''}
            <div class="pkg-name">${TIER_LABEL[tier] || tier}</div>
            <div class="pkg-desc">${escapeHtml(p.description || '')}</div>
            <div class="pkg-price">
              ${isPaid ? 'Rp' + Number(p.price || 0).toLocaleString('id-ID') : 'Gratis'}
              ${isPaid ? `<span>/ ${p.durationLabel || ''}</span>` : ''}
            </div>
            <ul class="pkg-benefits">
              ${(p.benefits || []).map(b => `
                <li><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6 9 17l-5-5"/></svg> ${escapeHtml(b)}</li>
              `).join('') || '<li>Belum ada detail benefit.</li>'}
            </ul>
            <div class="pkg-status">${isPaid ? (active ? 'Status: Tersedia' : 'Status: Tidak tersedia saat ini') : 'Status: Selalu aktif'}</div>
            <a href="#download" class="btn ${featured ? 'btn-primary' : 'btn-ghost'} btn-block">${isPaid ? 'Download App untuk Beli' : 'Mulai Gratis'}</a>
          </div>`;
      }).join('');
      grid.innerHTML = cards || `<div class="empty-state">Belum ada paket tersedia.</div>`;
      observeReveals();
    } catch (e) {
      console.error(e);
      grid.innerHTML = `<div class="error-state">Gagal memuat daftar paket.</div>`;
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // FAQ
  // ══════════════════════════════════════════════════════════════════
  async function loadFaq() {
    const wrap = document.getElementById('faqList');
    try {
      const data = await apiGet('/api/public/faq');
      const faq = data.faq || [];
      if (!faq.length) {
        wrap.innerHTML = `<div style="padding:24px;color:var(--text-faint);font-size:13.5px;">Belum ada FAQ yang ditambahkan.</div>`;
        return;
      }
      wrap.innerHTML = faq.map((f, i) => `
        <div class="faq-item" data-i="${i}">
          <button class="faq-q" aria-expanded="false">
            <span>${escapeHtml(f.question)}</span>
            <svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6"/></svg>
          </button>
          <div class="faq-a"><div class="faq-a-inner">${escapeHtml(f.answer)}</div></div>
        </div>
      `).join('');
      wrap.querySelectorAll('.faq-item').forEach(item => {
        const q = item.querySelector('.faq-q');
        const a = item.querySelector('.faq-a');
        q.addEventListener('click', () => {
          const isOpen = item.classList.contains('open');
          wrap.querySelectorAll('.faq-item.open').forEach(o => { o.classList.remove('open'); o.querySelector('.faq-a').style.maxHeight = null; o.querySelector('.faq-q').setAttribute('aria-expanded', 'false'); });
          if (!isOpen) {
            item.classList.add('open');
            a.style.maxHeight = a.scrollHeight + 'px';
            q.setAttribute('aria-expanded', 'true');
          }
        });
      });
    } catch (e) {
      console.error(e);
      wrap.innerHTML = `<div style="padding:24px;color:var(--red);font-size:13.5px;">Gagal memuat FAQ.</div>`;
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // INIT
  // ══════════════════════════════════════════════════════════════════
  async function init() {
    setTopLoader(15);
    observeReveals();
    await Promise.allSettled([
      loadWebsiteSettings(),
      loadStats(),
      loadDownloadInfo(),
      loadGenres().then(loadGames),
      loadPackages(),
      loadFaq()
    ]);
    setTopLoader(100);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
