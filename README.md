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
| `apps/auth-server` | Local Docker Compose stack: ZITADEL, its Login App, PostgreSQL, and Redis |
| `deploy` | Production Docker Compose stack for one server, with HTTPS |
| `apps/storybook` | Storybook workbench for the shared UI components |
| `packages/ui` | Shared shadcn components and design tokens (`@vern/ui`) |
| `scripts/` | Project tools: setup, provisioning, rename, update, and doctor |

Apps are generated from the templates into `apps/<name>`, each with a
production Dockerfile. The web apps keep OAuth tokens on the server in Redis;
the browser only gets an HTTP-only session cookie. Each generated app's README
covers its code and a production checklist.

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

```sh
proto install
bun install
moon generate tanstack -- --name dashboard --port 3000
moon generate axum -- --name api --port 4000
bun run setup
moon run :dev
```

If you started from this template for your own product, rename it first (see
[Rename and update](#rename-and-update)).

- `moon generate` creates each app under `apps/`. Use
  `moon generate next -- --name web --port 3001` for a Next.js app instead of (or
  next to) the TanStack one, and add `--no-include_demos` to leave out the demo
  routes.
- `bun run setup` creates the `.env` files from their examples, starts ZITADEL
  with its Login App, PostgreSQL, and Redis, and creates in ZITADEL the project,
  an OIDC application for each web app (Authorization Code with PKCE, no client
  secret), and an API application with a key for each Axum API. It fills in the
  project ID, client IDs, session secrets, key files, and `API_BASE_URL` when
  there is one API. Run it again after generating another app; it keeps what
  already exists.
- `moon run :dev` checks the ports, starts the auth stack, and runs every app
  plus Storybook.

Open <http://localhost:3000> and sign in as `zitadel-admin@vern.localhost` with
the password from `apps/auth-server/.env` (`Password1!` by default). The ZITADEL
Console is at <http://localhost:8081/ui/console/>. Stop the auth containers
(keeping their data) with `moon run auth-server:down`.

`bun run setup` signs in to ZITADEL as the `vern-setup` service account, whose
token ZITADEL creates when it first sets up its database. A database created
before that account existed needs a reset
(`docker compose --env-file apps/auth-server/.env -f apps/auth-server/docker-compose.yml down -v`)
or a token of a service user with the IAM Owner role in `ZITADEL_PAT`.

To manage one app's OIDC application by hand, use
`bun run zitadel:app -- --app <name> --write-env` (`--help` lists the options).
It resets changes made to that application in the Console.

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
| `bun run setup` | Create the `.env` files and the ZITADEL project, applications, and keys |
| `moon run :dev` | Run every project that has a `dev` task |
| `moon run :build` | Build every project that has a `build` task |
| `moon run <project>:<task>` | Run one task, such as `dashboard:check` or `api:test` |
| `moon run <app>:docker` | Build an app's production image |
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

## Deploy

[`deploy/`](deploy/README.md) runs ZITADEL, one web app, and one API on a single
server with Docker, behind Traefik with Let's Encrypt certificates. After you
set three hostnames in `deploy/.env`, one command generates the secrets,
creates the production ZITADEL project and applications, and starts
everything:

```sh
bun run setup -- --deploy
```

The same stack runs on your machine with local certificates, which CI uses to
sign in through it on every change. For other platforms, build the images with
`moon run <app>:docker` and run them with the settings from the app's README
and its production checklist. For more on running ZITADEL itself, see ZITADEL's
[self-hosting guide](https://zitadel.com/docs/self-hosting/deploy/overview).

## License

Vern is released under the [MIT License](LICENSE).

The auth stack runs ZITADEL and the
[Vern Login image](https://github.com/a-man-called-q/vern-zitadel-login) as
separate containers; this repository contains none of their source. ZITADEL is
licensed under AGPL-3.0, with its Login App and client packages under MIT (see
ZITADEL's
[LICENSING.md](https://github.com/zitadel/zitadel/blob/main/LICENSING.md)).
