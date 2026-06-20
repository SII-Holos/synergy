use crate::config::PermissionProfile;
use crate::error::HelperError;
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

/// Build a pure bwrap plan from a Synergy permission profile.
///
/// The plan intentionally starts with `--tmpfs /` for the restricted/default
/// filesystem view. Synergy does not use `--ro-bind / /` in this helper path;
/// every readable/writable root must be explicit.
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

    for root in &profile.file_system.writable_roots {
        push_bind(&mut mounts, root, root);
    }

    for subpath in &profile.file_system.read_only_subpaths {
        push_ro_bind(&mut mounts, subpath, subpath);
    }

    for protected_path in &profile.file_system.protected_paths {
        push_ro_bind(&mut mounts, protected_path, protected_path);
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

    for glob in &profile.file_system.unreadable_globs {
        if glob.starts_with('/') {
            mounts.push(MountOp::Tmpfs {
                target: glob.clone(),
            });
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
    fn writable_root_becomes_bind() {
        let profile = make_profile("/ws", "full", vec!["/ws"], vec![], vec![]);
        let plan = plan(&profile, "/ws");
        assert!(plan.mounts.iter().any(|m| {
            matches!(m, MountOp::Bind { source, target } if source == "/ws" && target == "/ws")
        }));
    }

    #[test]
    fn read_only_subpath_after_writable_binds() {
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
            .position(|m| matches!(m, MountOp::RoBind { source, target } if source == "/ws/.git" && target == "/ws/.git"))
            .unwrap();
        assert!(writable_bind_idx < read_only_subpath_idx);
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
}
