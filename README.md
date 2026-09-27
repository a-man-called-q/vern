# Vern

Developer templates for a TanStack Start BFF, an Axum API, and a local ZITADEL
development stack. Moon tasks generate apps from the templates and run their
development servers.

## Components

| Path | Description |
| --- | --- |
| `templates/tanstack` | TanStack Start + React BFF with OIDC login, Redis sessions, and server-side API calls |
| `templates/axum` | Rust API that validates ZITADEL access tokens through introspection |
| `apps/auth-server` | Docker Compose stack for local ZITADEL Login V2 |

The BFF keeps OAuth tokens server-side; the browser receives only an HTTP-only
session cookie. Axum protects API routes and verifies tokens with ZITADEL.

## Requirements

- Moon 2.5.5 (pinned in `.prototools`) and `cargo-generate` 0.23 or newer
- Bun and Rust (versions are pinned in `.prototools`)
- Docker Compose and Redis for local development

## Quick start

From the repository root, generate the applications:

```sh
moon run root:generate-tanstack -- --name my-dashboard
moon run root:generate-axum -- --name my-api
```

The development tasks expect these directory names. TanStack demos are included
by default; omit them with:

```sh
moon run root:generate-tanstack -- --name my-dashboard --define include_demos=false
```

Generated app directories are local and ignored by Git.

Start the local dependencies:

```sh
cd apps/auth-server
cp .env.example .env
docker compose up -d --wait
```

In another terminal, start Redis:

```sh
docker run --name vern-redis -p 6379:6379 -d redis:7-alpine
```

ZITADEL is available at <http://localhost:8081>; the Console is at
<http://localhost:8081/ui/console/>. Admin credentials are configured in
`apps/auth-server/.env`.

## Configure and run

Copy each generated project's `.env.example` to `.env`, then follow its
template README to create the ZITADEL applications and keys:

- [TanStack setup](templates/tanstack/README.md.liquid)
- [Axum setup](templates/axum/README.md.liquid)
- [Auth server](apps/auth-server/README.md)

Use the same ZITADEL project for the web app and its APIs. For the local stack,
set `ZITADEL_ISSUER=http://localhost:8081`. TanStack also needs
`ZITADEL_CLIENT_ID`, `ZITADEL_PROJECT_ID`, `SESSION_SECRET`, `REDIS_URL`, and
`API_BASE_URL`. Axum needs `ZITADEL_PROJECT_ID` and a downloaded API key file.

After configuring each generated app, run its development server from the
repository root. The TanStack task installs Bun dependencies before starting:

```sh
moon run root:dev-axum
```

```sh
moon run root:dev-tanstack
```

Or start both servers together with `moon run root:dev-axum root:dev-tanstack`.

## API routes

- `GET /healthz` — public health check
- `GET /api/me` — protected route; returns the verified subject

See the generated READMEs for development commands and production configuration.
