use std::collections::{BTreeSet, HashMap};

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::Value;
use thiserror::Error;

// ZITADEL puts the user's roles in the introspection response under these
// claims for a token that carries the project audience scope (the web templates
// ask for it): an object keyed by role key. The second form is scoped to one
// project. The organizations inside it are the ones that own the grants, not
// necessarily the user's, so they are not read as the user's organization.
const ROLES_CLAIM: &str = "urn:zitadel:iam:org:project:roles";

// The user's own organization, present when the web app asked for the
// `urn:zitadel:iam:user:resourceowner` scope (the web templates do).
const ORG_ID_CLAIM: &str = "urn:zitadel:iam:user:resourceowner:id";

#[derive(Clone, Debug, Error)]
pub enum IntrospectionError {
    #[error("ZITADEL token introspection is unavailable")]
    Unavailable,
}

/// Answers what ZITADEL knows about a token: ZITADEL itself, the cache in front
/// of it, or a fake in the tests.
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
    pub fn contains(&self, expected: &str) -> bool {
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

/// The role keys in the introspection response's extra claims.
pub fn roles_from_claims(extra: &HashMap<String, Value>, project_id: &str) -> BTreeSet<String> {
    let project_claim = format!("urn:zitadel:iam:org:project:{project_id}:roles");
    [ROLES_CLAIM, project_claim.as_str()]
        .into_iter()
        .filter_map(|claim| extra.get(claim)?.as_object())
        .flat_map(|roles| roles.keys().cloned())
        .collect()
}

/// The user's own organization. It is not read from the role claims: the
/// organization there owns the grant, so a role granted from the project's
/// organization (the Console does that by default) would make a customer's user
/// look like a member of the project's organization.
pub fn org_id_from_claims(extra: &HashMap<String, Value>) -> Option<String> {
    extra
        .get(ORG_ID_CLAIM)?
        .as_str()
        .map(str::trim)
        .filter(|org_id| !org_id.is_empty())
        .map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use serde_json::{Value, json};

    use super::{org_id_from_claims, roles_from_claims};
    use crate::testing::PROJECT;

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

    #[test]
    fn the_organization_is_the_users_own() {
        let claims = extra(json!({
            "urn:zitadel:iam:user:resourceowner:id": "org-1",
            "urn:zitadel:iam:user:resourceowner:name": "Acme Co",
            "urn:zitadel:iam:user:resourceowner:primary_domain": "acme.localhost"
        }));
        assert_eq!(org_id_from_claims(&claims).as_deref(), Some("org-1"));
    }

    #[test]
    fn the_organization_in_the_role_claims_is_not_the_users() {
        // A role granted from the project's organization (what the Console does by
        // default) names that organization, whichever company the user is in.
        let claims = extra(json!({
            "urn:zitadel:iam:org:project:roles": {
                "owner": { "project-org": "vern.localhost" }
            },
            "urn:zitadel:iam:org:project:shared-project-id:roles": {
                "owner": { "project-org": "vern.localhost" }
            }
        }));
        assert_eq!(org_id_from_claims(&claims), None);
        let both = extra(json!({
            "urn:zitadel:iam:org:project:roles": {
                "owner": { "project-org": "vern.localhost" }
            },
            "urn:zitadel:iam:user:resourceowner:id": "company-org"
        }));
        assert_eq!(org_id_from_claims(&both).as_deref(), Some("company-org"));
    }

    #[test]
    fn a_missing_or_malformed_resource_owner_means_no_organization() {
        assert_eq!(org_id_from_claims(&HashMap::new()), None);
        for value in [json!(""), json!("  "), json!(42), json!(["org"])] {
            let claims = extra(json!({ "urn:zitadel:iam:user:resourceowner:id": value }));
            assert_eq!(org_id_from_claims(&claims), None);
        }
    }
}
