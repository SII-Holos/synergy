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

/// Load the seccomp filter represented by `plan` into the current Linux task.
///
/// On non-Linux platforms this is a no-op so unit tests can run on developer
/// machines. On Linux this compiles a simple BPF deny-list filter with default
/// allow semantics and EPERM for denied syscalls.
pub fn load_seccomp_filter(plan: &SeccompPlan) -> Result<(), HelperError> {
    load_seccomp_filter_impl(plan)
}

#[cfg(target_os = "linux")]
fn load_seccomp_filter_impl(plan: &SeccompPlan) -> Result<(), HelperError> {
    use libc::{sock_filter, sock_fprog};

    const BPF_LD: u16 = 0x00;
    const BPF_W: u16 = 0x00;
    const BPF_ABS: u16 = 0x20;
    const BPF_JMP: u16 = 0x05;
    const BPF_JEQ: u16 = 0x10;
    const BPF_K: u16 = 0x00;
    const BPF_RET: u16 = 0x06;
    const SECCOMP_RET_KILL_PROCESS: u32 = 0x8000_0000;
    const SECCOMP_RET_ALLOW: u32 = 0x7fff_0000;
    const SECCOMP_RET_ERRNO: u32 = 0x0005_0000;
    const SECCOMP_DATA_NR_OFFSET: u32 = 0;
    const SECCOMP_DATA_ARCH_OFFSET: u32 = 4;

    let mut filters = Vec::<sock_filter>::new();
    // Validate architecture first. Unknown architecture kills the process.
    filters.push(stmt(BPF_LD | BPF_W | BPF_ABS, SECCOMP_DATA_ARCH_OFFSET));
    filters.push(jump(BPF_JMP | BPF_JEQ | BPF_K, audit_arch(), 1, 0));
    filters.push(stmt(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS));
    filters.push(stmt(BPF_LD | BPF_W | BPF_ABS, SECCOMP_DATA_NR_OFFSET));

    for rule in &plan.rules {
        let syscall = match rule {
            SeccompRule::AlwaysDeny { syscall } | SeccompRule::NetworkDeny { syscall } => syscall,
        };
        if let Some(number) = syscall_number(syscall) {
            filters.push(jump(BPF_JMP | BPF_JEQ | BPF_K, number as u32, 0, 1));
            filters.push(stmt(
                BPF_RET | BPF_K,
                SECCOMP_RET_ERRNO | libc::EPERM as u32,
            ));
        }
    }
    filters.push(stmt(BPF_RET | BPF_K, SECCOMP_RET_ALLOW));

    let mut program = sock_fprog {
        len: filters.len() as u16,
        filter: filters.as_mut_ptr(),
    };
    let rc = unsafe {
        libc::prctl(
            libc::PR_SET_SECCOMP,
            libc::SECCOMP_MODE_FILTER,
            &mut program as *mut sock_fprog,
        )
    };
    if rc == 0 {
        Ok(())
    } else {
        Err(HelperError::Seccomp(format!(
            "PR_SET_SECCOMP failed: {}",
            std::io::Error::last_os_error()
        )))
    }
}

#[cfg(not(target_os = "linux"))]
fn load_seccomp_filter_impl(_plan: &SeccompPlan) -> Result<(), HelperError> {
    Ok(())
}

#[cfg(target_os = "linux")]
fn stmt(code: u16, k: u32) -> libc::sock_filter {
    libc::sock_filter {
        code,
        jt: 0,
        jf: 0,
        k,
    }
}

#[cfg(target_os = "linux")]
fn jump(code: u16, k: u32, jt: u8, jf: u8) -> libc::sock_filter {
    libc::sock_filter { code, jt, jf, k }
}

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
fn audit_arch() -> u32 {
    0xc000_003e
}

#[cfg(all(target_os = "linux", target_arch = "aarch64"))]
fn audit_arch() -> u32 {
    0xc000_00b7
}

#[cfg(all(
    target_os = "linux",
    not(any(target_arch = "x86_64", target_arch = "aarch64"))
))]
fn audit_arch() -> u32 {
    0
}

#[cfg(target_os = "linux")]
fn syscall_number(name: &str) -> Option<i64> {
    match name {
        "init_module" => Some(libc::SYS_init_module),
        "finit_module" => Some(libc::SYS_finit_module),
        "delete_module" => Some(libc::SYS_delete_module),
        "mount" => Some(libc::SYS_mount),
        "umount2" => Some(libc::SYS_umount2),
        "pivot_root" => Some(libc::SYS_pivot_root),
        "swapon" => Some(libc::SYS_swapon),
        "swapoff" => Some(libc::SYS_swapoff),
        "reboot" => Some(libc::SYS_reboot),
        "kexec_load" => Some(libc::SYS_kexec_load),
        "bpf" => Some(libc::SYS_bpf),
        "perf_event_open" => Some(libc::SYS_perf_event_open),
        "ptrace" => Some(libc::SYS_ptrace),
        "process_vm_readv" => Some(libc::SYS_process_vm_readv),
        "process_vm_writev" => Some(libc::SYS_process_vm_writev),
        "io_uring_setup" => Some(libc::SYS_io_uring_setup),
        "io_uring_enter" => Some(libc::SYS_io_uring_enter),
        "io_uring_register" => Some(libc::SYS_io_uring_register),
        "socket" => Some(libc::SYS_socket),
        "connect" => Some(libc::SYS_connect),
        "accept" => Some(libc::SYS_accept),
        "accept4" => Some(libc::SYS_accept4),
        "bind" => Some(libc::SYS_bind),
        "listen" => Some(libc::SYS_listen),
        "shutdown" => Some(libc::SYS_shutdown),
        "getsockname" => Some(libc::SYS_getsockname),
        "getpeername" => Some(libc::SYS_getpeername),
        "socketpair" => Some(libc::SYS_socketpair),
        "sendto" => Some(libc::SYS_sendto),
        "sendmsg" => Some(libc::SYS_sendmsg),
        "recvfrom" => Some(libc::SYS_recvfrom),
        "recvmsg" => Some(libc::SYS_recvmsg),
        "setsockopt" => Some(libc::SYS_setsockopt),
        "getsockopt" => Some(libc::SYS_getsockopt),
        _ => None,
    }
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
