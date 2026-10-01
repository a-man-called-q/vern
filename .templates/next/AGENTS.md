<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# {{ name | kebab_case }}: a Next.js web app

Read [`../../AGENTS.md`](../../AGENTS.md) first. Before protecting a page or
calling an API, read
[`../../docs/agents/web-to-api.md`](../../docs/agents/web-to-api.md).

- **Sign-in is done.** The Route Handlers under `src/app/auth` and `auth`,
  `session`, `oidc`, `api`, `http`, `log`, and `ttl-cache` under `src/server` are
  its machinery. Build next to them, not in them.
- **Server code is in `src/server`** and imports `server-only`, so a client
  component that imports it fails the build. Keep it that way for new modules.
- **API calls** go through `fetchAuthenticatedApi`, wrapped in one module per
  API (`src/server/<api>.server.ts`). Browser code never calls an API and never
  sees a token.
- **A page that needs a user** calls `requireUser()` in its Server Component.
  Reading the session never sets cookies; only the `/auth` Route Handlers do.
- **Changes** (create, update, delete) are Server Actions that call the server
  module.
- **UI** comes from `@vern/ui/components/<name>`. Add a shadcn component with
  `bunx --bun shadcn@latest add <name>` from this folder.
{% if include_demos %}- **Demo files** (`src/app/(site)/demo`, files named `demo.*`) are samples and
  can be deleted.
{% endif %}
Check your work from the repository root:

```sh
moon run {{ name | kebab_case }}:check {{ name | kebab_case }}:test
```

`moon run {{ name | kebab_case }}:dev` starts ZITADEL and Redis first and loads
the shared settings; `bun run dev` alone misses them.
