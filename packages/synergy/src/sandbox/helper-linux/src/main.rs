// Synergy Linux sandbox helper — entrypoint
//
// CLI contract:
//   synergy-sandbox-linux --sandbox-policy-cwd <path> --permission-profile <json-path> -- <cmd> <args...>
//
// The helper receives:
//   1. --sandbox-policy-cwd: execution working directory
//   2. --permission-profile: path to JSON permission profile
//   3. --: separator, then the child command and its args
//
// Phase 2 baseline: echoes args and exits 0. Full implementation lands in Phase 3/4.
// This scaffold validates the CLI contract and JSON config parsing surface.

mod config;

use std::process::exit;

fn main() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("warn"))
        .target(env_logger::Target::Stderr)
        .init();

    let args: Vec<String> = std::env::args().collect();

    // Parse CLI: synergy-sandbox-linux --sandbox-policy-cwd <path> --permission-profile <json-path> -- <cmd> <args...>
    let mut sandbox_policy_cwd: Option<String> = None;
    let mut permission_profile: Option<String> = None;
    let mut separator_found = false;
    let mut child_cmd: Option<String> = None;
    let mut child_args: Vec<String> = Vec::new();

    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--sandbox-policy-cwd" => {
                if i + 1 < args.len() {
                    sandbox_policy_cwd = Some(args[i + 1].clone());
                    i += 1;
                }
            }
            "--permission-profile" => {
                if i + 1 < args.len() {
                    permission_profile = Some(args[i + 1].clone());
                    i += 1;
                }
            }
            "--" => {
                separator_found = true;
                // Everything after -- is the child command and args
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

    if !separator_found {
        log::error!("Missing '--' separator before child command");
        exit(1);
    }

    let policy_cwd = sandbox_policy_cwd.unwrap_or_else(|| {
        log::error!("Missing required --sandbox-policy-cwd argument");
        exit(1);
    });

    let profile_path = permission_profile.unwrap_or_else(|| {
        log::error!("Missing required --permission-profile argument");
        exit(1);
    });

    let cmd = child_cmd.unwrap_or_else(|| {
        log::error!("Missing child command after -- separator");
        exit(1);
    });

    // Phase 2 baseline: parse the config to validate JSON shape, then echo.
    // Full sandbox enforcement (bwrap, Landlock, seccomp) lands in Phase 3/4.
    let _profile = config::load_permission_profile(&profile_path).unwrap_or_else(|e| {
        log::error!("Failed to load permission profile {}: {}", profile_path, e);
        exit(1);
    });

    log::info!(
        "Sandbox helper starting: workspace={}, command={}",
        policy_cwd,
        cmd
    );

    // Phase 2 baseline: passthrough — execute command unsandboxed.
    // The TS side handles sandboxed: false delivery; this scaffold proves
    // the binary is found, hashable, and CLI-contract-compatible.
    let status = std::process::Command::new(&cmd)
        .args(&child_args)
        .current_dir(&policy_cwd)
        .status()
        .unwrap_or_else(|e| {
            log::error!("Failed to execute {}: {}", cmd, e);
            exit(1);
        });

    let code = status.code().unwrap_or(1);
    log::info!("Sandbox helper exiting with code: {}", code);
    exit(code);
}
