# Vern

A Moon-based monorepo template for TanStack dashboards, Rust Axum services,
shared React UI, and a local ZITADEL + Redis development stack.

## Projects

| Path | Purpose |
| --- | --- |
| `.templates/dashboard` | TanStack Start BFF with OIDC login, Redis sessions, and server-side API calls |
| `.templates/service` | Axum API that verifies access tokens through ZITADEL introspection |
| `apps/auth-server` | Docker Compose stack for local ZITADEL, PostgreSQL, and Redis |
| `apps/storybook` | Storybook workbench for shared UI components |
| `packages/ui` | Shared shadcn components and design tokens |

Moon generates application projects under `apps/`. The generated `moon.yml`
files make them available to workspace commands automatically.

## Requirements

- Moon 2.5.5, Bun, and Rust (versions are pinned in `.prototools`)
- Docker Compose

## First setup

Copy the shared and infrastructure environment examples:

```sh
cp .env.example .env
cp apps/auth-server/.env.example apps/auth-server/.env
```

Generate a service and a dashboard. Choose a distinct local port for every
project; the examples reserve 8081 for ZITADEL, 6379 for Redis, and 6006 for
Storybook.

```sh
moon generate service -- --name process --port 4000
moon generate dashboard -- --name dashboard --port 3000
```

Copy the generated app environment files and fill in the ZITADEL client/key
details and session secret:

```sh
cp apps/process/.env.example apps/process/.env
cp apps/dashboard/.env.example apps/dashboard/.env
```

To omit the dashboard demo routes, add `--no-include_demos` to its generate
command. The default includes the demos.

The root `.env` holds shared local settings such as `ZITADEL_ISSUER`,
`ZITADEL_PROJECT_ID`, `AUTH_HTTP_PORT`, `REDIS_PORT`, and `REDIS_URL`. Each app's
`.env` holds its own port and credentials. Project values override shared ones.
All `.env` files are ignored by Git; the examples are committed.

## Run and build

Run every project that defines `dev`:

```sh
moon run :dev
```

Moon validates configured ports and starts ZITADEL, PostgreSQL, and Redis in
the background before it runs the dashboard, service, and Storybook. Stop the
infrastructure containers while keeping their data with:

```sh
moon run auth-server:down
```

Build every project that defines `build`:

```sh
moon run :build
```

The source-only UI package participates through its typecheck. To run one
project, use its Moon target, such as `moon run dashboard:dev` or
`moon run process:build`. Check ports separately with
`moon run workspace:check-ports`.

The dashboard keeps OAuth tokens server-side in Redis; the browser receives
only an HTTP-only session cookie. Axum validates bearer tokens through
ZITADEL. Configure the dashboard's `API_BASE_URL` to the generated service's
port to enable the protected server-to-server `/api/me` request.

## API routes

- `GET /healthz` — public health check
- `GET /api/me` — protected route; returns the verified subject

## Storybook

Storybook is available at <http://localhost:6006>. Add shadcn components from a
generated dashboard so the CLI routes shared primitives into `packages/ui`:

```sh
cd apps/dashboard
bunx --bun shadcn@latest add card
```

Import shared components with paths such as `@vern/ui/components/button`.
See [the Storybook README](apps/storybook/README.md) for details.
