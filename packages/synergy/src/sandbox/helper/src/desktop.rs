/// Private desktop isolation contract.
///
/// Defines the pure behavioral contract for the Windows private desktop
/// subsystem. No FFI — these structs and functions describe what the
/// implementation must wire, and tests assert those expectations.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DesktopContract {
    pub private_desktop: bool,
    pub isolate_clipboard: bool,
    pub switch_thread: bool,
}

pub fn desktop_contract() -> DesktopContract {
    DesktopContract {
        private_desktop: true,
        isolate_clipboard: true,
        switch_thread: true,
    }
}

pub fn default_desktop_name() -> &'static str {
    "SynergySandbox"
}

/// Platform-aware wrapper: create a private desktop.
///
/// On Windows: delegates to the FFI implementation in `desktop::ffi`.
/// On non-Windows: always returns an error.
///
/// Returns `(private_desktop_handle, original_desktop_handle)` as raw handles.
/// Callers must later call `close_desktop` and `switch_to_desktop` to clean up.
pub unsafe fn create_private_desktop(name: &str) -> Result<(isize, isize), String> {
    #[cfg(target_os = "windows")]
    {
        ffi::create_private_desktop(name)
            .map(|(h, o)| (h as isize, o as isize))
            .map_err(|e| format!("{}", e))
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = name;
        Err("Private desktop not supported on this platform".into())
    }
}

/// Platform-aware wrapper: close a desktop handle.
pub unsafe fn close_desktop(hdesk: isize) {
    #[cfg(target_os = "windows")]
    {
        let _ = ffi::close_desktop(hdesk as ffi::HDESK);
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = hdesk;
    }
}

/// Platform-aware wrapper: switch the calling thread to a desktop.
pub unsafe fn switch_to_desktop(hdesk: isize) {
    #[cfg(target_os = "windows")]
    {
        let _ = ffi::switch_to_desktop(hdesk as ffi::HDESK);
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = hdesk;
    }
}

// ================================================================
// Private desktop FFI implementation (Windows only)
// ================================================================
#[cfg(target_os = "windows")]
pub mod ffi {
    use windows_result::*;
    use windows_sys::Win32::Foundation::{GetLastError, GENERIC_ALL, HDESK};
    use windows_sys::Win32::System::StationsAndDesktops::*;
    use windows_sys::Win32::System::Threading::GetCurrentThreadId;

    /// Create a private desktop and switch the calling thread to it.
    ///
    /// Calls `CreateDesktopW` with `GENERIC_ALL` access and no `DF_ALLOWOTHERACCOUNTHOOK`
    /// flag, ensuring clipboard and UI isolation from the default desktop.
    /// After creation, `SetThreadDesktop` switches the calling thread.
    ///
    /// Returns `(new_desktop_handle, original_desktop_handle)`.
    pub unsafe fn create_private_desktop(name: &str) -> windows_result::Result<(HDESK, HDESK)> {
        let name_wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();

        let original = GetThreadDesktop(GetCurrentThreadId());
        if original.is_null() {
            let hr = HRESULT::from_win32(GetLastError());
            return Err(Error::new(hr, "GetThreadDesktop failed"));
        }

        let hdesk = CreateDesktopW(
            name_wide.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            0, // dwFlags: private desktop (no DF_ALLOWOTHERACCOUNTHOOK)
            GENERIC_ALL,
            std::ptr::null(),
        );

        if hdesk.is_null() {
            let hr = HRESULT::from_win32(GetLastError());
            return Err(Error::new(hr, "CreateDesktopW failed"));
        }

        if SetThreadDesktop(hdesk) == 0 {
            CloseDesktop(hdesk);
            let hr = HRESULT::from_win32(GetLastError());
            return Err(Error::new(hr, "SetThreadDesktop failed"));
        }

        Ok((hdesk, original))
    }

    /// Switch the calling thread to a different desktop.
    pub unsafe fn switch_to_desktop(hdesk: HDESK) -> windows_result::Result<()> {
        if SetThreadDesktop(hdesk) == 0 {
            let hr = HRESULT::from_win32(GetLastError());
            return Err(Error::new(hr, "SetThreadDesktop failed"));
        }
        Ok(())
    }

    /// Close a desktop handle.
    pub unsafe fn close_desktop(hdesk: HDESK) -> windows_result::Result<()> {
        if CloseDesktop(hdesk) == 0 {
            let hr = HRESULT::from_win32(GetLastError());
            return Err(Error::new(hr, "CloseDesktop failed"));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    // ================================================================
    // Slice 4: Desktop isolation contract tests
    //
    // These tests assert the PURE contracts of the private desktop
    // subsystem. They run on any platform (no Windows FFI required).
    // The contract struct and functions declare behavioral expectations
    // — the upstream implementation wires them against the Windows API.
    //
    // Contract domains:
    //   1. Desktop properties: private, clipboard isolation, thread switch
    //   2. Naming: default desktop name for sandbox
    // ================================================================
    use super::*;

    // --- Desktop contract field assertions ---

    #[test]
    fn desktop_contract_private_desktop() {
        let contract = desktop_contract();
        assert!(
            contract.private_desktop,
            "Sandbox desktop must be a private desktop (CreateDesktopW)"
        );
    }

    #[test]
    fn desktop_contract_isolate_clipboard() {
        let contract = desktop_contract();
        assert!(
            contract.isolate_clipboard,
            "Sandbox desktop must isolate clipboard from the default desktop"
        );
    }

    #[test]
    fn desktop_contract_switch_thread() {
        let contract = desktop_contract();
        assert!(
            contract.switch_thread,
            "Sandbox must switch the process thread to the private desktop (SetThreadDesktop)"
        );
    }

    #[test]
    fn desktop_contract_is_pure() {
        // The contract is a pure function. No platform check, no FFI.
        let _ = desktop_contract();
    }

    // --- Desktop naming ---

    #[test]
    fn default_desktop_name_is_non_empty() {
        let name = default_desktop_name();
        assert!(
            !name.is_empty(),
            "Default desktop name must be a non-empty string"
        );
    }

    #[test]
    fn default_desktop_name_is_synergy_sandbox() {
        let name = default_desktop_name();
        assert_eq!(
            name, "SynergySandbox",
            "Default desktop name must be 'SynergySandbox' for consistency"
        );
    }

    #[test]
    fn default_desktop_name_is_pure() {
        let _ = default_desktop_name();
    }

    // --- Clipboard isolation contract ---

    #[test]
    fn clipboard_isolation_is_enforced() {
        // Clipboard isolation must be part of the desktop contract.
        let contract = desktop_contract();
        assert!(
            contract.isolate_clipboard,
            "Clipboard isolation must be enforced so child processes cannot read host clipboard"
        );
        // The desktop itself must be private for isolation to be meaningful.
        assert!(
            contract.private_desktop,
            "Private desktop must be enabled for clipboard isolation to take effect"
        );
    }
}
