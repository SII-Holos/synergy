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

    // Parse command line: synergy-sandbox.exe --config <path> -- <cmd> <args...>
    // OR config via stdin if no --config flag
    let mut config_path: Option<String> = None;
    for (i, arg) in args.iter().enumerate().skip(1) {
        if arg == "--config" && i + 1 < args.len() {
            config_path = Some(args[i + 1].clone());
        }
        if arg == "--" {
            break;
        }
    }

    // Parse config
    let sandbox_config: config::SandboxConfig = if let Some(ref path) = config_path {
        let content = std::fs::read_to_string(path).unwrap_or_else(|e| {
            log::error!("Failed to read config file {}: {}", path, e);
            exit(1);
        });
        serde_json::from_str(&content).unwrap_or_else(|e| {
            log::error!("Failed to parse config: {}", e);
            exit(1);
        })
    } else {
        config::parse_config().unwrap_or_else(|e| {
            log::error!("Failed to parse stdin config: {}", e);
            exit(1);
        })
    };

    log::info!(
        "Sandbox helper starting: level={}, mode={}, command={}",
        sandbox_config.level,
        sandbox_config.mode,
        sandbox_config.command
    );

    // Step 1: Canonicalize paths
    let canonical_workspace =
        path::canonicalize_win_path(&sandbox_config.workspace).unwrap_or_else(|e| {
            log::error!("Path canonicalization failed for workspace: {}", e);
            exit(1);
        });
    let canonical_cwd =
        path::canonicalize_win_path(&sandbox_config.execution_cwd).unwrap_or_else(|e| {
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
    if !sandbox_config.protected_paths.is_empty() {
        let saved_acls =
            unsafe { acl::protect_paths(&sandbox_config.protected_paths) }.unwrap_or_else(|e| {
                log::error!("Failed to apply DACL: {}", e);
                exit(1);
            });

        cleanup::register_dacl_cleanup(saved_acls);
    }

    // Step 5: Create process (suspended, assign to job, resume)
    let cmd_args: Vec<&str> = sandbox_config
        .args
        .iter()
        .map(|s: &String| s.as_str())
        .collect();
    let exit_code = unsafe {
        process::create_sandboxed_process(
            restricted_token,
            job,
            &sandbox_config.command,
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
