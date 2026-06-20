// ================================================================
// UAC elevation primitives — admin detection and elevation
// ================================================================

use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, ERROR_CANCELLED, HANDLE, HWND,
};
#[cfg(target_os = "windows")]
use windows_sys::Win32::Security::{GetTokenInformation};
#[cfg(target_os = "windows")]
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
#[cfg(target_os = "windows")]
use windows_sys::Win32::UI::Shell::{
    ShellExecuteExW, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW,
};

const TOKEN_ELEVATION: u32 = 20; // TOKEN_INFORMATION_CLASS value for TokenElevation
const TOKEN_QUERY: u32 = 0x0008;

/// TOKEN_ELEVATION struct — 4 bytes, alignment 4
#[repr(C)]
struct TokenElevation {
    TokenIsElevated: u32,
}

/// Check if the current process is running with administrator privileges.
///
/// Uses `GetTokenInformation` with `TokenElevation` class on Windows.
/// Returns `false` on non-Windows platforms.
pub fn is_elevated() -> bool {
    if !cfg!(target_os = "windows") {
        return false;
    }
    #[cfg(target_os = "windows")]
    unsafe { is_elevated_impl() }
    #[cfg(not(target_os = "windows"))]
    false
}

#[cfg(target_os = "windows")]
unsafe fn is_elevated_impl() -> bool {
    let mut token: HANDLE = 0;
    let ok = OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token);
    if ok == 0 {
        return false;
    }

    let mut elevation: TokenElevation = TokenElevation { TokenIsElevated: 0 };
    let mut return_length: u32 = 0;
    let ok = GetTokenInformation(
        token,
        TOKEN_ELEVATION,
        &mut elevation as *mut _ as *mut core::ffi::c_void,
        core::mem::size_of::<TokenElevation>() as u32,
        &mut return_length,
    );
    CloseHandle(token);
    if ok == 0 {
        return false;
    }
    elevation.TokenIsElevated != 0
}

/// Launch the current executable with administrator privileges via UAC.
///
/// Uses `ShellExecuteExW` with `"runas"` verb and `--setup-mode` flag.
/// The elevated process connects back to the parent's named pipe server.
///
/// Returns `Ok(())` if the user approved UAC (elevated process launched).
/// Returns `Err` if UAC was cancelled or launch failed.
pub fn self_elevate(
    pipe_name: &str,
    original_args: &[String],
) -> Result<(), Box<dyn std::error::Error>> {
    if !cfg!(target_os = "windows") {
        return Err("UAC elevation is only available on Windows".into());
    }
    #[cfg(target_os = "windows")]
    unsafe { self_elevate_impl(pipe_name, original_args) }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (pipe_name, original_args);
        unreachable!()
    }
}

#[cfg(target_os = "windows")]
unsafe fn self_elevate_impl(
    pipe_name: &str,
    original_args: &[String],
) -> Result<(), Box<dyn std::error::Error>> {
    // Build the parameter string: --setup-mode --setup-pipe <pipe_name> [original args]
    let mut params = format!("--setup-mode --setup-pipe {}", pipe_name);
    for arg in original_args {
        params.push(' ');
        if arg.contains(' ') {
            params.push('"');
            params.push_str(arg);
            params.push('"');
        } else {
            params.push_str(arg);
        }
    }

    // Get current exe path
    let exe_path = std::env::current_exe()
        .map_err(|e| format!("failed to get current executable path: {}", e))?;
    let exe_str = exe_path
        .to_str()
        .ok_or("current executable path is not valid UTF-8")?;

    let exe_wide: Vec<u16> = exe_str.encode_utf16().chain(std::iter::once(0)).collect();
    let params_wide: Vec<u16> = params.encode_utf16().chain(std::iter::once(0)).collect();
    let verb_wide: Vec<u16> = "runas".encode_utf16().chain(std::iter::once(0)).collect();

    let mut sei = SHELLEXECUTEINFOW {
        cbSize: core::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_NOCLOSEPROCESS,
        hwnd: 0 as HWND,
        lpVerb: verb_wide.as_ptr(),
        lpFile: exe_wide.as_ptr(),
        lpParameters: params_wide.as_ptr(),
        lpDirectory: std::ptr::null(),
        nShow: 0,
        hInstApp: 0,
        lpIDList: std::ptr::null_mut(),
        lpClass: std::ptr::null(),
        hkeyClass: 0,
        dwHotKey: 0,
        hMonitor: 0,
        hProcess: 0,
    };

    let ok = ShellExecuteExW(&mut sei);
    if ok == 0 {
        let err = GetLastError();
        if err == ERROR_CANCELLED {
            return Err("UAC elevation was cancelled by user".into());
        }
        return Err(format!("ShellExecuteExW failed: error {}", err).into());
    }

    // User approved — we have a process handle but don't need to wait for it.
    // The elevated process will connect back to our pipe server.
    if sei.hProcess != 0 {
        CloseHandle(sei.hProcess);
    }

    Ok(())
}

// ================================================================
// Tests: UAC elevation contract tests
// ================================================================
#[cfg(test)]
mod tests {
    use super::*;

    /// `is_elevated()` must never panic on any platform.
    #[test]
    fn is_elevated_does_not_panic() {
        let _ = is_elevated();
    }

    /// On non-Windows, `is_elevated()` must return `false`.
    #[test]
    fn is_elevated_false_on_non_windows() {
        if !cfg!(target_os = "windows") {
            assert!(!is_elevated(), "is_elevated must return false on non-Windows");
        }
    }

    /// `is_elevated()` must be idempotent — same result across repeated calls.
    #[test]
    fn is_elevated_is_idempotent() {
        let a = is_elevated();
        let b = is_elevated();
        assert_eq!(a, b, "is_elevated must be idempotent");
    }

    /// `self_elevate()` must return an error on non-Windows.
    #[test]
    fn self_elevate_fails_on_non_windows() {
        if !cfg!(target_os = "windows") {
            let result = self_elevate("\\\\.\\pipe\\test", &[]);
            assert!(result.is_err(), "self_elevate must fail on non-Windows");
            let err = result.unwrap_err().to_string();
            assert!(
                err.contains("Windows"),
                "Error must mention Windows: {}",
                err
            );
        }
    }
}
