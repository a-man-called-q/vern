# Add a web app

A web app is a server-rendered app with sign-in built in. It keeps the user's
tokens in Redis and calls the APIs from its server. Add one when a different
group of people needs its own product surface (customers and back office, for
example). A new screen for the same people is a route in an app that exists.

## Steps

1. **Choose the stack.** `tanstack` (TanStack Start) or `next` (Next.js App
   Router). Both have the same sign-in, sessions, and API calls. Use the one the
   project already uses unless the user asks for the other.
2. **Choose a free port.** Every app has its own. Look at `PORT` in
   `apps/*/.env.example`, `services/*/.env.example`, and `deploy/dev/*/.env.example`. Taken by the stack: 8081 (ZITADEL), 6379 (Redis), 6006
   (Storybook), and 5433 (the data PostgreSQL, when there is one).
3. **Generate it** from the repository root:

   ```sh
   moon generate tanstack -- --name backoffice --port 3001
   ```

   The name is kebab-case and becomes `apps/<name>` and the Moon project name,
   so no API in `services/` or stack in `deploy/dev/` may have it too.
   The demo routes and the sample dashboard are sample code; add
   `--no-include_demos` for an app that is going to ship. It starts from an empty
   dashboard in a working sidebar shell: add a page under `dashboard` and an item
   to `navGroups` in `src/components/dashboard-nav.tsx`.
4. **Choose its API**, only when the workspace has more than one Axum API: set
   `API_APP=<api name>` in the new app's `.env.example`. With a single API,
   `setup` wires it by itself.
5. **Provision it:**

   ```sh
   bun run setup
   ```

   This creates the app's `.env`, its ZITADEL application (Authorization Code
   with PKCE), a session secret, and `API_BASE_URL`. It keeps everything that
   already exists, so run it after every `moon generate`.
6. **Run it:** `moon run <name>:dev`, then sign in at `http://localhost:<port>`
   as `zitadel-admin@vern.localhost` with `ZITADEL_ADMIN_PASSWORD` from
   `deploy/dev/auth-server/.env`, or as a seeded user (see
   [roles-and-users.md](roles-and-users.md)).
7. **Check it:** `moon run <name>:check` and `moon run <name>:test`.

## Then build on it

- Pages that need a signed-in user, and calls to an API:
  [web-to-api.md](web-to-api.md).
- UI: import shared components from `@vern/ui/components/<name>`. Every shadcn
  component is already in `packages/ui`, so look there before writing one. For
  a form, use `form-tanstack` (TanStack Form) in a TanStack Start app and
  `form-rhf` (React Hook Form) in a Next.js app. Product-specific components
  stay in the app's `src/components`.
- A generated app is small. Sign-in (`packages/web-auth`) and the frame around
  the pages (`packages/app-shell`: the dashboard's sidebar and header, the
  public pages' header and footer, the theme toggle) are shared by every web
  app, and a fix there reaches all of them. The app holds what is its own:
  `src/server/auth.server.ts` binds sign-in to the app's ID,
  `src/components/dashboard-nav.tsx` lists the dashboard's pages, and the
  layouts pass the app's name, user, and navigation to the shell.
- `src/server/auth.server.ts`, `src/server/api.server.ts`, and the routes under
  `/auth` are the sign-in wiring. Build next to them, not in them.
- A different sidebar, header, or footer for one app is built in that app from
  `@vern/ui`; a change every app should get is made in `packages/app-shell`.
- The app's display name and ID are in `src/lib/site.ts`.

## Things that go wrong

- **`setup` says several APIs were found.** The app has no `API_APP`. Set it and
  run `setup` again.
- **The app starts but cannot find `ZITADEL_ISSUER` or Redis.** It was started
  outside Moon, so the root `.env` was not loaded. Use `moon run <name>:dev`.
- **Signing out of one app signs out the others.** That is single sign-on: they
  share one ZITADEL session. To try another user, sign out first.
- **Deploying a second web app.** `deploy/compose` runs one web app and one
  API; its README ("More apps") shows how to add another. On Kubernetes every
  app is deployed.

## Changing a generator

Every text file in `.vern/templates/<name>/` is rendered by Tera, whatever its
extension. A literal `{{` (common in JSX, `style={{ ... }}`) breaks generation:
name such a file `*.raw` so it is copied as it is. After a template change,
generate an app from it and run that app's `check` and `build`.
