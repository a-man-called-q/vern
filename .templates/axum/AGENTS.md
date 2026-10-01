# {{ name | kebab_case }}: an Axum API service

Read [`../../AGENTS.md`](../../AGENTS.md) first. Before adding an endpoint, read
[`../../docs/agents/service-engineering.md`](../../docs/agents/service-engineering.md).

- **Routes** are listed in `src/app.rs`. A route under `protected_routes` gets a
  verified `AuthenticatedUser`; a route outside it is public.
- **One module per resource** in `src/<resource>.rs`: types, handlers, and tests
  together.{% if database %} `src/notes.rs` is the example to copy and then replace.{% endif %}
- **`src/auth.rs` and `src/config.rs` verify tokens.** Build on
  `AuthenticatedUser`, `require_role`, and `has_role`; do not change how tokens
  are checked.
- **Handlers return `ApiError`** (`src/error.rs`). Log the cause of a failure
  and answer `ApiError::Internal`; never send a database or upstream error to
  the caller.
- **The caller is the token.** Never take a user ID, an owner, or a role from
  the request.
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
`cargo fmt` in this folder before finishing.
