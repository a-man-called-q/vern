use axum::{
    body::Body,
    extract::{Request, State},
    http::{HeaderMap, header},
    middleware::Next,
    response::{IntoResponse, Response},
};

use super::{
    AppState,
    claims::{IntrospectionError, org_id_from_claims, roles_from_claims},
    user::AuthenticatedUser,
};
use crate::error::ApiError;

/// Lets the request through with an `AuthenticatedUser` when ZITADEL vouches for
/// its bearer token: active, from our issuer, for our project, with a subject.
/// Anything else is 401, and 503 when ZITADEL cannot be asked.
pub async fn require_bearer(
    State(state): State<AppState>,
    mut request: Request<Body>,
    next: Next,
) -> Response {
    let Some(token) = bearer_token(request.headers()) else {
        return ApiError::Unauthorized.into_response();
    };

    let claims = match state.0.introspector.introspect(token).await {
        Ok(claims) => claims,
        Err(IntrospectionError::Unavailable) => {
            return ApiError::Unavailable("Token verification is unavailable".to_owned())
                .into_response();
        }
    };

    let valid_claims = claims.active
        && claims.iss.as_deref() == Some(state.0.expected_issuer.as_str())
        && claims
            .aud
            .as_ref()
            .is_some_and(|audience| audience.contains(&state.0.project_id))
        && claims
            .sub
            .as_ref()
            .is_some_and(|subject| !subject.trim().is_empty());
    if !valid_claims {
        return ApiError::Unauthorized.into_response();
    }

    let Some(sub) = claims.sub else {
        return ApiError::Unauthorized.into_response();
    };
    let roles = roles_from_claims(&claims.extra, &state.0.project_id);
    let org_id = org_id_from_claims(&claims.extra);
    request.extensions_mut().insert(AuthenticatedUser {
        sub,
        display_name: claims.name.or(claims.preferred_username),
        roles,
        org_id,
    });
    next.run(request).await
}

fn bearer_token(headers: &HeaderMap) -> Option<&str> {
    let value = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let (scheme, token) = value.split_once(' ')?;
    if !scheme.eq_ignore_ascii_case("bearer")
        || token.is_empty()
        || token.bytes().any(|byte| byte.is_ascii_whitespace())
    {
        return None;
    }
    Some(token)
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use axum::{
        body::{Body, to_bytes},
        http::{Request, StatusCode, header},
    };
    use serde_json::{Value, json};
    use tower::ServiceExt;

    use crate::{
        app::router,
        auth::{
            AppState,
            claims::{Audience, IntrospectionError},
            testing::{active_claims, claims_with, make_state},
        },
    };

    async fn request_me(state: AppState, token: Option<&str>) -> axum::response::Response {
        let app = router(state);
        let mut request = Request::builder()
            .uri("/api/me")
            .body(Body::empty())
            .expect("request is valid");
        if let Some(token) = token {
            request.headers_mut().insert(
                header::AUTHORIZATION,
                format!("Bearer {token}").parse().expect("header is valid"),
            );
        }
        app.oneshot(request).await.expect("router responds")
    }

    #[tokio::test]
    async fn all_four_web_apps_can_call_each_of_three_api_instances() {
        let mut replies = HashMap::new();
        for web_app in 1..=4 {
            replies.insert(
                format!("web-app-{web_app}-access-token"),
                Ok(active_claims(&format!("user-{web_app}"))),
            );
        }

        for api in 1..=3 {
            let api_state = make_state(replies.clone());
            for web_app in 1..=4 {
                let token = format!("web-app-{web_app}-access-token");
                let response = request_me(api_state.clone(), Some(&token)).await;
                assert_eq!(
                    response.status(),
                    StatusCode::OK,
                    "api-{api}, web-{web_app}"
                );
                let body = to_bytes(response.into_body(), usize::MAX)
                    .await
                    .expect("response body is readable");
                let json: Value = serde_json::from_slice(&body).expect("body is JSON");
                assert_eq!(json["sub"], format!("user-{web_app}"));
            }
        }
    }

    #[tokio::test]
    async fn health_check_is_public() {
        let app = router(make_state(HashMap::new()));
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/healthz")
                    .body(Body::empty())
                    .expect("request is valid"),
            )
            .await
            .expect("router responds");
        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn missing_and_inactive_tokens_are_rejected() {
        let state = make_state(HashMap::new());
        let missing = request_me(state.clone(), None).await;
        assert_eq!(missing.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(missing.headers()[header::WWW_AUTHENTICATE], "Bearer");

        let inactive = request_me(state, Some("unknown-token")).await;
        assert_eq!(inactive.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn wrong_issuer_and_wrong_audience_are_rejected() {
        let mut replies = HashMap::new();
        let mut wrong_issuer = active_claims("user");
        wrong_issuer.iss = Some("https://attacker.invalid".to_owned());
        replies.insert("wrong-issuer".to_owned(), Ok(wrong_issuer));
        let mut wrong_audience = active_claims("user");
        wrong_audience.aud = Some(Audience::Single("another-project".to_owned()));
        replies.insert("wrong-audience".to_owned(), Ok(wrong_audience));

        let state = make_state(replies);
        assert_eq!(
            request_me(state.clone(), Some("wrong-issuer"))
                .await
                .status(),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            request_me(state, Some("wrong-audience")).await.status(),
            StatusCode::UNAUTHORIZED
        );
    }

    #[tokio::test]
    async fn introspection_failure_fails_closed_with_service_unavailable() {
        let mut replies = HashMap::new();
        replies.insert(
            "zitadel-down".to_owned(),
            Err(IntrospectionError::Unavailable),
        );
        let response = request_me(make_state(replies), Some("zitadel-down")).await;
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    }

    #[tokio::test]
    async fn me_reports_the_name_and_roles() {
        let mut claims = claims_with(json!({
            "urn:zitadel:iam:org:project:roles": {
                "publisher": { "org-1": "acme.localhost" },
                "admin": { "org-1": "acme.localhost" }
            },
            "urn:zitadel:iam:user:resourceowner:id": "org-1"
        }));
        claims.name = Some("Ada Lovelace".to_owned());
        let mut replies = HashMap::new();
        replies.insert("token".to_owned(), Ok(claims));
        let response = request_me(make_state(replies), Some("token")).await;
        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("response body is readable");
        let json: Value = serde_json::from_slice(&body).expect("body is JSON");
        assert_eq!(json["name"], "Ada Lovelace");
        assert_eq!(json["roles"], json!(["admin", "publisher"]));
        assert_eq!(json["org_id"], "org-1");
    }

    #[tokio::test]
    async fn rejected_tokens_get_the_json_error_body() {
        let response = request_me(make_state(HashMap::new()), None).await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        let body = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("response body is readable");
        let json: Value = serde_json::from_slice(&body).expect("body is JSON");
        assert_eq!(json["error"]["code"], "unauthorized");
    }
}
