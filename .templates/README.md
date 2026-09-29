# Moon generators

This directory contains the Moon code generation templates. Every template
creates a project under `apps/<name>` and requires an explicit, unique local port.

## TanStack

```sh
moon generate tanstack -- --name dashboard --port 3000
```

Demo routes and examples are included by default. Omit them with
`--no-include_demos`.

## Next.js

```sh
moon generate next -- --name web --port 3001
```

The same OIDC login, Redis-backed sessions, and server-side API calls as the
TanStack template, built on the Next.js App Router. Demo routes and examples
are included by default; omit them with `--no-include_demos`.

## Axum

```sh
moon generate axum -- --name process --port 4000
```

After generation, copy the app's `.env.example` to `.env`, configure ZITADEL,
and run the workspace with `moon run :dev`. Moon checks that app, ZITADEL,
Redis, and Storybook ports do not conflict before starting the local stack.
