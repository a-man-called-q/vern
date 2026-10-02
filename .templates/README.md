# Moon generators

This directory contains the Moon code generation templates. Every template
creates a project under `apps/<name>` and requires an explicit, unique local port.

`web-base` is not generated on its own: it holds the files the TanStack and
Next.js templates share, and both extend it. Change a shared file there once; a
file in `tanstack/` or `next/` at the same path replaces the shared one.

## TanStack

```sh
moon generate tanstack -- --name dashboard --port 3000
```

Demo routes and examples are included by default. Omit them with
`--no-include_demos` and the app starts from a minimal signed-in shell: a
sidebar with working links, a header with the app name, a menu with only "Sign
out", and an empty dashboard page, with no sample data. Its `package.json` lists
only what that shell imports: the libraries the demos use (tables, charts, forms,
drag and drop, toasts) are left out.

In both web templates, a dependency that only a demo imports goes inside the
`{% if include_demos %}` block at the top of `dependencies` in
`package.json.tera`. `bun test scripts` generates each template with and without
demos and fails on a dependency nothing imports, or an import that is not listed.

## Next.js

```sh
moon generate next -- --name web --port 3001
```

The same OIDC login, Redis-backed sessions, and server-side API calls as the
TanStack template, built on the Next.js App Router. Demo routes and examples
are included by default; omit them with `--no-include_demos` for the same
minimal shell.

## Axum

```sh
moon generate axum -- --name process --port 4000
```

An API that the TanStack and Next.js apps call with the signed-in user's access
token. It verifies the token through ZITADEL introspection, and offers roles
(`require_role`) and JSON errors (`ApiError`) to its handlers.

Add `--database` for an API that keeps its data in PostgreSQL: sqlx, embedded
migrations, a `#[sqlx::test]` example, and the `db/init.sql` that gives it its
own database. It needs the data project below.

```sh
moon generate axum -- --name ads --port 4001 --database
```

Add `--events` (with `--database`) for an API that tells other APIs what changed
and hears from them, over NATS JetStream: an `outbox` table written in the same
transaction as the data, a relay that publishes it, and durable consumers. It
needs the bus project below.

```sh
moon generate axum -- --name inventory --port 4002 --database --events
```

## PostgreSQL

```sh
moon generate postgres -- --name data --port 5433
moon run data:up
```

A PostgreSQL for the data of your Axum APIs, apart from the one ZITADEL uses.
`data:up` starts it and creates the database and login role of every API
generated with `--database`. Name the project `data`: the APIs' `dev` and
`test` tasks start it as `data:up`, and their `.env.example` points at port
5433.

## Bus

```sh
moon generate bus -- --name bus --port 4222
moon run bus:up
```

A local NATS server with JetStream, the event bus between the APIs. Name the
project `bus`: an API generated with `--events` starts it as `bus:up` and its
`.env.example` points at port 4222.

## Storage

```sh
moon generate storage -- --name storage --port 9000
moon run storage:up
```

A local S3-compatible object store (SeaweedFS) with one bucket (`media` unless
you pass `--bucket`), for the API that handles uploads. Browsers upload to it
with presigned URLs; the web apps' origins are listed in `S3_ALLOWED_ORIGINS`.

After generation, create the app's `.env` and its ZITADEL application as the
[quick start](../README.md#quick-start) describes, then run the workspace with
`moon run :dev`. Moon checks that app, ZITADEL, Redis, and Storybook ports do
not conflict before starting the local stack.
