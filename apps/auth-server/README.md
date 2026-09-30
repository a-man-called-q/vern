# auth-server

The local identity stack the generated apps sign in against. It runs these
containers from `docker-compose.yml`:

| Service | Image | Role |
| --- | --- | --- |
| `proxy` | Traefik | Routes `http://localhost:8081` to the services below |
| `zitadel-api` | `ghcr.io/zitadel/zitadel` | ZITADEL: OIDC issuer, APIs, and Console |
| `zitadel-login` | [Vern Login](https://github.com/a-man-called-q/vern-zitadel-login) | The sign-in pages (ZITADEL Login V2 with the Vern shell) |
| `auth-server` | nginx | Serves `brand/` under `/brand` and sends `/` to the sign-in page |
| `postgres` | PostgreSQL | ZITADEL's database |
| `redis` | Redis | Session store for the generated web apps |

## Run

From the repository root:

```sh
cp apps/auth-server/.env.example apps/auth-server/.env
moon run auth-server:dev    # start in the background and wait until healthy
moon run auth-server:down   # stop, keeping the data
```

| URL | |
| --- | --- |
| <http://localhost:8081/> | Sign-in page |
| <http://localhost:8081/ui/console/> | Console |
| <http://localhost:8081> | OIDC issuer (`ZITADEL_ISSUER`) |

`AUTH_HTTP_PORT` and `REDIS_PORT` in the root `.env` move the published ports.
The admin account comes from `ZITADEL_ADMIN_USERNAME` and
`ZITADEL_ADMIN_PASSWORD`; sign in as `<username>@<org>.localhost`
(`zitadel-admin@vern.localhost` by default).

The `FIRSTINSTANCE` and `DEFAULTINSTANCE` settings in `docker-compose.yml`
(admin account, organization name, initial branding colors, Login V2 URLs) are
applied only when ZITADEL creates its database. To change them later, use the
Console, or reset the data. If you change the domain or port after the first
start, update **Default settings → Features → Login V2 → Base URI** in the
Console.

## Versions

`ZITADEL_VERSION` and `ZITADEL_LOGIN_IMAGE` in `.env` must name the same
ZITADEL release; change them together. New Login images are published by the
[vern-zitadel-login](https://github.com/a-man-called-q/vern-zitadel-login)
repository, tagged `<zitadel-version>-<commit>`. The stock
`ghcr.io/zitadel/zitadel-login:<ZITADEL_VERSION>` image also works, without the
Vern shell and `brand/`.

## Brand

`brand/brand.json` sets the text and images of the sign-in shell, and the files
next to it are served under `/brand/`. Edits show on the next page load. See
the [brand file reference](https://github.com/a-man-called-q/vern-zitadel-login#brand-file)
and the root README's
[Customize the login page](../../README.md#customize-the-login-page) section.

## Reset local data

This deletes the database and the Login App's bootstrap token:

```sh
docker compose --env-file apps/auth-server/.env -f apps/auth-server/docker-compose.yml down -v
```

Apps provisioned before a reset need `bun run zitadel:app` again, with a new
project ID and service user token.
