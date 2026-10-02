use std::collections::BTreeSet;

use crate::error::ApiError;

#[derive(Clone, Debug)]
pub struct AuthenticatedUser {
    pub sub: String,
    pub display_name: Option<String>,
    /// Role keys granted to the user in this project.
    pub roles: BTreeSet<String>,
    /// The ZITADEL organization the user belongs to: the company that owns the
    /// rows they may see. `None` when the token carries no organization (the
    /// session began before the web app asked for it: sign in again).
    pub org_id: Option<String>,
}

// Not every API checks roles; the template keeps both for the handlers you add.
#[allow(dead_code)]
impl AuthenticatedUser {
    pub fn has_role(&self, role: &str) -> bool {
        self.roles.contains(role)
    }

    /// The organization that owns the caller's rows. Answers 403 when the token
    /// names none: `let org = user.org()?;` before the query.
    pub fn org(&self) -> Result<&str, ApiError> {
        self.org_id.as_deref().ok_or_else(|| {
            ApiError::Forbidden("Your account does not belong to a company".to_owned())
        })
    }

    /// Answers 403 unless the user holds `role`:
    /// `user.require_role("publisher")?;` at the top of a handler.
    pub fn require_role(&self, role: &str) -> Result<(), ApiError> {
        if self.has_role(role) {
            Ok(())
        } else {
            Err(ApiError::Forbidden(format!("The {role} role is required")))
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use axum::{
        Extension, Router,
        body::{Body, to_bytes},
        http::{Request, StatusCode, header},
        middleware,
        routing::get,
    };
    use serde_json::{Value, json};
    use tower::ServiceExt;

    use super::AuthenticatedUser;
    use crate::{
        auth::{
            claims::IntrospectionClaims,
            require_bearer,
            testing::{active_claims, claims_with, make_state},
        },
        error::ApiError,
    };

    async fn publisher_only(
        Extension(user): Extension<AuthenticatedUser>,
    ) -> Result<String, ApiError> {
        user.require_role("publisher")?;
        Ok(format!("hello {}", user.sub))
    }

    async fn call_publisher_route(claims: IntrospectionClaims) -> axum::response::Response {
        let mut replies = HashMap::new();
        replies.insert("token".to_owned(), Ok(claims));
        let state = make_state(replies);
        let app = Router::new()
            .route("/publish", get(publisher_only))
            .route_layer(middleware::from_fn_with_state(
                state.clone(),
                require_bearer,
            ))
            .with_state(state);
        let request = Request::builder()
            .uri("/publish")
            .header(header::AUTHORIZATION, "Bearer token")
            .body(Body::empty())
            .expect("request is valid");
        app.oneshot(request).await.expect("router responds")
    }

    #[tokio::test]
    async fn require_role_lets_a_user_with_the_role_through() {
        let claims = claims_with(json!({
            "urn:zitadel:iam:org:project:roles": { "publisher": {} }
        }));
        let response = call_publisher_route(claims).await;
        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn require_role_answers_403_with_a_json_error() {
        let claims = claims_with(json!({
            "urn:zitadel:iam:org:project:roles": { "advertiser": {} }
        }));
        let response = call_publisher_route(claims).await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        let body = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("response body is readable");
        let json: Value = serde_json::from_slice(&body).expect("body is JSON");
        assert_eq!(json["error"]["code"], "forbidden");
        assert_eq!(json["error"]["message"], "The publisher role is required");
    }

    #[tokio::test]
    async fn a_user_without_any_role_claim_has_no_roles() {
        let response = call_publisher_route(active_claims("user")).await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }

    async fn call_org_route(claims: IntrospectionClaims) -> axum::response::Response {
        async fn whose(Extension(user): Extension<AuthenticatedUser>) -> Result<String, ApiError> {
            Ok(user.org()?.to_owned())
        }
        let mut replies = HashMap::new();
        replies.insert("token".to_owned(), Ok(claims));
        let state = make_state(replies);
        let app = Router::new()
            .route("/whose", get(whose))
            .route_layer(middleware::from_fn_with_state(
                state.clone(),
                require_bearer,
            ))
            .with_state(state);
        let request = Request::builder()
            .uri("/whose")
            .header(header::AUTHORIZATION, "Bearer token")
            .body(Body::empty())
            .expect("request is valid");
        app.oneshot(request).await.expect("router responds")
    }

    #[tokio::test]
    async fn org_gives_each_caller_their_own_organization() {
        for org in ["org-1", "org-2"] {
            let claims = claims_with(json!({
                "urn:zitadel:iam:user:resourceowner:id": org
            }));
            let response = call_org_route(claims).await;
            assert_eq!(response.status(), StatusCode::OK);
            let body = to_bytes(response.into_body(), usize::MAX)
                .await
                .expect("response body is readable");
            assert_eq!(&body[..], org.as_bytes());
        }
    }

    #[tokio::test]
    async fn org_answers_403_when_the_token_names_none() {
        let response = call_org_route(active_claims("user")).await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }
}
