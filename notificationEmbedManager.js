// ══════════════════════════════════════════════════════════════════════════
// NOTIFICATION EMBED MANAGER — generalisasi dari packageEmbedManager.js.
//
// Memberikan Embed Builder LENGKAP (title, description, color, author,
// thumbnail, image, fields, footer, timestamp, buttons, variable {{...}},
// default+custom template, Reset to Default, validasi limit Discord) untuk
// SEMUA kategori notifikasi Discord yang terdaftar di discordNotifyManager.js
// (CATEGORIES) — bukan cuma notifikasi Paket.
//
// TIDAK dibuat dari nol: struktur, nama fungsi, dan alur di file ini SENGAJA
// dibuat identik dengan packageEmbedManager.js (COLLECTION per-key,
// getTemplate/listAll/saveTemplate/resetTemplate/validateTemplate/
// renderTemplate, previousTemplate sebagai backup, fallback default kalau
// invalid) — packageEmbedManager.js dipakai sebagai REFERENSI UTAMA sesuai
// permintaan, hanya digeneralisasi supaya `categories` & `variables`-nya
// tidak hardcode ke domain paket saja.
//
// KOLEKSI DATABASE: `notification_embed_templates` (BARU — terpisah dari
// `package_embed_templates` yang lama, supaya tidak mengganggu template
// paket yang sudah ada). Satu dokumen per category key (_id = category).
//
// DEPENDENCY INJECTION (hindari circular require dengan discordNotifyManager.js):
//   const webhookManager = require('./discordNotifyManager')({ getDb });
//   const notificationEmbedManager = require('./notificationEmbedManager')({
//     getDb, categories: webhookManager.CATEGORIES, appName: APP_NAME
//   });
//   webhookManager.setEmbedManager(notificationEmbedManager); // late-bind
//
// PRINSIP FALLBACK (poin #20 "Tidak Boleh Ada Hardcoded" & #22 "Fallback
// System" dari instruksi):
//   - Kategori yang BELUM di-customize admin -> defaultTemplateFor() dipakai,
//     hasilnya construction-nya SAMA PERSIS dengan default embed lama di
//     discordNotifyManager.sendCategoryWebhook() (title meta.icon+meta.label,
//     description kosong, color meta.color, footer "{appName} · {label} ·
//     31 Tools") — supaya kategori yang belum disentuh admin TIDAK BERUBAH
//     tampilannya sama sekali.
//   - `fields` dinamis yang selalu dikirim pemanggil (data nyata per event —
//     nominal transaksi, nama game, dst) TETAP ikut tampil secara default
//     (template.includeRuntimeFields default true) supaya admin custom field
//     tidak pernah menghilangkan data asli tanpa sengaja.
//   - Template rusak / tidak ditemukan / DB gagal dibaca -> otomatis fallback
//     ke previousTemplate lalu ke default -> notifikasi TETAP terkirim.
// ══════════════════════════════════════════════════════════════════════════

const COLLECTION = 'notification_embed_templates';

const LIMITS = {
  title: 256, description: 4096, fieldName: 256, fieldValue: 1024,
  footerText: 2048, authorName: 256, maxFields: 25, totalEmbed: 6000
};

// Variable generik yang tersedia untuk SEMUA kategori (data lain yang khusus
// per event tetap lewat sebagai `fields` dinamis, lihat includeRuntimeFields
// di atas — karena tiap kategori punya data berbeda, bukan dipaksa jadi satu
// daftar variable universal yang sebagian besar akan kosong per kategori).
const VARIABLES = [
  { key: 'title', label: 'Judul Default (dinamis dari sistem)', example: '(judul asli event)' },
  { key: 'description', label: 'Deskripsi Default (dinamis dari sistem)', example: '(deskripsi asli event)' },
  { key: 'username', label: 'Username User Terkait', example: 'RizkyGamers' },
  { key: 'user_id', label: 'Discord User ID Terkait', example: '123456789012345678' },
  { key: 'role', label: 'Role/Paket User Terkait', example: 'Gold' },
  { key: 'admin_name', label: 'Admin Pelaku (kalau ada)', example: 'Admin' },
  { key: 'category_label', label: 'Nama Kategori Notifikasi', example: 'Login Akun' },
  { key: 'server_name', label: 'Nama Aplikasi/Toko', example: '31 Tools' }
];

function embedCharCount(t) {
  let total = 0;
  total += (t.title || '').length;
  total += (t.description || '').length;
  total += (t.footer?.text || '').length;
  total += (t.author?.name || '').length;
  for (const f of (t.fields || [])) total += (f.name || '').length + (f.value || '').length;
  return total;
}

