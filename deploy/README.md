# Deploy

`deploy/docker-compose.yml` runs everything on one server with Docker:

| Service | Serves |
| --- | --- |
| `traefik` | HTTPS for all three hostnames, with Let's Encrypt certificates |
| `zitadel-api`, `zitadel-login`, `auth-server` | ZITADEL and the Vern sign-in pages on `AUTH_DOMAIN` |
| `web` | The web app `apps/$WEB_APP` on `APP_DOMAIN` |
| `api` | The Axum API `services/$API_APP` on `API_DOMAIN` |
| `postgres`, `redis` | ZITADEL's database and the web app's sessions, on an internal network |

The web app sends users' access tokens to the API only over HTTPS, so the API
gets its own hostname. It accepts only tokens that ZITADEL confirms.

## First deployment

On a server with Docker, Bun, and a checkout of your project (with the apps
generated and `bun.lock` committed):

1. Point DNS records for the three hostnames at the server, and open ports 80
   and 443. Let's Encrypt needs both before the first start.
2. Create the settings file and set the first block (hostnames, email, and the
   apps to deploy):

   ```sh
   cp deploy/.env.example deploy/.env
   ```

3. Run:

   ```sh
   bun run setup -- --deploy
   ```

   It generates the missing secrets in `deploy/.env`, starts ZITADEL, waits for
   its certificate, creates the ZITADEL project, the web app's OIDC application,
   and the API's key (in `deploy/secrets/`), then builds and starts the apps.
   It is safe to run again.

Open `https://APP_DOMAIN`. The ZITADEL Console is at
`https://AUTH_DOMAIN/ui/console/`; sign in as the admin that `setup` prints,
with `ZITADEL_ADMIN_PASSWORD` from `deploy/.env`. ZITADEL asks for a new
password on the first sign-in.

The sign-in page has no "Sign up" link: accounts are created in the Console or
from your product. To let visitors register, set `ZITADEL_ALLOW_REGISTER=true`
in `deploy/.env` and run `bun run setup -- --deploy` again; it changes only that
setting of the running ZITADEL's login policy. With the variable missing from
`deploy/.env`, setup leaves the policy as it is and says so when sign-up is open.
The sign-in pages cache ZITADEL's settings for 15 minutes; restart `zitadel-login`
(`docker compose --env-file deploy/.env -f deploy/docker-compose.yml restart zitadel-login`)
to apply a change at once.

ZITADEL sends mail for invitations, email verification, and password resets, and
it needs an SMTP server for that. Set `SMTP_HOST` (with the port) and
`SMTP_FROM_ADDRESS` in `deploy/.env`, plus `SMTP_USER` and `SMTP_PASSWORD` when
the server asks for them, and run `bun run setup -- --deploy` again; it creates
the mail configuration in ZITADEL (described "Vern" in the Console) and sets the
password again on every run, so a rotated password only needs a new run. Without
`SMTP_HOST`, setup changes nothing and warns that no mail is sent, unless the
Console already has a mail setup, which it then leaves alone.

Back up `deploy/.env` in a secret manager: `ZITADEL_MASTERKEY` encrypts data in
the database, and the database is useless without it. Back up the
`postgres-data` volume as well.

## Updates

After pulling new app code, rebuild and restart the apps:

```sh
docker compose --env-file deploy/.env -f deploy/docker-compose.yml up -d --build web api
```

To move to a new ZITADEL release, set `ZITADEL_VERSION` and
`ZITADEL_LOGIN_IMAGE` together (see `infra/auth-server/.env.example`), then run
the same command without service names.

## More apps

The stack deploys one web app and one API. For several of each, or more than
one replica, use [Kubernetes](k8s/README.md): `bun run setup -- --kubernetes
production` provisions every web app and API. For another app, copy the `web` or
`api` service with its own hostname (add it to the `traefik` aliases) and give
it its own ZITADEL application: in the Console, or with `bun run zitadel:app`
and `--issuer https://AUTH_DOMAIN --project <ZITADEL_PROJECT_ID> --app-url https://<hostname>`
(`--help` lists the options). A web app also needs its own `SESSION_SECRET`.

## Try it locally

`docker-compose.local.yml` swaps Let's Encrypt for certificates from a local
certificate authority, so the whole stack runs on your machine. Use hostnames
under `localtest.me`, which resolve to 127.0.0.1, and keep ports 80 and 443
free:

```sh
cp deploy/.env.example deploy/.env
# AUTH_DOMAIN=auth.localtest.me, APP_DOMAIN=app.localtest.me,
# API_DOMAIN=api.localtest.me, ACME_EMAIL=you@localtest.me
deploy/local-certs.sh
export COMPOSE_FILE=deploy/docker-compose.yml:deploy/docker-compose.local.yml
NODE_EXTRA_CA_CERTS=deploy/.local/ca.pem bun run setup -- --deploy
deploy/smoke-test.sh
```

`deploy/smoke-test.sh` signs in from a browser in a container and checks that
the web app reaches the API; CI runs the same steps. Your own browser does not
trust the local authority: import `deploy/.local/ca.pem`, or accept the warning.
Remove the stack with
`docker compose --env-file deploy/.env down -v`.
