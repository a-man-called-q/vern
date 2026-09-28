use std::sync::Arc;

use async_trait::async_trait;
use axum::{
    body::Body,
    extract::{Request, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    middleware::Next,
    response::{IntoResponse, Response},
};
use jsonwebtoken::errors::Error as JwtError;
use serde::Deserialize;
use thiserror::Error;

use crate::config::Config;

const PRIVATE_KEY_JWT_ASSERTION_TYPE: &str =
    "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";

#[derive(Clone)]
pub struct AppState(Arc<AppStateInner>);

struct AppStateInner {
    expected_issuer: String,
    project_id: String,
    introspector: Arc<dyn TokenIntrospector>,
}

impl AppState {
    pub fn from_config(config: Config) -> Self {
        let issuer = config.issuer().to_owned();
        let project_id = config.project_id().to_owned();
        let introspector: Arc<dyn TokenIntrospector> = Arc::new(ZitadelIntrospector { config });
        Self::with_introspector(issuer, project_id, introspector)
    }

    fn with_introspector(
        expected_issuer: String,
        project_id: String,
        introspector: Arc<dyn TokenIntrospector>,
    ) -> Self {
        Self(Arc::new(AppStateInner {
            expected_issuer,
            project_id,
            introspector,
        }))
    }
}

#[derive(Clone, Debug, Error)]
pub enum IntrospectionError {
    #[error("ZITADEL token introspection is unavailable")]
    Unavailable,
}

#[async_trait]
pub trait TokenIntrospector: Send + Sync {
    async fn introspect(&self, token: &str) -> Result<IntrospectionClaims, IntrospectionError>;
}

#[derive(Clone, Debug, Deserialize)]
#[serde(untagged)]
pub enum Audience {
    Single(String),
    Multiple(Vec<String>),
}

impl Audience {
    fn contains(&self, expected: &str) -> bool {
        match self {
            Self::Single(value) => value == expected,
            Self::Multiple(values) => values.iter().any(|value| value == expected),
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
pub struct IntrospectionClaims {
    pub active: bool,
    pub sub: Option<String>,
    pub iss: Option<String>,
    pub aud: Option<Audience>,
}

#[derive(Clone, Debug)]
pub struct AuthenticatedUser {
    pub sub: String,
}

struct ZitadelIntrospector {
    config: Config,
}

#[async_trait]
impl TokenIntrospector for ZitadelIntrospector {
    async fn introspect(&self, token: &str) -> Result<IntrospectionClaims, IntrospectionError> {
        let client_assertion = self
            .config
            .client_assertion()
            .map_err(|_: JwtError| IntrospectionError::Unavailable)?;
        let endpoint = self
            .config
            .introspection_endpoint()
            .await
            .map_err(|_| IntrospectionError::Unavailable)?;
        let response = self
            .config
            .http_client()
            .post(endpoint)
            .form(&[
                ("token", token),
                ("client_assertion_type", PRIVATE_KEY_JWT_ASSERTION_TYPE),
                ("client_assertion", client_assertion.as_str()),
            ])
            .send()
            .await
            .map_err(|_| IntrospectionError::Unavailable)?;

        if !response.status().is_success() {
            return Err(IntrospectionError::Unavailable);
        }

        response
            .json::<IntrospectionClaims>()
            .await
            .map_err(|_| IntrospectionError::Unavailable)
    }
}

pub async fn require_bearer(
    State(state): State<AppState>,
    mut request: Request<Body>,
    next: Next,
) -> Response {
    let Some(token) = bearer_token(request.headers()) else {
        return unauthorized();
    };

    let claims = match state.0.introspector.introspect(token).await {
        Ok(claims) => claims,
        Err(IntrospectionError::Unavailable) => {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                "Token verification is unavailable",
            )
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
        return unauthorized();
    }

    let Some(sub) = claims.sub else {
        return unauthorized();
    };
    request.extensions_mut().insert(AuthenticatedUser { sub });
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

fn unauthorized() -> Response {
    let mut response = (StatusCode::UNAUTHORIZED, "Unauthorized").into_response();
    response
        .headers_mut()
        .insert(header::WWW_AUTHENTICATE, HeaderValue::from_static("Bearer"));
    response
}

#[cfg(test)]
mod tests {
    use std::{collections::HashMap, sync::Arc};

    use axum::{
        body::{Body, to_bytes},
        http::{Request, StatusCode, header},
    };
    use serde_json::Value;
    use tower::ServiceExt;

    use super::{AppState, Audience, IntrospectionClaims, IntrospectionError, TokenIntrospector};
    use crate::app::router;

    const ISSUER: &str = "http://zitadel.test";
    const PROJECT: &str = "shared-project-id";

    #[derive(Clone)]
    struct MockIntrospector {
        replies: HashMap<String, Result<IntrospectionClaims, IntrospectionError>>,
    }

    #[async_trait::async_trait]
    impl TokenIntrospector for MockIntrospector {
        async fn introspect(&self, token: &str) -> Result<IntrospectionClaims, IntrospectionError> {
            self.replies
                .get(token)
                .cloned()
                .unwrap_or(Ok(IntrospectionClaims {
                    active: false,
                    sub: None,
                    iss: None,
                    aud: None,
                }))
        }
    }

    fn active_claims(sub: &str) -> IntrospectionClaims {
        IntrospectionClaims {
            active: true,
            sub: Some(sub.to_owned()),
            iss: Some(ISSUER.to_owned()),
            aud: Some(Audience::Multiple(vec![
                PROJECT.to_owned(),
                "api-client-id".to_owned(),
            ])),
        }
    }

    fn make_state(
        replies: HashMap<String, Result<IntrospectionClaims, IntrospectionError>>,
    ) -> AppState {
        AppState::with_introspector(
            ISSUER.to_owned(),
            PROJECT.to_owned(),
            Arc::new(MockIntrospector { replies }),
        )
    }

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
}
