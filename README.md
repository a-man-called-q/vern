# Vern

A Moon monorepo template for web apps that sign users in with
[ZITADEL](https://zitadel.com): TanStack Start and Next.js dashboards, Rust Axum
APIs, a shared shadcn UI package, and a local ZITADEL + Redis stack to develop
against.

## What's inside

| Path | Purpose |
| --- | --- |
| `.templates/tanstack` | TanStack Start app with OIDC sign-in, Redis sessions, and server-side API calls |
| `.templates/next` | Next.js App Router app with the same sign-in, sessions, and API calls |
| `.templates/axum` | Axum API that verifies access tokens through ZITADEL introspection |
| `apps/auth-server` | Docker Compose stack: ZITADEL, its Login App, PostgreSQL, and Redis |
| `apps/storybook` | Storybook workbench for the shared UI components |
| `packages/ui` | Shared shadcn components and design tokens (`@vern/ui`) |
| `scripts/` | Project tools: provisioning, rename, update, and doctor |

Apps are generated from the templates into `apps/<name>`. The web apps keep
OAuth tokens on the server in Redis; the browser only gets an HTTP-only session
cookie. Each generated app's README covers its code and a production checklist.

## Requirements

- [proto](https://moonrepo.dev/proto), which installs the Moon, Bun, and Rust
  versions pinned in `.prototools`
- Docker with Compose v2

```sh
curl -fsSL https://moonrepo.dev/install/proto.sh | bash
```

## Quick start

These steps take a fresh copy to a running TanStack app with sign-in and an
Axum API behind it. Replace the names and ports as you like; every app needs its
own port. The defaults reserve 8081 for ZITADEL, 6379 for Redis, and 6006 for
Storybook.

### 1. Install the tools and dependencies

```sh
proto install
bun install
cp .env.example .env
cp apps/auth-server/.env.example apps/auth-server/.env
```

If you started from this template for your own product, rename it now (see
[Rename and update](#rename-and-update)).

### 2. Start ZITADEL

```sh
moon run auth-server:dev
```

This starts ZITADEL, its Login App, PostgreSQL, and Redis in the background.
Open the Console at <http://localhost:8081/ui/console/> and sign in with the
admin account from `apps/auth-server/.env` (by default
`zitadel-admin@vern.localhost` / `Password1!`).

### 3. Create a project

In the Console, create a project for your apps and copy its ID into
`ZITADEL_PROJECT_ID` in the root `.env`. All apps in this workspace share it.

### 4. Create a service user for provisioning

The `zitadel:app` command creates each app's OIDC application for you. It needs
a token:

1. Create a service user and add a personal access token to it.
2. Make the service user a manager of the project with the **Project Owner** role.
3. Keep the token in your shell (`export ZITADEL_PAT=...`) or in a file outside
   the repository (`--pat-file`). Do not put it in a `.env` file: Moon passes
   `.env` values to every task.

### 5. Generate apps

```sh
moon generate tanstack -- --name dashboard --port 3000
moon generate axum -- --name api --port 4000
```

Use `moon generate next -- --name web --port 3001` for a Next.js app instead of
(or next to) the TanStack one. Add `--no-include_demos` to a web app to leave out
the demo routes.

### 6. Configure the apps

```sh
cp apps/dashboard/.env.example apps/dashboard/.env
cp apps/api/.env.example apps/api/.env
```

In `apps/dashboard/.env`, set `SESSION_SECRET` to the output of
`openssl rand -base64 32` and `API_BASE_URL` to `http://localhost:4000`.

Then create the dashboard's OIDC application and store its client ID:

```sh
bun run zitadel:app -- --app dashboard --write-env
```

The command configures Authorization Code with PKCE (no client secret), refresh
tokens, and the callback URLs derived from the app's `APP_URL`. It is safe to
run again: it brings an existing application back to these settings, so changes
made in the Console are reset. Add `--dry-run` to only print the configuration.

The Axum API authenticates to ZITADEL with its own key: create an API
application with a JSON key as described in `apps/api/README.md`.

### 7. Run everything

```sh
moon run :dev
```

Moon checks the ports, starts the auth stack, and runs every app plus
Storybook. Open <http://localhost:3000> and sign in. Stop the auth containers
(keeping their data) with `moon run auth-server:down`.

## Customize the login page

The sign-in pages are served by the ZITADEL Login App with a Vern shell around
them. Change them at the level you need:

1. **Colors, logo, and font**: ZITADEL's branding settings in the Console, per
   instance or per organization. The shell's buttons and links follow the
   primary color, and an uploaded logo replaces the brand logo. The initial
   colors are the `LABELPOLICY` values in `apps/auth-server/docker-compose.yml`;
   ZITADEL only applies them when it creates its database.
2. **Text and images of the shell**: edit `apps/auth-server/brand/`.
   `brand.json` holds the headline, description, highlights, and image paths;
   the SVGs next to it are served under `/brand/`. Changes show on the next page
   load. See the [brand file reference](https://github.com/a-man-called-q/vern-zitadel-login#brand-file).
3. **Layout and components**: fork
   [vern-zitadel-login](https://github.com/a-man-called-q/vern-zitadel-login),
   publish your own image, and set `ZITADEL_LOGIN_IMAGE` in
   `apps/auth-server/.env`.

## Commands

| Command | What it does |
| --- | --- |
| `moon run :dev` | Run every project that has a `dev` task |
| `moon run :build` | Build every project that has a `build` task |
| `moon run <project>:<task>` | Run one task, such as `dashboard:check` or `api:test` |
| `moon run auth-server:down` | Stop the auth containers and keep their data |
| `moon run workspace:check-ports` | Check that no two services share a port |
| `bun run zitadel:app -- --app <name>` | Create or update an app's ZITADEL application |
| `bun run project:doctor` | Check the tools, configuration, and ports |
| `bun test scripts` | Test the workspace scripts |

The root `.env` holds shared settings (`ZITADEL_ISSUER`, `ZITADEL_PROJECT_ID`,
`AUTH_HTTP_PORT`, `REDIS_PORT`, `REDIS_URL`); each app's `.env` holds its own
port and credentials, and its values win. All `.env` files are ignored by Git;
the `.env.example` files are committed.

### Shared UI and Storybook

Add shadcn components from a generated app so the CLI puts shared primitives in
`packages/ui`:

```sh
cd apps/dashboard
bunx --bun shadcn@latest add card
```

Import them as `@vern/ui/components/card`. Storybook runs at
<http://localhost:6006>; see [its README](apps/storybook/README.md).

## Rename and update

Set your product's display name and package slug. A preview is shown by
default; add `--apply` to write the changes:

```sh
bun run project:rename -- --name "Acme Platform" --slug acme-platform --apply
```

The name accepts letters, numbers, spaces, periods, and hyphens. The slug must
be lowercase kebab-case and becomes the UI package scope (`@acme-platform/ui`).
The rename updates text references to Vern (URLs and container images keep
their names) and records the project identity and the Vern commit it started
from in `.vern/config.json`. If Git history cannot identify that commit, pass
it with `--base <sha>`. Renaming the auth Compose project needs Docker running;
existing auth volumes must be migrated by hand first.

To preview the changes available from Vern's `main` branch:

```sh
bun run project:update
```

Apply them on a new review branch, together with the latest Bun and Rust
package versions (Rust upgrades need `cargo install cargo-edit`):

```sh
bun run project:update -- --apply
```

The updater needs a clean working tree, so commit the rename and your changes
first. Generated app source is not synchronized, but its dependency manifests
are upgraded. If a conflict or a failed check stops the update, fix it on the
review branch and run `bun run project:update -- --continue`. Review the diff
and merge it yourself.

## Production

Vern does not include deployment recipes yet. Before deploying a generated app,
work through the production checklist in its README: HTTPS origins, a
separate ZITADEL application per environment, an authenticated TLS Redis, and a
secret manager for `SESSION_SECRET`. For ZITADEL itself, follow ZITADEL's
[self-hosting guide](https://zitadel.com/docs/self-hosting/deploy/overview) or
use ZITADEL Cloud, and run the Login image from `apps/auth-server/.env.example`
at the same version as the backend. To provision an app in another
environment, run `zitadel:app` with that environment's `ZITADEL_ISSUER`,
`ZITADEL_PROJECT_ID`, and `APP_URL`.

## License

Vern is released under the [MIT License](LICENSE).

The auth stack runs ZITADEL and the
[Vern Login image](https://github.com/a-man-called-q/vern-zitadel-login) as
separate containers; this repository contains none of their source. ZITADEL is
licensed under AGPL-3.0, with its Login App and client packages under MIT (see
ZITADEL's
[LICENSING.md](https://github.com/zitadel/zitadel/blob/main/LICENSING.md)).
