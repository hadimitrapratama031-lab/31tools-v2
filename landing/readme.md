# 31 Tools — Landing Page

Landing page statis (HTML/CSS/JS murni, tanpa build step) untuk aplikasi **31 Tools**.
Semua konten (statistik, daftar game, paket, FAQ, hero, link Discord, info download)
diambil **realtime** dari backend yang sudah kamu punya — tidak ada yang di-hardcode.

## 1. Sebelum deploy: isi `js/config.js`

Buka `js/config.js` dan ganti `API_BASE_URL` dengan URL backend production kamu
(server.js yang sudah jalan di Railway/dsb), **tanpa** trailing slash:

```js
window.SITE_CONFIG = {
  API_BASE_URL: "https://31tools-v2-production.up.railway.app"
};
```

Itu satu-satunya file yang perlu diubah. Karena backend sudah pakai `app.use(cors())`
(mengizinkan semua origin), website ini bisa langsung fetch API dari domain Netlify
tanpa perlu setting CORS tambahan.

## 2. Deploy ke Netlify

**Cara termudah (drag & drop):**
1. Buka https://app.netlify.com/drop
2. Drag folder `landing/` (folder ini) ke halaman tersebut.
3. Selesai — Netlify langsung kasih URL live.

**Lewat Git (disarankan untuk update berkelanjutan):**
1. Push folder ini ke repo GitHub/GitLab.
2. Di Netlify: **Add new site → Import an existing project**.
3. Build command: kosongkan (atau biarkan default dari `netlify.toml`).
4. Publish directory: `.` (root folder ini).
5. Deploy.

**Lewat Netlify CLI:**
```bash
npm install -g netlify-cli
cd landing
netlify deploy --prod
```

## 3. Endpoint backend yang dipakai (sudah ditambahkan ke server.js kamu)

Semua endpoint ini **publik** (tanpa login) dan sudah otomatis tersedia setelah kamu
deploy backend yang sudah di-update:

| Endpoint | Kegunaan |
|---|---|
| `GET /api/public/stats` | Total Game, Total User, Total Download (Hero) |
| `GET /api/public/games` | Daftar game — support `?search=&genre=&page=&limit=` |
| `GET /api/public/genres` | Daftar genre/kategori untuk filter |
| `GET /api/public/packages` | Daftar paket Public/Gold/Platinum |
| `GET /api/public/faq` | Daftar FAQ |
| `GET /api/public/website-settings` | Hero title/subtitle/banner, logo, Discord, System Requirements, versi website |
| `GET /api/app-update` | Info Download EXE (versi, changelog, ukuran file, link installer) — endpoint ini **sudah ada sebelumnya**, dipakai bareng oleh App |

## 4. Kelola konten dari Admin Web

Buka Admin Web → menu **Website Settings** untuk atur:
- Hero Title, Hero Subtitle, Banner Hero, Logo
- Link & deskripsi komunitas Discord
- System Requirements (satu baris = satu item)
- Versi Website (tampil di footer)
- FAQ (tambah/edit/hapus)
- Mode Statistik: **Auto** (dihitung dari database) atau **Manual** (isi angka sendiri)

Info **Download EXE** (versi, changelog, ukuran file, link installer) tetap dikelola
di halaman **App Update** yang sudah ada — supaya App dan Website selalu pakai data
yang sama persis (satu sumber kebenaran).

Semua perubahan di Admin Web langsung tampil di website begitu halaman di-refresh —
**tidak perlu redeploy Netlify sama sekali**, karena data diambil lewat API saat
halaman dibuka.

## 5. Struktur folder

```
landing/
├── index.html          # Semua section: Home, Download, Fitur, Games, Paket, FAQ, Discord, Footer
├── css/style.css        # Tema ungu/navy — turunan langsung dari palet Admin Web
├── js/config.js         # ← WAJIB diisi sebelum deploy
├── js/main.js            # Fetch API + render semua section + search/filter/pagination/skeleton
├── assets/favicon.svg
├── assets/og-cover.svg
├── netlify.toml
└── robots.txt
```

## 6. Catatan teknis

- **Tanpa framework/build step** — cukup file statis, cocok untuk Netlify gratis.
- **Lazy loading gambar** cover game pakai `IntersectionObserver`.
- **Skeleton loading** dipakai di Games (saat search/filter/pindah halaman) dan Paket.
- **Search & filter genre** di-debounce 380ms supaya tidak spam request ke server.
- **Reduced motion** dihormati (`prefers-reduced-motion`) untuk aksesibilitas.
- Sistem App & Admin Web yang sudah berjalan **tidak diubah sama sekali** — semua
  penambahan bersifat additive (endpoint baru + 1 halaman admin baru).
