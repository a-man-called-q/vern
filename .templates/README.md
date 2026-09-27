# Project templates

This directory contains the reusable project templates maintained by this
repository. TanStack apps are generated into `apps/`; Axum APIs are generated at
the repository root.

## TanStack Start BFF

Generate a project with the demo routes and examples enabled (the default):

```bash
moon run gen:dashboard -- --name my-dashboard
```

To omit the demo routes and their supporting files:

```bash
moon run gen:dashboard -- --name my-dashboard --define include_demos=false
```

TanStack handles browser login and keeps OAuth tokens in Redis. It calls Axum
APIs server-to-server; the browser never receives a bearer token. See
[`tanstack/README.md.liquid`](tanstack/README.md.liquid) for local ZITADEL and
Redis setup.

## Axum API

Generate an API-only project:

```bash
moon run gen:process -- --name my-api
```

Axum validates bearer access tokens through ZITADEL introspection using its own
Private Key JWT application key. See
[`axum/README.md.liquid`](axum/README.md.liquid) for the ZITADEL API app setup.

## Integration test setup

The four TanStack apps and three Axum APIs described during template
verification are temporary test instances only. They are not part of this
repository's permanent application structure. The test setup puts its web and
API applications in one ZITADEL project so the APIs can use the same project
audience; each API still has its own key.
