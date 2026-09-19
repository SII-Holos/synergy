use crate::config::PermissionProfile;
use crate::error::HelperError;
use crate::glob_expand;
use std::path::{Path, PathBuf};

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
/// "/"), the plan starts with `--ro-bind / /`, a complete read-only view of the
/// host filesystem. Otherwise the plan starts with `--tmpfs /` for the
/// restricted default view.
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
        // No readable-root or platform-default binds follow: the recursive
        // read-only bind of "/" already covers all of them, and a redundant
        // bind makes bwrap hard-fail before the child starts when the source is
        // absent on this host (/var/db/timezone is macOS-only).
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
        for root in &profile.file_system.readable_roots {
            push_ro_bind(&mut mounts, root, root);
        }
    }

    // Credential and sensitive paths stay unreadable, which bwrap expresses as a
    // cover mount rather than a deny rule. bwrap resolves shadowing by mount
    // order rather than by specificity, so covers are emitted on BOTH sides of
    // the writable-root binds according to containment:
    //
    // - a deny that CONTAINS a writable root mounts first, so the deeper
    //   writable bind restores a workspace nested inside a denied directory
    //   while its credential siblings stay hidden;
    // - a deny equal to or INSIDE a writable root mounts after that bind, so
    //   the deny wins. Emitting it first would let the writable bind re-expose
    //   the credential, which is why such denies used to be pruned from the
    //   profile instead; ordering them makes them enforceable and keeps the
    //   deny set complete.
    let (denies_before_writable_binds, denies_after_writable_binds): (Vec<&String>, Vec<&String>) =
        profile
            .file_system
            .data_deny_roots
            .iter()
            .partition(|root| !is_inside_writable_root(root, &profile.file_system.writable_roots));

    for deny_root in &denies_before_writable_binds {
        push_read_deny(&mut mounts, deny_root.as_str());
    }

    for root in &profile.file_system.writable_roots {
        push_bind(&mut mounts, root, root);
    }

    for deny_root in &denies_after_writable_binds {
        push_read_deny(&mut mounts, deny_root.as_str());
    }

    for subpath in &profile.file_system.read_only_subpaths {
        if is_read_deny_for(subpath, &profile.file_system.data_deny_roots) {
            log::warn!(
                "skipping read-only mount for {subpath}: an exact read deny replaces it with a cover, and re-binding would re-expose the covered content"
            );
            continue;
        }
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
        if is_read_deny_for(protected_path, &profile.file_system.data_deny_roots) {
            log::warn!(
                "skipping read-only mount for {protected_path}: an exact read deny replaces it with a cover, and re-binding would re-expose the covered content"
            );
            continue;
        }
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

    for writable_root in &profile.file_system.writable_roots {
        for metadata_name in &profile.file_system.protected_metadata_names {
            let protected = Path::new(writable_root)
                .join(metadata_name)
                .to_string_lossy()
                .into_owned();
            // Only mount metadata directories that exist: bwrap hard-fails
            // when a --ro-bind source is missing, and most workspaces have no
            // .agents/.codex directory at launch. Creation inside the sandbox
            // stays blocked by the ProtectedCreateMonitor (which removes the
            // entry), so skipping a missing directory does not weaken the
            // protection.
            if !Path::new(&protected).exists() {
                log::warn!(
                    "skipping read-only mount for {protected}: path does not exist (create vector covered by ProtectedCreateMonitor)"
                );
                continue;
            }
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

/// Whether `path` is equal to, or inside, any writable root.
///
/// Compare the same canonical destinations used for cover mounts so a symlink
/// cannot move a deny across a writable boundary after ordering it.
fn is_inside_writable_root(path: &str, writable_roots: &[String]) -> bool {
    if path.is_empty() {
        return false;
    }
    let candidate = canonical_mount_path(path);
    writable_roots
        .iter()
        .any(|root| !root.is_empty() && candidate.starts_with(canonical_mount_path(root)))
}

/// Whether a read deny makes a read-only bind of `path` redundant.
///
/// Exact match only. A deny is applied as a cover mount on its own path and,
/// for a deny that contains `path`, mounts before the writable bind that
/// contains both — so the deny never hides `path` itself, and skipping the
/// read-only bind would leave it writable through that bind. Reporting an
/// ancestor deny here is what made `<ws>/.git/hooks` and `<ws>/.git/config`
/// writable for a workspace nested inside a credential directory.
fn is_read_deny_for(path: &str, deny_roots: &[String]) -> bool {
    let candidate = canonical_mount_path(path);
    deny_roots
        .iter()
        .any(|root| !root.is_empty() && canonical_mount_path(root) == candidate)
}
/// Cover a denied path so the sandbox cannot read it.
///
/// bwrap has no deny rule, so a deny is a cover mount: an empty tmpfs for a
/// directory, and the null device for a regular file. A tmpfs destination must
/// be a directory — bwrap dies with "Destination is not a directory" otherwise
/// — so a file cannot use one. A cover hides reads and writes at once, which is
/// why it must mount after any write-protecting bind of the same path.
///
/// The target is resolved before mounting: bwrap refuses to mount over a
/// symlink destination ("Can't mount on symlink destination"), and a credential
/// store such as `~/.ssh` is commonly a link. Resolving keeps the cover on the
/// path the kernel actually serves. A path that does not exist hides nothing and
/// is skipped, so the plan never carries a missing mount source.
fn canonical_mount_path(path: &str) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| PathBuf::from(path))
}

fn push_read_deny(mounts: &mut Vec<MountOp>, path: &str) {
    if path.trim().is_empty() {
        return;
    }
    let resolved = canonical_mount_path(path);
    let target = resolved.to_string_lossy().into_owned();
    match std::fs::metadata(&resolved) {
        Ok(metadata) if metadata.is_dir() => mounts.push(MountOp::Tmpfs { target }),
        Ok(_) => mounts.push(MountOp::RoBind {
            source: "/dev/null".into(),
            target,
        }),
        Err(_) => {}
    }
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
    fn full_read_plan_omits_macos_only_platform_defaults() {
        // The recursive "/" bind already covers the platform defaults. Emitting
        // them again would hard-fail on Linux, where /var/db/timezone does not
        // exist and bwrap cannot open a missing --ro-bind source.
        let profile = make_full_read_profile("/ws", "full", vec![]);
        let plan = plan(&profile, "/ws");
        assert!(
            plan.mounts.iter().any(|m| {
                matches!(m, MountOp::RoBind { source, target } if source == "/" && target == "/")
            }),
            "full-read plan must bind the whole host root read-only"
        );
        assert!(
            !plan.mounts.iter().any(|m| {
                matches!(m, MountOp::RoBind { source, .. } if source == "/var/db/timezone")
            }),
            "full-read plan must not bind the macOS-only /var/db/timezone"
        );
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

    // --- read deny (credential and sensitive paths) ---

    fn profile_with_denies(denies: &[&str]) -> PermissionProfile {
        let mut profile = make_profile("/ws", "full", vec![], vec![], vec![]);
        profile.file_system.data_deny_roots = denies.iter().map(|s| s.to_string()).collect();
        profile
    }

    #[test]
    fn read_deny_inside_root_workspace_mounts_after_writable_root() {
        let tmp = std::env::temp_dir().join(format!("bwrap_root_deny_{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let denied = std::fs::canonicalize(&tmp)
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let mut profile = profile_with_denies(&[&denied]);
        profile.file_system.writable_roots = vec!["/".into()];
        let plan = plan(&profile, "/");
        let write = plan
            .mounts
            .iter()
            .position(|m| matches!(m, MountOp::Bind { target, .. } if target == "/"))
            .unwrap();
        let deny = plan
            .mounts
            .iter()
            .position(|m| matches!(m, MountOp::Tmpfs { target } if target == &denied))
            .unwrap();
        assert!(write < deny, "root workspace must not uncover credentials");
        std::fs::remove_dir_all(tmp).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn read_deny_symlink_target_stays_covered_after_writable_bind() {
        let tmp = std::env::temp_dir().join(format!("bwrap_link_deny_{}", std::process::id()));
        let workspace = tmp.join("workspace");
        let target = workspace.join("credentials");
        std::fs::create_dir_all(&target).unwrap();
        let alias = tmp.join("credential-link");
        let _ = std::fs::remove_file(&alias);
        std::os::unix::fs::symlink(&target, &alias).unwrap();
        let ws = std::fs::canonicalize(&workspace)
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let denied = std::fs::canonicalize(&target)
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let mut profile = profile_with_denies(&[alias.to_str().unwrap()]);
        profile.file_system.writable_roots = vec![ws.clone()];
        profile.file_system.read_only_subpaths = vec![denied.clone()];
        let plan = plan(&profile, &ws);
        let write = plan
            .mounts
            .iter()
            .position(|m| matches!(m, MountOp::Bind { target, .. } if target == &ws))
            .unwrap();
        let deny = plan
            .mounts
            .iter()
            .position(|m| matches!(m, MountOp::Tmpfs { target } if target == &denied))
            .unwrap();
        assert!(write < deny, "mount order must use the symlink target");
        assert!(!plan.mounts.iter().any(|m| matches!(m, MountOp::RoBind { source, target } if source == &denied && target == &denied)), "a metadata bind must not uncover the same canonical deny");
        std::fs::remove_dir_all(tmp).unwrap();
    }

    #[test]
    fn read_deny_directory_is_covered_by_tmpfs() {
        let tmp = std::env::temp_dir().join(format!("bwrap_deny_dir_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let denied = std::fs::canonicalize(&tmp)
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let plan = plan(&profile_with_denies(&[&denied]), "/ws");
        assert!(
            plan.mounts.contains(&MountOp::Tmpfs {
                target: denied.clone()
            }),
            "a denied directory must be covered by an empty tmpfs"
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn read_deny_file_is_covered_by_the_null_device() {
        let tmp = std::env::temp_dir().join(format!("bwrap_deny_file_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let denied_file = tmp.join("id_rsa");
        std::fs::write(&denied_file, "secret\n").unwrap();
        let denied = std::fs::canonicalize(&denied_file)
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let plan = plan(&profile_with_denies(&[&denied]), "/ws");
        assert!(
            plan.mounts.contains(&MountOp::RoBind {
                source: "/dev/null".into(),
                target: denied.clone(),
            }),
            "a denied file must be covered by the null device; tmpfs needs a directory destination"
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn read_deny_missing_path_produces_no_mount() {
        let denied = std::env::temp_dir()
            .join(format!("bwrap_deny_missing_{}", std::process::id()))
            .join("nope")
            .to_string_lossy()
            .into_owned();

        let plan = plan(&profile_with_denies(&[&denied]), "/ws");
        assert!(
            !plan.mounts.iter().any(|m| {
                matches!(m, MountOp::Tmpfs { target } if *target == denied)
                    || matches!(m, MountOp::RoBind { target, .. } if *target == denied)
            }),
            "a missing deny path has nothing to hide and must not be mounted"
        );
    }

    #[test]
    fn read_deny_mounts_before_a_writable_bind_it_contains() {
        // Mount order is the whole guarantee on bwrap: the last mount wins. The
        // cover must precede a writable bind it contains, or a workspace nested
        // inside a denied directory would stay hidden along with the credentials
        // it lives beside.
        let tmp = std::env::temp_dir().join(format!("bwrap_deny_order_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let secrets = tmp.join("secrets");
        let workspace = secrets.join("proj");
        std::fs::create_dir_all(&workspace).unwrap();
        let denied = std::fs::canonicalize(&secrets).unwrap();
        let denied_str = denied.to_string_lossy().into_owned();
        let ws = std::fs::canonicalize(&workspace)
            .unwrap()
            .to_string_lossy()
            .into_owned();

        let mut profile = profile_with_denies(&[&denied_str]);
        profile.file_system.writable_roots = vec![ws.clone()];
        let plan = plan(&profile, &ws);

        let index_of = |pred: &dyn Fn(&MountOp) -> bool| {
            plan.mounts
                .iter()
                .position(|m| pred(m))
                .expect("expected mount not found in plan")
        };
        let deny_idx =
            index_of(&|m| matches!(m, MountOp::Tmpfs { target } if *target == denied_str));
        let writable_idx =
            index_of(&|m| matches!(m, MountOp::Bind { target, .. } if *target == ws));
        assert!(
            deny_idx < writable_idx,
            "the read deny must mount before the writable bind that it contains"
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn read_deny_inside_a_writable_root_mounts_after_it() {
        // The inverse of the case above, and the one the deny list used to
        // prune away. A credential store inside a writable root is only hidden
        // if its cover mounts AFTER the writable bind: bwrap applies mounts in
        // order and the last mount on a path wins, so a cover emitted earlier
        // is overridden by the deeper writable bind and hides nothing.
        let tmp = std::env::temp_dir().join(format!("bwrap_deny_inside_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let home = tmp.join("home");
        let credentials = home.join(".ssh");
        std::fs::create_dir_all(&credentials).unwrap();
        let ws = std::fs::canonicalize(&home)
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let denied = std::fs::canonicalize(&credentials)
            .unwrap()
            .to_string_lossy()
            .into_owned();

        let mut profile = profile_with_denies(&[&denied]);
        profile.file_system.writable_roots = vec![ws.clone()];
        let plan = plan(&profile, &ws);

        let index_of = |pred: &dyn Fn(&MountOp) -> bool| {
            plan.mounts
                .iter()
                .position(|m| pred(m))
                .expect("expected mount not found in plan")
        };
        let deny_idx = index_of(&|m| matches!(m, MountOp::Tmpfs { target } if *target == denied));
        let writable_idx =
            index_of(&|m| matches!(m, MountOp::Bind { target, .. } if *target == ws));
        assert!(
            writable_idx < deny_idx,
            "a read deny inside a writable root must mount after it or the writable bind re-exposes the credential"
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn read_deny_equal_to_a_writable_root_wins() {
        // A path both denied and writable is fail-closed: the cover is emitted
        // last so the deny wins, rather than the writable bind re-exposing it.
        let tmp = std::env::temp_dir().join(format!("bwrap_deny_tie_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let shared = tmp.join("shared");
        std::fs::create_dir_all(&shared).unwrap();
        let path = std::fs::canonicalize(&shared)
            .unwrap()
            .to_string_lossy()
            .into_owned();

        let mut profile = profile_with_denies(&[&path]);
        profile.file_system.writable_roots = vec![path.clone()];
        let plan = plan(&profile, &path);

        let index_of = |pred: &dyn Fn(&MountOp) -> bool| {
            plan.mounts
                .iter()
                .position(|m| pred(m))
                .expect("expected mount not found in plan")
        };
        let deny_idx = index_of(&|m| matches!(m, MountOp::Tmpfs { target } if *target == path));
        let writable_idx =
            index_of(&|m| matches!(m, MountOp::Bind { target, .. } if *target == path));
        assert!(
            writable_idx < deny_idx,
            "a deny equal to a writable root must be emitted after the writable bind"
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn nested_workspace_git_metadata_stays_read_only_bound() {
        // The protected-metadata guarantee must survive a workspace nested
        // inside a deny root. The deny list keeps the ANCESTOR entry for such a
        // workspace, so the ancestor containment test that used to drive the
        // skip must not: the ancestor cover mounts BEHIND the workspace's own
        // writable bind, so skipping these read-only binds left
        // `.git/hooks` (code execution) and `.git/config` (alias/filter
        // execution) writable inside a workspace the operator considers
        // protected.
        let tmp = std::env::temp_dir().join(format!("bwrap_nested_git_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let deny_root = tmp.join("skills");
        let workspace = deny_root.join("proj");
        let git_dir = workspace.join(".git");
        std::fs::create_dir_all(git_dir.join("hooks")).unwrap();
        std::fs::write(git_dir.join("config"), "[core]\n").unwrap();
        let denied = std::fs::canonicalize(&deny_root)
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let ws = std::fs::canonicalize(&workspace)
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let hooks = format!("{ws}/.git/hooks");
        let config = format!("{ws}/.git/config");

        let mut profile = profile_with_denies(&[&denied]);
        profile.file_system.writable_roots = vec![ws.clone()];
        profile.file_system.read_only_subpaths = vec![hooks.clone(), config.clone()];
        let plan = plan(&profile, &ws);

        for protected in [&hooks, &config] {
            assert!(
                plan.mounts.iter().any(|m| matches!(
                    m,
                    MountOp::RoBind { source, target } if source == protected && target == protected
                )),
                "{protected} must stay read-only bound when the workspace is nested inside a deny root"
            );
        }

        let writable_idx = plan
            .mounts
            .iter()
            .position(|m| matches!(m, MountOp::Bind { target, .. } if *target == ws))
            .expect("workspace writable bind missing");
        for protected in [&hooks, &config] {
            let protected_idx = plan
                .mounts
                .iter()
                .position(|m| matches!(
                    m,
                    MountOp::RoBind { source, target } if source == protected && target == protected
                ))
                .expect("read-only bind missing");
            assert!(
                writable_idx < protected_idx,
                "the read-only bind for {protected} must follow the workspace writable bind"
            );
        }
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn metadata_ro_bind_skips_missing_and_binds_existing() {
        let tmp = std::env::temp_dir().join(format!("bwrap_meta_test_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(tmp.join(".agents")).unwrap();
        let ws = tmp.to_string_lossy().into_owned();
        let mut profile = make_profile(&ws, "full", vec![&ws], vec![], vec![]);
        profile.file_system.protected_metadata_names = vec![".agents".into(), ".codex".into()];
        let plan = plan(&profile, &ws);
        assert!(
            plan.mounts.iter().any(|m| {
                matches!(m, MountOp::RoBind { source, target }
                    if source == &format!("{ws}/.agents") && target == &format!("{ws}/.agents"))
            }),
            "existing metadata directory (.agents) must be ro-bound"
        );
        assert!(
            !plan.mounts.iter().any(|m| {
                matches!(m, MountOp::RoBind { source, target } if source == &format!("{ws}/.codex"))
            }),
            "missing metadata directory (.codex) must be skipped — bwrap hard-fails on missing --ro-bind sources"
        );
        let _ = std::fs::remove_dir_all(&tmp);
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
