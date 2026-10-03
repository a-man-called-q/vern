# services

One folder per Axum API, made by `moon generate axum -- --name <name> --port <port>`
(see [docs/agents/new-service.md](../docs/agents/new-service.md)). Every folder
here is a member of the Cargo workspace at the repository root and builds with
the crates in [`crates/`](../crates), which hold what the APIs share.

Keep this file: Cargo refuses a workspace whose `services/*` matches nothing,
which is the case until the first API is generated.
