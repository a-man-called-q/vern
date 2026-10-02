//! A fake ZITADEL for the tests: answers each token from a table.

use std::{collections::HashMap, sync::Arc};

use super::{
    AppState,
    claims::{Audience, IntrospectionClaims, IntrospectionError, TokenIntrospector},
};

pub const ISSUER: &str = "http://zitadel.test";
pub const PROJECT: &str = "shared-project-id";

#[derive(Clone)]
pub struct MockIntrospector {
    pub replies: HashMap<String, Result<IntrospectionClaims, IntrospectionError>>,
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

pub fn active_claims(sub: &str) -> IntrospectionClaims {
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

pub fn claims_with(extra: serde_json::Value) -> IntrospectionClaims {
    let mut claims = active_claims("user");
    claims.extra = serde_json::from_value(extra).expect("claims are an object");
    claims
}

pub fn make_state(
    replies: HashMap<String, Result<IntrospectionClaims, IntrospectionError>>,
) -> AppState {
    AppState::with_introspector(
        ISSUER.to_owned(),
        PROJECT.to_owned(),
        Arc::new(MockIntrospector { replies }),
    )
}
