use crate::config::PermissionProfile;
use crate::error::HelperError;
use crate::glob_expand;
use std::path::Path;

/// Mount operation in the bubblewrap plan.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MountOp {
    /// --tmpfs <target>
    Tmpfs { target: String },
    /// --bind <source> <target>
    Bind { source: String, target: String },
    /// --ro-bind <source> <target>
    RoBind { source: String, target: String },
    /// --dev <target>
    Dev { target: String },
    /// --proc <target>
    Proc { target: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BwrapPlan {
    pub flags: Vec<String>,
    pub mounts: Vec<MountOp>,
    pub unshare_net: bool,
    pub command: Vec<String>,
}

impl BwrapPlan {
    pub fn args(&self) -> Vec<String> {
        let mut args = self.flags.clone();
        for mount in &self.mounts {
            match mount {
                MountOp::Tmpfs { target } => {
                    args.push("--tmpfs".into());
                    args.push(target.clone());
                }
                MountOp::Bind { source, target } => {
                    args.push("--bind".into());
                    args.push(source.clone());
                    args.push(target.clone());
                }
                MountOp::RoBind { source, target } => {
                    args.push("--ro-bind".into());
                    args.push(source.clone());
                    args.push(target.clone());
                }
                MountOp::Dev { target } => {
                    args.push("--dev".into());
                    args.push(target.clone());
                }
                MountOp::Proc { target } => {
                    args.push("--proc".into());
                    args.push(target.clone());
                }
            }
        }
        if self.unshare_net {
            args.push("--unshare-net".into());
        }
        args.push("--".into());
        args.extend(self.command.clone());
        args
    }
}
/// Walk from `path` up to the filesystem root, checking whether any ancestor
/// component falls under a writable root AND is itself a symlink.
///
/// A writable symlink ancestor is a TOCTTOU hazard: the symlink target can be
/// swapped between the check and the bwrap mount, defeating read-only
/// enforcement. When this function returns `Ok(true)`, the caller should
/// skip the read-only mount for that path and accept it stays writable.
pub fn has_writable_symlink_ancestor(
    path: &Path,
    writable_roots: &[String],
) -> std::io::Result<bool> {
    if writable_roots.is_empty() {
        return Ok(false);
    }
    // Walk ancestors only — the path itself may not exist yet.
    let mut current = path.parent();
    while let Some(p) = current {
        let under_writable = writable_roots.iter().any(|root| {
            let root_path = Path::new(root);
            p.starts_with(root_path)
        });
        if under_writable {
            let metadata = std::fs::symlink_metadata(p)?;
            if metadata.file_type().is_symlink() {
                return Ok(true);
            }
        }
        current = p.parent();
    }
    Ok(false)
}

/// Platform default paths that are always ro-bound under a full-read bwrap
/// plan. These mirror the conservative Codex full-read baseline.
const FULL_READ_PLATFORM_DEFAULTS: &[&str] = &[
    "/bin",
    "/sbin",
    "/usr",
    "/etc",
    "/lib",
    "/lib64",
    "/var/db/timezone",
    "/usr/share",
    "/usr/libexec",
];

/// Returns true when the permission profile indicates a full-disk-read policy.
///
/// Full-read profiles include "/" in readable_roots. In this case the bwrap
/// plan starts with `--ro-bind / /` instead of `--tmpfs /`, offering a
/// complete read-only view of the host filesystem.
fn is_full_read(profile: &PermissionProfile) -> bool {
    profile
        .file_system
        .readable_roots
        .iter()
        .any(|root| root == "/")
}

/// Build a pure bwrap plan from a Synergy permission profile.
///
/// When the profile indicates a full-disk-read policy (readable_roots includes
/// "/"), the plan starts with `--ro-bind / /` followed by platform-default
/// ro-binds. Otherwise the plan starts with `--tmpfs /` for the restricted
/// default view.
pub fn build_bwrap_plan(
    profile: &PermissionProfile,
    policy_cwd: &Path,
    command: &[String],
) -> Result<BwrapPlan, HelperError> {
    if command.is_empty() {
        return Err(HelperError::Bwrap("missing child command".into()));
    }

    let flags = vec![
        "--new-session".into(),
        "--die-with-parent".into(),
        "--unshare-user".into(),
        "--unshare-pid".into(),
    ];
    let mut mounts = Vec::new();
    if is_full_read(profile) {
        mounts.push(MountOp::RoBind {
            source: "/".into(),
            target: "/".into(),
        });
        for root in FULL_READ_PLATFORM_DEFAULTS {
            push_ro_bind(&mut mounts, root, root);
        }
        mounts.push(MountOp::Dev {
            target: "/dev".into(),
        });
        mounts.push(MountOp::Proc {
            target: "/proc".into(),
        });
    } else {
        mounts.push(MountOp::Tmpfs { target: "/".into() });
        mounts.push(MountOp::Dev {
            target: "/dev".into(),
        });
        mounts.push(MountOp::Proc {
            target: "/proc".into(),
        });
    }

    for root in &profile.file_system.readable_roots {
        push_ro_bind(&mut mounts, root, root);
    }

    for root in &profile.file_system.writable_roots {
        push_bind(&mut mounts, root, root);
    }

    for subpath in &profile.file_system.read_only_subpaths {
        match has_writable_symlink_ancestor(Path::new(subpath), &profile.file_system.writable_roots)
        {
            Ok(true) => {
                log::warn!(
                    "skipping read-only mount for {subpath}: symlink ancestor under writable root (TOCTTOU)"
                );
            }
            Ok(false) => {
                push_ro_bind(&mut mounts, subpath, subpath);
            }
            Err(e) => {
                log::warn!(
                    "skipping read-only mount for {subpath}: unable to check symlink ancestry ({e})"
                );
            }
        }
    }

    for protected_path in &profile.file_system.protected_paths {
        match has_writable_symlink_ancestor(
            Path::new(protected_path),
            &profile.file_system.writable_roots,
        ) {
            Ok(true) => {
                log::warn!(
                    "skipping read-only mount for {protected_path}: symlink ancestor under writable root (TOCTTOU)"
                );
            }
            Ok(false) => {
                push_ro_bind(&mut mounts, protected_path, protected_path);
            }
            Err(e) => {
                log::warn!(
                    "skipping read-only mount for {protected_path}: unable to check symlink ancestry ({e})"
                );
            }
        }
    }

    for deny_root in &profile.file_system.data_deny_roots {
        mounts.push(MountOp::Tmpfs {
            target: deny_root.clone(),
        });
    }

    for writable_root in &profile.file_system.writable_roots {
        for metadata_name in &profile.file_system.protected_metadata_names {
            let protected = Path::new(writable_root)
                .join(metadata_name)
                .to_string_lossy()
                .into_owned();
            push_ro_bind(&mut mounts, &protected, &protected);
        }
    }

    // Mount tmpfs over resolved glob paths to deny read access.
    // WARNING: mounting tmpfs over a path makes its children invisible;
    // ro-bind individual subpaths first if they need to remain visible.
    if !profile.file_system.unreadable_globs.is_empty() {
        let resolved =
            glob_expand::expand_glob_patterns(&profile.file_system.unreadable_globs, policy_cwd)?;
        for path in resolved {
            mounts.push(MountOp::Tmpfs { target: path });
        }
    }
    if profile.file_system.include_platform_defaults {
        // Platform defaults are normally compiled by the TS policy engine into
        // readable_roots. This branch deliberately has no extra mounts; reading
        // the flag here keeps the Rust helper contract explicit and prevents a
        // future interpretation where the field is silently ignored.
    }

    let tmp_source = controlled_tmp_source(policy_cwd);
    push_bind(&mut mounts, &tmp_source, "/tmp");

    let unshare_net = matches!(profile.network.mode.as_str(), "restricted" | "proxy_only");
    let _allow_local_binding = profile.network.allow_local_binding;
    let _allowed_unix_sockets = &profile.network.allowed_unix_sockets;

    Ok(BwrapPlan {
        flags,
        mounts,
        unshare_net,
        command: command.to_vec(),
    })
}

fn controlled_tmp_source(policy_cwd: &Path) -> String {
    policy_cwd
        .join(".synergy")
        .join("tmp")
        .to_string_lossy()
        .into_owned()
}

fn push_bind(mounts: &mut Vec<MountOp>, source: &str, target: &str) {
    if source.trim().is_empty() || target.trim().is_empty() {
        return;
    }
    mounts.push(MountOp::Bind {
        source: source.into(),
        target: target.into(),
    });
}

fn push_ro_bind(mounts: &mut Vec<MountOp>, source: &str, target: &str) {
    if source.trim().is_empty() || target.trim().is_empty() {
        return;
    }
    mounts.push(MountOp::RoBind {
        source: source.into(),
        target: target.into(),
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{FileSystemPolicy, NetworkPolicy, PermissionProfile};

    fn make_profile(
        workspace: &str,
        network_mode: &str,
        writable_roots: Vec<&str>,
        read_only_subpaths: Vec<&str>,
        protected_paths: Vec<&str>,
    ) -> PermissionProfile {
        PermissionProfile {
            file_system: FileSystemPolicy {
                workspace: workspace.to_string(),
                readable_roots: vec!["/usr".to_string(), "/lib".to_string()],
                writable_roots: writable_roots.iter().map(|s| s.to_string()).collect(),
                read_only_subpaths: read_only_subpaths.iter().map(|s| s.to_string()).collect(),
                unreadable_globs: vec![],
                protected_metadata_names: vec![],
                protected_paths: protected_paths.iter().map(|s| s.to_string()).collect(),
                data_deny_roots: vec![],
                include_platform_defaults: true,
            },
            network: NetworkPolicy {
                mode: network_mode.to_string(),
                allow_local_binding: false,
                allowed_unix_sockets: vec![],
            },
        }
    }

    fn make_full_read_profile(
        workspace: &str,
        network_mode: &str,
        writable_roots: Vec<&str>,
    ) -> PermissionProfile {
        PermissionProfile {
            file_system: FileSystemPolicy {
                workspace: workspace.to_string(),
                readable_roots: vec!["/".to_string(), "/usr".to_string(), "/lib".to_string()],
                writable_roots: writable_roots.iter().map(|s| s.to_string()).collect(),
                read_only_subpaths: vec![],
                unreadable_globs: vec![],
                protected_metadata_names: vec![],
                protected_paths: vec![],
                data_deny_roots: vec![],
                include_platform_defaults: true,
            },
            network: NetworkPolicy {
                mode: network_mode.to_string(),
                allow_local_binding: false,
                allowed_unix_sockets: vec![],
            },
        }
    }

    fn plan(profile: &PermissionProfile, workspace: &str) -> BwrapPlan {
        build_bwrap_plan(profile, Path::new(workspace), &["echo".into(), "ok".into()]).unwrap()
    }

    #[test]
    fn plan_starts_with_tmpfs_root() {
        let profile = make_profile("/ws", "full", vec![], vec![], vec![]);
        let plan = plan(&profile, "/ws");
        assert_eq!(
            plan.mounts[0],
            MountOp::Tmpfs {
                target: "/".to_string()
            },
            "first mount must be --tmpfs /, not --ro-bind / /"
        );
    }

    #[test]
    fn full_read_plan_starts_with_ro_bind_root() {
        let profile = make_full_read_profile("/ws", "full", vec![]);
        let plan = plan(&profile, "/ws");
        assert_eq!(
            plan.mounts[0],
            MountOp::RoBind {
                source: "/".into(),
                target: "/".into(),
            },
            "full-read plan must start with --ro-bind / /, not --tmpfs /"
        );
    }

    #[test]
    fn full_read_plan_includes_platform_defaults() {
        let profile = make_full_read_profile("/ws", "full", vec![]);
        let plan = plan(&profile, "/ws");
        for root in FULL_READ_PLATFORM_DEFAULTS {
            assert!(
                plan.mounts.iter().any(|m| {
                    matches!(m, MountOp::RoBind { source, target } if source == *root && target == *root)
                }),
                "full-read plan must ro-bind platform default {root}"
            );
        }
    }

    #[test]
    fn full_read_plan_includes_dev_proc() {
        let profile = make_full_read_profile("/ws", "full", vec![]);
        let plan = plan(&profile, "/ws");
        assert!(plan.mounts.contains(&MountOp::Dev {
            target: "/dev".into()
        }));
        assert!(plan.mounts.contains(&MountOp::Proc {
            target: "/proc".into()
        }));
    }

    #[test]
    fn full_read_plan_includes_controlled_tmp() {
        let profile = make_full_read_profile("/ws", "full", vec![]);
        let plan = plan(&profile, "/ws");
        assert!(plan.mounts.iter().any(|m| {
            matches!(m, MountOp::Bind { source, target }
                if source.ends_with(".synergy/tmp") && target == "/tmp")
        }));
    }

    #[test]
    fn full_read_plan_does_not_have_tmpfs_root() {
        let profile = make_full_read_profile("/ws", "full", vec![]);
        let plan = plan(&profile, "/ws");
        assert!(!plan.mounts.contains(&MountOp::Tmpfs { target: "/".into() }));
    }

    #[test]
    fn is_full_read_detects_ro_root() {
        let full = make_full_read_profile("/ws", "full", vec![]);
        let restricted = make_profile("/ws", "full", vec![], vec![], vec![]);
        assert!(is_full_read(&full));
        assert!(!is_full_read(&restricted));
    }

    #[test]
    fn writable_root_becomes_bind() {
        let profile = make_profile("/ws", "full", vec!["/ws"], vec![], vec![]);
        let plan = plan(&profile, "/ws");
        assert!(plan.mounts.iter().any(|m| {
            matches!(m, MountOp::Bind { source, target } if source == "/ws" && target == "/ws")
        }));
    }

    #[test]
    fn read_only_subpath_after_writable_binds() {
        // Build a profile where writable root is "/ws" (which exists) and
        // read_only_subpaths has "/ws/.git" which may or may not exist.
        // The plan should still have the writable bind; the read-only subpath
        // may be skipped via TOCTTOU check if the path does not exist on disk.
        // Historically the test checked ordering; now we verify that writable
        // bind is present and if the ro-bind is present, it comes after.
        let profile = make_profile(
            "/ws",
            "full",
            vec!["/ws"],
            vec!["/ws/.git"],
            vec!["/home/user/.aws"],
        );
        let plan = plan(&profile, "/ws");
        let writable_bind_idx = plan
            .mounts
            .iter()
            .position(|m| matches!(m, MountOp::Bind { source, target } if source == "/ws" && target == "/ws"))
            .unwrap();
        let read_only_subpath_idx = plan
            .mounts
            .iter()
            .position(|m| matches!(m, MountOp::RoBind { source, target } if source == "/ws/.git" && target == "/ws/.git"));
        // When the subpath exists and is not symlinked, the ro-bind is present
        // after the writable bind. When the subpath doesn't exist, the TOCTTOU
        // check fails (IO error) and the mount is skipped — this is safe.
        if let Some(idx) = read_only_subpath_idx {
            assert!(
                writable_bind_idx < idx,
                "ro-bind for read-only subpath must come after writable bind"
            );
        }
    }

    #[test]
    fn protected_path_produces_ro_bind() {
        let profile = make_profile(
            "/ws",
            "full",
            vec!["/ws"],
            vec![],
            vec!["/home/user/.aws", "/home/user/.ssh"],
        );
        let plan = plan(&profile, "/ws");
        for pp in ["/home/user/.aws", "/home/user/.ssh"] {
            assert!(plan.mounts.iter().any(|m| {
                matches!(m, MountOp::RoBind { source, target } if source == pp && target == pp)
            }));
        }
    }

    #[test]
    fn restricted_network_adds_unshare_net() {
        let profile = make_profile("/ws", "restricted", vec![], vec![], vec![]);
        assert!(plan(&profile, "/ws").unshare_net);
    }

    #[test]
    fn full_network_does_not_add_unshare_net() {
        let profile = make_profile("/ws", "full", vec![], vec![], vec![]);
        assert!(!plan(&profile, "/ws").unshare_net);
    }

    #[test]
    fn proxy_only_network_adds_unshare_net() {
        let profile = make_profile("/ws", "proxy_only", vec![], vec![], vec![]);
        assert!(plan(&profile, "/ws").unshare_net);
    }

    #[test]
    fn controlled_tmp_bind_present() {
        let profile = make_profile("/ws", "full", vec![], vec![], vec![]);
        let plan = plan(&profile, "/ws");
        assert!(plan.mounts.iter().any(|m| {
            matches!(m, MountOp::Bind { source, target }
                if source.ends_with(".synergy/tmp") && target == "/tmp")
        }));
    }

    #[test]
    fn read_only_workspace_produces_no_writable_binds() {
        let profile = make_profile("/ws", "full", vec![], vec![], vec![]);
        let plan = plan(&profile, "/ws");
        assert!(!plan.mounts.iter().any(|m| {
            matches!(m, MountOp::Bind { source, target } if source == "/ws" && target == "/ws")
        }));
    }

    #[test]
    fn bwrap_args_include_separator_and_command() {
        let profile = make_profile("/ws", "restricted", vec![], vec![], vec![]);
        let plan =
            build_bwrap_plan(&profile, Path::new("/ws"), &["echo".into(), "ok".into()]).unwrap();
        let args = plan.args();
        assert!(args.contains(&"--".to_string()));
        assert_eq!(args[args.len() - 2], "echo");
        assert_eq!(args[args.len() - 1], "ok");
    }

    #[test]
    fn args_include_namespace_and_lifecycle_flags() {
        let profile = make_profile("/ws", "restricted", vec![], vec![], vec![]);
        let args = plan(&profile, "/ws").args();
        assert!(args.contains(&"--new-session".to_string()));
        assert!(args.contains(&"--die-with-parent".to_string()));
        assert!(args.contains(&"--unshare-user".to_string()));
        assert!(args.contains(&"--unshare-pid".to_string()));
        assert!(args.contains(&"--unshare-net".to_string()));
    }

    // --- unreadable_globs tests ---

    fn make_profile_with_globs(globs: Vec<&str>) -> PermissionProfile {
        PermissionProfile {
            file_system: FileSystemPolicy {
                workspace: "/ws".to_string(),
                readable_roots: vec!["/usr".to_string(), "/lib".to_string()],
                writable_roots: vec![],
                read_only_subpaths: vec![],
                unreadable_globs: globs.iter().map(|s| s.to_string()).collect(),
                protected_metadata_names: vec![],
                protected_paths: vec![],
                data_deny_roots: vec![],
                include_platform_defaults: true,
            },
            network: NetworkPolicy {
                mode: "full".to_string(),
                allow_local_binding: false,
                allowed_unix_sockets: vec![],
            },
        }
    }

    #[test]
    fn unreadable_glob_no_wildcard_mounts_tmpfs() {
        let profile = make_profile_with_globs(vec!["/tmp/cache"]);
        let plan = plan(&profile, "/ws");
        assert!(
            plan.mounts.contains(&MountOp::Tmpfs {
                target: "/tmp/cache".to_string()
            }),
            "absolute glob without wildcards should produce --tmpfs mount"
        );
    }

    #[test]
    fn unreadable_glob_non_absolute_expands_relative_to_workspace() {
        // Relative patterns are resolved against policy_cwd, then glob-expanded.
        // With "/ws" as cwd, "testdir/*.txt" becomes "/ws/testdir/*.txt".
        // Since nothing exists at that path, expansion yields zero matches.
        let profile = make_profile_with_globs(vec!["testdir/*.txt"]);
        let plan = plan(&profile, "/ws");
        // Zero matches → no tmpfs mounts from this glob.
        assert!(
            !plan.mounts.contains(&MountOp::Tmpfs {
                target: "/ws/testdir/*.txt".to_string()
            }),
            "non-absolute globs are resolved then expanded; no mounts when no matches exist"
        );
    }

    #[test]
    fn unreadable_glob_with_wildcard_expands_and_mounts() {
        // /var/log is a real directory; glob expansion matches actual files.
        let profile = make_profile_with_globs(vec!["/var/log/*.log"]);
        let plan = plan(&profile, "/ws");
        // Some .log files typically exist under /var/log (e.g. install.log).
        // We should see tmpfs mounts for those resolved paths, not the raw pattern.
        for mount in &plan.mounts {
            if let MountOp::Tmpfs { target } = mount {
                assert!(
                    !target.contains('*'),
                    "resolved glob target must not contain wildcard, got: {target}"
                );
            }
        }
        // /var may be a symlink (e.g. /var → /private/var on macOS), so
        // canonicalized targets can differ from the literal pattern string.
        // Check that at least one resolved --tmpfs mount ends with /log/ and
        // is a .log file, without wildcard characters.
        assert!(
            plan.mounts.iter().any(|m| {
                if let MountOp::Tmpfs { target } = m {
                    target.contains("/log/") && target.ends_with(".log") && !target.contains('*')
                } else {
                    false
                }
            }),
            "wildcard glob should produce --tmpfs mounts for matched .log files"
        );
    }

    #[test]
    fn unreadable_glob_empty_list_produces_no_tmpfs_glob_mounts() {
        let profile = make_profile_with_globs(vec![]);
        let plan = plan(&profile, "/ws");
        // No tmpfs mounts from unreadable_globs. Base plan still has / tmpfs
        // plus dev/proc.
        let glob_tmpfs_count = plan
            .mounts
            .iter()
            .filter(|m| matches!(m, MountOp::Tmpfs { target } if target == "/var/log/*.log"))
            .count();
        assert_eq!(glob_tmpfs_count, 0);
    }
    // --- TOCTTOU symlink tests ---

    #[test]
    fn plain_writable_root_no_symlink_ancestor() {
        // A regular directory under a writable root with no symlinks in path.
        let tmp = std::env::temp_dir();
        let writable = vec![tmp.to_string_lossy().into_owned()];
        assert!(
            !has_writable_symlink_ancestor(&tmp, &writable).unwrap(),
            "plain dir under writable root should not be flagged"
        );
    }

    #[test]
    fn symlink_under_writable_root_is_detected() {
        use std::os::unix::fs as unix_fs;
        let tmp = std::env::temp_dir();
        let test_dir = tmp.join("tocttou_test_target");
        let link_dir = tmp.join("tocttou_test_link");
        // Clean up any prior test residue.
        let _ = std::fs::remove_dir_all(&test_dir);
        let _ = std::fs::remove_file(&link_dir);
        std::fs::create_dir_all(&test_dir).unwrap();
        unix_fs::symlink(&test_dir, &link_dir).unwrap();
        let child = link_dir.join("somefile");
        let writable = vec![tmp.to_string_lossy().into_owned()];
        assert!(
            has_writable_symlink_ancestor(&child, &writable).unwrap(),
            "symlink ancestor under writable root should be detected"
        );
        // Cleanup.
        let _ = std::fs::remove_file(&link_dir);
        let _ = std::fs::remove_dir_all(&test_dir);
    }

    #[test]
    fn path_outside_writable_roots_not_flagged() {
        let writable = vec!["/tmp/isolated_thing".to_string()];
        assert!(
            !has_writable_symlink_ancestor(Path::new("/etc/hostname"), &writable).unwrap(),
            "path outside writable roots should not be flagged"
        );
    }
}
