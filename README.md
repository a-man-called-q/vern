# Vern

Vern adalah kumpulan template untuk membangun aplikasi web dengan autentikasi
ZITADEL. Repository ini menyediakan aplikasi TanStack Start sebagai Backend for
Frontend (BFF), API Axum yang memeriksa access token, dan stack ZITADEL lokal
untuk pengembangan.

## Arsitektur

- Browser login ke ZITADEL melalui aplikasi TanStack Start. Browser hanya
  menyimpan cookie sesi `HttpOnly`; token OAuth disimpan di Redis dan tidak
  dikirim ke komponen browser.
- Server TanStack Start memanggil API Axum dari server ke server dengan bearer
  access token.
- API Axum memeriksa token lewat endpoint introspection ZITADEL sebelum
  menangani rute yang dilindungi.
- `apps/auth-server` menyediakan ZITADEL Login V2 lokal menggunakan Docker
  Compose dan image resmi ZITADEL.

## Isi repository

```text
apps/
  auth-server/       Stack ZITADEL lokal dan branding Login V2
templates/
  tanstack/          Template BFF TanStack Start + React
  axum/              Template API Rust + Axum
```

Template menghasilkan aplikasi baru; source aplikasi hasil generate tidak
disimpan di repository ini.

## Prasyarat

- [Docker Compose](https://docs.docker.com/compose/) untuk menjalankan ZITADEL
  lokal.
- [`cargo-generate`](https://cargo-generate.github.io/cargo-generate/) versi
  0.23 atau lebih baru untuk membuat aplikasi dari template.
- [Bun](https://bun.sh/) untuk aplikasi TanStack Start.
- [Rust](https://www.rust-lang.org/tools/install) untuk aplikasi Axum.
- Redis untuk menyimpan sesi aplikasi TanStack. Jalankan server Redis sendiri
  atau gunakan contoh di bawah.

Versi Bun dan Rust yang digunakan proyek tercatat di `.prototools`.

## Buat aplikasi dari template

Jalankan perintah dari root repository. Ganti nama proyek sesuai kebutuhan.

```sh
cargo generate --path templates/tanstack --name my-dashboard
cargo generate --path templates/axum --name my-api
```

Template TanStack menyertakan halaman demo secara default. Untuk menghasilkan
aplikasi tanpa route dan file demo:

```sh
cargo generate \
  --path templates/tanstack \
  --name my-dashboard \
  --define include_demos=false
```

Setiap template menghasilkan README dengan instruksi setup dan konfigurasi
yang lebih lengkap:

- [TanStack Start BFF](templates/tanstack/README.md.liquid)
- [Axum API](templates/axum/README.md.liquid)

## Menjalankan layanan lokal

### 1. Nyalakan ZITADEL

```sh
cd apps/auth-server
cp .env.example .env
docker compose up -d --wait
```

Alamat lokal:

- Login: <http://localhost:8081/>
- Console: <http://localhost:8081/ui/console/>
- OIDC issuer: <http://localhost:8081>

Kredensial admin lokal dibaca dari `apps/auth-server/.env`. Nilai bawaan di
contoh environment hanya ditujukan untuk pengembangan lokal; ubah secret dan
password sebelum layanan dapat diakses dari jaringan.

Panduan branding, penggantian port, dan reset database tersedia di
[README auth-server](apps/auth-server/README.md).

### 2. Nyalakan Redis

Contoh menjalankan Redis lokal dengan Docker:

```sh
docker run --name vern-redis -p 6379:6379 -d redis:7-alpine
```

### 3. Konfigurasikan dan jalankan aplikasi

Ikuti README yang dihasilkan oleh masing-masing template untuk membuat
aplikasi ZITADEL dan mengisi file `.env`:

- TanStack memerlukan `ZITADEL_CLIENT_ID`, `ZITADEL_PROJECT_ID`, `SESSION_SECRET`,
  `REDIS_URL`, dan `API_BASE_URL`.
- Axum memerlukan `ZITADEL_PROJECT_ID` dan file key Private Key JWT dari
  aplikasi API ZITADEL. Gunakan issuer lokal `http://localhost:8081` saat
  terhubung ke `apps/auth-server`.

> Semua API yang akan dipanggil aplikasi web harus berada di project ZITADEL
> yang sama agar dapat memakai audience project yang diminta TanStack. Buat
> aplikasi API dan key tersendiri untuk setiap service Axum.

Setelah konfigurasi selesai, jalankan tiap aplikasi di terminal terpisah dari
root repository:

```sh
# Terminal 1: API Axum
cd my-api
cp .env.example .env
# Isi konfigurasi ZITADEL dan letakkan key di path yang ditentukan.
cargo run
```

```sh
# Terminal 2: aplikasi TanStack Start
cd my-dashboard
cp .env.example .env
bun install
# Isi konfigurasi ZITADEL, Redis, API, dan SESSION_SECRET.
bun run dev
```

Sesuaikan direktori proyek jika nama yang dipilih saat generate berbeda.
README TanStack mencantumkan Redirect URI dan Post-logout Redirect URI yang
perlu didaftarkan pada aplikasi web ZITADEL.

## Endpoint contoh Axum

- `GET /healthz` bersifat publik dan mengembalikan `{"status":"ok"}`.
- `GET /api/me` memerlukan token aktif dengan audience project yang benar dan
  mengembalikan subject terverifikasi.

## Perintah pengembangan

Di proyek TanStack hasil generate:

```sh
bun run dev
bun run build
bun run check
bun run test
```

Di proyek Axum hasil generate:

```sh
cargo run
cargo fmt --check
cargo test
cargo clippy --all-targets --all-features -- -D warnings
```

README masing-masing template menjelaskan detail pengembangan dan konfigurasi
produksi. Untuk deployment, gunakan HTTPS untuk aplikasi, API, dan issuer;
simpan secret dan key di secret manager atau environment deployment, bukan di
repository.
