//! Authorization scopes of the form `project:environment`.
//!
//! # Why this module exists
//!
//! A scope is two components joined by a colon. The environment component is
//! user-chosen text and may itself contain colons -- `eu:west`, `12:30`,
//! `review:pr-441` are all reasonable environment names.
//!
//! Splitting a scope on *every* colon therefore truncates such environments,
//! silently granting or denying access to the wrong thing. The correct parse
//! splits on the **first** colon only and treats the entire remainder as the
//! environment, which is what [`Scope::parse`] does via
//! [`str::split_once`]. `"a:b:c:d"` is project `a` in environment `b:c:d`.
//!
//! Because the split is unambiguous in one direction only, a project name may
//! not contain a colon; [`Scope::new`] rejects one.

use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};

/// The token that matches any project or any environment.
pub const WILDCARD: &str = "*";

/// The separator between the project and environment components.
pub const SEPARATOR: char = ':';

/// Reasons a scope string could not be parsed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[non_exhaustive]
pub enum ParseScopeError {
    /// The input contained no `:`, so it names only one of the two components.
    #[error("a scope must be written as `project:environment`")]
    MissingSeparator,
    /// The text before the first `:` was empty.
    #[error("scope has an empty project component")]
    EmptyProject,
    /// The text after the first `:` was empty.
    #[error("scope has an empty environment component")]
    EmptyEnvironment,
    /// A project name was supplied containing a `:`, which cannot round-trip.
    #[error("a project name may not contain `:`")]
    ColonInProject,
}

/// A parsed `project:environment` authorization scope.
///
/// Ordering is lexicographic by project then environment, which makes a sorted
/// list of scopes group by project. It carries no authorization meaning.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct Scope {
    project: String,
    environment: String,
}

impl Scope {
    /// Parses a scope, splitting on the **first** colon only.
    ///
    /// The entire remainder after that colon is the environment, so colons in
    /// environment names survive parsing intact.
    ///
    /// # Errors
    ///
    /// Returns [`ParseScopeError::MissingSeparator`] if there is no colon, and
    /// [`ParseScopeError::EmptyProject`] / [`ParseScopeError::EmptyEnvironment`]
    /// if either component is empty. An empty component is always a mistake:
    /// the wildcard is spelled `*`, not "".
    pub fn parse(raw: &str) -> Result<Self, ParseScopeError> {
        let (project, environment) =
            raw.split_once(SEPARATOR).ok_or(ParseScopeError::MissingSeparator)?;

        if project.is_empty() {
            return Err(ParseScopeError::EmptyProject);
        }
        if environment.is_empty() {
            return Err(ParseScopeError::EmptyEnvironment);
        }

        Ok(Self { project: project.to_owned(), environment: environment.to_owned() })
    }

    /// Builds a scope from already-separated components.
    ///
    /// # Errors
    ///
    /// Rejects empty components, and rejects a project containing a colon --
    /// such a scope could not be re-parsed back into the same pair.
    pub fn new(
        project: impl Into<String>,
        environment: impl Into<String>,
    ) -> Result<Self, ParseScopeError> {
        let project = project.into();
        let environment = environment.into();

        if project.is_empty() {
            return Err(ParseScopeError::EmptyProject);
        }
        if environment.is_empty() {
            return Err(ParseScopeError::EmptyEnvironment);
        }
        if project.contains(SEPARATOR) {
            return Err(ParseScopeError::ColonInProject);
        }

        Ok(Self { project, environment })
    }

    /// The scope matching every environment of every project (`*:*`).
    pub fn global() -> Self {
        Self { project: WILDCARD.to_owned(), environment: WILDCARD.to_owned() }
    }

    /// The project component.
    pub fn project(&self) -> &str {
        &self.project
    }

    /// The environment component, colons and all.
    pub fn environment(&self) -> &str {
        &self.environment
    }

    /// Whether the project component is the wildcard.
    pub fn is_project_wildcard(&self) -> bool {
        self.project == WILDCARD
    }

    /// Whether the environment component is the wildcard.
    pub fn is_environment_wildcard(&self) -> bool {
        self.environment == WILDCARD
    }

    /// Whether this scope matches everything (`*:*`).
    pub fn is_global(&self) -> bool {
        self.is_project_wildcard() && self.is_environment_wildcard()
    }

    /// Whether this scope covers a concrete `(project, environment)` pair.
    ///
    /// Matching is exact string equality per component, with `*` matching any
    /// value. There is no prefix or glob matching: `prod*` matches an
    /// environment literally named `prod*` and nothing else.
    pub fn matches(&self, project: &str, environment: &str) -> bool {
        (self.is_project_wildcard() || self.project == project)
            && (self.is_environment_wildcard() || self.environment == environment)
    }

    /// How specific this scope is, for resolving overlapping grants.
    ///
    /// Higher is more specific. Callers that need "most specific grant wins"
    /// ordering should sort on this; callers implementing "highest role over
    /// all matching grants" can ignore it.
    pub fn specificity(&self) -> u8 {
        u8::from(!self.is_project_wildcard()) + u8::from(!self.is_environment_wildcard())
    }
}

impl fmt::Display for Scope {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}{}{}", self.project, SEPARATOR, self.environment)
    }
}

