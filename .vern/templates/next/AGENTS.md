<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# {{ name | kebab_case }}: a Next.js web app

Read [`../../AGENTS.md`](../../AGENTS.md) first. Before protecting a page or
calling an API, read
[`../../.vern/agents/web-to-api.md`](../../.vern/agents/web-to-api.md).

- **Sign-in is done, and shared.** The flow, the session, and the token
  refresh are in `../../packages/web-auth`, which every web app uses.
  `src/server/auth.server.ts` binds it to this app (`createWebAuth`), and the
  Route Handlers under `src/app/auth` call it. Build next to them, not in them,
  and do not copy the package's code here.
- **The frame is shared too.** The dashboard's sidebar and header and the
  public pages' header and footer come from `../../packages/app-shell`; the
  layouts pass it this app's name, user, and navigation.
- **Server code is in `src/server`.** A new module there imports `server-only`,
  so a client component that imports it fails the build.
- **API calls** go through `fetchAuthenticatedApi`, wrapped in one module per
  API (`src/server/<api>.server.ts`). Browser code never calls an API and never
  sees a token.
- **A page that needs a user** calls `requireUser()` in its Server Component.
  Reading the session never sets cookies; only the `/auth` Route Handlers do.
- **Changes** (create, update, delete) are Server Actions that call the server
  module.
- **UI** comes from `@vern/ui/components/<name>`. Every shadcn component is
  already there; for a form, use `form-rhf` (React Hook Form).
{% if include_demos %}- **Demo files** (`src/app/(site)/demo`, files named `demo-*`) are samples and
  can be deleted.
{% endif %}- **The dashboard shell** is `src/app/dashboard/layout.tsx` (sidebar and header).
  A new page goes in `src/app/dashboard/<name>/page.tsx`, starts with
  `await requireUser()`, and gets an item in `navGroups` in
  `src/components/dashboard-nav.tsx`.

Check your work from the repository root:

```sh
moon run {{ name | kebab_case }}:check {{ name | kebab_case }}:test
```

`moon run {{ name | kebab_case }}:dev` starts ZITADEL and Redis first and loads
the shared settings; `bun run dev` alone misses them.
