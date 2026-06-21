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
            .map(|r| match r {
                LandlockRule::Read { path } | LandlockRule::Write { path } => path.clone(),
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

// ---------------------------------------------------------------------------
// Landlock kernel syscall wrappers (Linux-only)
// ---------------------------------------------------------------------------

#[cfg(target_os = "linux")]
mod sys {
    use libc::{c_int, c_long, c_uint, c_void, size_t};
    use std::ffi::CString;
    use std::io;
    use std::os::unix::ffi::OsStrExt;
    use std::path::Path;

    // Landlock syscall numbers (Linux 5.13+).
    const SYS_LANDLOCK_CREATE_RULESET: c_long = 444;
    const SYS_LANDLOCK_ADD_RULE: c_long = 445;
    const SYS_LANDLOCK_RESTRICT_SELF: c_long = 446;

    // Rule type: path-beneath is the only type in the current kernel.
    const LANDLOCK_RULE_PATH_BENEATH: c_uint = 1;

    // Filesystem access flags (from linux/landlock.h).
    const LANDLOCK_ACCESS_FS_EXECUTE: u64 = 1 << 0;
    const LANDLOCK_ACCESS_FS_WRITE_FILE: u64 = 1 << 1;
    const LANDLOCK_ACCESS_FS_READ_FILE: u64 = 1 << 2;
    const LANDLOCK_ACCESS_FS_READ_DIR: u64 = 1 << 3;
    const LANDLOCK_ACCESS_FS_REMOVE_DIR: u64 = 1 << 4;
    const LANDLOCK_ACCESS_FS_REMOVE_FILE: u64 = 1 << 5;
    const LANDLOCK_ACCESS_FS_MAKE_CHAR: u64 = 1 << 6;
    const LANDLOCK_ACCESS_FS_MAKE_DIR: u64 = 1 << 7;
    const LANDLOCK_ACCESS_FS_MAKE_REG: u64 = 1 << 8;
    const LANDLOCK_ACCESS_FS_MAKE_SOCK: u64 = 1 << 9;
    const LANDLOCK_ACCESS_FS_MAKE_FIFO: u64 = 1 << 10;
    const LANDLOCK_ACCESS_FS_MAKE_BLOCK: u64 = 1 << 11;
    const LANDLOCK_ACCESS_FS_MAKE_SYM: u64 = 1 << 12;

    /// Read-only access: read directories and files.
    pub const FS_READ: u64 = LANDLOCK_ACCESS_FS_READ_DIR | LANDLOCK_ACCESS_FS_READ_FILE;

    /// Read-write access: all read bits plus write, creation, and removal.
    pub const FS_WRITE: u64 = LANDLOCK_ACCESS_FS_READ_DIR
        | LANDLOCK_ACCESS_FS_READ_FILE
        | LANDLOCK_ACCESS_FS_EXECUTE
        | LANDLOCK_ACCESS_FS_WRITE_FILE
        | LANDLOCK_ACCESS_FS_REMOVE_DIR
        | LANDLOCK_ACCESS_FS_REMOVE_FILE
        | LANDLOCK_ACCESS_FS_MAKE_CHAR
        | LANDLOCK_ACCESS_FS_MAKE_DIR
        | LANDLOCK_ACCESS_FS_MAKE_REG
        | LANDLOCK_ACCESS_FS_MAKE_SOCK
        | LANDLOCK_ACCESS_FS_MAKE_FIFO
        | LANDLOCK_ACCESS_FS_MAKE_BLOCK
        | LANDLOCK_ACCESS_FS_MAKE_SYM;

    /// The union of all access rights we control.  We only need to set bits
    /// the running kernel actually supports; probing the ABI version tells us
    /// which access bits are safe.
    pub const FS_ALL_HANDLED: u64 = FS_READ | FS_WRITE;

    #[repr(C)]
    pub struct LandlockRulesetAttr {
        pub handled_access_fs: u64,
    }

    #[repr(C)]
    pub struct LandlockPathBeneathAttr {
        pub allowed_access: u64,
        pub parent_fd: c_int,
    }

    pub fn landlock_create_ruleset(
        attr: *const LandlockRulesetAttr,
        size: size_t,
        flags: u32,
    ) -> c_int {
        unsafe { libc::syscall(SYS_LANDLOCK_CREATE_RULESET, attr, size, flags) as c_int }
    }

    pub fn landlock_add_rule(
        ruleset_fd: c_int,
        rule_type: c_uint,
        rule_attr: *const LandlockPathBeneathAttr,
        flags: u32,
    ) -> c_int {
        unsafe {
            libc::syscall(
                SYS_LANDLOCK_ADD_RULE,
                ruleset_fd,
                rule_type,
                rule_attr,
                flags,
            ) as c_int
        }
    }

    pub fn landlock_restrict_self(ruleset_fd: c_int, flags: u32) -> c_int {
        unsafe { libc::syscall(SYS_LANDLOCK_RESTRICT_SELF, ruleset_fd, flags) as c_int }
    }

    /// Open `path` with O_PATH|O_CLOEXEC (no actual access, just a handle for
    /// use as a Landlock parent fd).
    pub fn open_path(path: &Path) -> Result<c_int, io::Error> {
        let c_path = CString::new(path.as_os_str().as_bytes())
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e))?;
        let fd = unsafe { libc::open(c_path.as_ptr(), libc::O_PATH | libc::O_CLOEXEC) };
        if fd < 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(fd)
        }
    }
}

