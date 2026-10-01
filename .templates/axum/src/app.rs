use axum::{Json, Router, extract::Extension, middleware, routing::get};
use serde::Serialize;
use tower_http::trace::TraceLayer;

use crate::auth::{AppState, AuthenticatedUser, require_bearer};
{% if database %}use crate::notes;
{% endif %}
#[derive(Serialize)]
struct HealthResponse {
    status: &'static str,
}

#[derive(Serialize)]
struct MeResponse {
    sub: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    roles: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    org_id: Option<String>,
}

async fn healthz() -> Json<HealthResponse> {
    Json(HealthResponse { status: "ok" })
}

async fn api_me(Extension(user): Extension<AuthenticatedUser>) -> Json<MeResponse> {
    Json(MeResponse {
        sub: user.sub,
        name: user.display_name,
        roles: user.roles.into_iter().collect(),
        org_id: user.org_id,
    })
}

pub fn router(state: AppState) -> Router {
{% if database %}    let protected_routes = Router::new()
        .route("/api/me", get(api_me))
        .route("/api/notes", get(notes::list).post(notes::create))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            require_bearer,
        ));
{% else %}    let protected_routes =
        Router::new()
            .route("/api/me", get(api_me))
            .route_layer(middleware::from_fn_with_state(
                state.clone(),
                require_bearer,
            ));
{% endif %}
    Router::new()
        .route("/healthz", get(healthz))
        .merge(protected_routes)
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}
