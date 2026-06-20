// Synergy Linux sandbox helper — entrypoint
//
// CLI contract:
//   synergy-sandbox-linux --sandbox-policy-cwd <path> --permission-profile <json-path> -- <cmd> <args...>
//
// Stage 1 starts bwrap with this helper as the stage-2 executable.
// Stage 2 applies no_new_privs / seccomp contracts and execs the child command.

use std::path::Path;
use std::process::exit;
use synergy_sandbox_linux::{bwrap, config, seccomp};

#[derive(Debug, Clone)]
struct HelperArgs {
    sandbox_policy_cwd: String,
    permission_profile: String,
    child_command: Vec<String>,
    apply_seccomp_then_exec: bool,
}

fn main() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("warn"))
        .target(env_logger::Target::Stderr)
        .init();

    let helper_args = parse_args(std::env::args().collect()).unwrap_or_else(|message| {
        log::error!("{message}");
        exit(1);
    });

    let profile =
        config::load_permission_profile(&helper_args.permission_profile).unwrap_or_else(|e| {
            log::error!(
                "Failed to load permission profile {}: {}",
                helper_args.permission_profile,
                e
            );
            exit(1);
        });

    if helper_args.apply_seccomp_then_exec {
        run_stage_two(helper_args, profile).unwrap_or_else(|message| {
            log::error!("{message}");
            exit(1);
        });
        return;
    }

    let current_exe = std::env::current_exe().unwrap_or_else(|e| {
        log::error!("Failed to locate helper executable: {e}");
        exit(1);
    });

    ensure_controlled_tmp(&helper_args.sandbox_policy_cwd).unwrap_or_else(|e| {
        log::error!("Failed to prepare controlled /tmp: {e}");
        exit(1);
    });

    let inner_command = build_inner_command(&current_exe, &helper_args);
    let plan = bwrap::build_bwrap_plan(
        &profile,
        Path::new(&helper_args.sandbox_policy_cwd),
        &inner_command,
    )
    .unwrap_or_else(|e| {
        log::error!("Failed to build bwrap plan: {e}");
        exit(1);
    });

    log::info!(
        "Starting bwrap sandbox: workspace={}, command={}",
        helper_args.sandbox_policy_cwd,
        helper_args.child_command[0]
    );

    let status = std::process::Command::new(bwrap_binary())
        .args(plan.args())
        .status()
        .unwrap_or_else(|e| {
            log::error!("Failed to execute bwrap: {e}");
            exit(1);
        });

    exit(status.code().unwrap_or(1));
}

fn parse_args(args: Vec<String>) -> Result<HelperArgs, String> {
    let mut sandbox_policy_cwd: Option<String> = None;
    let mut permission_profile: Option<String> = None;
    let mut apply_seccomp_then_exec = false;
    let mut child_command: Vec<String> = Vec::new();

    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--apply-seccomp-then-exec" => {
                apply_seccomp_then_exec = true;
            }
            "--sandbox-policy-cwd" => {
                let value = args
                    .get(i + 1)
                    .ok_or_else(|| "Missing value for --sandbox-policy-cwd".to_string())?;
                sandbox_policy_cwd = Some(value.clone());
                i += 1;
            }
            "--permission-profile" => {
                let value = args
                    .get(i + 1)
                    .ok_or_else(|| "Missing value for --permission-profile".to_string())?;
                permission_profile = Some(value.clone());
                i += 1;
            }
            "--" => {
                child_command = args[i + 1..].to_vec();
                break;
            }
            other => {
                return Err(format!("Unknown argument before -- separator: {other}"));
            }
        }
        i += 1;
    }

    if child_command.is_empty() {
        return Err("Missing child command after -- separator".into());
    }

    Ok(HelperArgs {
        sandbox_policy_cwd: sandbox_policy_cwd
            .ok_or_else(|| "Missing required --sandbox-policy-cwd argument".to_string())?,
        permission_profile: permission_profile
            .ok_or_else(|| "Missing required --permission-profile argument".to_string())?,
        child_command,
        apply_seccomp_then_exec,
    })
}

