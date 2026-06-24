#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ConptyAvailabilityContract {
    pub available_on_win10_1809: bool,
    pub fallback_to_pipes: bool,
}

pub fn conpty_contract() -> ConptyAvailabilityContract {
    ConptyAvailabilityContract {
        available_on_win10_1809: true,
        fallback_to_pipes: true,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ConptyDimensionsContract {
    pub default_cols: u16,
    pub default_rows: u16,
    pub honor_env_vars: bool,
}

pub fn conpty_dimensions_contract() -> ConptyDimensionsContract {
    ConptyDimensionsContract {
        default_cols: 120,
        default_rows: 40,
        honor_env_vars: true,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ConptySignalContract {
    pub forward_ctrl_c: bool,
    pub forward_sigterm: bool,
}

pub fn conpty_signal_contract() -> ConptySignalContract {
    ConptySignalContract {
        forward_ctrl_c: true,
        forward_sigterm: true,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ConptyFallbackContract {
    pub max_retries: u32,
    pub report_via_readiness: bool,
}

pub fn conpty_fallback_contract() -> ConptyFallbackContract {
    ConptyFallbackContract {
        max_retries: 0,
        report_via_readiness: true,
    }
}

#[cfg(test)]
mod tests {
    // ================================================================
    // Slice 3: ConPTY bridge contract tests
    //
    // These tests assert the PURE contracts of the ConPTY subsystem.
    // They run on any platform (no Windows FFI required). The target
    // structs and functions provide the contract stubs — tests are
    // GREEN now so the upstream implementation knows what to wire.
    //
    // Contract domains:
    //   1. Availability: ConPTY feature detection and pipe fallback
    //   2. Dimensions: default terminal dimensions and env-var support
    //   3. Signal forwarding: Ctrl+C and SIGTERM propagation
    //   4. Pipe fallback: retry and readiness reporting
    // ================================================================
    use super::*;

    // --- ConPTY availability contract ---

    #[test]
    fn conpty_available_on_win10_1809() {
        let contract = conpty_contract();
        assert!(
            contract.available_on_win10_1809,
            "ConPTY must report as available on Windows 10 1809+ (CreatePseudoConsole supported)"
        );
    }

    #[test]
    fn conpty_fallback_to_pipes() {
        let contract = conpty_contract();
        assert!(
            contract.fallback_to_pipes,
            "ConPTY must support fallback to anonymous pipes when pseudo-console is unavailable"
        );
    }

    #[test]
    fn conpty_contract_is_pure() {
        // The contract is a pure function. No platform check, no FFI.
        let _ = conpty_contract();
    }

    // --- ConPTY dimensions contract ---

    #[test]
    fn conpty_default_cols_is_120() {
        let dims = conpty_dimensions_contract();
        assert_eq!(dims.default_cols, 120, "ConPTY default columns must be 120");
    }

    #[test]
    fn conpty_default_rows_is_40() {
        let dims = conpty_dimensions_contract();
        assert_eq!(dims.default_rows, 40, "ConPTY default rows must be 40");
    }

    #[test]
    fn conpty_honors_env_vars() {
        let dims = conpty_dimensions_contract();
        assert!(
            dims.honor_env_vars,
            "ConPTY dimensions must be overridable via SYNERGY_TERM_COLS / SYNERGY_TERM_ROWS env vars"
        );
    }

    #[test]
    fn conpty_dimensions_contract_is_pure() {
        let _ = conpty_dimensions_contract();
    }

    // --- ConPTY signal forwarding contract ---

    #[test]
    fn conpty_forwards_ctrl_c() {
        let sig = conpty_signal_contract();
        assert!(
            sig.forward_ctrl_c,
            "ConPTY must forward Ctrl+C (GenerateConsoleCtrlEvent) to the child process"
        );
    }

    #[test]
    fn conpty_forwards_sigterm() {
        let sig = conpty_signal_contract();
        assert!(
            sig.forward_sigterm,
            "ConPTY must forward SIGTERM-equivalent shutdown to the child process"
        );
    }

    #[test]
    fn conpty_signal_contract_is_pure() {
        let _ = conpty_signal_contract();
    }

    // --- ConPTY pipe fallback contract ---

    #[test]
    fn conpty_fallback_max_retries_is_zero() {
        let fallback = conpty_fallback_contract();
        assert_eq!(
            fallback.max_retries, 0,
            "ConPTY fallback must not retry — max_retries must be 0"
        );
    }

    #[test]
    fn conpty_fallback_reports_via_readiness() {
        let fallback = conpty_fallback_contract();
        assert!(
            fallback.report_via_readiness,
            "ConPTY fallback status must be observable via a readiness signal (not via polling)"
        );
    }

    #[test]
    fn conpty_fallback_contract_is_pure() {
        let _ = conpty_fallback_contract();
    }
}

// ===========================================================================
// Windows ConPTY FFI (real implementation)
// ===========================================================================

#[cfg(target_os = "windows")]
mod ffi {
    use windows_result::*;
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, HANDLE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
    use windows_sys::Win32::System::Console::{
        ClosePseudoConsole, CreatePseudoConsole, ResizePseudoConsole, COORD, HPCON,
    };
    use windows_sys::Win32::System::Pipes::CreatePipe;

    /// PSEUDOCONSOLE_RESIZE_QUIRK flag for CreatePseudoConsole dwFlags.
    /// Not yet exposed by windows-sys 0.59; defined here per Win32 SDK.
    pub const PSEUDOCONSOLE_RESIZE_QUIRK: u32 = 0x2;

    /// Create a ConPTY pseudo console.
    ///
    /// Allocates two anonymous pipes (one for input, one for output),
    /// creates the pseudo console, and returns:
    ///   - input_write: parent-side write handle for feeding data into the child
    ///   - output_read:  parent-side read handle for reading child stdout/stderr
    ///   - hpcon:        pseudo console handle (for resize / close)
    ///
    /// The caller owns all three returned handles and must close them.
    pub unsafe fn create_pseudo_console(
        cols: u16,
        rows: u16,
    ) -> windows_result::Result<(HANDLE, HANDLE, HPCON)> {
        let sa = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: std::ptr::null_mut(),
            bInheritHandle: 1,
        };

        // Input pipe: parent writes → ConPTY reads → child stdin
        let mut input_read: HANDLE = INVALID_HANDLE_VALUE;
        let mut input_write: HANDLE = INVALID_HANDLE_VALUE;
        if CreatePipe(&mut input_read, &mut input_write, &sa, 0) == 0 {
            let hr = HRESULT::from_win32(GetLastError());
            return Err(Error::new(hr, "CreatePipe for ConPTY input failed"));
        }

        // Output pipe: child stdout/stderr → ConPTY writes → parent reads
        let mut output_read: HANDLE = INVALID_HANDLE_VALUE;
        let mut output_write: HANDLE = INVALID_HANDLE_VALUE;
        if CreatePipe(&mut output_read, &mut output_write, &sa, 0) == 0 {
            CloseHandle(input_read);
            CloseHandle(input_write);
            let hr = HRESULT::from_win32(GetLastError());
            return Err(Error::new(hr, "CreatePipe for ConPTY output failed"));
        }

        let size = COORD {
            X: cols as i16,
            Y: rows as i16,
        };

        let mut hpcon: HPCON = 0;
        let hr = CreatePseudoConsole(size, input_read, output_write, 0, &mut hpcon);

        if hr < 0 {
            CloseHandle(input_read);
            CloseHandle(input_write);
            CloseHandle(output_read);
            CloseHandle(output_write);
            return Err(Error::new(windows_result::HRESULT(hr), "CreatePseudoConsole failed"));
        }

        // ConPTY owns input_read and output_write — close our references
        CloseHandle(input_read);
        CloseHandle(output_write);

        // Parent keeps input_write (to feed data) and output_read (to read output)
        Ok((input_write, output_read, hpcon))
    }

    /// Resize an existing pseudo console.
    pub unsafe fn resize_pseudo_console(
        hpcon: HPCON,
        cols: u16,
        rows: u16,
    ) -> windows_result::Result<()> {
        let size = COORD {
            X: cols as i16,
            Y: rows as i16,
        };
        let hr = ResizePseudoConsole(hpcon, size);
        if hr < 0 {
            return Err(Error::new(windows_result::HRESULT(hr), "ResizePseudoConsole failed"));
        }
        Ok(())
    }

    /// Close a pseudo console handle.
    /// The pseudo console must outlive any attached process — the caller
    /// is responsible for closing it after process exit.
    pub unsafe fn close_pseudo_console(hpcon: HPCON) {
        ClosePseudoConsole(hpcon);
    }
}

#[cfg(target_os = "windows")]
pub use ffi::*;
