use std::{sync::Arc, time::Duration};

use async_trait::async_trait;
use jsonwebtoken::{Algorithm, Header, encode};
use reqwest::{Client, Url, redirect::Policy};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use tokio::sync::OnceCell;

use super::claims::{IntrospectionClaims, IntrospectionError, TokenIntrospector};
use crate::config::{ApiKey, Config, is_plain_http_url};

const PRIVATE_KEY_JWT_ASSERTION_TYPE: &str =
    "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
const PRIVATE_KEY_JWT_TTL_SECONDS: i64 = 5 * 60;

#[derive(Debug, Error)]
enum DiscoveryError {
    #[error("ZITADEL_ISSUER discovery failed")]
    Request(#[source] reqwest::Error),
    #[error("ZITADEL discovery metadata did not match ZITADEL_ISSUER")]
    IssuerMismatch,
    #[error("ZITADEL discovery metadata has an invalid introspection endpoint")]
    InvalidIntrospectionEndpoint,
}

#[derive(Deserialize)]
struct DiscoveryDocument {
    issuer: String,
    introspection_endpoint: String,
}

#[derive(Serialize)]
struct ClientAssertionClaims<'a> {
    iss: &'a str,
    sub: &'a str,
    aud: &'a str,
    iat: i64,
    exp: i64,
}

/// Asks ZITADEL's introspection endpoint, signing in with the API's key
/// (`private_key_jwt`). The endpoint comes from discovery, once.
pub struct ZitadelIntrospector {
    issuer: String,
    api_key: Arc<ApiKey>,
    http_client: Client,
    introspection_endpoint: OnceCell<String>,
}

impl ZitadelIntrospector {
    pub fn new(config: &Config) -> Result<Self, reqwest::Error> {
        let http_client = Client::builder()
            .timeout(Duration::from_secs(5))
            .redirect(Policy::none())
            .build()?;
        Ok(Self {
            issuer: config.issuer().to_owned(),
            api_key: config.api_key(),
            http_client,
            introspection_endpoint: OnceCell::new(),
        })
    }

    async fn introspection_endpoint(&self) -> Result<&str, DiscoveryError> {
        let endpoint = self
            .introspection_endpoint
            .get_or_try_init(|| async {
                let discovery_url = format!("{}/.well-known/openid-configuration", self.issuer);
                let metadata: DiscoveryDocument = self
                    .http_client
                    .get(&discovery_url)
                    .send()
                    .await
                    .map_err(DiscoveryError::Request)?
                    .error_for_status()
                    .map_err(DiscoveryError::Request)?
                    .json()
                    .await
                    .map_err(DiscoveryError::Request)?;
                if metadata.issuer.trim_end_matches('/') != self.issuer {
                    return Err(DiscoveryError::IssuerMismatch);
                }

                let introspection_url = Url::parse(&metadata.introspection_endpoint)
                    .map_err(|_| DiscoveryError::InvalidIntrospectionEndpoint)?;
                if !is_plain_http_url(&introspection_url) {
                    return Err(DiscoveryError::InvalidIntrospectionEndpoint);
                }
                Ok(metadata.introspection_endpoint)
            })
            .await?;
        Ok(endpoint.as_str())
    }

    /// A short-lived JWT, signed with the API's key, that proves to ZITADEL which
    /// API is asking.
    fn client_assertion(&self) -> Result<String, jsonwebtoken::errors::Error> {
        let issued_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system clock must be after the Unix epoch")
            .as_secs() as i64;
        let claims = ClientAssertionClaims {
            iss: &self.api_key.client_id,
            sub: &self.api_key.client_id,
            aud: &self.issuer,
            iat: issued_at,
            exp: issued_at + PRIVATE_KEY_JWT_TTL_SECONDS,
        };
        let mut header = Header::new(Algorithm::RS256);
        header.kid = Some(self.api_key.key_id.clone());
        encode(&header, &claims, &self.api_key.signing_key)
    }
}

#[async_trait]
impl TokenIntrospector for ZitadelIntrospector {
    async fn introspect(&self, token: &str) -> Result<IntrospectionClaims, IntrospectionError> {
        let client_assertion = self
            .client_assertion()
            .map_err(|_| IntrospectionError::Unavailable)?;
        let endpoint = self
            .introspection_endpoint()
            .await
            .map_err(|_| IntrospectionError::Unavailable)?;
        let response = self
            .http_client
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
