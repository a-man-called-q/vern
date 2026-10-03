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
| `.templates/axum` | Axum API that verifies access tokens through ZITADEL introspection, or with `--worker` a service that serves no API |
| `.templates/postgres` | Optional PostgreSQL for the APIs' own data, one database per API |
| `.templates/bus` | Optional NATS JetStream, the event bus between APIs generated with `--events` |
| `.templates/storage` | Optional S3-compatible object store for uploads, with one bucket |
| `deploy/dev/auth-server` | Local Docker Compose stack: ZITADEL, its Login App, PostgreSQL, Redis, and Mailpit (a local inbox for the email ZITADEL sends) |
| `deploy` | How the product is run, one folder per environment: `dev`, `local`, `staging`, and `prod`, on one server with Docker Compose or on Kubernetes |
| `apps/storybook` | Storybook workbench for the shared UI components |
| `packages/ui` | Shared shadcn components and design tokens (`@vern/ui`) |
| `packages/web-auth` | Sign-in, the session, and API calls as the signed-in user, for every web app (`@vern/web-auth`) |
| `packages/app-shell` | The frame every web app shares: the dashboard's sidebar and header, the public pages' header and footer, the theme toggle (`@vern/app-shell`) |
| `crates/` | What the Axum APIs share, as crates of the Cargo workspace at the root (`Cargo.toml`): the token check, the error type, startup and shutdown, the database pool, and events |
| `scripts/` | Project tools: setup, provisioning, rename, update, and doctor |

Projects are generated from the templates by kind: web apps into
`apps/<name>`, Axum APIs into `services/<name>`, and the PostgreSQL, bus, and
storage stacks into `deploy/dev/<name>`, next to the auth stack. Each app and API has
a production Dockerfile. The web apps keep OAuth tokens on the server in Redis;
the browser only gets an HTTP-only session cookie. Each generated app's README
covers its code and a production checklist.

A generated app or API is thin. What every one of them does the same way is not
copied into it: the web apps import it from `packages/`, and the APIs build with
the crates in `crates/`. A fix made there, here or by `project:update`, reaches
every app of the project; a generated folder holds only what is the app's own.

## Requirements

