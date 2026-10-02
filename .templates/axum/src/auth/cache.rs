use std::{
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use async_trait::async_trait;
use moka::{Expiry, future::Cache};
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::claims::{IntrospectionClaims, IntrospectionError, TokenIntrospector};

/// How many tokens the cache keeps at most.
const CACHE_CAPACITY: u64 = 10_000;

/// Remembers what ZITADEL said about a token, so the hot path does not call it
/// for every request. A revoked token, or a role granted or removed, takes effect
/// when the entry expires: after `ttl` at the latest.
///
/// Only an active token is kept, and never past its own `exp`. A failed lookup is
/// not kept, and requests for the same new token share one lookup.
pub struct CachedIntrospector {
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
    pub fn new(inner: Arc<dyn TokenIntrospector>, ttl: Duration) -> Self {
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

#[cfg(test)]
mod tests {
    use std::{
        sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        },
        time::{Duration, SystemTime, UNIX_EPOCH},
    };

    use serde_json::json;

    use super::{CachedIntrospector, cache_lifetime};
    use crate::auth::{
        claims::{IntrospectionClaims, IntrospectionError, TokenIntrospector},
        testing::{active_claims, claims_with},
    };

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
