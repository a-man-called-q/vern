# Vern auth server

ZITADEL Login V2 yang dijalankan sepenuhnya lewat Docker. Stack ini memakai image resmi ZITADEL dan tidak menyalin source tree ZITADEL ke repository.

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

## Ganti logo dan tampilan

- Logo light: `brand/logo-light.svg`
- Logo dark: `brand/logo-dark.svg`
- Favicon: `brand/favicon.svg`
- CSS login: `brand/login.css`

Setelah mengubah file branding, rebuild proxy-nya:

```sh
docker compose -f apps/auth-server/docker-compose.yml up -d --build auth-server
```

Logo diganti di layer proxy lewat stylesheet, sedangkan alur login tetap berasal dari Login V2 resmi. Warna awal juga dikirim ke instance ZITADEL lewat `DEFAULTINSTANCE_LABELPOLICY_*` di Compose. Konfigurasi instance tersebut hanya berlaku pada inisialisasi database baru.

## Catatan deployment

- Ganti `ZITADEL_MASTERKEY`, password PostgreSQL, dan password admin sebelum dipakai di jaringan.
- Gunakan HTTPS di reverse proxy production, lalu sesuaikan `ZITADEL_EXTERNALSECURE`, scheme, dan external port.
- Pin `ZITADEL_VERSION` ke release yang sudah dites. Jangan memakai `latest` untuk production.
- Kalau butuh mengubah alur atau teks internal Login V2 sampai level React component, image resmi saja tidak cukup; itu memerlukan custom build Login UI upstream. Untuk kebutuhan visual/logo yang sekarang, `brand/` sudah menjadi extension point Docker-only.

## Reset data lokal

Perintah ini menghapus database dan bootstrap token lokal:

```sh
docker compose -f apps/auth-server/docker-compose.yml down -v
```

Stop the stack without deleting local data with `moon run auth-server:down`.
