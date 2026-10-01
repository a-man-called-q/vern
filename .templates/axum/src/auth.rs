use std::{
    collections::{BTreeSet, HashMap},
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use async_trait::async_trait;
use axum::{
    body::Body,
    extract::{Request, State},
    http::{HeaderMap, header},
    middleware::Next,
    response::{IntoResponse, Response},
};
use jsonwebtoken::errors::Error as JwtError;
use moka::{Expiry, future::Cache};
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::{config::Config, error::ApiError};

// ZITADEL puts the user's roles in the introspection response under these
// claims when the web app asked for the `urn:zitadel:iam:org:projects:roles`
// scope (the web templates do): an object keyed by role key, whose value is an
// object keyed by the ID of the organization the role is granted in. The second
// form is scoped to one project.
const ROLES_CLAIM: &str = "urn:zitadel:iam:org:project:roles";

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
        let cache_ttl = config.introspection_cache_ttl();
        let zitadel: Arc<dyn TokenIntrospector> = Arc::new(ZitadelIntrospector { config });
        let introspector: Arc<dyn TokenIntrospector> = if cache_ttl.is_zero() {
            zitadel
        } else {
            Arc::new(CachedIntrospector::new(zitadel, cache_ttl))
        };
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

#[derive(Clone, Debug, Default, Deserialize)]
pub struct IntrospectionClaims {
    pub active: bool,
    pub sub: Option<String>,
    pub iss: Option<String>,
    pub aud: Option<Audience>,
    pub name: Option<String>,
    pub preferred_username: Option<String>,
    /// Every other claim, such as the roles.
    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
}

#[derive(Clone, Debug)]
pub struct AuthenticatedUser {
    pub sub: String,
    pub display_name: Option<String>,
    /// Role keys granted to the user in this project.
    pub roles: BTreeSet<String>,
    /// The ZITADEL organization the user belongs to: the company that owns the
    /// rows they may see. `None` when the token carries no role, or roles from
    /// more than one organization.
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

/// The role keys in the introspection response's extra claims.
fn roles_from_claims(extra: &HashMap<String, Value>, project_id: &str) -> BTreeSet<String> {
    let project_claim = format!("urn:zitadel:iam:org:project:{project_id}:roles");
    [ROLES_CLAIM, project_claim.as_str()]
        .into_iter()
        .filter_map(|claim| extra.get(claim)?.as_object())
        .flat_map(|roles| roles.keys().cloned())
        .collect()
}

/// The organization the roles in the claims are granted in. A user belongs to
/// one organization, so a token that names several is treated as naming none.
fn org_id_from_claims(extra: &HashMap<String, Value>, project_id: &str) -> Option<String> {
    let project_claim = format!("urn:zitadel:iam:org:project:{project_id}:roles");
    let orgs: BTreeSet<&String> = [ROLES_CLAIM, project_claim.as_str()]
        .into_iter()
        .filter_map(|claim| extra.get(claim)?.as_object())
        .flat_map(|roles| roles.values())
        .filter_map(Value::as_object)
        .flat_map(|granted_in| granted_in.keys())
        .collect();
    match orgs.len() {
        1 => orgs.into_iter().next().cloned(),
        _ => None,
    }
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

/// How many tokens the cache keeps at most.
const CACHE_CAPACITY: u64 = 10_000;

/// Remembers what ZITADEL said about a token, so the hot path does not call it
/// for every request. A revoked token, or a role granted or removed, takes effect
/// when the entry expires: after `ttl` at the latest.
///
/// Only an active token is kept, and never past its own `exp`. A failed lookup is
/// not kept, and requests for the same new token share one lookup.
struct CachedIntrospector {
    inner: Arc<dyn TokenIntrospector>,
    cache: Cache<[u8; 32], CachedClaims>,
    ttl: Duration,
}

#[derive(Clone)]
struct CachedClaims {
    claims: IntrospectionClaims,
    ttl: Duration,
}

/// Gives each entry its own lifetime, which may be shorter than the cache's `ttl`.
struct EntryExpiry;

impl Expiry<[u8; 32], CachedClaims> for EntryExpiry {
    fn expire_after_create(
        &self,
        _key: &[u8; 32],
        value: &CachedClaims,
        _created_at: std::time::Instant,
    ) -> Option<Duration> {
        Some(value.ttl)
    }
}

enum Lookup {
    Failed(IntrospectionError),
    /// Answered, but not worth keeping: inactive, or already past `exp`.
    Uncacheable(IntrospectionClaims),
}

impl CachedIntrospector {
    fn new(inner: Arc<dyn TokenIntrospector>, ttl: Duration) -> Self {
        let cache = Cache::builder()
            .max_capacity(CACHE_CAPACITY)
            .expire_after(EntryExpiry)
            .build();
        Self { inner, cache, ttl }
    }
}

/// How long an answer may be kept: `max`, or until the token expires if sooner.
/// `None` when it has expired already.
fn cache_lifetime(
    claims: &IntrospectionClaims,
    max: Duration,
    now: SystemTime,
) -> Option<Duration> {
    let Some(exp) = claims.extra.get("exp").and_then(Value::as_u64) else {
        return Some(max);
    };
    let expires_at = UNIX_EPOCH + Duration::from_secs(exp);
    let left = expires_at.duration_since(now).ok()?;
    (!left.is_zero()).then_some(left.min(max))
}

#[async_trait]
impl TokenIntrospector for CachedIntrospector {
    async fn introspect(&self, token: &str) -> Result<IntrospectionClaims, IntrospectionError> {
        // The key is a hash, so a token never sits in memory next to its answer.
        let key: [u8; 32] = Sha256::digest(token.as_bytes()).into();
        let lookup = self
            .cache
            .try_get_with(key, async {
                let claims = self.inner.introspect(token).await.map_err(Lookup::Failed)?;
                if !claims.active {
                    return Err(Lookup::Uncacheable(claims));
                }
                match cache_lifetime(&claims, self.ttl, SystemTime::now()) {
                    Some(ttl) => Ok(CachedClaims { claims, ttl }),
                    None => Err(Lookup::Uncacheable(claims)),
                }
            })
            .await;
        match lookup {
            Ok(cached) => Ok(cached.claims),
            Err(error) => match error.as_ref() {
                Lookup::Failed(error) => Err(error.clone()),
                Lookup::Uncacheable(claims) => Ok(claims.clone()),
            },
        }
    }
}

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
    let org_id = org_id_from_claims(&claims.extra, &state.0.project_id);
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
    use std::{
        collections::HashMap,
        sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        },
        time::{Duration, SystemTime, UNIX_EPOCH},
    };

    use axum::{
        Extension, Router,
        body::{Body, to_bytes},
        http::{Request, StatusCode, header},
        middleware,
        routing::get,
    };
    use serde_json::{Value, json};
    use tower::ServiceExt;

    use super::{
        AppState, Audience, AuthenticatedUser, CachedIntrospector, IntrospectionClaims,
        IntrospectionError, TokenIntrospector, cache_lifetime, org_id_from_claims, require_bearer,
        roles_from_claims,
    };
    use crate::{app::router, error::ApiError};

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
                .unwrap_or(Ok(IntrospectionClaims::default()))
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
            ..IntrospectionClaims::default()
        }
    }

    fn claims_with(extra: serde_json::Value) -> IntrospectionClaims {
        let mut claims = active_claims("user");
        claims.extra = serde_json::from_value(extra).expect("claims are an object");
        claims
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

    fn extra(value: Value) -> HashMap<String, Value> {
        serde_json::from_value(value).expect("claims are an object")
    }

    #[test]
    fn roles_are_the_keys_of_both_role_claims() {
        let claims = extra(json!({
            "urn:zitadel:iam:org:project:roles": {
                "publisher": { "org-1": "acme.localhost" }
            },
            "urn:zitadel:iam:org:project:shared-project-id:roles": {
                "admin": { "org-1": "acme.localhost" },
                "publisher": { "org-1": "acme.localhost" }
            },
            "urn:zitadel:iam:org:project:another-project:roles": {
                "owner": { "org-1": "acme.localhost" }
            }
        }));
        let roles: Vec<_> = roles_from_claims(&claims, PROJECT).into_iter().collect();
        assert_eq!(roles, ["admin", "publisher"]);
    }

    #[test]
    fn missing_or_malformed_role_claims_mean_no_roles() {
        assert!(roles_from_claims(&HashMap::new(), PROJECT).is_empty());
        let malformed = extra(json!({
            "urn:zitadel:iam:org:project:roles": ["publisher"],
            "urn:zitadel:iam:org:project:shared-project-id:roles": "admin"
        }));
        assert!(roles_from_claims(&malformed, PROJECT).is_empty());
    }

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

    #[tokio::test]
    async fn me_reports_the_name_and_roles() {
        let mut claims = claims_with(json!({
            "urn:zitadel:iam:org:project:roles": {
                "publisher": { "org-1": "acme.localhost" },
                "admin": { "org-1": "acme.localhost" }
            }
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

    #[test]
    fn the_organization_is_the_one_the_roles_are_granted_in() {
        let claims = extra(json!({
            "urn:zitadel:iam:org:project:roles": {
                "publisher": { "org-1": "acme.localhost" },
                "owner": { "org-1": "acme.localhost" }
            },
            "urn:zitadel:iam:org:project:shared-project-id:roles": {
                "publisher": { "org-1": "acme.localhost" }
            },
            "urn:zitadel:iam:org:project:another-project:roles": {
                "owner": { "org-2": "other.localhost" }
            }
        }));
        assert_eq!(
            org_id_from_claims(&claims, PROJECT).as_deref(),
            Some("org-1")
        );
    }

    #[test]
    fn roles_from_several_organizations_mean_no_organization() {
        let claims = extra(json!({
            "urn:zitadel:iam:org:project:roles": {
                "publisher": { "org-1": "acme.localhost" },
                "advertiser": { "org-2": "other.localhost" }
            }
        }));
        assert_eq!(org_id_from_claims(&claims, PROJECT), None);
    }

    #[test]
    fn no_role_claim_or_a_malformed_one_means_no_organization() {
        assert_eq!(org_id_from_claims(&HashMap::new(), PROJECT), None);
        let malformed = extra(json!({
            "urn:zitadel:iam:org:project:roles": { "publisher": "org-1", "admin": [] }
        }));
        assert_eq!(org_id_from_claims(&malformed, PROJECT), None);
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
    async fn org_gives_the_callers_organization() {
        let claims = claims_with(json!({
            "urn:zitadel:iam:org:project:roles": { "owner": { "org-1": "acme.localhost" } }
        }));
        let response = call_org_route(claims).await;
        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("response body is readable");
        assert_eq!(&body[..], b"org-1");
    }

    #[tokio::test]
    async fn org_answers_403_when_the_token_names_none() {
        let response = call_org_route(active_claims("user")).await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }

    /// Answers every lookup with the same reply and counts the calls.
    struct CountingIntrospector {
        calls: AtomicUsize,
        reply: Result<IntrospectionClaims, IntrospectionError>,
    }

    impl CountingIntrospector {
        fn new(reply: Result<IntrospectionClaims, IntrospectionError>) -> Arc<Self> {
            Arc::new(Self {
                calls: AtomicUsize::new(0),
                reply,
            })
        }

        fn calls(&self) -> usize {
            self.calls.load(Ordering::SeqCst)
        }
    }

    #[async_trait::async_trait]
    impl TokenIntrospector for CountingIntrospector {
        async fn introspect(
            &self,
            _token: &str,
        ) -> Result<IntrospectionClaims, IntrospectionError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.reply.clone()
        }
    }

    fn now_seconds() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock is after the epoch")
            .as_secs()
    }

    #[tokio::test]
    async fn a_repeated_token_is_looked_up_once() {
        let inner = CountingIntrospector::new(Ok(active_claims("user")));
        let cached = CachedIntrospector::new(inner.clone(), Duration::from_secs(30));
        for _ in 0..3 {
            let claims = cached.introspect("token").await.expect("answers");
            assert_eq!(claims.sub.as_deref(), Some("user"));
        }
        assert_eq!(inner.calls(), 1);
        cached.introspect("another-token").await.expect("answers");
        assert_eq!(inner.calls(), 2);
    }

    #[tokio::test]
    async fn the_answer_is_asked_again_after_the_ttl() {
        let inner = CountingIntrospector::new(Ok(active_claims("user")));
        let cached = CachedIntrospector::new(inner.clone(), Duration::from_millis(80));
        cached.introspect("token").await.expect("answers");
        tokio::time::sleep(Duration::from_millis(200)).await;
        cached.introspect("token").await.expect("answers");
        assert_eq!(inner.calls(), 2);
    }

    #[tokio::test]
    async fn inactive_tokens_and_failures_are_not_kept() {
        let inactive = CountingIntrospector::new(Ok(IntrospectionClaims::default()));
        let cached = CachedIntrospector::new(inactive.clone(), Duration::from_secs(30));
        for _ in 0..2 {
            let claims = cached.introspect("revoked").await.expect("answers");
            assert!(!claims.active);
        }
        assert_eq!(inactive.calls(), 2);

        let failing = CountingIntrospector::new(Err(IntrospectionError::Unavailable));
        let cached = CachedIntrospector::new(failing.clone(), Duration::from_secs(30));
        for _ in 0..2 {
            assert!(cached.introspect("token").await.is_err());
        }
        assert_eq!(failing.calls(), 2);
    }

    #[test]
    fn an_answer_is_never_kept_past_the_tokens_expiry() {
        let now = UNIX_EPOCH + Duration::from_secs(1_000);
        let max = Duration::from_secs(30);
        let with_exp = |exp: u64| claims_with(json!({ "exp": exp }));

        assert_eq!(cache_lifetime(&active_claims("user"), max, now), Some(max));
        assert_eq!(cache_lifetime(&with_exp(1_500), max, now), Some(max));
        assert_eq!(
            cache_lifetime(&with_exp(1_010), max, now),
            Some(Duration::from_secs(10))
        );
        assert_eq!(cache_lifetime(&with_exp(1_000), max, now), None);
        assert_eq!(cache_lifetime(&with_exp(900), max, now), None);
    }

    #[tokio::test]
    async fn a_token_about_to_expire_is_not_kept_longer_than_it_lives() {
        let mut claims = active_claims("user");
        claims
            .extra
            .insert("exp".to_owned(), json!(now_seconds() + 1));
        let inner = CountingIntrospector::new(Ok(claims));
        let cached = CachedIntrospector::new(inner.clone(), Duration::from_secs(30));
        cached.introspect("token").await.expect("answers");
        tokio::time::sleep(Duration::from_millis(2_100)).await;
        cached.introspect("token").await.expect("answers");
        assert_eq!(inner.calls(), 2);
    }
}
