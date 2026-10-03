use axum::{Json, Router, routing::get};
use serde::Serialize;

#[derive(Serialize)]
pub struct HealthResponse {
    status: &'static str,
}

/// What a load balancer or a probe calls. Public on purpose: it answers while
/// the process can serve requests, whatever the state of what it depends on.
pub async fn healthz() -> Json<HealthResponse> {
    Json(HealthResponse { status: "ok" })
}

/// A router with only `/healthz`, for a process that serves no API (a worker).
pub fn health_router() -> Router {
    Router::new().route("/healthz", get(healthz))
}