fn build_inner_command(current_exe: &Path, args: &HelperArgs) -> Vec<String> {
    let mut command = vec![
        current_exe.to_string_lossy().into_owned(),
        "--apply-seccomp-then-exec".into(),
        "--sandbox-policy-cwd".into(),
        args.sandbox_policy_cwd.clone(),
        "--permission-profile".into(),
        args.permission_profile.clone(),
        "--".into(),
    ];
    command.extend(args.child_command.clone());
    command
}

fn ensure_controlled_tmp(policy_cwd: &str) -> Result<(), std::io::Error> {
    std::fs::create_dir_all(Path::new(policy_cwd).join(".synergy").join("tmp"))
}

fn bwrap_binary() -> String {
    std::env::var("SYNERGY_BWRAP").unwrap_or_else(|_| "bwrap".into())
}

fn run_stage_two(args: HelperArgs, profile: config::PermissionProfile) -> Result<(), String> {
    seccomp::apply_no_new_privs().map_err(|e| e.to_string())?;
    let seccomp_mode = match profile.network.mode.as_str() {
        "full" => seccomp::NetworkSeccompMode::Full,
        "proxy_only" => seccomp::NetworkSeccompMode::ProxyOnly,
        _ => seccomp::NetworkSeccompMode::Restricted,
    };
    let seccomp_plan = seccomp::build_seccomp_plan(seccomp_mode);
    seccomp::load_seccomp_filter(&seccomp_plan).map_err(|e| e.to_string())?;
    exec_child(&args.child_command, &args.sandbox_policy_cwd)
}

#[cfg(unix)]
fn exec_child(command: &[String], cwd: &str) -> Result<(), String> {
    use std::os::unix::process::CommandExt;
    let error = std::process::Command::new(&command[0])
        .args(&command[1..])
        .current_dir(cwd)
        .exec();
    Err(format!("Failed to exec {}: {}", command[0], error))
}

#[cfg(not(unix))]
fn exec_child(command: &[String], cwd: &str) -> Result<(), String> {
    let status = std::process::Command::new(&command[0])
        .args(&command[1..])
        .current_dir(cwd)
        .status()
        .map_err(|e| format!("Failed to execute {}: {}", command[0], e))?;
    exit(status.code().unwrap_or(1));
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn parse_requires_separator_and_child_command() {
        let err = parse_args(vec![
            "helper".into(),
            "--sandbox-policy-cwd".into(),
            "/ws".into(),
        ])
        .unwrap_err();
        assert!(err.contains("child command"));
    }

    #[test]
    fn parse_reads_stage_two_flag() {
        let args = parse_args(vec![
            "helper".into(),
            "--apply-seccomp-then-exec".into(),
            "--sandbox-policy-cwd".into(),
            "/ws".into(),
            "--permission-profile".into(),
            "/tmp/profile.json".into(),
            "--".into(),
            "echo".into(),
            "ok".into(),
        ])
        .unwrap();
        assert!(args.apply_seccomp_then_exec);
        assert_eq!(args.child_command, vec!["echo", "ok"]);
    }

    #[test]
    fn inner_command_reenters_helper_with_stage_two_flag() {
        let args = HelperArgs {
            sandbox_policy_cwd: "/ws".into(),
            permission_profile: "/tmp/profile.json".into(),
            child_command: vec!["echo".into(), "ok".into()],
            apply_seccomp_then_exec: false,
        };
        let inner = build_inner_command(&PathBuf::from("/bin/synergy-sandbox-linux"), &args);
        assert!(inner.contains(&"--apply-seccomp-then-exec".to_string()));
        assert_eq!(inner[0], "/bin/synergy-sandbox-linux");
        assert_eq!(inner[inner.len() - 2], "echo");
        assert_eq!(inner[inner.len() - 1], "ok");
    }
}
