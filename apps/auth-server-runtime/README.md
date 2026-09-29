# Vern auth server

ZITADEL Login V2 berjalan sebagai service Docker terpisah dari API ZITADEL. Compose mengizinkan image login ditentukan lewat `ZITADEL_LOGIN_IMAGE`, sehingga Login App hasil full-repository fork dapat digunakan tanpa mengubah service API, database, atau issuer.

## Jalankan lokal

```sh
cp .env.example .env
cp apps/auth-server/.env.example apps/auth-server/.env
moon run auth-server:dev
```

Buka:

- Login: <http://localhost:8081/>
- Console: <http://localhost:8081/ui/console/>
- OIDC issuer: <http://localhost:8081>
- Redis: `redis://localhost:6379`

Set `AUTH_HTTP_PORT` in the repository root `.env` to another free local port if `8081` is already in use. Update `ZITADEL_ISSUER` to match. If the database has already been initialized, also update **Default settings → Features → Login V2 → Base URI** in the Console; ZITADEL applies `DEFAULTINSTANCE` values only on first initialization.

Username dan password admin diambil dari `.env`. Nilai `FIRSTINSTANCE` hanya dipakai ketika database pertama kali dibuat.

## Login UI kustom

Target source Login App adalah full-repository fork publik [`a-man-called-q/zitadel`](https://github.com/a-man-called-q/zitadel), berbasis tag ZITADEL yang sama dengan backend. Fork dan image tersebut belum tersedia. Target image GHCR adalah `ghcr.io/a-man-called-q/vern-zitadel-login`, dengan tag yang mengandung versi upstream dan commit fork.

Saat ini fork/image tersebut belum tersedia, jadi `.env.example` tetap memakai image resmi yang cocok dengan `ZITADEL_VERSION`. Setelah image fork dipublikasikan, set `ZITADEL_LOGIN_IMAGE` di `apps/auth-server/.env` ke tag immutable yang sesuai. Jangan menaikkan `ZITADEL_VERSION` tanpa mengganti Login App ke build dari rilis upstream yang sama.

Layout kustom memakai shadcn `login-02` sebagai kerangka visual, sementara form, MFA, IdP, registrasi, pemulihan akun, dan alur OIDC tetap dijalankan oleh Login App ZITADEL. Sinkronisasi upstream direncanakan melalui PR update; image baru digunakan setelah PR diperiksa, digabung, dan diuji di staging.

## Branding saat ini

- Logo light: `brand/logo-light.svg`
- Logo dark: `brand/logo-dark.svg`
- Favicon: `brand/favicon.svg`
- CSS fallback untuk image resmi: `brand/login.css`

Setelah mengubah file branding, rebuild proxy-nya:

```sh
docker compose -f apps/auth-server/docker-compose.yml up -d --build auth-server
```

Selama masih memakai image resmi, logo dan styling diterapkan oleh stylesheet di layer proxy. Setelah image fork yang sudah membawa branding Vern tersedia dan lolos pemeriksaan visual, hapus stylesheet injection dari `nginx.conf` dan jadikan styling Login App fork sebagai sumber utama. Warna instance ZITADEL juga diatur lewat `DEFAULTINSTANCE_LABELPOLICY_*` di Compose. Konfigurasi tersebut hanya berlaku pada inisialisasi database baru.

## Catatan deployment

- Ganti `ZITADEL_MASTERKEY`, password PostgreSQL, dan password admin sebelum dipakai di jaringan.
- Gunakan HTTPS di reverse proxy production, lalu sesuaikan `ZITADEL_EXTERNALSECURE`, scheme, dan external port.
- Pin `ZITADEL_VERSION` dan `ZITADEL_LOGIN_IMAGE` ke pasangan release yang sudah dites. Jangan memakai `latest` untuk production. Gunakan tag GHCR immutable yang mencantumkan versi upstream dan commit fork; simpan digest serta image sebelumnya untuk rollback.
- Image resmi dipakai sebagai fallback selama custom fork belum dipublikasikan. Jangan menghapus fallback CSS sebelum image kustom menggantikannya.

## Reset data lokal

Perintah ini menghapus database dan bootstrap token lokal:

```sh
docker compose -f apps/auth-server/docker-compose.yml down -v
```

Stop the stack without deleting local data with `moon run auth-server:down`.
