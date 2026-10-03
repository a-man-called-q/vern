use std::sync::Arc;

use thiserror::Error;

use crate::{
    cache::CachedIntrospector, claims::TokenIntrospector, config::Config,
    zitadel::ZitadelIntrospector,
};

#[derive(Debug, Error)]
pub enum AuthSetupError {
    #[error("failed to build HTTP client")]
    HttpClient(#[source] reqwest::Error),
}

/// What `require_bearer` checks a token against: the issuer and project it must
/// name, and who to ask about it.
#[derive(Clone)]
pub struct AppState(pub(crate) Arc<AppStateInner>);

pub(crate) struct AppStateInner {
    pub(crate) expected_issuer: String,
    pub(crate) project_id: String,
    pub(crate) introspector: Arc<dyn TokenIntrospector>,
}

impl AppState {
    pub fn from_config(config: Config) -> Result<Self, AuthSetupError> {
        let cache_ttl = config.introspection_cache_ttl();
        let zitadel: Arc<dyn TokenIntrospector> =
            Arc::new(ZitadelIntrospector::new(&config).map_err(AuthSetupError::HttpClient)?);
        let introspector: Arc<dyn TokenIntrospector> = if cache_ttl.is_zero() {
            zitadel
        } else {
            Arc::new(CachedIntrospector::new(zitadel, cache_ttl))
        };
        Ok(Self::with_introspector(
            config.issuer().to_owned(),
            config.project_id().to_owned(),
            introspector,
        ))
    }

    pub(crate) fn with_introspector(
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
