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
}
