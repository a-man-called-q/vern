# Vern

A Moon-based monorepo template for TanStack dashboards, Rust Axum services,
shared React UI, and a local ZITADEL + Redis development stack.

## Projects

| Path | Purpose |
| --- | --- |
| `.templates/tanstack` | TanStack Start BFF with OIDC login, Redis sessions, and server-side API calls |
| `.templates/axum` | Axum API that verifies access tokens through ZITADEL introspection |
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

Generate an Axum API and a TanStack app. Choose a distinct local port for every
project; the examples reserve 8081 for ZITADEL, 6379 for Redis, and 6006 for
Storybook.

```sh
moon generate axum -- --name process --port 4000
moon generate tanstack -- --name dashboard --port 3000
```

Copy the generated app environment files and fill in the ZITADEL client/key
details and session secret:

```sh
cp apps/process/.env.example apps/process/.env
cp apps/dashboard/.env.example apps/dashboard/.env
```

To omit the TanStack demo routes, add `--no-include_demos` to its generate
command. The default includes the demos.

The root `.env` holds shared local settings such as `ZITADEL_ISSUER`,
`ZITADEL_PROJECT_ID`, `AUTH_HTTP_PORT`, `REDIS_PORT`, and `REDIS_URL`. Each app's
`.env` holds its own port and credentials. Project values override shared ones.
All `.env` files are ignored by Git; the examples are committed.

## Rename and update a project

After using Vern as a project starter, set the project display name and package
slug. A preview is shown by default; add `--apply` to make the changes:

```sh
bun run project:rename -- --name "Acme Platform" --slug acme-platform --apply
```

The name accepts letters, numbers, spaces, periods, and hyphens. The slug must
be lowercase kebab-case and is used as the shared UI package scope
(`@acme-platform/ui`). The rename updates textual brand references and records
the project identity and last-synced Vern commit in `.vern/config.json`. If Git
history does not identify the starting Vern commit, pass its upstream SHA with
`--base <sha>`. Renaming the auth Compose project requires Docker to be running;
existing auth volumes must be migrated manually first.

Check the local tools, project configuration, and port assignments with:

```sh
bun run project:doctor
```

To preview files available from the configured upstream's `main` branch:

```sh
bun run project:update
```

Apply an update on a new review branch, including latest Bun and Rust package
versions:

```sh
bun run project:update -- --apply
```

Generated app source is not synchronized from the upstream templates. Its
dependency manifests can still be upgraded. Rust upgrades require
[`cargo-edit`](https://github.com/killercup/cargo-edit); install it with
`cargo install cargo-edit`. If a file conflict or validation failure interrupts
an update, resolve the reported issue on the review branch and resume with:

```sh
bun run project:update -- --continue
```

Review the resulting diff and merge it yourself when it is ready.
Commit the rename and local project changes before applying an update; the
updater requires a clean working tree.

## Run and build

Run every project that defines `dev`:

```sh
moon run :dev
```

Moon validates configured ports and starts ZITADEL, PostgreSQL, and Redis in
the background before it runs the TanStack app, Axum API, and Storybook. Stop the
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

The TanStack app keeps OAuth tokens server-side in Redis; the browser receives
only an HTTP-only session cookie. Axum validates bearer tokens through
ZITADEL. Configure the TanStack app's `API_BASE_URL` to the generated Axum API's
port to enable the protected server-to-server `/api/me` request.

## API routes

- `GET /healthz` — public health check
- `GET /api/me` — protected route; returns the verified subject

## Storybook

Storybook is available at <http://localhost:6006>. Add shadcn components from a
generated TanStack app so the CLI routes shared primitives into `packages/ui`:

```sh
cd apps/dashboard
bunx --bun shadcn@latest add card
```

Import shared components with paths such as `@vern/ui/components/button`.
See [the Storybook README](apps/storybook/README.md) for details.
