# Moon generators

This directory contains the Moon code generation templates. Both templates
create a project under `apps/<name>` and require an explicit, unique local port.

## TanStack

```sh
moon generate tanstack -- --name dashboard --port 3000
```

Demo routes and examples are included by default. Omit them with
`--no-include_demos`.

## Axum

```sh
moon generate axum -- --name process --port 4000
```

After generation, copy the app's `.env.example` to `.env`, configure ZITADEL,
and run the workspace with `moon run :dev`. Moon checks that app, ZITADEL,
Redis, and Storybook ports do not conflict before starting the local stack.
