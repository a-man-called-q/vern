# Build inside an API service

How to add an endpoint, a table, or a rule to an Axum service so that it looks
like the code already there. The example to copy is `src/notes.rs` of a service
generated with `--database`: one resource, with its types, handlers, and tests
in one file.

## Where things go

| File | Holds | Change it? |
| --- | --- | --- |
| `src/main.rs` | Startup: settings, the database pool, the listener, `mod` lines | Only to add a `mod` or a startup setting |
| `src/app.rs` | The router. Every route of the service is listed here | Yes, one line per route |
| `src/<resource>.rs` | One resource: request and response types, handlers, tests | Yes, this is where the work is |
| `src/error.rs` | `ApiError`, the only error a handler returns | Add a variant when a new status is needed |
| `src/auth.rs`, `src/config.rs` | Token verification, `AuthenticatedUser`, roles | No. Build on them |
| `src/db.rs` | The pool, and applying migrations at startup | Rarely |
| `migrations/` | The schema, one numbered SQL file per change | Add files; never edit one that has shipped |
| `db/init.sql` | Creates the service's local database and role | No |

Keep a resource in one module until it is hard to read, then split it by
resource, not by layer. Do not add repository traits, a service layer, or a
generic CRUD helper before a second caller needs one: handlers that hold their
own SQL are easy to read, test, and change.

## Add an endpoint

1. **Schema first**, when the endpoint needs new data. Add
   `migrations/000N_<what>.sql`. It is embedded in the binary and applied when
   the service starts.
   - Rows that belong to a user get `owner_sub text NOT NULL`, the ZITADEL user
     ID. There is no users table to reference.
   - Put the rule in the database when the database can hold it: `NOT NULL`,
     `CHECK`, `UNIQUE`, foreign keys, an exclusion constraint for "no two
     overlapping". Two requests racing cannot both pass a constraint; they can
     both pass an `if` in a handler.
   - Add the index the list query needs.
2. **Types.** A `Deserialize` struct for the request body and a `Serialize`
   struct (with `sqlx::FromRow`) for the response. Never return a row type that
   carries columns the caller should not see.
3. **Handler**, in this order:

   ```rust
   pub async fn create(
       Extension(user): Extension<AuthenticatedUser>,
       Extension(pool): Extension<PgPool>,
       Json(new): Json<NewInvoice>,
   ) -> Result<(StatusCode, Json<Invoice>), ApiError> {
       user.require_role("accountant")?;              // 1. may this caller do it? (403)
       let amount = validate_amount(new.amount)?;     // 2. is the input valid? (400)
       let invoice = sqlx::query_as::<_, Invoice>(    // 3. do it, limited to the caller's rows
           "INSERT INTO invoices (owner_sub, amount) VALUES ($1, $2) \
            RETURNING id, amount, created_at",
       )
       .bind(&user.sub)
       .bind(amount)
       .fetch_one(&pool)
       .await
       .map_err(database_error)?;
       Ok((StatusCode::CREATED, Json(invoice)))
   }
   ```

4. **Route.** Add it to `protected_routes` in `src/app.rs`, under `/api/`, and
   add `mod <resource>;` to `src/main.rs`. A path parameter is written
   `/api/invoices/{id}`. A route outside `protected_routes` is public: put one
   there only on purpose, next to `/healthz`.
5. **Tests**, in the same file (see below).
6. **The web side.** When a web app reads the endpoint, update its types and
   calls in the same change ([web-to-api.md](web-to-api.md)).

## Rules

- **Who the caller is comes only from `AuthenticatedUser`.** Never take a user
  ID, an owner, or a role from the request body, the path, or a header.
- **Role, then ownership.** `user.require_role("x")?` answers 403.
  `user.has_role("x")` is the check that does not fail, for "admins see all,
  others see their own". Then limit every query with `WHERE owner_sub = $1` or
  the product's own ownership rule.
- **Someone else's row is `NotFound`**, the same answer as a row that does not
  exist, so an ID cannot be probed.
- **Handlers return `ApiError`.** It renders `{"error":{"code","message"}}` with
  the right status. The message of `BadRequest`, `Forbidden`, and `NotFound` is
  shown to users, so write it for them. Database and upstream failures are
  logged with `tracing::error!` and returned as `ApiError::Internal`, which
  hides the cause (`database_error` in `notes.rs`).
- **Validate at the edge.** Trim, bound lengths, and check ranges in the handler
  before the query, and answer `BadRequest` with what is wrong. The database
  constraint is the second line, not the error message.
- **Lists are bounded.** Every list query has an `ORDER BY` and a `LIMIT`; add
  paging when the product needs more.
- **Queries use sqlx's runtime API** (`sqlx::query_as::<_, T>(...)` with
  `.bind`), not the `query!` macros, so the service and its image build without
  a database. Always bind values; never format them into the SQL string.
- **Several writes that belong together run in one transaction**
  (`pool.begin()`, then `commit()`).
- **A new setting** is read from the environment once at startup, added to
  `.env.example`, and missing means the service refuses to start, as
  `src/main.rs` does for `PORT`.
- **New roles** go in `roles.json` first ([roles-and-users.md](roles-and-users.md)).

## Tests

Tests live in the module they test, under `#[cfg(test)]`. They do not need
ZITADEL: build a small router with the handlers and put the user in by hand,
as the tests in `notes.rs` do.

```rust
fn app(pool: &PgPool, sub: &str, roles: &[&str]) -> Router {
    let user = AuthenticatedUser {
        sub: sub.to_owned(),
        display_name: None,
        roles: roles.iter().map(|role| role.to_string()).collect(),
    };
    Router::new()
        .route("/api/invoices", get(list).post(create))
        .layer(Extension(user))
        .layer(Extension(pool.clone()))
}

#[sqlx::test]
async fn an_invoice_is_listed_for_its_owner(pool: PgPool) { /* ... */ }
```

`#[sqlx::test]` gives each test its own throwaway database with `migrations/`
applied, so tests do not see each other's rows and need no cleanup.

Cover, for each endpoint:

- the happy path, asserting the status and the body;
- invalid input (400);
- a caller without the role (403);
- a caller asking for another user's row (404, and the row is unchanged);
- the rule the endpoint exists to enforce (the overlap, the limit, the state
  change that is not allowed).

## Before calling it done

```sh
cargo fmt                              # in apps/<service>
moon run <service>:check <service>:test
```

Then, when a web app uses the endpoint, sign in locally and try it once as a
user with the role and once as a user without it
([roles-and-users.md](roles-and-users.md) creates both).
