//! What every API answers with, whatever it is about:
//!
//! - `error`: `ApiError`, the only error a handler returns.
//! - `health`: `/healthz`, for a load balancer or a probe.

pub mod error;
pub mod health;

pub use error::ApiError;
