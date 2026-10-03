//! The router of an API: what is public, and what needs a signed-in user.

use axum::{Json, Router, extract::Extension, middleware, routing::get};
use serde::Serialize;
use svc_http::health::healthz;
use tower_http::trace::TraceLayer;

use crate::{AppState, AuthenticatedUser, require_bearer};

#[derive(Serialize)]
struct MeResponse {
    sub: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    roles: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    org_id: Option<String>,
}

/// Who the API takes the caller for: what a web app shows as "signed in as", and
/// the first thing to ask when a token is refused.
async fn api_me(Extension(user): Extension<AuthenticatedUser>) -> Json<MeResponse> {
    Json(MeResponse {
        sub: user.sub,
        name: user.display_name,
        roles: user.roles.into_iter().collect(),
        org_id: user.org_id,
    })
}

/// The whole router of an API: `/healthz`, the `public` routes (each has its own
/// check, or needs none), and the `protected` ones with `/api/me`, behind
/// `require_bearer`. A handler of a protected route gets a verified
/// `AuthenticatedUser`.
pub fn api_router(
    public: Router<AppState>,
    protected: Router<AppState>,
    state: AppState,
) -> Router {
    let protected =
        protected
            .route("/api/me", get(api_me))
            .route_layer(middleware::from_fn_with_state(
                state.clone(),
                require_bearer,
            ));

    Router::new()
        .route("/healthz", get(healthz))
        .merge(public)
        .merge(protected)
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}
