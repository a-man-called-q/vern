use std::{env, fs, sync::Arc, time::Duration};

use jsonwebtoken::{Algorithm, EncodingKey, Header, encode};
use reqwest::{Client, Url, redirect::Policy};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use tokio::sync::OnceCell;

const PRIVATE_KEY_JWT_TTL_SECONDS: i64 = 5 * 60;
const DEFAULT_INTROSPECTION_CACHE_SECONDS: u64 = 30;
// A revoked token or a removed role keeps working for this long at most, so the
// setting has a ceiling.
const MAX_INTROSPECTION_CACHE_SECONDS: u64 = 300;

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("required environment variable {0} is missing")]
    MissingEnvironment(&'static str),
    #[error("ZITADEL_ISSUER must be an absolute http(s) issuer URL")]
    InvalidIssuer,
    #[error("ZITADEL_PROJECT_ID must be set to the shared project ID")]
    InvalidProjectId,
    #[error("ZITADEL_ISSUER discovery failed")]
    Discovery(#[source] reqwest::Error),
    #[error("ZITADEL discovery metadata did not match ZITADEL_ISSUER")]
    IssuerMismatch,
    #[error("ZITADEL discovery metadata has an invalid introspection endpoint")]
    InvalidIntrospectionEndpoint,
    #[error("failed to read ZITADEL API key file")]
    KeyFileRead(#[source] std::io::Error),
    #[error("ZITADEL API key file is not valid JSON")]
    KeyFileJson(#[source] serde_json::Error),
    #[error("ZITADEL API key file is missing clientId, keyId, or key")]
    InvalidKeyFile,
    #[error("ZITADEL API key file does not contain a valid RSA private key")]
    InvalidPrivateKey(#[source] jsonwebtoken::errors::Error),
    #[error("failed to build HTTP client")]
    HttpClient(#[source] reqwest::Error),
    #[error("INTROSPECTION_CACHE_SECONDS must be a whole number from 0 to 300")]
    InvalidIntrospectionCache,
}

#[derive(Clone)]
pub struct Config {
    issuer: String,
    project_id: String,
    discovery_url: String,
    introspection_endpoint: Arc<OnceCell<String>>,
    client_id: String,
    key_id: String,
    signing_key: Arc<EncodingKey>,
    http_client: Client,
    introspection_cache_ttl: Duration,
}

#[derive(Deserialize)]
struct DiscoveryDocument {
    issuer: String,
    introspection_endpoint: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApiKeyFile {
    client_id: String,
    key_id: String,
    key: String,
}

#[derive(Serialize)]
struct ClientAssertionClaims<'a> {
    iss: &'a str,
    sub: &'a str,
    aud: &'a str,
    iat: i64,
    exp: i64,
}

impl Config {
    pub fn from_env() -> Result<Self, ConfigError> {
        let issuer = env::var("ZITADEL_ISSUER")
            .map_err(|_| ConfigError::MissingEnvironment("ZITADEL_ISSUER"))?;
        let issuer_url = Url::parse(&issuer).map_err(|_| ConfigError::InvalidIssuer)?;
        if !matches!(issuer_url.scheme(), "http" | "https")
            || issuer_url.host_str().is_none()
            || !issuer_url.username().is_empty()
            || issuer_url.password().is_some()
            || issuer_url.query().is_some()
            || issuer_url.fragment().is_some()
        {
            return Err(ConfigError::InvalidIssuer);
        }

        let project_id = env::var("ZITADEL_PROJECT_ID")
            .map_err(|_| ConfigError::MissingEnvironment("ZITADEL_PROJECT_ID"))?;
        if project_id.is_empty()
            || !project_id
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || "_-".contains(character))
        {
            return Err(ConfigError::InvalidProjectId);
        }

        let http_client = Client::builder()
            .timeout(Duration::from_secs(5))
            .redirect(Policy::none())
            .build()
            .map_err(ConfigError::HttpClient)?;
        let discovery_url = format!(
            "{}/.well-known/openid-configuration",
            issuer.trim_end_matches('/')
        );

        let key_path = env::var("ZITADEL_API_KEY_FILE")
            .map_err(|_| ConfigError::MissingEnvironment("ZITADEL_API_KEY_FILE"))?;
        let key_json = fs::read_to_string(key_path).map_err(ConfigError::KeyFileRead)?;
        let key_file: ApiKeyFile =
            serde_json::from_str(&key_json).map_err(ConfigError::KeyFileJson)?;
        if key_file.client_id.is_empty() || key_file.key_id.is_empty() || key_file.key.is_empty() {
            return Err(ConfigError::InvalidKeyFile);
        }
        let signing_key = EncodingKey::from_rsa_pem(key_file.key.as_bytes())
            .map_err(ConfigError::InvalidPrivateKey)?;

        let introspection_cache_ttl = match env::var("INTROSPECTION_CACHE_SECONDS") {
            Ok(seconds) if !seconds.trim().is_empty() => seconds
                .trim()
                .parse::<u64>()
                .ok()
                .filter(|seconds| *seconds <= MAX_INTROSPECTION_CACHE_SECONDS)
                .ok_or(ConfigError::InvalidIntrospectionCache)?,
            _ => DEFAULT_INTROSPECTION_CACHE_SECONDS,
        };

        Ok(Self {
            issuer: issuer.trim_end_matches('/').to_owned(),
            project_id,
            discovery_url,
            introspection_endpoint: Arc::new(OnceCell::new()),
            client_id: key_file.client_id,
            key_id: key_file.key_id,
            signing_key: Arc::new(signing_key),
            http_client,
            introspection_cache_ttl: Duration::from_secs(introspection_cache_ttl),
        })
    }

    pub fn issuer(&self) -> &str {
        &self.issuer
    }

    pub fn project_id(&self) -> &str {
        &self.project_id
    }

    /// How long an introspection answer may be reused. Zero turns the cache off.
    pub fn introspection_cache_ttl(&self) -> Duration {
        self.introspection_cache_ttl
    }

    pub async fn introspection_endpoint(&self) -> Result<&str, ConfigError> {
        let endpoint = self
            .introspection_endpoint
            .get_or_try_init(|| async {
                let metadata: DiscoveryDocument = self
                    .http_client
                    .get(&self.discovery_url)
                    .send()
                    .await
                    .map_err(ConfigError::Discovery)?
                    .error_for_status()
                    .map_err(ConfigError::Discovery)?
                    .json()
                    .await
                    .map_err(ConfigError::Discovery)?;
                if metadata.issuer.trim_end_matches('/') != self.issuer {
                    return Err(ConfigError::IssuerMismatch);
                }

                let introspection_url = Url::parse(&metadata.introspection_endpoint)
                    .map_err(|_| ConfigError::InvalidIntrospectionEndpoint)?;
                if !matches!(introspection_url.scheme(), "http" | "https")
                    || introspection_url.host_str().is_none()
                    || !introspection_url.username().is_empty()
                    || introspection_url.password().is_some()
                    || introspection_url.query().is_some()
                    || introspection_url.fragment().is_some()
                {
                    return Err(ConfigError::InvalidIntrospectionEndpoint);
                }
                Ok(metadata.introspection_endpoint)
            })
            .await?;
        Ok(endpoint.as_str())
    }

    pub fn http_client(&self) -> &Client {
        &self.http_client
    }

    pub fn client_assertion(&self) -> Result<String, jsonwebtoken::errors::Error> {
        let issued_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system clock must be after the Unix epoch")
            .as_secs() as i64;
        let claims = ClientAssertionClaims {
            iss: &self.client_id,
            sub: &self.client_id,
            aud: &self.issuer,
            iat: issued_at,
            exp: issued_at + PRIVATE_KEY_JWT_TTL_SECONDS,
        };
        let mut header = Header::new(Algorithm::RS256);
        header.kid = Some(self.key_id.clone());
        encode(&header, &claims, self.signing_key.as_ref())
    }
}
