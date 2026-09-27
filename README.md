# Vern

Developer templates for TanStack Start apps, an Axum API, a shared React UI
package, and a local ZITADEL development stack. Moon tasks generate apps from
the templates and run their development servers.

## Components

| Path | Description |
| --- | --- |
| `.templates/tanstack` | TanStack Start + React BFF with OIDC login, Redis sessions, and server-side API calls |
| `.templates/axum` | Rust API that validates ZITADEL access tokens through introspection |
| `apps/auth-server` | Docker Compose stack for local ZITADEL Login V2 |
| `apps/storybook` | Storybook workbench for shared UI components |
| `packages/ui` | Shared shadcn components, utilities, and design tokens |

The BFF keeps OAuth tokens server-side; the browser receives only an HTTP-only
session cookie. Axum protects API routes and verifies tokens with ZITADEL.

## Requirements

- Moon 2.5.5 (pinned in `.prototools`) and `cargo-generate` 0.23 or newer
- Bun and Rust (versions are pinned in `.prototools`)
- Docker Compose and Redis for local development

## Quick start

From the repository root, generate the applications:

```sh
moon run gen:dashboard -- --name dashboard
moon run gen:process -- --name process
```

`dashboard` generates TanStack; `process` generates Axum. The names can be
changed, and Moon discovers each generated project through its `moon.yml`.
TanStack apps are created in `apps/<name>`, while Axum APIs are created at the
repository root. Install all Bun workspace dependencies from the repository
root:

```sh
bun install
```

TanStack demos are included by default; omit them with:

```sh
moon run gen:dashboard -- --name dashboard --define include_demos=false
```

Generated application source is part of the repository and can be committed.
`.gitignore` excludes dependency folders, build output, and local environment
files.

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

- [TanStack setup](.templates/tanstack/README.md.liquid)
- [Axum setup](.templates/axum/README.md.liquid)
- [Auth server](apps/auth-server/README.md)

Use the same ZITADEL project for the web app and its APIs. For the local stack,
set `ZITADEL_ISSUER=http://localhost:8081`. TanStack also needs
`ZITADEL_CLIENT_ID`, `ZITADEL_PROJECT_ID`, `SESSION_SECRET`, `REDIS_URL`, and
`API_BASE_URL`. Axum needs `ZITADEL_PROJECT_ID` and a downloaded API key file.

After configuring each generated app, run its development server from the
repository root. The TanStack task installs workspace dependencies before
starting:

```sh
moon run process:dev
```

```sh
moon run dashboard:dev
```

For a dashboard generated with `--name my-dashboard`, run
`moon run my-dashboard:dev`. The same applies to an API generated with
`--name my-api`: run `moon run my-api:install` to fetch Rust dependencies, or
`moon run my-api:dev` to start it. To install dependencies for every generated
project, run `moon run :install`.

Or start both example servers together with
`moon run process:dev dashboard:dev`.

## API routes

- `GET /healthz` — public health check
- `GET /api/me` — protected route; returns the verified subject

See the generated READMEs for development commands and production configuration.

## Storybook

Run the shared component workbench with `moon run storybook:dev` or
`bun run storybook` from `apps/storybook`. Add shadcn components from a
generated TanStack app so the CLI routes shared primitives into `packages/ui`:

```sh
cd apps/dashboard
bunx --bun shadcn@latest add card
```

Import shared components with paths such as
`@vern/ui/components/button`; app-specific components stay inside each app.
See [the Storybook README](apps/storybook/README.md) for setup and agent skills.
