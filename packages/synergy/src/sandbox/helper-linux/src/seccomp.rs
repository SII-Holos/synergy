use std::collections::HashSet;

use crate::error::HelperError;

/// Network seccomp filtering mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NetworkSeccompMode {
    /// Allow all network-related syscalls.
    Full,
    /// Deny direct network access except local Unix-domain IPC contracts.
    Restricted,
    /// Allow only the proxy bridge path; distinct from full and restricted.
    ProxyOnly,
}

/// A structured seccomp rule within a plan.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SeccompRule {
    AlwaysDeny { syscall: &'static str },
    NetworkDeny { syscall: &'static str },
}

/// Compiled seccomp plan ready for filter construction.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SeccompPlan {
    pub rules: Vec<SeccompRule>,
}

impl SeccompPlan {
    pub fn always_denied_names(&self) -> HashSet<&'static str> {
        self.rules
            .iter()
            .filter_map(|r| match r {
                SeccompRule::AlwaysDeny { syscall } => Some(*syscall),
                _ => None,
            })
            .collect()
    }

    pub fn network_denied_names(&self) -> HashSet<&'static str> {
        self.rules
            .iter()
            .filter_map(|r| match r {
                SeccompRule::NetworkDeny { syscall } => Some(*syscall),
                _ => None,
            })
            .collect()
    }
}

/// Build a structured seccomp plan from the network mode.
///
/// This is an architecture-independent representation; the final BPF compiler
/// consumes the plan when running on Linux. Keeping the representation pure makes
/// the sandbox policy testable on macOS CI.
pub fn build_seccomp_plan(mode: NetworkSeccompMode) -> SeccompPlan {
    let mut rules = Vec::new();
    for syscall in always_denied_syscalls() {
        rules.push(SeccompRule::AlwaysDeny { syscall });
    }
    for syscall in network_denied_syscalls(mode) {
        rules.push(SeccompRule::NetworkDeny { syscall });
    }
    SeccompPlan { rules }
}

/// Syscalls denied regardless of network mode.
pub fn always_denied_syscalls() -> Vec<&'static str> {
    vec![
        // Kernel module loading
        "init_module",
        "finit_module",
        "delete_module",
        "create_module",
        "get_kernel_syms",
        "query_module",
        // Privileged mount / boot operations
        "mount",
        "umount2",
        "pivot_root",
        "swapoff",
        "swapon",
        "reboot",
        "kexec_load",
        "kexec_file_load",
        // Kernel attack-surface amplifiers
        "bpf",
        "perf_event_open",
        // Cross-process debugging / memory access
        "ptrace",
        "process_vm_readv",
        "process_vm_writev",
        // io_uring may bypass syscall-level mediation once rings exist.
        "io_uring_setup",
        "io_uring_enter",
        "io_uring_register",
    ]
}

/// Network-related syscalls denied based on selected mode.
pub fn network_denied_syscalls(mode: NetworkSeccompMode) -> Vec<&'static str> {
    match mode {
        NetworkSeccompMode::Full => vec![],
        NetworkSeccompMode::Restricted => vec![
            "socket",
            "connect",
            "accept",
            "accept4",
            "bind",
            "listen",
            "shutdown",
            "getsockname",
            "getpeername",
            "sendto",
            "sendmsg",
            "sendmmsg",
            "recvfrom",
            "recvmsg",
            "recvmmsg",
            "setsockopt",
            "getsockopt",
        ],
        NetworkSeccompMode::ProxyOnly => vec![
            "socket",
            "connect",
            "accept",
            "accept4",
            "bind",
            "listen",
            "shutdown",
            "getsockname",
            "getpeername",
            "socketpair",
            "sendto",
            "sendmsg",
            "sendmmsg",
            "recvfrom",
            "recvmsg",
            "recvmmsg",
            "setsockopt",
            "getsockopt",
        ],
    }
}

/// Apply PR_SET_NO_NEW_PRIVS before loading seccomp filters.
pub fn apply_no_new_privs() -> Result<(), HelperError> {
    apply_no_new_privs_impl()
}

#[cfg(target_os = "linux")]
fn apply_no_new_privs_impl() -> Result<(), HelperError> {
    let rc = unsafe { libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) };
    if rc == 0 {
        Ok(())
    } else {
        Err(HelperError::Seccomp(format!(
            "PR_SET_NO_NEW_PRIVS failed: {}",
            std::io::Error::last_os_error()
        )))
    }
}

#[cfg(not(target_os = "linux"))]
fn apply_no_new_privs_impl() -> Result<(), HelperError> {
    Ok(())
}

