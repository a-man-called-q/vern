# {{ name | kebab_case }}: an Axum API service

Read [`../../AGENTS.md`](../../AGENTS.md) first. Before adding an endpoint, read
[`../../.vern/agents/service-engineering.md`](../../.vern/agents/service-engineering.md).

- **Routes** are listed in `src/app.rs`. A route under `protected` gets a
  verified `AuthenticatedUser`; a route under `public` is open to anyone.
- **One module per resource** in `src/<resource>.rs`: types, handlers, and tests
  together.{% if database %} `src/notes.rs` is the example to copy and then replace.{% endif %}
- **The `svc-*` crates in `../../crates/` are shared by every API**: `svc-auth`
  verifies tokens, `svc-http` has `ApiError`, `svc-boot` starts and stops the
  service{% if database %}, `svc-db` connects to the database{% endif %}{% if events %}, `svc-events` sends and receives events{% endif %}. Build on
  `AuthenticatedUser`, `require_role`, and `has_role`; do not change how tokens
  are checked, and do not copy a crate's code into this service.
- **Handlers return `ApiError`** (`svc_http::ApiError`). Log the cause of a
  failure and answer `ApiError::Internal`; never send a database or upstream
  error to the caller.
- **A new dependency** gets its version in the `Cargo.toml` at the repository
  root (`[workspace.dependencies]`) and `<name> = { workspace = true }` here.
- **The caller is the token.** Never take a user ID, an owner, an organization,
  or a role from the request. `user.org()?` is the caller's company.
{% if database %}- **Schema changes are new files** in `migrations/` (`000N_<what>.sql`),
  applied when the service starts. Never edit one that has shipped.
- **Queries** use `sqlx::query_as` with `.bind`, and are limited to the
  caller's rows.
{% endif %}- **Roles** this service checks are declared in `roles.json` at the repository
  root.

Check your work from the repository root:

```sh
moon run {{ name | kebab_case }}:check {{ name | kebab_case }}:test
```

`moon run {{ name | kebab_case }}:dev` starts what the service needs first. Run
`cargo fmt -p {{ name | kebab_case }}` before finishing.
