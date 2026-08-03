mod acl;
mod cleanup;
mod config;
mod conpty;
mod desktop;
mod elevated_session;
mod elevation;
mod env;
mod ipc_framed;
mod path;
mod pipe;
mod process;
mod setup;
mod sid;
mod token;
mod wfp;

use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};

fn normalized_safety_path(path: &str) -> String {
    path.replace('/', "\\")
        .trim_end_matches('\\')
        .to_ascii_lowercase()
}

fn is_volume_root(path: &str) -> bool {
    path::is_volume_root(path)
}

/// Accept only deny-read roots that cannot cover the execution workspace.
/// This is intentionally fail-closed: the shared profile can supply the
/// user's home directory as a legacy deny root, but changing that directory's
/// DACL would affect the whole sandbox workspace and unrelated profile data.
fn safe_data_deny_roots(
    data_deny_roots: &[String],
    workspace: &str,
) -> Result<Vec<String>, String> {
    let workspace = normalized_safety_path(workspace);
    if is_volume_root(&workspace) {
        return Err(format!(
            "workspace {workspace} is a volume root; refusing to apply deny roots"
        ));
    }
    let mut seen = std::collections::HashSet::new();
    let mut safe = Vec::new();

    for root in data_deny_roots {
        let normalized = normalized_safety_path(root);
        if root.replace('/', "\\").split('\\').any(|part| part == "..") {
            return Err(format!("deny root {root} contains '..' and is refused"));
        }
        let is_absolute = (normalized.len() >= 3
            && normalized.as_bytes()[1] == b':'
            && normalized.as_bytes()[2] == b'\\')
            || normalized.starts_with(r"\\");
        let is_device_namespace =
            normalized.starts_with(r"\\?\") || normalized.starts_with(r"\\.\");
        if normalized.is_empty()
            || !is_absolute
            || is_device_namespace
            || is_volume_root(&normalized)
        {
            return Err(format!(
                "deny root {root} is not a non-root absolute Windows directory"
            ));
        }

        let contains_workspace = workspace == normalized
            || workspace
                .strip_prefix(&normalized)
                .is_some_and(|suffix| suffix.starts_with('\\'));
        if contains_workspace {
            return Err(format!(
                "deny root {root} contains the workspace {workspace}; refusing to weaken the configured deny-read policy"
            ));
        }

        if seen.insert(normalized) {
            safe.push(root.clone());
        }
    }

    Ok(safe)
}

struct DesktopCleanup {
    handles: Option<(isize, isize)>,
}

impl DesktopCleanup {
    fn new(handles: Option<(isize, isize)>) -> Self {
        Self { handles }
    }
}

impl Drop for DesktopCleanup {
    fn drop(&mut self) {
        if let Some((private, original)) = self.handles.take() {
            unsafe {
                desktop::switch_to_desktop(original);
                desktop::close_desktop(private);
            }
            log::info!("Private desktop closed, original desktop restored");
        }
    }
}

struct KernelHandleCleanup {
    handle: Option<HANDLE>,
}

impl KernelHandleCleanup {
    fn new(handle: HANDLE) -> Self {
        Self {
            handle: if handle.is_null() || handle == INVALID_HANDLE_VALUE {
                None
            } else {
                Some(handle)
            },
        }
    }

    fn take(&mut self) -> HANDLE {
        self.handle.take().unwrap_or(std::ptr::null_mut())
    }
}

impl Drop for KernelHandleCleanup {
    fn drop(&mut self) {
        if let Some(handle) = self.handle.take() {
            unsafe { CloseHandle(handle) };
        }
    }
}

#[cfg(test)]
mod lifecycle_tests {
    use super::safe_data_deny_roots;

    #[test]
    fn data_deny_roots_do_not_cover_the_workspace_or_a_volume_root() {
        let roots = safe_data_deny_roots(
            &[
                r"C:\Users\alice\secrets".into(),
                r"C:\Users\alice\project\secrets".into(),
            ],
            r"C:\Users\alice\project",
        )
        .unwrap();

        assert_eq!(
            roots,
            vec![r"C:\Users\alice\secrets", r"C:\Users\alice\project\secrets"]
        );
    }

    #[test]
    fn data_deny_roots_are_deduplicated_without_case_or_separator_variants() {
        let roots = safe_data_deny_roots(
            &[
                r"C:\Users\alice\secrets".into(),
                r"c:/users/alice/secrets".into(),
            ],
            r"C:\Users\alice\project",
        )
        .unwrap();

        assert_eq!(roots, vec![r"C:\Users\alice\secrets"]);
    }

    #[test]
    fn workspace_ancestor_is_a_configuration_error_not_a_silent_skip() {
        let error = safe_data_deny_roots(&[r"C:\Users\alice".into()], r"C:\Users\alice\project")
            .unwrap_err();

        assert!(error.contains("contains the workspace"));
        assert!(error.contains("refusing"));
    }

    #[test]
    fn unsafe_roots_are_rejected_instead_of_being_dropped() {
        assert!(safe_data_deny_roots(&[r"C:\".into()], r"C:\Users\alice\project").is_err());
        assert!(safe_data_deny_roots(
            &[r"C:\Users\alice\..\secrets".into()],
            r"C:\Users\alice\project"
        )
        .is_err());
        assert!(
            safe_data_deny_roots(&[r"relative\secrets".into()], r"C:\Users\alice\project").is_err()
        );
    }
}

fn main() {
    // std::process::exit passes the i32 through to ExitProcess on Windows;
    // ExitCode::from(u8) would truncate child exit codes above 255.
    std::process::exit(run());
}

fn run() -> i32 {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("warn"))
        .target(env_logger::Target::Stderr)
        .init();

    let _cleanup_guard = cleanup::CleanupGuard::new();

    let args: Vec<String> = std::env::args().collect();

    // Parse command line: synergy-sandbox-windows.exe --permission-profile <path> [--cwd <path>] -- <cmd> <args...>
    // OR config via stdin if no --permission-profile flag
    let mut config_path: Option<String> = None;
    let mut cwd_arg: Option<String> = None;
    let mut child_cmd: Option<String> = None;
    let mut child_args: Vec<String> = Vec::new();
    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--permission-profile" => {
                if i + 1 < args.len() {
                    config_path = Some(args[i + 1].clone());
                    i += 1;
                }
            }
            "--cwd" => {
                if i + 1 < args.len() {
                    cwd_arg = Some(args[i + 1].clone());
                    i += 1;
                }
            }
            "--" => {
                if i + 1 < args.len() {
                    child_cmd = Some(args[i + 1].clone());
                    child_args = args[i + 2..].to_vec();
                }
                break;
            }
            _ => {}
        }
        i += 1;
    }

    // Parse config
    let profile: config::PermissionProfile = if let Some(ref path) = config_path {
        match config::load_permission_profile(path) {
            Ok(profile) => profile,
            Err(e) => {
                log::error!("Failed to load permission profile {}: {}", path, e);
                return 1;
            }
        }
    } else {
        match config::parse_config() {
            Ok(profile) => profile,
            Err(e) => {
                log::error!("Failed to parse stdin config: {}", e);
                return 1;
            }
        }
    };

    let command = match child_cmd {
        Some(command) => command,
        None => {
            log::error!("Missing child command after -- separator");
            return 1;
        }
    };
    let execution_cwd = cwd_arg.unwrap_or_else(|| profile.file_system.workspace.clone());

    log::info!(
        "Sandbox helper starting: network={}, command={}",
        profile.network.mode,
        command
    );

    // Check if elevated backend is required (deny-read DACL or WFP filters)
    if profile.file_system.data_deny_roots.len() > 0 || profile.network.wfp_enabled {
        log::info!(
            "Deny-read or WFP requested, elevated backend required (not yet fully implemented)"
        );
    }

    // Step 1: Canonicalize paths
    let canonical_workspace =
        match path::canonicalize_existing_win_path(&profile.file_system.workspace) {
            Ok(path) => path,
            Err(e) => {
                log::error!("Path canonicalization failed for workspace: {}", e);
                return 1;
            }
        };
    let canonical_cwd = match path::canonicalize_existing_win_path(&execution_cwd) {
        Ok(path) => path,
        Err(e) => {
            log::error!("Path canonicalization failed for cwd: {}", e);
            return 1;
        }
    };

    // Resolve and validate deny roots before any ACL is changed. An invalid
    // root (including the default home ancestor) is a profile error: dropping
    // it would make the requested deny-read policy silently ineffective.
    let canonical_deny_roots = match profile
        .file_system
        .data_deny_roots
        .iter()
        .map(|root| path::canonicalize_deny_root(root))
        .collect::<Result<Vec<_>, _>>()
    {
        Ok(roots) => roots,
        Err(e) => {
            log::error!("Unsafe data deny root; refusing to start sandbox: {}", e);
            return 1;
        }
    };
    let safe_deny_roots = match safe_data_deny_roots(&canonical_deny_roots, &canonical_workspace) {
        Ok(roots) => roots,
        Err(e) => {
            log::error!("Invalid data deny roots; refusing to start sandbox: {}", e);
            return 1;
        }
    };

    log::info!("Workspace: {}", canonical_workspace);
    log::info!("Execution CWD: {}", canonical_cwd);

    // Step 2: Create restricted token
    let restricted_token = match unsafe { token::create_restricted_token() } {
        Ok(token) => token,
        Err(e) => {
            log::error!("Failed to create restricted token: {}", e);
            return 1;
        }
    };
    let mut token_cleanup = KernelHandleCleanup::new(restricted_token);

    // Step 3: Create Job Object
    let job = match unsafe { process::create_sandbox_job() } {
        Ok(job) => job,
        Err(e) => {
            log::error!("Failed to create job object: {}", e);
            return 1;
        }
    };
    let mut job_cleanup = KernelHandleCleanup::new(job);

    // Step 3a: Create private desktop (isolates clipboard, UI, and user input)
    let desktop_handles: Option<(isize, isize)> = unsafe {
        match desktop::create_private_desktop(desktop::default_desktop_name()) {
            Ok((private, original)) => {
                log::info!("Private desktop created successfully");
                Some((private, original))
            }
            Err(e) => {
                log::warn!("Private desktop creation failed (non-fatal): {}", e);
                None
            }
        }
    };
    let _desktop_cleanup = DesktopCleanup::new(desktop_handles);

    // Step 4: Apply DACL to protected paths
    if !profile.file_system.protected_paths.is_empty() {
        let saved_acls = match unsafe { acl::protect_paths(&profile.file_system.protected_paths) } {
            Ok(acls) => acls,
            Err(e) => {
                log::error!("Failed to apply DACL: {}", e);
                return 1;
            }
        };

        cleanup::register_dacl_cleanup(saved_acls);
    }

    // Step 4b: Apply deny-read DACL to dataDenyRoots
    if !safe_deny_roots.is_empty() {
        let saved_read_acls = match unsafe { acl::protect_paths_deny_read(&safe_deny_roots) } {
            Ok(acls) => acls,
            Err(e) => {
                log::error!("Failed to apply deny-read DACL: {}", e);
                return 1;
            }
        };

        cleanup::register_dacl_cleanup(saved_read_acls);
    }

    // Step 4a: Install WFP filters (network sandboxing via Windows Filtering Platform)
    if profile.network.wfp_enabled
        && (profile.network.mode == "restricted" || profile.network.mode == "proxy_only")
    {
        if let Ok(username) = std::env::var("USERNAME") {
            match wfp::install_wfp_filters_for_account(&username) {
                Ok(count) => {
                    log::info!("WFP: installed {} network filters for {}", count, username)
                }
                Err(e) => log::warn!("WFP: filter installation failed (non-fatal): {}", e),
            }
        }
    }

    // Step 5: Create process (suspended, assign to job, resume)
    let cmd_args: Vec<&str> = child_args.iter().map(|s: &String| s.as_str()).collect();
    let exit_code = match unsafe {
        process::create_sandboxed_process(
            token_cleanup.take(),
            job_cleanup.take(),
            &command,
            &cmd_args,
            &canonical_cwd,
            false,
        )
    } {
        Ok(exit_code) => exit_code,
        Err(e) => {
            log::error!("Failed to create sandboxed process: {}", e);
            return 1;
        }
    };

    log::info!("Sandbox helper exiting with code: {}", exit_code);
    exit_code
}