/// Whether proxy_only mode has its own seccomp path.
pub fn proxy_only_has_distinct_filter() -> bool {
    network_denied_syscalls(NetworkSeccompMode::ProxyOnly)
        != network_denied_syscalls(NetworkSeccompMode::Restricted)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn always_denied_syscalls_non_empty() {
        assert!(!always_denied_syscalls().is_empty());
    }

    #[test]
    fn network_denied_syscalls_full_is_empty() {
        assert!(network_denied_syscalls(NetworkSeccompMode::Full).is_empty());
    }

    #[test]
    fn network_denied_syscalls_restricted_non_empty() {
        assert!(!network_denied_syscalls(NetworkSeccompMode::Restricted).is_empty());
    }

    #[test]
    fn network_denied_syscalls_proxy_only_non_empty() {
        assert!(!network_denied_syscalls(NetworkSeccompMode::ProxyOnly).is_empty());
    }

    #[test]
    fn apply_no_new_privs_succeeds() {
        apply_no_new_privs().expect("no_new_privs should be applicable or no-op on this platform");
    }

    #[test]
    fn always_denied_includes_ptrace() {
        assert!(always_denied_syscalls().contains(&"ptrace"));
    }

    #[test]
    fn always_denied_includes_process_vm_readv() {
        assert!(always_denied_syscalls().contains(&"process_vm_readv"));
    }

    #[test]
    fn always_denied_includes_io_uring_setup() {
        assert!(always_denied_syscalls().contains(&"io_uring_setup"));
    }

    #[test]
    fn always_denied_includes_io_uring_enter() {
        assert!(always_denied_syscalls().contains(&"io_uring_enter"));
    }

    #[test]
    fn always_denied_includes_io_uring_register() {
        assert!(always_denied_syscalls().contains(&"io_uring_register"));
    }

    #[test]
    fn restricted_network_denies_bind() {
        assert!(network_denied_syscalls(NetworkSeccompMode::Restricted).contains(&"bind"));
    }

    #[test]
    fn restricted_network_denies_listen() {
        assert!(network_denied_syscalls(NetworkSeccompMode::Restricted).contains(&"listen"));
    }

    #[test]
    fn proxy_only_has_distinct_filter_contract() {
        assert!(proxy_only_has_distinct_filter());
    }

    // ── SeccompPlan RED tests ──
    // These tests define the contract for build_seccomp_plan(). The stub
    // returns an empty plan, so all assertions below will currently FAIL.

    #[test]
    fn build_seccomp_plan_restricted_includes_always_denied() {
        let plan = build_seccomp_plan(NetworkSeccompMode::Restricted);
        let names = plan.always_denied_names();
        assert!(
            names.contains("ptrace"),
            "restricted plan must always-deny ptrace"
        );
        assert!(
            names.contains("process_vm_readv"),
            "restricted plan must always-deny process_vm_readv"
        );
        assert!(
            names.contains("process_vm_writev"),
            "restricted plan must always-deny process_vm_writev"
        );
        assert!(
            names.contains("io_uring_setup"),
            "restricted plan must always-deny io_uring_setup"
        );
        assert!(
            names.contains("io_uring_enter"),
            "restricted plan must always-deny io_uring_enter"
        );
        assert!(
            names.contains("io_uring_register"),
            "restricted plan must always-deny io_uring_register"
        );
        assert!(
            names.contains("bpf"),
            "restricted plan must always-deny bpf"
        );
    }

    #[test]
    fn build_seccomp_plan_restricted_includes_network_denies() {
        let plan = build_seccomp_plan(NetworkSeccompMode::Restricted);
        let names = plan.network_denied_names();
        assert!(
            !names.is_empty(),
            "restricted plan must have network-denied rules"
        );
        assert!(
            names.contains("bind"),
            "restricted plan must network-deny bind"
        );
        assert!(
            names.contains("listen"),
            "restricted plan must network-deny listen"
        );
        assert!(
            names.contains("connect"),
            "restricted plan must network-deny connect"
        );
        assert!(
            names.contains("sendto"),
            "restricted plan must network-deny sendto"
        );
        assert!(
            names.contains("recvfrom"),
            "restricted plan must network-deny recvfrom"
        );
    }

    #[test]
    fn build_seccomp_plan_restricted_does_not_allow_direct_socket_bind() {
        let plan = build_seccomp_plan(NetworkSeccompMode::Restricted);
        let net_denied = plan.network_denied_names();
        assert!(
            net_denied.contains("bind"),
            "restricted must network-deny bind"
        );
        assert!(
            net_denied.contains("listen"),
            "restricted must network-deny listen"
        );
    }

    #[test]
    fn build_seccomp_plan_full_includes_always_denied() {
        let plan = build_seccomp_plan(NetworkSeccompMode::Full);
        let names = plan.always_denied_names();
        assert!(
            names.contains("ptrace"),
            "full plan must always-deny ptrace"
        );
        assert!(
            names.contains("io_uring_setup"),
            "full plan must always-deny io_uring_setup"
        );
    }

    #[test]
    fn build_seccomp_plan_full_has_zero_network_denies() {
        let plan = build_seccomp_plan(NetworkSeccompMode::Full);
        assert!(
            plan.network_denied_names().is_empty(),
            "Full mode must add no network-denied rules — raw-byte syscalls are allowed"
        );
    }

    #[test]
    fn build_seccomp_plan_proxy_only_is_distinct_from_restricted() {
        let proxy_plan = build_seccomp_plan(NetworkSeccompMode::ProxyOnly);
        let restricted_plan = build_seccomp_plan(NetworkSeccompMode::Restricted);
        assert_ne!(
            proxy_plan.network_denied_names(),
            restricted_plan.network_denied_names(),
            "ProxyOnly plan must differ from Restricted plan in network-denied set"
        );
    }

    #[test]
    fn build_seccomp_plan_proxy_only_always_denied_matches_restricted() {
        let proxy_plan = build_seccomp_plan(NetworkSeccompMode::ProxyOnly);
        let restricted_plan = build_seccomp_plan(NetworkSeccompMode::Restricted);
        assert_eq!(
            proxy_plan.always_denied_names(),
            restricted_plan.always_denied_names(),
            "Always-denied set must be identical regardless of network mode"
        );
    }

    #[test]
    fn build_seccomp_plan_for_all_modes_produces_non_empty_plan() {
        for mode in [
            NetworkSeccompMode::Full,
            NetworkSeccompMode::Restricted,
            NetworkSeccompMode::ProxyOnly,
        ] {
            let plan = build_seccomp_plan(mode);
            assert!(
                !plan.rules.is_empty(),
                "Plan for {:?} must not be empty — at least always-denied rules must be present",
                mode
            );
        }
    }
}
