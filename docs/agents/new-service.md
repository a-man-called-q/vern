# Add an API service

A service is an Axum API under `services/<name>`. It accepts the access token of a
signed-in user, verifies it with ZITADEL, and gives each handler the verified
user and their roles. A generated service is small: its startup, its routes, and
its resources. The token check, the error type, startup, the database pool, and
events are in the crates of `crates/`, which every service builds with.

## A new service, or a module in one that exists?

Default to one service per domain: a part of the product with its own data and
its own rules (billing, catalog, bookings). A new resource in a domain that
already has a service is a new module there
([service-engineering.md](service-engineering.md)), not a new service. Every
service adds a port, a ZITADEL application, a key, a database, and an image to
deploy, so add one when the data and rules are really separate, and say so to
the user when the choice is not obvious. A service that only works in the
background is a [worker](#a-worker-a-service-with-no-api).

There is no users service. Users, passwords, and role grants live in ZITADEL.
A service stores the user's ID (`sub`) next to the rows that user owns.

## Steps

1. **Choose a free port and a new name.** See `PORT` in
   `apps/*/.env.example`, `services/*/.env.example`, and `deploy/dev/*/.env.example`;
   the convention is 4000 and up for APIs. The name must not be taken in any of
   the three folders.
2. **If it stores data**, the workspace needs the data project once. Check for
   `deploy/dev/data`; when it is missing:

   ```sh
   moon generate postgres -- --name data --port 5433
   ```

   Keep the name `data` and the port 5433: the APIs' tasks start it as
   `data:up`, and their `.env.example` points at that port. It is separate from
   ZITADEL's own PostgreSQL, which no service may use.
3. **Generate the service** from the repository root:

   ```sh
   moon generate axum -- --name billing --port 4001 --database
   ```

   Leave out `--database` for a service that keeps no data. With it, the service
   gets sqlx, `migrations/`, `db/init.sql` (its own database and login role,
   named after the service), and example `/api/notes` endpoints.
   Add `--events` for a service that tells other services what changed or hears
   from them. It sends events over NATS JetStream through an outbox table, and
   needs the bus project once (`moon generate bus -- --name bus --port 4222`).
   The service's README, section "Events", explains the `svc-events` crate.
   A service that keeps uploaded files needs the storage project once
   (`moon generate storage -- --name storage --port 9000`): an S3-compatible
   store with one bucket, whose settings the project's README lists for the
   service's `.env`.
4. **Provision it:**

   ```sh
   bun run setup
   ```

   This creates the service's `.env`, its ZITADEL API application, and the key
   in `services/<name>/secrets/` that it uses to verify tokens.
5. **Point a web app at it.** With one API in the workspace, `setup` already
   did. With several, a web app keeps the API it had. To move one to the new
   service, set `API_APP=<name>` in that web app's `.env.example` (and its
   `.env`, when that exists), empty `API_BASE_URL` in its `.env`, and run
   `bun run setup` again.
6. **Run and check it:**

   ```sh
   moon run billing:dev     # starts ZITADEL and the database first
   curl http://localhost:4001/healthz
   moon run billing:check billing:test
   ```

   The first build adds the service to `Cargo.lock` at the repository root:
   commit that change with the service, so its image builds with the versions
   you tested.

7. **Replace the example.** `src/notes.rs` and `migrations/0001_init.sql` show
   the pattern. Turn them into the service's first real resource, following
   [service-engineering.md](service-engineering.md). Edit `0001_init.sql` in
   place only while it has never been deployed.

## A worker: a service with no API

Work that no user asks for directly (handling the events other services
publish, a job on a schedule) goes in a worker, not behind an endpoint:

```sh
moon generate axum -- --name ingest --port 4100 --database --events --worker
bun run setup
moon run ingest:dev
```

A worker answers only `/healthz` on its port, for a probe. It verifies no token,
so `setup` creates its `.env` and nothing in ZITADEL: no application, no key,
and no `ZITADEL_*` lines in its `.env.example`, which is how the scripts tell it
from an API. On Kubernetes it gets a Deployment with its database and bus
settings, and no Service or Ingress; `deploy/compose` does not run workers.
`--database` and `--events` mean what they mean for an API. With `--events`,
`src/events.rs` is the example handler: it records the ID of each event it
handled, because an event can be delivered twice.

A worker has no caller. When its work concerns a user or a company, it takes the
`sub` or `org_id` from the event or the row, which the API that wrote it took
from a verified token. Never add an endpoint to a worker: a request from a user
belongs in an API.

An existing service that kept the `ZITADEL_*` lines only to be set up and
deployed becomes a worker by removing them from its `.env.example` and `.env`,
and the key mount from its `k8s/deployment.yaml`.

## A web app that calls two services

`fetchAuthenticatedApi` uses `API_BASE_URL`, one API. For more, list the other
Axum apps in `API_APPS` in the web app's `.env.example` (comma-separated, for
example `API_APPS=billing,inventory`) and run `bun run setup`: it gives each a
variable with its URL (`BILLING_API_URL`, `INVENTORY_API_URL`) and keeps one you
set by hand. Make a client for each in the server module of that API:

```ts
// src/server/billing.server.ts
import { createApiClient } from "./api.server";

const fetchBillingApi = createApiClient("BILLING_API_URL");
```

`fetchBillingApi(path, init)` works like `fetchAuthenticatedApi`. The same access
token works for every service of the project. The variable is `<APP>_API_URL`,
with the app's name in capitals and non-letters as `_` (`billing-api` becomes
`BILLING_API_API_URL`). In a deployment, set the variable to the API's public
HTTPS address; `deploy/compose` runs one API.

## A service that calls another service

Forward the caller's own bearer token. Both services verify tokens against the
same ZITADEL project, so it is valid there, and the second service applies its
own role and ownership rules to the real user. Do not create a shared secret or
a super-user token between services. `reqwest` is in the workspace: add
`reqwest = { workspace = true }` to the service's `Cargo.toml`, keep the calls
in one module (`src/<other>_client.rs`), and give the request a timeout. When a
second service makes the same calls, move the module to a crate in `crates/`.

## Things that go wrong

- **The service stops at startup** with a missing environment variable or an
  unreadable key file. `bun run setup` was not run after `moon generate`.
- **`401` for a signed-in user.** The service's `ZITADEL_PROJECT_ID` is not the
  project the web app signs in to. `bun run setup` writes the right one.
- **`503 Token verification is unavailable`.** The service cannot reach ZITADEL
  or its key is stale (ZITADEL's database was reset). Run `bun run setup`.
- **`could not connect to the database`.** The service was started outside
  Moon. `moon run <name>:dev` runs `data:up` first.
- **`Connection refused` in a test that uses Redis or ZITADEL.** Nothing
  started the auth stack for it. Add `- 'auth-server:up'` to the `deps` of the
  `test` task in the service's `moon.yml`, as `data:up` is there for the
  database.
- **Deploying a second service.** `deploy/compose` runs one web app and one
  API; its README ("More apps") shows how to add another. On Kubernetes every
  service is deployed.