function validateTemplate(t) {
  const errors = [];
  if ((t.title || '').length > LIMITS.title) errors.push(`Title melebihi ${LIMITS.title} karakter.`);
  if ((t.description || '').length > LIMITS.description) errors.push(`Description melebihi ${LIMITS.description} karakter.`);
  if ((t.footer?.text || '').length > LIMITS.footerText) errors.push(`Footer text melebihi ${LIMITS.footerText} karakter.`);
  if ((t.author?.name || '').length > LIMITS.authorName) errors.push(`Author name melebihi ${LIMITS.authorName} karakter.`);
  if ((t.fields || []).length > LIMITS.maxFields) errors.push(`Maksimal ${LIMITS.maxFields} fields (saat ini ${t.fields.length}).`);
  (t.fields || []).forEach((f, i) => {
    if ((f.name || '').length > LIMITS.fieldName) errors.push(`Field #${i + 1}: nama melebihi ${LIMITS.fieldName} karakter.`);
    if ((f.value || '').length > LIMITS.fieldValue) errors.push(`Field #${i + 1}: value melebihi ${LIMITS.fieldValue} karakter.`);
  });
  if (embedCharCount(t) > LIMITS.totalEmbed) errors.push(`Total karakter embed melebihi ${LIMITS.totalEmbed}.`);
  return { ok: errors.length === 0, errors };
}

function hexToInt(hex, fallback) {
  if (typeof hex === 'number') return hex;
  const s = String(hex || '').replace('#', '');
  const n = parseInt(s, 16);
  return Number.isFinite(n) ? n : fallback;
}

function cleanUrl(u) {
  const s = (u || '').trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) return null; // Discord menolak URL non-http(s) di embed
  return s;
}

function replaceVars(str, vars) {
  if (typeof str !== 'string' || !str) return str;
  return str.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (match, key) => {
    const v = vars[key.toLowerCase()];
    return v !== undefined ? v : '';
  }).trim();
}

