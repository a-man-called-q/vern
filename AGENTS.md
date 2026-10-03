# Vern: guide for coding agents

Vern is a Moon monorepo for a product whose users sign in with ZITADEL: web
apps (TanStack Start or Next.js) that call Rust Axum APIs. Sign-in, sessions,
token verification, roles, a database tier, and deployment already exist. Build
the product on top of them; do not rebuild them.

## Map

| Path | What it is |
| --- | --- |
| `apps/<name>` | One web app each (TanStack Start or Next.js), generated from `.templates/`, and Storybook. Product code lives here |
| `services/<name>` | One Axum API each, generated from `.templates/axum`. Product code lives here |
| `packages/<name>` | What the web apps share: `ui` (shadcn components and design tokens, `@vern/ui`), `web-auth` (sign-in, the session, and API calls as the user, `@vern/web-auth`), and `app-shell` (the dashboard's sidebar and header, the public pages' header and footer, `@vern/app-shell`) |
| `crates/<name>` | What the APIs share, as crates of the Cargo workspace at the root: `svc-auth` (the token check), `svc-http` (`ApiError`, `/healthz`), `svc-boot` (startup and shutdown), `svc-db` (the database pool), `svc-events` (the outbox and the bus) |
| `.templates/` | The generators behind `moon generate` |
| `scripts/` | Setup, provisioning, doctor, rename, and update |
| `roles.json`, `seed-users.json` | The product's roles, and local test users |
| `deploy/dev/<name>` | What the apps run on while developing, as Compose stacks: `auth-server` (the local ZITADEL and Redis), and the generated `postgres`, `bus`, and `storage`. Configuration only |
| `deploy/local`, `deploy/staging`, `deploy/prod` | One folder per environment that runs the whole product: its settings, and its Kustomize overlay. `deploy/compose` (Docker Compose, one server) and `deploy/base` (Kubernetes) hold what they share; see [deploy/README.md](deploy/README.md) |

## Recipes

Read the one that matches the task before writing code. Each is short.

| The task | Read |
| --- | --- |
| Add a web app | [docs/agents/new-app.md](docs/agents/new-app.md) |
| Add an API service, with or without a database | [docs/agents/new-service.md](docs/agents/new-service.md) |
| Add an endpoint, a table, or a rule to a service | [docs/agents/service-engineering.md](docs/agents/service-engineering.md) |
| Protect a page, or call an API from a web app | [docs/agents/web-to-api.md](docs/agents/web-to-api.md) |
| Add a role, a test user, or a screen that manages users | [docs/agents/roles-and-users.md](docs/agents/roles-and-users.md) |
| Deploy to Kubernetes, or change how an app runs there | [docs/agents/kubernetes.md](docs/agents/kubernetes.md) |

Each generated app also has its own `AGENTS.md` and a README that covers its
code and its production checklist.

## Rules that hold everywhere

1. **Generate, do not copy.** A new app or API comes from `moon generate`,
   followed by `bun run setup`. A hand-copied app has no ZITADEL application, no
   key, and a port that collides. Code two apps or two APIs need goes in a
   package under `packages/` or a crate under `crates/`, not into a second copy:
   a fix there reaches every app that uses it.
2. **Do not write authentication.** No login page, password table, JWT parsing,
   or session library. Users live in ZITADEL; refer to one by `sub`, the ZITADEL
   user ID.
3. **Tokens stay on the server.** A web app calls an API from server code with
   `fetchAuthenticatedApi`. Browser code never holds a token and never calls an
   API directly.
4. **The API decides.** Every endpoint that is not deliberately public sits
   behind `require_bearer`, checks the role with `require_role`, and limits its
   queries to the caller's own rows: `owner_sub` for a user's rows, or `org_id`
   (`user.org()?`) when the users of one company share theirs. Hiding a button in
   a web app is not access control.
5. **Roles are declared, not invented.** A role an API checks is listed in
   `roles.json` and created by `bun run setup`.
6. **`.env` files belong to `setup`.** They are ignored by Git and hold
   generated IDs and secrets. Add a new setting to the app's `.env.example`,
   read it in one place, and fail at startup when it is missing.
7. **Run through Moon.** `moon run <app>:dev` starts what the app depends on and
   loads the shared settings from the root `.env`; an app started another way
   misses them.
8. **Keep the HTTPS guards.** The web apps refuse plain HTTP for `APP_URL`,
   `ZITADEL_ISSUER`, and `API_BASE_URL` in production, because tokens travel over
   those. Do not relax the checks to make something start.

## Commands

| Command | What it does |
| --- | --- |
| `moon generate <tanstack\|next\|axum\|postgres> -- --name <name> --port <port>` | Create `apps/<name>` (a web app), `services/<name>` (an API), or `deploy/dev/<name>` |
| `bun run setup` | Create the `.env` files, ZITADEL applications, keys, roles, and local test users. Safe to run again; needs Docker running |
| `moon run :dev` | Run everything. `moon run <app>:dev` runs one app and what it needs |
| `moon run <app>:check` | Type-check one app (and lint it, for a web app) |
| `moon run <app>:test` | Run one app's tests |
| `bun run project:stack` | Show how each environment runs (Docker Compose, Kubernetes, or none); with `--local`, `--staging`, `--prod`, change it and keep only the files of that way |
| `bun run project:doctor` | Check the tools, configuration, roles, and ports |

## Done means

- `moon run <app>:check` and `moon run <app>:test` pass for every app you
  touched. After a change in `packages/` or `crates/`, that is the package or
  crate itself (`moon run web-auth:check web-auth:test`, `moon run svc-auth:test`)
  and every app or API that uses it.
- A new endpoint has tests for the happy path, bad input, a caller without the
  role, and a caller asking for someone else's data.
- A change to an API response is matched in the web app that reads it, in the
  same change.
- `bun run project:doctor` passes after a change to ports, roles, or `.env`
  examples.
- Nothing from a `.env` file, a `settings.env`, `secrets/`, or `generated/` is
  committed.

## This project

Notes about this product (its domain, the apps and what each is for, decisions
already made) go below this line. Keep the sections above as they are, so
`bun run project:update` can bring in changes to them.
