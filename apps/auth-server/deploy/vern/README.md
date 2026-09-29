# Vern auth server runtime

Source lengkap ZITADEL `v4.19.2` berada langsung di `apps/auth-server/`. UI Vern hanya mengubah Login App di `apps/login`; API, Console, issuer, dan protokol autentikasi tetap mengikuti ZITADEL upstream.

Konfigurasi runtime milik Vern disimpan di `apps/auth-server/deploy/vern/`. Berkas Compose tetap menjalankan API, PostgreSQL, Redis, proxy, dan Login App terpisah. Hanya image Login yang dapat diganti melalui `ZITADEL_LOGIN_IMAGE`.

## Jalankan lokal

Dari root repo Vern:

```sh
cp apps/auth-server/.env.example apps/auth-server/.env
moon run auth-server:dev
```

Buka login di <http://localhost:8081/>, Console di <http://localhost:8081/ui/console/>, dan issuer di <http://localhost:8081>. Set `AUTH_HTTP_PORT` di `apps/auth-server/.env` bila port 8081 sudah dipakai. Jika database sudah diinisialisasi dengan domain/port berbeda, ubah **Default settings → Features → Login V2 → Base URI** di Console.

Username dan password admin berasal dari `apps/auth-server/.env`; nilai `FIRSTINSTANCE` hanya digunakan ketika database pertama dibuat. Jangan commit `.env`.

## Login App dan image

Login App sumber berada di `apps/auth-server/apps/login` dan memakai workspace pnpm ZITADEL. Di desktop, tampilan memakai layout dua kolom dengan branding Vern; di layar kecil layout berubah menjadi satu kolom. Komponen autentikasi ZITADEL tetap menangani login, MFA/passkey, IdP, registrasi, pemulihan, dan OIDC.

Sinkronisasi source upstream dilakukan melalui PR di repo Vern dengan merge tag upstream tanpa squash. Setelah PR disetujui dan digabung, workflow membangun serta menerbitkan image publik ke `ghcr.io/a-man-called-q/vern-zitadel-login`, dengan tag immutable berisi versi ZITADEL dan commit source. Workflow tidak menggabungkan PR atau men-deploy otomatis.

Tambahkan repository secret `ZITADEL_UPSTREAM_SYNC_TOKEN` sebelum mengaktifkan workflow sinkronisasi. Gunakan fine-grained token untuk repo Vern dengan izin **Contents: read and write** dan **Pull requests: read and write**. Token ini diperlukan agar PR otomatis memicu pemeriksaan CI.

Pada publikasi pertama, ubah visibility package GHCR menjadi **Public** di pengaturan package GitHub. Catatan image dari setiap publikasi berisi tag, digest, versi upstream, dan commit source di ringkasan serta artifact workflow.

Untuk staging/production, set `ZITADEL_VERSION` dan `ZITADEL_LOGIN_IMAGE` ke pasangan yang telah diuji. Simpan tag dan digest image sebelumnya untuk rollback. Jangan menaikkan versi backend tanpa image Login dari versi upstream yang sama. Image resmi menjadi fallback lokal selama custom image belum tersedia.

Sebelum mengubah image deployment, jalankan acceptance di staging dengan backend dan Login App pada versi yang sama. Pastikan alur OIDC authorization-code + PKCE kembali ke dashboard Vern dan logout berhasil; kredensial salah serta kode/tautan kedaluwarsa menampilkan error yang benar; metode aktif seperti MFA/passkey dan IdP, registrasi, serta pemulihan akun tetap berfungsi; dan API serta Console tetap dapat diakses. Tinjau tampilan desktop dan mobile, lalu catat tag, digest, dan image rollback.

## Tes acceptance Login

Pasang dependencies Login App dan workspace yang dibutuhkannya dari root source dengan `pnpm install --frozen-lockfile --filter @zitadel/login...`, siapkan konfigurasi acceptance di `apps/auth-server/apps/login/.env.test.local`, lalu seed ZITADEL sesuai petunjuk `apps/auth-server/apps/login/acceptance/setup/` bila menjalankan suite upstream penuh. Jalankan stack dan smoke suite Vern dari root repo Vern:

```sh
moon run auth-server:test-login
```

Task tersebut menunggu Compose sehat, memeriksa endpoint Login, lalu menjalankan Playwright acceptance suite terhadap URL lokal.

Smoke suite Vern memakai port host 80 agar router berbasis host cocok dengan browser. Pastikan port tersebut kosong sebelum menjalankannya; Redis test memakai port 26379 dan dapat diganti dengan `AUTH_LOGIN_TEST_REDIS_PORT`.

## Reset data lokal

Perintah berikut menghapus database dan bootstrap token lokal:

```sh
docker compose --env-file .env -f deploy/vern/docker-compose.yml down -v
```

`moon run auth-server:down` menghentikan stack tanpa menghapus volume.
