mod acl;
mod cleanup;
mod config;
mod path;
mod process;
mod token;

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

    // Step 4: Apply DACL to protected paths
    if !profile.file_system.protected_paths.is_empty() {
        let saved_acls = unsafe { acl::protect_paths(&profile.file_system.protected_paths) }
            .unwrap_or_else(|e| {
                log::error!("Failed to apply DACL: {}", e);
                exit(1);
            });

        cleanup::register_dacl_cleanup(saved_acls);
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
        )
    }
    .unwrap_or_else(|e| {
        log::error!("Failed to create sandboxed process: {}", e);
        exit(1);
    });

    // Step 6: Cleanup (DACL restore)
    cleanup::restore_all();

    log::info!("Sandbox helper exiting with code: {}", exit_code);
    exit(exit_code);
}