impl FromStr for Scope {
    type Err = ParseScopeError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Self::parse(s)
    }
}

impl TryFrom<String> for Scope {
    type Error = ParseScopeError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::parse(&value)
    }
}

impl From<Scope> for String {
    fn from(value: Scope) -> Self {
        value.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_on_the_first_colon_only() {
        let scope = Scope::parse("a:b:c:d").unwrap();
        assert_eq!(scope.project(), "a");
        assert_eq!(scope.environment(), "b:c:d");
    }

    #[test]
    fn multi_colon_environments_round_trip() {
        for raw in ["app:eu:west", "app:12:30", "app:review:pr-441", "app:a:b:c:d:e"] {
            let scope = Scope::parse(raw).unwrap();
            assert_eq!(scope.to_string(), raw, "round trip failed for {raw}");
        }
    }

    #[test]
    fn multi_colon_environment_matches_only_its_full_name() {
        let scope = Scope::parse("app:eu:west").unwrap();
        assert!(scope.matches("app", "eu:west"));
        // The truncation bug would have made this pair match.
        assert!(!scope.matches("app", "eu"));
        assert!(!scope.matches("app", "eu:west:1"));
    }

    #[test]
    fn simple_scope_parses() {
        let scope = Scope::parse("billing:production").unwrap();
        assert_eq!(scope.project(), "billing");
        assert_eq!(scope.environment(), "production");
        assert_eq!(scope.specificity(), 2);
    }

    #[test]
    fn project_wildcard_matches_any_project() {
        let scope = Scope::parse("*:production").unwrap();
        assert!(scope.is_project_wildcard());
        assert!(!scope.is_environment_wildcard());
        assert!(!scope.is_global());
        assert!(scope.matches("billing", "production"));
        assert!(scope.matches("anything", "production"));
        assert!(!scope.matches("billing", "staging"));
        assert_eq!(scope.specificity(), 1);
    }

    #[test]
    fn environment_wildcard_matches_any_environment_including_colons() {
        let scope = Scope::parse("billing:*").unwrap();
        assert!(scope.matches("billing", "production"));
        assert!(scope.matches("billing", "eu:west"));
        assert!(!scope.matches("payments", "production"));
    }

    #[test]
    fn global_wildcard_matches_everything() {
        let scope = Scope::parse("*:*").unwrap();
        assert!(scope.is_global());
        assert_eq!(scope, Scope::global());
        assert!(scope.matches("billing", "eu:west"));
        assert!(scope.matches("*", "*"));
        assert_eq!(scope.specificity(), 0);
    }

    #[test]
    fn wildcard_is_not_a_prefix_match() {
        let scope = Scope::parse("app:prod*").unwrap();
        assert!(scope.matches("app", "prod*"));
        assert!(!scope.matches("app", "production"));
    }

    #[test]
    fn missing_separator_is_an_error() {
        assert_eq!(Scope::parse("billing"), Err(ParseScopeError::MissingSeparator));
        assert_eq!(Scope::parse(""), Err(ParseScopeError::MissingSeparator));
        assert_eq!(Scope::parse("*"), Err(ParseScopeError::MissingSeparator));
    }

    #[test]
    fn empty_components_are_errors() {
        assert_eq!(Scope::parse(":production"), Err(ParseScopeError::EmptyProject));
        assert_eq!(Scope::parse("billing:"), Err(ParseScopeError::EmptyEnvironment));
        assert_eq!(Scope::parse(":"), Err(ParseScopeError::EmptyProject));
        // A trailing colon does not become an environment named ":".
        assert_eq!(Scope::parse("a::"), Ok(Scope::new("a", ":").unwrap()));
    }

    #[test]
    fn new_rejects_a_colon_in_the_project() {
        assert_eq!(Scope::new("a:b", "prod"), Err(ParseScopeError::ColonInProject));
        assert!(Scope::new("a", "b:c").is_ok());
    }

    #[test]
    fn from_str_and_display_agree() {
        let scope: Scope = "app:eu:west".parse().unwrap();
        assert_eq!(scope, Scope::new("app", "eu:west").unwrap());
        assert_eq!(scope.to_string().parse::<Scope>().unwrap(), scope);
    }

    #[test]
    fn serde_round_trips_through_the_string_form() {
        let scope = Scope::parse("app:eu:west").unwrap();
        let json = serde_json::to_string(&scope).unwrap();
        assert_eq!(json, r#""app:eu:west""#);
        assert_eq!(serde_json::from_str::<Scope>(&json).unwrap(), scope);
    }

    #[test]
    fn deserialising_a_malformed_scope_fails() {
        assert!(serde_json::from_str::<Scope>(r#""nocolon""#).is_err());
    }

    #[test]
    fn ordering_groups_by_project() {
        let mut scopes = [
            Scope::parse("b:dev").unwrap(),
            Scope::parse("a:prod").unwrap(),
            Scope::parse("a:dev").unwrap(),
        ];
        scopes.sort();
        let rendered: Vec<String> = scopes.iter().map(ToString::to_string).collect();
        assert_eq!(rendered, ["a:dev", "a:prod", "b:dev"]);
    }
}
