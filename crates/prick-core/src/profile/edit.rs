//! Changes to a [`Config`]: adding, renaming, removing and choosing the default.
//!
//! Each function takes the configuration and returns the changed copy or a
//! refusal, so the caller can apply it under a lock and the rules are tested
//! without a filesystem.

use super::{Config, Profile, Tombstone, is_profile_name, normalize_url};

/// Why a change to the profile set was refused.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum EditError {
    /// A name outside the grammar.
    #[error("`{name}` is not a usable profile name: lowercase letters, digits and single hyphens")]
    InvalidName {
        /// The offending name.
        name: String,
    },
    /// No profile by that name.
    #[error("there is no profile named `{name}`")]
    Unknown {
        /// The name asked for.
        name: String,
    },
    /// The name is in use.
    #[error("a profile named `{name}` already exists")]
    Exists {
        /// The name asked for.
        name: String,
    },
    /// The name once belonged to a profile for a different deployment.
    #[error(
        "`{name}` was the name of a profile for another deployment (renamed to `{to}`); reusing it could send a script written for that deployment to this one"
    )]
    Tombstoned {
        /// The name asked for.
        name: String,
        /// What the old profile is called now.
        to: String,
    },
    /// A profile already exists for this name with a different server.
    #[error(
        "profile `{name}` is for {existing}, not {requested}; a profile's server never changes"
    )]
    UrlMismatch {
        /// The profile.
        name: String,
        /// Its server.
        existing: String,
        /// The server asked for.
        requested: String,
    },
}

/// Whether `name` may be given to a new profile for `instance`.
///
/// A tombstoned name is refused unless `reuse` is set or the tombstone records
/// the same deployment (renaming back is always allowed).
fn check_available(
    config: &Config,
    name: &str,
    instance: Option<&str>,
    reuse: bool,
) -> Result<(), EditError> {
    if !is_profile_name(name) {
        return Err(EditError::InvalidName { name: name.to_owned() });
    }
    if config.profiles.contains_key(name) {
        return Err(EditError::Exists { name: name.to_owned() });
    }
    if let Some(tombstone) = config.renamed.get(name) {
        let same_deployment =
            tombstone.instance.is_some() && tombstone.instance.as_deref() == instance;
        if !reuse && !same_deployment {
            return Err(EditError::Tombstoned { name: name.to_owned(), to: tombstone.to.clone() });
        }
    }
    Ok(())
}

/// Adds a profile.
///
/// The first profile ever added becomes the default, and so does any profile
/// added with `make_default`. A reused tombstoned name drops its tombstone.
///
/// # Errors
///
/// [`EditError`] if the name is invalid, taken, or tombstoned without `reuse`.
pub fn add(
    config: &Config,
    name: &str,
    profile: Profile,
    make_default: bool,
    reuse: bool,
) -> Result<Config, EditError> {
    check_available(config, name, profile.instance.as_deref(), reuse)?;
    let mut next = config.clone();
    next.renamed.remove(name);
    let profile = Profile { api_url: normalize_url(&profile.api_url), ..profile };
    next.profiles.insert(name.to_owned(), profile);
    if make_default || next.default_profile.is_none() {
        next.default_profile = Some(name.to_owned());
    }
    Ok(next)
}

/// Renames a profile.
///
/// Only the key changes: the credential file, the session and every pin stay
/// as they are. The default follows, every tombstone that pointed at the old
/// name now points at the new one, and the old name is tombstoned.
///
/// # Errors
///
/// [`EditError`] if `old` does not exist or `new` is not available.
pub fn rename(config: &Config, old: &str, new: &str) -> Result<Config, EditError> {
    let profile = config
        .profiles
        .get(old)
        .ok_or_else(|| EditError::Unknown { name: old.to_owned() })?
        .clone();
    // Renaming back onto the name this profile used to have is always
    // allowed: the tombstone points at this very profile.
    let renaming_back = config.renamed.get(new).is_some_and(|tombstone| tombstone.to == old);
    check_available(config, new, profile.instance.as_deref(), renaming_back)?;

    let mut next = config.clone();
    next.profiles.remove(old);
    next.renamed.remove(new);
    for tombstone in next.renamed.values_mut() {
        if tombstone.to == old {
            new.clone_into(&mut tombstone.to);
        }
    }
    next.renamed.insert(
        old.to_owned(),
        Tombstone { to: new.to_owned(), instance: profile.instance.clone() },
    );
    next.profiles.insert(new.to_owned(), profile);
    if next.default_profile.as_deref() == Some(old) {
        next.default_profile = Some(new.to_owned());
    }
    Ok(next)
}

/// Drops a tombstone on purpose, freeing the name.
///
/// # Errors
///
/// [`EditError::Unknown`] if there is no tombstone by that name.
pub fn forget(config: &Config, name: &str) -> Result<Config, EditError> {
    if !config.renamed.contains_key(name) {
        return Err(EditError::Unknown { name: name.to_owned() });
    }
    let mut next = config.clone();
    next.renamed.remove(name);
    Ok(next)
}

