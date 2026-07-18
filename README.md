# Nova Launcher — Project Baru (dari 0)

Struktur:
```
server.js          → backend (Express + MongoDB + Discord OAuth)
main.js             → Electron main process
preload.js           → jembatan aman main <-> renderer
app/                → UI aplikasi (index.html, style.css, app.js)
public/admin.html    → admin web (di-serve backend di /admin.html)
public/admin.css
public/admin.js
.env.example         → contoh isi environment variable
```

## 1. Setup Discord Application
1. Buka https://discord.com/developers/applications → New Application.
2. Tab **OAuth2** → catat `Client ID` & `Client Secret`.
3. Masih di tab OAuth2 → **Redirects** → tambahkan:
   `http://localhost:3000/auth/discord/callback` (waktu masih development)
   Nanti kalau sudah deploy, tambahkan juga versi domain aslinya, contoh:
   `https://nama-project-kamu.up.railway.app/auth/discord/callback`
4. Tab **Bot** → Add Bot → Reset Token → catat token-nya. Bot ini **tidak perlu**
   diundang ke server pakai OAuth invite khusus bot — tapi server Discord kamu
   harus punya bot yang sudah invited supaya bisa dicek keanggotaannya. Kalau
   belum ada bot di server, tambahkan lewat OAuth2 URL Generator (scope `bot`,
   permission cukup "View Channels" / minimal, tidak perlu izin macam-macam).
5. Klik kanan nama server Discord kamu di app Discord → **Copy Server ID**
   (perlu aktifkan Developer Mode dulu di Discord: Settings → Advanced).

## 2. Setup MongoDB
Bikin cluster gratis di https://www.mongodb.com/cloud/atlas, ambil connection
string-nya (`mongodb+srv://...`), tempel ke `MONGODB_URI`.

## 3. Isi file `.env`
Copy `.env.example` jadi `.env`, isi semua field sesuai punya kamu. Nama-nama
variabelnya sudah dibikin simpel & ada komentar penjelasan di tiap baris.

## 4. Jalankan backend
```
npm install
npm run server
```

## 5. Jalankan app (Electron)
Sebelum itu, buka `app/app.js`, baris paling atas:
```js
const SERVER_URL = 'http://localhost:3000';
```
Ganti ke alamat backend kamu kalau sudah di-deploy (misal ke Railway).

```
npm run app
```

## 6. Buka Admin Web
Setelah backend jalan, buka browser ke:
```
http://localhost:3000/admin.html
```
Login pakai `ADMIN_PASSWORD` yang kamu isi di `.env`.

## Alur Login App
1. User pencet "Login dengan Discord" di app → app buka browser default ke
   `/auth/discord`.
2. User login & izinkan di Discord (browser).
3. Discord redirect balik ke backend → backend cek: apakah user ini sudah
   jadi member server Discord kamu (pakai bot token)?
   - **Belum join** → ditampilkan halaman suruh join dulu + link invite.
   - **Sudah join** → user disimpan/​diperbarui di database (role default
     `public` kalau baru pertama kali), lalu browser menampilkan "Login
     berhasil, kembali ke app".
4. Selama itu, app terus-menerus nanya ke backend ("polling") apakah proses
   login sudah kelar. Begitu kelar, app otomatis masuk ke halaman utama.

## Yang perlu kamu lakukan manual dulu
- Role user (`public`/`gold`/`platinum`) sekarang **cuma bisa diubah lewat
  Admin Web** (menu Users) — belum ada sistem pembayaran/upgrade otomatis,
  sesuai permintaan awal ("fitur dikit dulu").
- Menambahkan Game/Bypass juga lewat Admin Web (menu Game/Bypass), termasuk
  nyari cover art otomatis lewat SteamGridDB (kalau API key sudah diisi).

## Yang beda dari project sebelumnya
- Arsitektur baru: Electron pakai `contextIsolation` + `preload.js` (bukan
  `nodeIntegration` langsung), lebih aman.
- Tidak ada sistem expiry/durasi paket & pembayaran — role sekarang statis,
  diatur manual oleh admin (bisa dikembangkan lagi nanti kalau sudah stabil).
- Desain UI baru: tema "digital gradient" (ungu → pink, aksen cyan/emas buat
  role), custom title bar frameless, sidebar navigasi — beda total dari tema
  sebelumnya.
- Nama-nama environment variable dibikin ulang lebih pendek & jelas.
