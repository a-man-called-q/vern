use std::{env, fs, sync::Arc, time::Duration};

use jsonwebtoken::EncodingKey;
use reqwest::Url;
use serde::Deserialize;
use thiserror::Error;

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
    #[error("failed to read ZITADEL API key file")]
    KeyFileRead(#[source] std::io::Error),
    #[error("ZITADEL API key file is not valid JSON")]
    KeyFileJson(#[source] serde_json::Error),
    #[error("ZITADEL API key file is missing clientId, keyId, or key")]
    InvalidKeyFile,
    #[error("ZITADEL API key file does not contain a valid RSA private key")]
    InvalidPrivateKey(#[source] jsonwebtoken::errors::Error),
    #[error("INTROSPECTION_CACHE_SECONDS must be a whole number from 0 to 300")]
    InvalidIntrospectionCache,
}

/// The API's key from `bun run setup`: who it is to ZITADEL, and what it signs with.
pub struct ApiKey {
    pub client_id: String,
    pub key_id: String,
    pub signing_key: EncodingKey,
}

/// The service's settings, read from the environment and checked once at
/// startup. A missing or malformed one stops the service before it listens.
#[derive(Clone)]
pub struct Config {
    issuer: String,
    project_id: String,
    api_key: Arc<ApiKey>,
    introspection_cache_ttl: Duration,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApiKeyFile {
    client_id: String,
    key_id: String,
    key: String,
}

/// An absolute http(s) URL with a host and nothing else: no credentials, query,
/// or fragment.
pub fn is_plain_http_url(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https")
        && url.host_str().is_some()
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
}

impl Config {
    pub fn from_env() -> Result<Self, ConfigError> {
        let issuer = env::var("ZITADEL_ISSUER")
            .map_err(|_| ConfigError::MissingEnvironment("ZITADEL_ISSUER"))?;
        let issuer_url = Url::parse(&issuer).map_err(|_| ConfigError::InvalidIssuer)?;
        if !is_plain_http_url(&issuer_url) {
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
            api_key: Arc::new(ApiKey {
                client_id: key_file.client_id,
                key_id: key_file.key_id,
                signing_key,
            }),
            introspection_cache_ttl: Duration::from_secs(introspection_cache_ttl),
        })
    }

    /// `ZITADEL_ISSUER` without a trailing slash: what tokens must name as `iss`.
    pub fn issuer(&self) -> &str {
        &self.issuer
    }

    pub fn project_id(&self) -> &str {
        &self.project_id
    }

    pub fn api_key(&self) -> Arc<ApiKey> {
        self.api_key.clone()
    }

    /// How long an introspection answer may be reused. Zero turns the cache off.
    pub fn introspection_cache_ttl(&self) -> Duration {
        self.introspection_cache_ttl
    }
}
