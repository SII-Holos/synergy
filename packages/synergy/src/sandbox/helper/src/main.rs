mod acl;
mod cleanup;
mod config;
mod conpty;
mod desktop;
mod elevated_session;
mod elevation;
mod pipe;
mod env;
mod ipc_framed;
mod path;
mod process;
mod setup;
mod sid;
mod token;
mod wfp;

use std::process::exit;

fn main() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("warn"))
        .target(env_logger::Target::Stderr)
        .init();

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
        config::load_permission_profile(path).unwrap_or_else(|e| {
            log::error!("Failed to load permission profile {}: {}", path, e);
            exit(1);
        })
    } else {
        config::parse_config().unwrap_or_else(|e| {
            log::error!("Failed to parse stdin config: {}", e);
            exit(1);
        })
    };

    let command = child_cmd.unwrap_or_else(|| {
        log::error!("Missing child command after -- separator");
        exit(1);
    });
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
    let canonical_workspace = path::canonicalize_win_path(&profile.file_system.workspace)
        .unwrap_or_else(|e| {
            log::error!("Path canonicalization failed for workspace: {}", e);
            exit(1);
        });
    let canonical_cwd = path::canonicalize_win_path(&execution_cwd).unwrap_or_else(|e| {
        log::error!("Path canonicalization failed for cwd: {}", e);
        exit(1);
    });

    log::info!("Workspace: {}", canonical_workspace);
    log::info!("Execution CWD: {}", canonical_cwd);

    // Step 2: Create restricted token
    let restricted_token = unsafe { token::create_restricted_token() }.unwrap_or_else(|e| {
        log::error!("Failed to create restricted token: {}", e);
        exit(1);
    });

    // Step 3: Create Job Object
    let job = unsafe { process::create_sandbox_job() }.unwrap_or_else(|e| {
        log::error!("Failed to create job object: {}", e);
        exit(1);
    });

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

    // Step 4: Apply DACL to protected paths
    if !profile.file_system.protected_paths.is_empty() {
        let saved_acls = unsafe { acl::protect_paths(&profile.file_system.protected_paths) }
            .unwrap_or_else(|e| {
                log::error!("Failed to apply DACL: {}", e);
                exit(1);
            });

        cleanup::register_dacl_cleanup(saved_acls);
    }

    // Step 4b: Apply deny-read DACL to dataDenyRoots
    if !profile.file_system.data_deny_roots.is_empty() {
        let saved_read_acls =
            unsafe { acl::protect_paths_deny_read(&profile.file_system.data_deny_roots) }
                .unwrap_or_else(|e| {
                    log::error!("Failed to apply deny-read DACL: {}", e);
                    exit(1);
                });

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
    let exit_code = unsafe {
        process::create_sandboxed_process(
            restricted_token,
            job,
            &command,
            &cmd_args,
            &canonical_cwd,
            false,
        )
    }
    .unwrap_or_else(|e| {
        log::error!("Failed to create sandboxed process: {}", e);
        exit(1);
    });

    // Step 6: Desktop cleanup — restore original and close private desktop
    if let Some((private, original)) = desktop_handles {
        unsafe {
            desktop::switch_to_desktop(original);
            desktop::close_desktop(private);
        }
        log::info!("Private desktop closed, original desktop restored");
    }

    // Step 7: Cleanup (DACL restore)
    cleanup::restore_all();

    log::info!("Sandbox helper exiting with code: {}", exit_code);
    exit(exit_code);
}
