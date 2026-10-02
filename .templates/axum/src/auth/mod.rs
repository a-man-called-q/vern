//! Verifying the caller's token. `require_bearer` asks ZITADEL about the token
//! (introspection, cached for a short while) and gives the handler an
//! `AuthenticatedUser`: who the caller is, their roles, and their organization.
//!
//! - `claims`: the introspection response and what is read from it.
//! - `user`: `AuthenticatedUser`, with `require_role` and `org`.
//! - `zitadel`: the call to ZITADEL, signed with the API's key.
//! - `cache`: keeps an answer for a short while.
//! - `state`: `AppState`, which holds the introspector.
//! - `middleware`: `require_bearer`.

mod cache;
mod claims;
mod middleware;
mod state;
#[cfg(test)]
mod testing;
mod user;
mod zitadel;

pub use middleware::require_bearer;
pub use state::{AppState, AuthSetupError};
pub use user::AuthenticatedUser;
