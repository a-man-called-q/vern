# {{ name | kebab_case }}: a TanStack Start web app

Read [`../../AGENTS.md`](../../AGENTS.md) first. Before protecting a page or
calling an API, read
[`../../docs/agents/web-to-api.md`](../../docs/agents/web-to-api.md).

- **Sign-in is done, and shared.** The flow, the session, and the token
  refresh are in `../../packages/web-auth`, which every web app uses.
  `src/server/auth.server.ts` binds it to this app (`createWebAuth`), and the
  `/auth` routes call it. Build next to them, not in them, and do not copy the
  package's code here.
- **The frame is shared too.** The dashboard's sidebar and header and the
  public pages' header and footer come from `../../packages/app-shell`; the
  root route and `src/routes/dashboard.tsx` pass it this app's name, user, and
  navigation.
- **Server code is in `*.server.ts`.** A route reaches it through a server
  function (`createServerFn`) that imports the `.server` module inside its
  handler, as `src/server/auth.ts` does. A `loader` also runs in the browser, so
  it never imports a `.server` file directly.
- **API calls** go through `fetchAuthenticatedApi`, wrapped in one module per
  API (`src/server/<api>.server.ts`). Browser code never calls an API and never
  sees a token.
- **A page that needs a user** calls `requireUser()` in its server function.
- **Routes** are files in `src/routes`. `src/routeTree.gen.ts` is generated; do
  not edit it.
- **UI** comes from `@vern/ui/components/<name>`. Every shadcn component is
  already there; for a form, use `form-tanstack` (TanStack Form).
{% if include_demos %}- **Demo files** (`src/routes/demo`, files named `demo-*`) are samples and can
  be deleted.
{% endif %}- **The dashboard shell** is `src/routes/dashboard.tsx` (sidebar and header).
  A new page goes in `src/routes/dashboard.<name>.tsx`, loads its data through a
  server function, and gets an item in `navGroups` in
  `src/components/dashboard-nav.tsx`.

Check your work from the repository root:

```sh
moon run {{ name | kebab_case }}:check {{ name | kebab_case }}:test
```

`moon run {{ name | kebab_case }}:dev` starts ZITADEL and Redis first and loads
the shared settings; `bun run dev` alone misses them.