/// Removes a profile, returning the changed configuration and the profile.
///
/// Removing the default clears the default rather than choosing another:
/// picking one would decide which organisation an unqualified command reaches.
///
/// # Errors
///
/// [`EditError::Unknown`] if there is no such profile.
pub fn remove(config: &Config, name: &str) -> Result<(Config, Profile), EditError> {
    let mut next = config.clone();
    let profile =
        next.profiles.remove(name).ok_or_else(|| EditError::Unknown { name: name.to_owned() })?;
    if next.default_profile.as_deref() == Some(name) {
        next.default_profile = None;
    }
    // A tombstone pointing at a profile that no longer exists would answer
    // "renamed to `x`" for a name that leads nowhere.
    next.renamed.retain(|_, tombstone| tombstone.to != name);
    Ok((next, profile))
}

/// Makes a profile the default.
///
/// # Errors
///
/// [`EditError::Unknown`] if there is no such profile.
pub fn set_default(config: &Config, name: &str) -> Result<Config, EditError> {
    if !config.profiles.contains_key(name) {
        return Err(EditError::Unknown { name: name.to_owned() });
    }
    let mut next = config.clone();
    next.default_profile = Some(name.to_owned());
    Ok(next)
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    fn pinned(url: &str, credential: &str, instance: &str) -> Profile {
        Profile { instance: Some(instance.to_owned()), ..Profile::new(url, credential) }
    }

    fn two() -> Config {
        let config = add(
            &Config::default(),
            "prod",
            pinned("https://a.example", "0000000000000001", A),
            false,
            false,
        )
        .unwrap();
        add(&config, "staging", pinned("https://b.example", "0000000000000002", B), false, false)
            .unwrap()
    }

    #[test]
    fn the_first_profile_becomes_the_default_and_later_ones_do_not() {
        let config = two();
        assert_eq!(config.default_profile.as_deref(), Some("prod"));
    }

    #[test]
    fn a_rename_moves_only_the_key_and_the_default_follows() {
        let config = rename(&two(), "prod", "acme").unwrap();
        let profile = &config.profiles["acme"];
        assert_eq!(profile.credential, "0000000000000001");
        assert_eq!(profile.instance.as_deref(), Some(A));
        assert!(!config.profiles.contains_key("prod"));
        assert_eq!(config.default_profile.as_deref(), Some("acme"));
        assert_eq!(config.renamed["prod"].to, "acme");
    }

    #[test]
    fn a_tombstoned_name_cannot_be_reused_for_another_deployment() {
        let config = rename(&two(), "prod", "acme").unwrap();
        let err =
            add(&config, "prod", pinned("https://c.example", "0000000000000003", B), false, false)
                .unwrap_err();
        assert!(matches!(err, EditError::Tombstoned { ref to, .. } if to == "acme"));

        let reused =
            add(&config, "prod", pinned("https://c.example", "0000000000000003", B), false, true)
                .unwrap();
        assert!(!reused.renamed.contains_key("prod"), "reusing a name consumes its tombstone");
    }

    #[test]
    fn renaming_back_is_allowed() {
        let config = rename(&two(), "prod", "acme").unwrap();
        let back = rename(&config, "acme", "prod").unwrap();
        assert!(back.profiles.contains_key("prod"));
        assert_eq!(back.renamed["acme"].to, "prod");
        assert!(!back.renamed.contains_key("prod"));
    }

    #[test]
    fn an_unpinned_profile_can_be_renamed_back_too() {
        let config = add(
            &Config::default(),
            "prod",
            Profile::new("https://a.example", "0000000000000001"),
            false,
            false,
        )
        .unwrap();
        let renamed = rename(&config, "prod", "acme").unwrap();
        rename(&renamed, "acme", "prod").expect("the tombstone points at this very profile");
    }

    #[test]
    fn a_chain_of_renames_points_every_old_name_at_the_current_one() {
        let config = rename(&rename(&two(), "prod", "acme").unwrap(), "acme", "acme-eu").unwrap();
        assert_eq!(config.renamed["prod"].to, "acme-eu");
        assert_eq!(config.renamed["acme"].to, "acme-eu");
    }

    #[test]
    fn a_rename_onto_an_existing_name_is_refused() {
        assert!(matches!(rename(&two(), "prod", "staging"), Err(EditError::Exists { .. })));
        assert!(matches!(rename(&two(), "nope", "x"), Err(EditError::Unknown { .. })));
        assert!(matches!(rename(&two(), "prod", "Not A Name"), Err(EditError::InvalidName { .. })));
    }

    #[test]
    fn removing_the_default_leaves_no_default_rather_than_choosing_one() {
        let (config, removed) = remove(&two(), "prod").unwrap();
        assert_eq!(removed.api_url, "https://a.example");
        assert_eq!(config.default_profile, None);
    }

    #[test]
    fn removing_a_profile_drops_the_tombstones_that_point_at_it() {
        let config = rename(&rename(&two(), "prod", "acme").unwrap(), "acme", "acme-eu").unwrap();
        let (config, _) = remove(&config, "acme-eu").unwrap();
        assert!(config.renamed.is_empty(), "{:?}", config.renamed);
    }

    #[test]
    fn forgetting_a_tombstone_frees_the_name() {
        let config = rename(&two(), "prod", "acme").unwrap();
        let config = forget(&config, "prod").unwrap();
        add(&config, "prod", pinned("https://c.example", "0000000000000003", B), false, false)
            .expect("a forgotten name is free");
    }
}
