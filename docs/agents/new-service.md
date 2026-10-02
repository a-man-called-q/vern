# Add an API service

A service is an Axum API under `apps/<name>`. It accepts the access token of a
signed-in user, verifies it with ZITADEL, and gives each handler the verified
user and their roles.

## A new service, or a module in one that exists?

Default to one service per domain: a part of the product with its own data and
its own rules (billing, catalog, bookings). A new resource in a domain that
already has a service is a new module there
([service-engineering.md](service-engineering.md)), not a new service. Every
service adds a port, a ZITADEL application, a key, a database, and an image to
deploy, so add one when the data and rules are really separate, and say so to
the user when the choice is not obvious.

There is no users service. Users, passwords, and role grants live in ZITADEL.
A service stores the user's ID (`sub`) next to the rows that user owns.

## Steps

1. **Choose a free port.** See `PORT` in `apps/*/.env.example`; the convention
   is 4000 and up for APIs.
2. **If it stores data**, the workspace needs the data project once. Check for
   `apps/data`; when it is missing:

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
   The service's README, section "Events", explains `src/events.rs`.
   A service that keeps uploaded files needs the storage project once
   (`moon generate storage -- --name storage --port 9000`): an S3-compatible
   store with one bucket, whose settings the project's README lists for the
   service's `.env`.
4. **Provision it:**

   ```sh
   bun run setup
   ```

   This creates the service's `.env`, its ZITADEL API application, and the key
   in `apps/<name>/secrets/` that it uses to verify tokens.
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

7. **Replace the example.** `src/notes.rs` and `migrations/0001_init.sql` show
   the pattern. Turn them into the service's first real resource, following
   [service-engineering.md](service-engineering.md). Edit `0001_init.sql` in
   place only while it has never been deployed.

## A web app that calls two services

`fetchAuthenticatedApi` uses `API_BASE_URL`, one API. For a second one, add a
setting (for example `BILLING_API_URL`) to the web app's `.env.example` and its
`.env`, and write a second helper in a server module the way
`fetchAuthenticatedApi` is written at the end of `src/server/api.server.ts`:

```ts
export async function fetchBillingApi(path: string, init: RequestInit = {}) {
	const baseUrl = env.BILLING_API_URL;
	if (!baseUrl) throw new Error("BILLING_API_URL is required");
	const { dropRevokedSession, getApiAccessToken } = await import("./auth.server");
	return createAuthenticatedApiFetcher({
		baseUrl,
		getAccessToken: getApiAccessToken,
		onUnauthorized: dropRevokedSession,
	})(path, init);
}
```

The same access token works for every service of the project. `setup` does not
fill in this second URL; locally it is `http://localhost:<the service's port>`.

## A service that calls another service

Forward the caller's own bearer token. Both services verify tokens against the
same ZITADEL project, so it is valid there, and the second service applies its
own role and ownership rules to the real user. Do not create a shared secret or
a super-user token between services. `reqwest` is already a dependency; keep
the calls in one module (`src/<other>_client.rs`) and give the request a
timeout.

## Things that go wrong

- **The service stops at startup** with a missing environment variable or an
  unreadable key file. `bun run setup` was not run after `moon generate`.
- **`401` for a signed-in user.** The service's `ZITADEL_PROJECT_ID` is not the
  project the web app signs in to. `bun run setup` writes the right one.
- **`503 Token verification is unavailable`.** The service cannot reach ZITADEL
  or its key is stale (ZITADEL's database was reset). Run `bun run setup`.
- **`could not connect to the database`.** The service was started outside
  Moon. `moon run <name>:dev` runs `data:up` first.
- **Deploying a second service.** `deploy/` runs one web app and one API; its
  README ("More apps") shows how to add another.
