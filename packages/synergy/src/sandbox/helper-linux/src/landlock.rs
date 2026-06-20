use crate::config::PermissionProfile;
use crate::error::HelperError;
use std::collections::HashSet;
use std::path::PathBuf;

/// Whether Landlock can be used as a runtime fallback sandbox.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LandlockMode {
    /// No Landlock — bwrap provides the filesystem sandbox.
    Disabled,
    /// Landlock available as a runtime fallback for full-read policies.
    ReadOnly,
}

/// A Landlock access right mapped from the Synergy permission profile.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum LandlockRule {
    /// Read-only access to a filesystem path.
    Read { path: PathBuf },
    /// Read-write access to a filesystem path.
    Write { path: PathBuf },
}

/// Planned Landlock ruleset derived from the permission profile.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LandlockPlan {
    pub mode: LandlockMode,
    pub rules: Vec<LandlockRule>,
}

impl LandlockPlan {
    pub fn read_paths(&self) -> HashSet<PathBuf> {
        self.rules
            .iter()
            .filter_map(|r| match r {
                LandlockRule::Read { path } | LandlockRule::Write { path } => Some(path.clone()),
            })
            .collect()
    }

    pub fn write_paths(&self) -> HashSet<PathBuf> {
        self.rules
            .iter()
            .filter_map(|r| match r {
                LandlockRule::Write { path } => Some(path.clone()),
                _ => None,
            })
            .collect()
    }
}

/// Check whether the given profile is compatible with a Landlock fallback.
///
/// Synergy mirrors Codex's conservative fallback boundary: Landlock can only
/// represent policies with full-read semantics. Restricted-read profiles must use
/// bwrap because Landlock alone cannot synthesize a fresh filesystem view.
pub fn can_use_landlock_fallback(profile: &PermissionProfile) -> bool {
    profile
        .file_system
        .readable_roots
        .iter()
        .any(|root| root == "/")
}

/// Build a Landlock ruleset plan from the permission profile.
pub fn build_landlock_plan(profile: &PermissionProfile) -> Result<LandlockPlan, HelperError> {
    if !can_use_landlock_fallback(profile) {
        return Ok(LandlockPlan {
            mode: LandlockMode::Disabled,
            rules: Vec::new(),
        });
    }

    let mut rules = Vec::new();
    for root in &profile.file_system.readable_roots {
        push_rule_once(
            &mut rules,
            LandlockRule::Read {
                path: PathBuf::from(root),
            },
        );
    }
    for root in &profile.file_system.writable_roots {
        push_rule_once(
            &mut rules,
            LandlockRule::Read {
                path: PathBuf::from(root),
            },
        );
        push_rule_once(
            &mut rules,
            LandlockRule::Write {
                path: PathBuf::from(root),
            },
        );
    }

    Ok(LandlockPlan {
        mode: LandlockMode::ReadOnly,
        rules,
    })
}

fn push_rule_once(rules: &mut Vec<LandlockRule>, rule: LandlockRule) {
    if !rules.contains(&rule) {
        rules.push(rule);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{FileSystemPolicy, NetworkPolicy, PermissionProfile};

    fn make_profile(readable_roots: Vec<&str>, writable_roots: Vec<&str>) -> PermissionProfile {
        PermissionProfile {
            file_system: FileSystemPolicy {
                workspace: "/ws".to_string(),
                readable_roots: readable_roots.iter().map(|s| s.to_string()).collect(),
                writable_roots: writable_roots.iter().map(|s| s.to_string()).collect(),
                read_only_subpaths: vec![],
                unreadable_globs: vec![],
                protected_metadata_names: vec![],
                protected_paths: vec![],
                data_deny_roots: vec![],
                include_platform_defaults: false,
            },
            network: NetworkPolicy {
                mode: "restricted".to_string(),
                allow_local_binding: false,
                allowed_unix_sockets: vec![],
            },
        }
    }

    #[test]
    fn landlock_fallback_allowed_with_full_disk_read() {
        let profile = make_profile(vec!["/"], vec!["/ws"]);
        assert!(can_use_landlock_fallback(&profile));
    }

    #[test]
    fn landlock_fallback_rejected_with_restricted_read() {
        let profile = make_profile(vec!["/usr", "/lib", "/etc"], vec!["/ws"]);
        assert!(!can_use_landlock_fallback(&profile));
    }

    #[test]
    fn landlock_fallback_rejected_with_empty_readable_roots() {
        let profile = make_profile(vec![], vec![]);
        assert!(!can_use_landlock_fallback(&profile));
    }

    #[test]
    fn build_landlock_plan_includes_writable_roots_as_write_rules() {
        let profile = make_profile(vec!["/"], vec!["/ws", "/tmp"]);
        let plan = build_landlock_plan(&profile).unwrap();
        let write_paths = plan.write_paths();
        assert!(write_paths.contains(&PathBuf::from("/ws")));
        assert!(write_paths.contains(&PathBuf::from("/tmp")));
    }

    #[test]
    fn build_landlock_plan_includes_readable_roots_as_read_rules() {
        let profile = make_profile(vec!["/", "/usr", "/lib"], vec!["/ws"]);
        let plan = build_landlock_plan(&profile).unwrap();
        let read_paths = plan.read_paths();
        assert!(read_paths.contains(&PathBuf::from("/")));
        assert!(read_paths.contains(&PathBuf::from("/usr")));
        assert!(read_paths.contains(&PathBuf::from("/lib")));
    }

    #[test]
    fn build_landlock_plan_writable_also_readable() {
        let profile = make_profile(vec!["/"], vec!["/ws"]);
        let plan = build_landlock_plan(&profile).unwrap();
        assert!(plan.read_paths().contains(&PathBuf::from("/ws")));
    }

    #[test]
    fn build_landlock_plan_mode_matches_fallback_eligibility() {
        let eligible = make_profile(vec!["/"], vec!["/ws"]);
        let ineligible = make_profile(vec!["/usr"], vec!["/ws"]);
        assert_eq!(
            build_landlock_plan(&eligible).unwrap().mode,
            LandlockMode::ReadOnly
        );
        assert_eq!(
            build_landlock_plan(&ineligible).unwrap().mode,
            LandlockMode::Disabled
        );
    }

    #[test]
    fn build_landlock_plan_non_empty_for_eligible_profile() {
        let profile = make_profile(vec!["/"], vec!["/ws"]);
        assert!(!build_landlock_plan(&profile).unwrap().rules.is_empty());
    }

    #[test]
    fn landlock_mode_enum_variants_cover_full_contract() {
        let modes = [LandlockMode::Disabled, LandlockMode::ReadOnly];
        assert_eq!(modes.len(), 2);
        assert_ne!(LandlockMode::Disabled, LandlockMode::ReadOnly);
    }

    #[test]
    fn landlock_rule_variants_are_distinct() {
        let read_rule = LandlockRule::Read {
            path: PathBuf::from("/usr"),
        };
        let write_rule = LandlockRule::Write {
            path: PathBuf::from("/usr"),
        };
        assert_ne!(read_rule, write_rule);
    }
}