- Git
- [proto](https://moonrepo.dev/proto), which installs the Moon, Bun, and Rust
  versions pinned in `.prototools`
- Docker with Compose v2, running

```sh
curl -fsSL https://moonrepo.dev/install/proto.sh | bash
```

## Quick start

These steps take a fresh copy to a running TanStack app with sign-in and an
Axum API behind it. Replace the names and ports as you like; every app needs its
own port. The defaults reserve 8081 for ZITADEL, 6379 for Redis, and 6006 for
Storybook.

[create-vern](https://github.com/a-man-called-q/create-vern) copies the latest
release, renames it to your project, starts a new Git history, and installs the
toolchain and dependencies:

```sh
bunx create-vern my-app    # or: npx create-vern my-app, pnpm dlx create-vern my-app
cd my-app
moon generate tanstack -- --name dashboard --port 3000
moon generate axum -- --name api --port 4000
bun run setup
moon run :dev
```

To work from a clone instead, for example to contribute to Vern, install the
toolchain and dependencies yourself. If the clone is the start of your own
product, rename it first (see [Rename and update](#rename-and-update)).

```sh
git clone https://github.com/a-man-called-q/vern.git
cd vern
proto install
bun install
moon generate tanstack -- --name dashboard --port 3000
moon generate axum -- --name api --port 4000
bun run setup
moon run :dev
```

- `moon generate` creates each web app under `apps/` and each API under
  `services/`. Use
  `moon generate next -- --name web --port 3001` for a Next.js app instead of (or
  next to) the TanStack one, and add `--no-include_demos` to leave out the demo
  routes and the sample dashboard: you get a signed-in shell with a working
  sidebar and an empty dashboard page to build on.
- `bun run setup` creates the `.env` files from their examples, starts ZITADEL
  with its Login App, PostgreSQL, and Redis, and creates in ZITADEL the project,
  an OIDC application for each web app (Authorization Code with PKCE, no client
  secret), and an API application with a key for each Axum API. It fills in the
  project ID, client IDs, session secrets, key files, and each web app's
  `API_BASE_URL`: the only API there is, or the one named by `API_APP` in the
  app's `.env` when there are several. An app that calls more lists them in
  `API_APPS` (for example `API_APPS=billing,inventory`) and gets a variable with
  each one's URL (`BILLING_API_URL`). It also creates the project roles listed
  in `roles.json`, and, locally, the test users in `seed-users.json` (see
  [Roles and users](#roles-and-users)). Run it again after generating another
  app; it keeps what already exists.
- `moon run :dev` checks the ports, starts the auth stack, and runs every app
  plus Storybook.

Open <http://localhost:3000> and sign in as `zitadel-admin@vern.localhost` with
the password from `deploy/dev/auth-server/.env` (`Password1!` by default). The ZITADEL
Console is at <http://localhost:8081/ui/console/>. Stop the auth containers
(keeping their data) with `moon run auth-server:down`.

`bun run setup` signs in to ZITADEL as the `vern-setup` service account, whose
token ZITADEL creates when it first sets up its database. A database created
before that account existed needs a reset
(`docker compose --env-file deploy/dev/auth-server/.env -f deploy/dev/auth-server/docker-compose.yml down -v`)
or a token of a service user with the IAM Owner role in `ZITADEL_PAT`.

To manage one app's OIDC application by hand, use
`bun run zitadel:app -- --app <name> --write-env` (`--help` lists the options).
It resets changes made to that application in the Console.

## Data for your APIs

An Axum API that needs a database is generated with `--database`, next to a
PostgreSQL generated from the `postgres` template (it is separate from the one
ZITADEL uses):

```sh
moon generate postgres -- --name data --port 5433
moon generate axum -- --name ads --port 4001 --database
bun run setup
moon run ads:dev    # starts the database first, creating the API's own
```

The API gets sqlx, migrations in `migrations/` that run when it starts, and
`#[sqlx::test]` tests that each use a throwaway database. The
[template README](.templates/README.md#postgresql) and the API's own README
cover the rest, including TLS to a production database.

## Roles and users

Roles say who may do what in your product. List the ones your APIs check in
`roles.json` at the repository root, as plain keys or with a display name and
group:

```json
[
  "publisher",
  { "key": "admin", "displayName": "Administrator", "group": "Staff" }
]
```

`bun run setup` creates the missing roles on the ZITADEL project, locally and
in a deployment. It never changes or deletes a role that exists, so edit or
remove roles in the Console. Grant roles to users in the Console, or from your
product with the service account below. The Axum template reads a user's roles
from the token and offers `require_role("publisher")?` for its handlers (see its
README).

To have someone to sign in as while you build, list local test users in
`seed-users.json` at the repository root, next to `roles.json`:

```json
{
  "adminRoles": ["admin"],
  "users": [
    { "name": "publisher", "givenName": "Demo", "familyName": "Publisher", "roles": ["publisher"] }
  ]
}
```

`bun run setup` then grants `adminRoles` to the admin ZITADEL created
(`zitadel-admin@vern.localhost`) and creates each user as
`<name>@vern.localhost` (the organization's login domain), with its roles. Every
role must be one `roles.json` declares; a mistake stops `setup` before it starts
a container, and `bun run project:doctor` checks the file too.

A product where each company is a ZITADEL organization with several users lists
them under `companies`. Each company becomes an organization that may use the
project roles in its own `roles` (the company's project grant), and its users hold
those roles plus their own:

```json
{
  "companies": [
    {
      "name": "Acme Ads",
      "roles": ["advertiser"],
      "users": [
        { "name": "owner", "givenName": "Ada", "familyName": "Owner", "roles": ["owner"] },
        { "name": "member", "givenName": "Max", "familyName": "Member" }
      ]
    }
  ]
}
```

The users sign in as `<name>@<organization domain>`, such as
`owner@acme-ads.localhost`; `setup` prints the logins it seeded. A token of such a
user carries the organization's ID (the web apps ask for it with the
`urn:zitadel:iam:user:resourceowner` scope), which the Axum template reads as
`AuthenticatedUser::org_id`. A user is in the company that holds their roles;
if a role is granted in the Console from another organization, the user still
belongs to their own.

- **Local only.** It never runs for a deployment (`--compose`, `--kubernetes`), and it is skipped when
  `ZITADEL_ISSUER` is not `localhost`, `127.0.0.1`, or `[::1]`. In production,
  create users and grant roles in the Console or with the service account below.
  `--no-seed` skips it on a local ZITADEL too.
- **The password is yours, not shared.** The seeded users share one password,
  which `setup` generates into `ZITADEL_SEED_PASSWORD` in
  `deploy/dev/auth-server/.env` the first time it creates a user (set it there first to
  choose your own). It is never committed or printed, because the auth stack
  listens on every network interface of your machine.
- **Additive.** A user that already exists is left as it is, password included,
  and only gets the roles it lacks; no role is ever removed. Running `setup` again
  changes nothing.

An admin screen that creates users and grants roles needs a credential, and the
token `setup` signs in with can do everything in ZITADEL, so it must never reach
an app. This command creates a service user that only manages users (the
`ORG_USER_MANAGER` role in the organization, which cannot create projects or
roles) and writes its token to one app's `.env`:

```sh
bun run zitadel:service-account -- --app user-management
```

The token is stored as `ZITADEL_USER_ADMIN_TOKEN`. It manages every user of the
organization and can grant them project roles, so keep it on the server. Running
the command again changes nothing while the token still works; to rotate it,
remove the variable and run it again. For a production ZITADEL, pass an IAM Owner
token and the issuer:
`ZITADEL_PAT=<token> bun run zitadel:service-account -- --app <name> --issuer https://auth.example.com`.
`--help` lists the other options.

A service that signs companies up creates organizations, which no organization
role allows; it needs an instance role. `--instance-role IAM_ORG_MANAGER` grants
it, and `--role none` skips the organization role:

```sh
bun run zitadel:service-account -- --app tenants --name tenants --role none \
  --instance-role IAM_ORG_MANAGER --env-key ZITADEL_ORG_ADMIN_TOKEN
```

That token can create organizations, give them project roles, and create their
users, and it can also create projects, roles, and applications in the default
organization. ZITADEL has no narrower role that creates organizations, so treat
the token like a database password: server only, one service, rotated on a
schedule. It reaches every organization, your customers' included, so the service
takes the organization from the caller's verified token, never from a request.
A local `bun run setup` does this by itself for an Axum API whose `.env.example`
declares `ZITADEL_ORG_ADMIN_TOKEN=`.

## Customize the login page

The sign-in pages are served by the ZITADEL Login App with a Vern shell around
them. Change them at the level you need:

1. **Colors, logo, and font**: ZITADEL's branding settings in the Console, per
   instance or per organization. The shell's buttons and links follow the
   primary color, and an uploaded logo replaces the brand logo. The initial
   colors are the `LABELPOLICY` values in `deploy/dev/auth-server/docker-compose.yml`;
   ZITADEL only applies them when it creates its database.
2. **Text and images of the shell**: edit `deploy/dev/auth-server/brand/`.
   `brand.json` holds the headline, description, highlights, and image paths;
   the SVGs next to it are served under `/brand/`. Changes show on the next page
   load. See the [brand file reference](https://github.com/a-man-called-q/vern-zitadel-login#brand-file).
3. **Layout and components**: edit the Login App source in
   [vern-zitadel-login](https://github.com/a-man-called-q/vern-zitadel-login).
   `npx create-vern login`, run inside your project, clones it next to the
   project as `<slug>-login/`, forks it on GitHub, builds an image, and points
   `deploy/dev/auth-server/.env` at it (`create-vern` offers the same when it creates
   the project). To deploy your login, publish an image from your fork (see its
   README) and set `ZITADEL_LOGIN_IMAGE` to that tag.

## Who can sign up

A new project has no "Sign up" link on the sign-in page: an administrator
creates the accounts, locally from `seed-users.json` and in production in the
Console or from your product. A visitor who registered on their own would get an
account with no roles, which is harmless but not what an admin screen promises.
`ZITADEL_ALLOW_REGISTER` in `deploy/dev/auth-server/.env` (and in a deployment's
settings: `deploy/<environment>/.env` or `settings.env`) holds
the choice, `false` unless you set it to `true`.

ZITADEL reads the variable only when it creates its database, like the initial
colors above. `bun run setup` (and `bun run setup -- --env <environment>`) applies the value
in `.env` to an instance that already exists and changes nothing else in its
login policy. With no value in `.env` it changes nothing, and says so when
sign-up is open. An organization that overrides the login policy in the Console
keeps its own. The Login App caches ZITADEL's settings for 15 minutes, so the
sign-in pages follow a change within that time; restart the `zitadel-login`
container to apply it at once. `bun run project:doctor` shows the current
choice.

## Email

ZITADEL sends mail for invitations (a user created with an email code), email
verification, and password resets. Locally the auth stack's Mailpit container
catches it: a new database starts with ZITADEL pointed at it, and `bun run setup`
does the same for one that predates that, then prints where to read the messages
(<http://localhost:8025> by default). An invitation can be tried end to end: the
link in the mail opens the sign-in pages, where the user verifies the address and
chooses a password. If the Console already has a mail setup for another server,
`setup` leaves it alone.

In production, `SMTP_HOST`, `SMTP_FROM_ADDRESS`, and (when the server asks)
`SMTP_USER` and `SMTP_PASSWORD` in the environment's settings configure it, and
`bun run setup -- --env <environment>` applies them to the running ZITADEL; see
[deploy/README.md](deploy/README.md). `bun run project:doctor` says when none is
set.

## Building with a coding agent

[`AGENTS.md`](AGENTS.md) tells a coding agent (Claude Code, Codex, Cursor, and
others that read the file) what the project already provides, the rules that
keep sign-in and access control intact, and how to check its own work. It points
at short recipes in [`docs/agents/`](docs/agents) for adding a web app, adding an
API service, building inside a service, calling an API from a web app, and roles
and users. Each generated app carries its own `AGENTS.md` for its stack.

Describe your product under **This project** at the end of `AGENTS.md`: what it
is for, which app serves whom, and the decisions you have made. The sections
above it are updated by `bun run project:update`.

## Commands

| Command | What it does |
| --- | --- |
| `bun run setup` | Create the `.env` files and the ZITADEL project, applications, and keys |
| `moon run :dev` | Run every project that has a `dev` task |
| `moon run :build` | Build every project that has a `build` task |
| `moon run :test` | Run every project's tests. The first run downloads Chromium for Storybook's browser tests |
| `moon run <project>:<task>` | Run one task, such as `dashboard:check` or `api:test` |
| `moon run <app>:docker` | Build an app's production image |
| `moon run auth-server:down` | Stop the auth containers and keep their data |
| `moon run workspace:check-ports` | Check that no two services share a port |
| `bun run zitadel:app -- --app <name>` | Create or update an app's ZITADEL application |
| `bun run zitadel:service-account -- --app <name>` | Create a service user that manages users, and store its token in the app's `.env` |
| `bun run project:doctor` | Check the tools, configuration, and ports |
| `bun test scripts` | Test the workspace scripts |

The root `.env` holds shared settings (`ZITADEL_ISSUER`, `ZITADEL_PROJECT_ID`,
`AUTH_HTTP_PORT`, `REDIS_PORT`, `REDIS_URL`); each app's `.env` holds its own
port and credentials, and its values win. All `.env` files are ignored by Git;
the `.env.example` files are committed.

### Shared UI and Storybook

`packages/ui` already holds every shadcn component; import one as
`@vern/ui/components/card`. The form component comes in two versions with the
same parts: `form-tanstack` for TanStack Form, which TanStack Start apps use,
and `form-rhf` for React Hook Form, which Next.js apps use.

When shadcn releases a component that is not there yet, add it from a generated
app so the CLI puts it in `packages/ui`:

```sh
cd apps/dashboard
bunx --bun shadcn@latest add <name>
```

The CLI writes the file in its own style. `moon run ui:check` formats and lints
`packages/ui` with Biome, so format the new file once:
`bunx biome check --write` in `packages/ui`.

Storybook runs at
<http://localhost:6006>; see [its README](apps/storybook/README.md).

## Rename and update

A project created with `create-vern` is already renamed. To rename a clone, set
your product's display name and package slug. A preview is shown by default; add
`--apply` to write the changes:

```sh
bun run project:rename -- --name "Acme Platform" --slug acme-platform --apply
```

The name accepts letters, numbers, spaces, periods, and hyphens. The slug must
be lowercase kebab-case and becomes the UI package scope (`@acme-platform/ui`).
The rename updates text references to Vern (URLs and container images keep
their names) and records the project identity and the Vern commit it started
from in `.vern/config.json`. If Git history cannot identify that commit, pass
it with `--base <sha>`. A checkout that has already started its auth stack
(it has `deploy/dev/auth-server/.env`) needs Docker running for the rename, and its
existing auth volumes must be migrated by hand first. A fresh copy without that
file owns no Docker data, so it is renamed without looking at Docker, whatever
other Vern checkouts have on the machine.

To preview the changes available from Vern's `main` branch:

```sh
bun run project:update
```

Apply them on a new review branch, together with the latest Bun and Rust
package versions (Rust upgrades need `cargo install cargo-edit`):

```sh
bun run project:update -- --apply
```

`npx create-vern update` runs the same script from any folder of the project and
takes the same `--apply` and `--continue` flags.

A project made before the layout of today (APIs in `services/`, the Compose
stacks in `deploy/dev/`, and one folder per environment in `deploy/`) gets it
from its next update. That update still runs the project's old updater, which
brings the new files but cannot move the project's own: the stacks it generated
stay in `infra/` (or `apps/`), with the local `.env` of `auth-server`, and a
deployment's settings stay in `deploy/.env` and `deploy/k8s/overlays/`.
`bun run project:doctor` names each of them, and
`bun run project:update -- --migrate` moves them: the stacks with `git mv`
(local `.env` files and keys go along, and the paths in them are fixed),
`deploy/.env` and `deploy/secrets/` to `deploy/prod/` (to `deploy/local/` when
its hostnames are under `localtest.me`), and each overlay's `settings.env` and
`generated/` to `deploy/prod/` or `deploy/local/`. When the update stops on a
conflict, `bun run project:update -- --continue` does the same once the
conflicts are resolved. A file of the old layout that you changed yourself
(`deploy/docker-compose.yml`, a brand file of the old `auth-server`) stays where
it is, for you to carry over to its new place and delete. Docker keeps the
volumes: no Compose project changes its name. A rename no longer touches
`scripts/`, which merges as Vern ships it.

The updater needs a clean working tree, so commit the rename and your changes
first. Generated app source is not synchronized, but its dependency manifests
are upgraded. The TanStack packages are pinned in the templates, because
`@tanstack/react-start` depends on one exact `@tanstack/react-router`; the
updater moves them together and keeps the router on the version Start uses, so
do the same when you bump them by hand. If a conflict or a failed check stops the update, fix it on the
review branch and run `bun run project:update -- --continue`. Review the diff
and merge it yourself. An update that fails before it has merged the files
undoes its review branch, and can be applied again.

The updater that runs is the project's own copy, from its last update. An older
one stops with `git merge-file failed for <file>:`, and nothing after the colon,
when one file conflicts in two or more places, and leaves a review branch that
neither `--apply` nor `--continue` accepts. Discard it (replace `main` with the
branch you were on):

```sh
git reset --hard && git clean -fd && git switch main && git branch -D vern/update-<sha>
```

Then, in `scripts/project/merge.ts` (`scripts/update-project.ts` in an older
project), change `result.status > 1` to `result.status > 127` and
`result.status === 1` to `result.status > 0`, commit, and apply the update
again.

### Edits an update asks for

The update upgrades each generated app's packages but not its source, so an
upgrade that changes a package's types stops at `moon run :check`. Make the
edit on the review branch and run `bun run project:update -- --continue`.

- **`redis` 6** (`Promise<RedisClientType<…>>` is not assignable, then
  `'client' is possibly 'undefined'`). In each web app's
  `src/server/session-record.server.ts` (`src/server/session.server.ts` in an
  older app; an app generated since has no such file, the code is in
  `packages/web-auth`), take the client's type from the call that creates it:

  ```ts
  function newRedisClient(url: string) {
  	return createClient({ url });
  }
  type RedisClient = ReturnType<typeof newRedisClient>;
  ```

  and create the client with `newRedisClient(url)` in `getRedisClient`.
- **Shared packages and crates.** Apps and APIs generated before `packages/web-auth`,
  `packages/app-shell`, and `crates/` keep working as they are, each with its
  own copy of that code, which no update reaches. To move one over, generate a
  fresh app or API from the template and carry your own pages, handlers, and
  migrations into it; `docs/agents/new-app.md` and `docs/agents/new-service.md`
  say what a generated folder holds now.
  One thing is not optional for an API: `deploy/compose` and the image workflow
  now build an API from the repository root, with the Cargo workspace. The
  update rewrites the `Dockerfile` and the `docker` task of an older API for
  that (`bun run project:update -- --migrate` does only this). If you had
  changed them, it names the file and leaves it: copy `Dockerfile` and
  `Dockerfile.dockerignore` from `.templates/axum/`, put the API's name where
  the template has `{{ name | kebab_case }}`, and in `moon.yml` make the
  `docker` task run `docker build -f services/<name>/Dockerfile -t <name> .`
  with `runFromWorkspaceRoot: true`. Then run `cargo check` once and commit the
  `Cargo.lock` at the root.
- **Biome 2.5** reports each app's `biome.json` as out of date. These are
  notes, not failures; `bunx biome migrate --write` in the app's folder brings
  the file up to date.
- **The logos, on the update that moves the auth stack to `deploy/dev/`.** That
  update runs the project's old updater, which writes
  `deploy/dev/auth-server/brand/logo-light.svg` and `logo-dark.svg` without
  fitting the product's name to the logo's width. Restore the fitted ones from
  the old folder, with the branch you were on in place of `main`:

  ```sh
  git show main:apps/auth-server/brand/logo-light.svg > deploy/dev/auth-server/brand/logo-light.svg
  git show main:apps/auth-server/brand/logo-dark.svg > deploy/dev/auth-server/brand/logo-dark.svg
  ```

  (`infra/auth-server/` when the stack was there.)

## Deploy

[`deploy/`](deploy/README.md) says how the product is run, with one folder per
environment:

| Folder | Runs |
| --- | --- |
| `deploy/dev` | What the apps depend on while you develop (ZITADEL, Redis, and the stacks you generate); the apps themselves run from source |
| `deploy/local` | The whole product on your machine, as a rehearsal of production |
| `deploy/staging` | The whole product, to try a change before production |
| `deploy/prod` | Production |

`local`, `staging`, and `prod` each run in one of two ways, and an environment
folder holds only its own settings.

[`deploy/compose`](deploy/compose/README.md) runs ZITADEL, one web app, and one
API on a single server with Docker, behind Traefik with Let's Encrypt
certificates. After you set three hostnames in `deploy/prod/.env`, one command
generates the secrets, creates the ZITADEL project and applications, and starts
everything:

```sh
bun run setup -- --compose prod
```

`bun run setup -- --compose local` runs the same stack on your machine with
local certificates and no settings to fill in; CI signs in through it on every
change.

For several web apps and APIs, or replicas, [`deploy/base`](deploy/base/README.md)
runs the product on Kubernetes with Kustomize: every app gets its own manifests
and HTTPS hostname, and `bun run setup -- --kubernetes prod` creates them all
in ZITADEL. `deploy/staging` is an overlay on the same base with its own
hostnames, namespace, and Secrets, and `deploy/local` runs it on a kind cluster
on your machine (`deploy/local/local-cluster.sh`).

Once an environment is set up, `moon run deploy:staging` and
`moon run deploy:prod` (or `bun run setup -- --env <environment>`) run it again
the same way, after a change to the apps or the settings. For other platforms, build the images with
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
