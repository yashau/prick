//! `prk access`.
//!
//! # Status
//!
//! Argument definitions only.
//!
//! # The detail that makes this usable
//!
//! A service token's identity is its `common_name`, which looks like
//! `e367826f93b8d71185e03fe518aff3b4.access`. Nobody can map that string to
//! "the staging deploy job" from memory.
//!
//! So denials are audited, and `prk access identities --denied` lists subjects
//! that were recently refused. The workflow becomes: point CI at the server,
//! watch it get a 403, then grant the identity that just appeared. No copying
//! opaque identifiers between two consoles.
//!
//! There is also **no god mode**. A global administrator is an ordinary grant
//! row with a global scope, resolved by the same code as every other grant, so
//! it is auditable and revocable. A special case in the authorization check
//! that returns "allowed" for a class of caller is the bug this design exists
//! to prevent.

use clap::Subcommand;

/// Access subcommands.
#[derive(Debug, Subcommand)]
pub enum AccessCommand {
    /// List grants.
    List,

    /// List identities the server has seen.
    Identities {
        /// Show only identities that were denied and have no grant.
        #[arg(long)]
        denied: bool,
    },

    /// Grant a role on a scope to an identity.
    Grant {
        /// The identity: an email address, or a service token's common name.
        #[arg(value_name = "SUBJECT")]
        subject: String,

        /// The role to grant.
        #[arg(long, value_name = "ROLE")]
        role: RoleArg,

        /// The scope, written `project:environment`. `*` is a wildcard.
        ///
        /// Split on the first colon only, so an environment name may itself
        /// contain colons.
        #[arg(long, value_name = "SCOPE", default_value = "*:*")]
        scope: String,

        /// Expire the grant after this many days.
        #[arg(long, value_name = "DAYS")]
        expires_in: Option<u32>,
    },

    /// Revoke a grant.
    Revoke {
        /// The identity to revoke.
        #[arg(value_name = "SUBJECT")]
        subject: String,

        /// The scope to revoke it on.
        #[arg(long, value_name = "SCOPE", default_value = "*:*")]
        scope: String,
    },
}

impl AccessCommand {
    /// The command path as a user would type it.
    pub fn path(&self) -> &'static str {
        match self {
            Self::List => "access list",
            Self::Identities { .. } => "access identities",
            Self::Grant { .. } => "access grant",
            Self::Revoke { .. } => "access revoke",
        }
    }
}

/// The roles a grant can carry, in increasing order of privilege.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, clap::ValueEnum)]
pub enum RoleArg {
    /// Read secret metadata and values.
    Reader,
    /// Everything a reader can do, plus writing secrets.
    Writer,
    /// Everything a writer can do, plus managing grants.
    Admin,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roles_order_by_privilege() {
        // Effective role is the maximum over matching grants, so the ordering
        // is behaviour rather than presentation.
        assert!(RoleArg::Reader < RoleArg::Writer);
        assert!(RoleArg::Writer < RoleArg::Admin);
        assert_eq!([RoleArg::Admin, RoleArg::Reader].into_iter().max(), Some(RoleArg::Admin));
    }
}