/// Probe the kernel: is Landlock available?
///
/// Returns `true` when the kernel supports at least Landlock ABI v1.
#[cfg(target_os = "linux")]
pub fn is_landlock_available() -> bool {
    let abi = sys::landlock_create_ruleset(std::ptr::null(), 0, 0);
    abi >= 1
}

#[cfg(not(target_os = "linux"))]
pub fn is_landlock_available() -> bool {
    false
}

/// Apply a planned Landlock ruleset to the current process.
///
/// On Linux kernels that support Landlock (5.13+, ABI ≥ 1) this builds a
/// Landlock ruleset with the specified read/write access and calls
/// `landlock_restrict_self`.  On non-Linux platforms this is a safe no-op.
pub fn apply_landlock_ruleset(plan: &LandlockPlan) -> Result<(), HelperError> {
    apply_landlock_ruleset_impl(plan)
}

#[cfg(target_os = "linux")]
fn apply_landlock_ruleset_impl(plan: &LandlockPlan) -> Result<(), HelperError> {
    if plan.mode == LandlockMode::Disabled || plan.rules.is_empty() {
        return Ok(());
    }

    // Probe the supported ABI version.
    let abi = sys::landlock_create_ruleset(std::ptr::null(), 0, 0);
    if abi < 1 {
        return Err(HelperError::Landlock(
            "Landlock not supported by kernel".into(),
        ));
    }

    // Restrict the access mask to what this kernel supports.  ABI v1 covers
    // bits 0–12 (through MAKE_SYM); v2 adds REFER (bit 13), v3 TRUNCATE
    // (bit 14).  We don't set bits 13+ so the mask is identical, but
    // masking here keeps the function robust against future constant changes.
    let mut handled_access = sys::FS_ALL_HANDLED;
    if abi < 2 {
        handled_access &= !((1 << 13) | (1 << 14));
    }

    // Create the ruleset.
    let attr = sys::LandlockRulesetAttr {
        handled_access_fs: handled_access,
    };
    let ruleset_fd =
        sys::landlock_create_ruleset(&attr, std::mem::size_of::<sys::LandlockRulesetAttr>(), 0);
    if ruleset_fd < 0 {
        return Err(HelperError::Landlock(format!(
            "landlock_create_ruleset failed: {}",
            std::io::Error::last_os_error()
        )));
    }

    // Add each rule.
    for rule in &plan.rules {
        let (path, access) = match rule {
            LandlockRule::Read { path } => (path, sys::FS_READ & handled_access),
            LandlockRule::Write { path } => (path, sys::FS_WRITE & handled_access),
        };

        let dir_fd = sys::open_path(path)
            .map_err(|e| HelperError::Landlock(format!("open({}) failed: {e}", path.display())))?;

        let path_attr = sys::LandlockPathBeneathAttr {
            allowed_access: access,
            parent_fd: dir_fd,
        };

        let ret =
            sys::landlock_add_rule(ruleset_fd, sys::LANDLOCK_RULE_PATH_BENEATH, &path_attr, 0);
        // Close the parent fd immediately — Landlock copies what it needs.
        unsafe {
            libc::close(dir_fd);
        }

        if ret < 0 {
            unsafe {
                libc::close(ruleset_fd);
            }
            return Err(HelperError::Landlock(format!(
                "landlock_add_rule({}) failed: {}",
                path.display(),
                std::io::Error::last_os_error()
            )));
        }
    }

    // Enforce the ruleset on the calling process.
    let ret = sys::landlock_restrict_self(ruleset_fd, 0);
    unsafe {
        libc::close(ruleset_fd);
    }

    if ret < 0 {
        return Err(HelperError::Landlock(format!(
            "landlock_restrict_self failed: {}",
            std::io::Error::last_os_error()
        )));
    }

    Ok(())
}

#[cfg(not(target_os = "linux"))]
fn apply_landlock_ruleset_impl(_plan: &LandlockPlan) -> Result<(), HelperError> {
    Ok(())
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

    // -- New tests for Landlock syscall wrappers --

    #[test]
    fn is_landlock_available_returns_bool() {
        // On macOS (non-Linux) this is always false.
        let available = is_landlock_available();
        assert!(!available);
    }

    #[test]
    fn apply_landlock_ruleset_noop_for_disabled_mode() {
        let plan = LandlockPlan {
            mode: LandlockMode::Disabled,
            rules: vec![],
        };
        assert!(apply_landlock_ruleset(&plan).is_ok());
    }

    #[test]
    fn apply_landlock_ruleset_noop_for_readonly_with_no_rules() {
        let plan = LandlockPlan {
            mode: LandlockMode::ReadOnly,
            rules: vec![],
        };
        assert!(apply_landlock_ruleset(&plan).is_ok());
    }

    #[test]
    fn apply_landlock_ruleset_noop_on_non_linux_for_eligible_plan() {
        // Even with a plan that would apply on Linux, this is a no-op on macOS.
        let plan = LandlockPlan {
            mode: LandlockMode::ReadOnly,
            rules: vec![LandlockRule::Read {
                path: PathBuf::from("/"),
            }],
        };
        assert!(apply_landlock_ruleset(&plan).is_ok());
    }

    #[test]
    fn landlock_read_write_masks_are_non_empty() {
        // Verify the access masks represent distinct, non-trivial access sets.
        #[cfg(target_os = "linux")]
        {
            assert!(sys::FS_READ > 0);
            assert!(sys::FS_WRITE > 0);
            assert!(sys::FS_WRITE & sys::FS_READ == sys::FS_READ);
            assert!((sys::FS_WRITE & !sys::FS_READ) > 0);
        }
        // On non-Linux the sys module doesn't exist; the test trivially passes.
    }
}