module.exports = function ({ getDb, categories, appName }) {
  const db = () => getDb();
  if (!Array.isArray(categories) || !categories.length) {
    throw new Error('notificationEmbedManager: `categories` wajib diisi (dari discordNotifyManager.CATEGORIES).');
  }
  const CATEGORY_KEYS = categories.map(c => c.key);
  const CATEGORY_MAP = Object.fromEntries(categories.map(c => [c.key, c]));

  function isValidCategory(key) { return CATEGORY_KEYS.includes(key); }

  // Default template = REPLIKA PERSIS embed default lama di
  // discordNotifyManager.sendCategoryWebhook() — supaya kategori yang belum
  // di-customize admin tampilannya TIDAK BERUBAH sama sekali.
  function defaultTemplateFor(key) {
    const meta = CATEGORY_MAP[key];
    if (!meta) throw new Error('Kategori notifikasi tidak dikenal: ' + key);
    const color = '#' + (meta.color ?? 0x3498db).toString(16).padStart(6, '0');
    return {
      title: '', description: '', color,
      url: '', author: { name: '', iconUrl: '', url: '' },
      thumbnail: { url: '' }, image: { url: '' },
      footer: { text: '', iconUrl: '' }, timestamp: true,
      fields: [], buttons: [],
      // Kalau true (default), fields dinamis yang dikirim pemanggil tetap
      // digabung/ditampilkan meskipun admin sudah menambah field custom.
      includeRuntimeFields: true
    };
  }

  async function getDoc(category) {
    return db().collection(COLLECTION).findOne({ _id: category });
  }

  async function getTemplate(category) {
    if (!isValidCategory(category)) throw new Error('Kategori notifikasi tidak dikenal: ' + category);
    const doc = await getDoc(category);
    return doc?.template || defaultTemplateFor(category);
  }

  async function listAll() {
    const docs = await db().collection(COLLECTION).find({}).toArray();
    const byId = Object.fromEntries(docs.map(d => [d._id, d]));
    return categories.map(c => ({
      ...c,
      isCustomized: !!byId[c.key],
      updatedAt: byId[c.key]?.updatedAt || null,
      updatedBy: byId[c.key]?.updatedBy || null
    }));
  }

  async function saveTemplate(category, template, adminName) {
    if (!isValidCategory(category)) throw new Error('Kategori notifikasi tidak dikenal: ' + category);
    const validation = validateTemplate(template);
    if (!validation.ok) {
      const err = new Error(validation.errors[0]);
      err.validation = validation.errors;
      throw err;
    }
    const existing = await getDoc(category);
    await db().collection(COLLECTION).updateOne({ _id: category }, {
      $set: {
        category, template,
        updatedAt: new Date(), updatedBy: adminName || 'Admin',
        previousTemplate: existing ? existing.template : defaultTemplateFor(category)
      }
    }, { upsert: true });
    return template;
  }

  async function resetTemplate(category) {
    if (!isValidCategory(category)) throw new Error('Kategori notifikasi tidak dikenal: ' + category);
    await db().collection(COLLECTION).deleteOne({ _id: category });
    return defaultTemplateFor(category);
  }

  async function isCustomized(category) {
    return !!(await getDoc(category));
  }

  // runtimeData = data nyata yang dikirim pemanggil sendCategoryWebhook untuk
  // event ini SAAT INI TERJADI: { title, description, color, fields,
  // thumbnail, image, username, userId, admin, role }.
  function buildVariableMap(category, runtimeData = {}) {
    const meta = CATEGORY_MAP[category];
    const map = {};
    const set = (k, v) => { if (v !== undefined && v !== null && v !== '') map[k] = String(v); };
    set('title', runtimeData.title || `${meta.icon} ${meta.label}`);
    set('description', runtimeData.description);
    set('username', runtimeData.username);
    set('user_id', runtimeData.userId);
    set('role', runtimeData.role);
    set('admin_name', runtimeData.admin);
    set('category_label', meta.label);
    set('server_name', appName);
    return map;
  }

  function renderTemplate(category, template, runtimeData = {}) {
    const meta = CATEGORY_MAP[category];
    if (!meta) throw new Error('Kategori notifikasi tidak dikenal: ' + category);
    const vars = buildVariableMap(category, runtimeData);

    const title = replaceVars(template.title, vars) || vars.title || `${meta.icon} ${meta.label}`;
    const description = replaceVars(template.description, vars) || vars.description || runtimeData.description || '';

    let fields = (template.fields || [])
      .map(f => ({ name: replaceVars(f.name, vars), value: replaceVars(f.value, vars), inline: !!f.inline }))
      .filter(f => f.name && f.value);

    if (template.includeRuntimeFields !== false && Array.isArray(runtimeData.fields) && runtimeData.fields.length) {
      const existingNames = new Set(fields.map(f => f.name));
      for (const f of runtimeData.fields) {
        if (f && f.name && !existingNames.has(f.name)) fields.push(f);
      }
    }

    const footerText = replaceVars(template.footer?.text, vars) ||
      `${appName ? appName + ' · ' : ''}${meta.label} · 31 Tools`;

    const embed = {
      title: title || undefined,
      description: description || undefined,
      color: hexToInt(template.color, runtimeData.color ?? meta.color ?? 0x3498db),
      fields,
      timestamp: template.timestamp !== false ? new Date().toISOString() : undefined,
      footer: { text: footerText }
    };
    const footerIcon = cleanUrl(replaceVars(template.footer?.iconUrl, vars));
    if (footerIcon) embed.footer.icon_url = footerIcon;

    const url = cleanUrl(replaceVars(template.url, vars));
    if (url) embed.url = url;

    const authorName = replaceVars(template.author?.name, vars);
    if (authorName) {
      embed.author = { name: authorName };
      const aIcon = cleanUrl(replaceVars(template.author?.iconUrl, vars));
      const aUrl = cleanUrl(replaceVars(template.author?.url, vars));
      if (aIcon) embed.author.icon_url = aIcon;
      if (aUrl) embed.author.url = aUrl;
    }

    // Thumbnail/image: template custom menang kalau diisi, else pakai yang
    // dikirim pemanggil (mis. avatar user / cover game) — supaya gambar
    // dinamis per event tidak hilang hanya gara-gara kategori belum dikustomisasi.
    const thumbUrl = cleanUrl(replaceVars(template.thumbnail?.url, vars)) || cleanUrl(runtimeData.thumbnail);
    if (thumbUrl) embed.thumbnail = { url: thumbUrl };

    const imgUrl = cleanUrl(replaceVars(template.image?.url, vars)) || cleanUrl(runtimeData.image);
    if (imgUrl) embed.image = { url: imgUrl };

    const linkButtons = (template.buttons || [])
      .filter(b => b.enabled !== false && b.label && cleanUrl(replaceVars(b.url, vars)))
      .slice(0, 5)
      .map(b => ({ type: 2, style: 5, label: String(b.label).slice(0, 80), url: cleanUrl(replaceVars(b.url, vars)) }));
    const components = linkButtons.length ? [{ type: 1, components: linkButtons }] : undefined;

    return { embed, components };
  }

  // Dipakai discordNotifyManager.sendCategoryWebhook() lewat setEmbedManager()
  // — fail-safe: template salah/DB gagal -> fallback previousTemplate -> default.
  // Notifikasi TETAP dikirim (poin #22 Fallback System).
  async function renderCategoryEmbed(category, runtimeData = {}) {
    let template;
    try { template = await getTemplate(category); } catch { template = defaultTemplateFor(category); }
    let validation = validateTemplate(template);
    if (!validation.ok) {
      try {
        const doc = await getDoc(category);
        template = doc?.previousTemplate || defaultTemplateFor(category);
        validation = validateTemplate(template);
        if (!validation.ok) template = defaultTemplateFor(category);
      } catch { template = defaultTemplateFor(category); }
    }
    return renderTemplate(category, template, runtimeData);
  }

  return {
    CATEGORY_KEYS, CATEGORY_MAP, VARIABLES, LIMITS,
    isValidCategory, getTemplate, listAll, saveTemplate, resetTemplate,
    validateTemplate, renderTemplate, renderCategoryEmbed, defaultTemplateFor,
    buildVariableMap, replaceVars, embedCharCount, isCustomized
  };
};
