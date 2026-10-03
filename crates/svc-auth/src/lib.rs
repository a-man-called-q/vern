//! Who is calling an API. `require_bearer` asks ZITADEL about the token
//! (introspection, cached for a short while) and gives the handler an
//! `AuthenticatedUser`: who the caller is, their roles, and their organization.
//!
//! - `config`: the ZITADEL settings, read and checked once at startup.
//! - `claims`: the introspection response and what is read from it.
//! - `user`: `AuthenticatedUser`, with `require_role` and `org`.
//! - `zitadel`: the call to ZITADEL, signed with the API's key.
//! - `cache`: keeps an answer for a short while.
//! - `state`: `AppState`, which holds the introspector.
//! - `middleware`: `require_bearer`.
//! - `routes`: the router of an API, with the check in front of its routes.
//! - `testing` (feature `testing`): a fake ZITADEL for the tests of a service.

mod cache;
mod claims;
pub mod config;
mod middleware;
pub mod routes;
mod state;
#[cfg(any(test, feature = "testing"))]
pub mod testing;
mod user;
mod zitadel;

pub use config::{Config, ConfigError};
pub use middleware::require_bearer;
pub use state::{AppState, AuthSetupError};
pub use user::AuthenticatedUser;
