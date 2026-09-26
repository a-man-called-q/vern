use axum::{Json, Router, extract::Extension, middleware, routing::get};
use serde::Serialize;
use tower_http::trace::TraceLayer;

use crate::auth::{AppState, AuthenticatedUser, require_bearer};

#[derive(Serialize)]
struct HealthResponse {
    status: &'static str,
}

#[derive(Serialize)]
struct MeResponse {
    sub: String,
}

async fn healthz() -> Json<HealthResponse> {
    Json(HealthResponse { status: "ok" })
}

async fn api_me(Extension(user): Extension<AuthenticatedUser>) -> Json<MeResponse> {
    Json(MeResponse { sub: user.sub })
}

pub fn router(state: AppState) -> Router {
    let protected_routes =
        Router::new()
            .route("/api/me", get(api_me))
            .route_layer(middleware::from_fn_with_state(
                state.clone(),
                require_bearer,
            ));

    Router::new()
        .route("/healthz", get(healthz))
        .merge(protected_routes)
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}
