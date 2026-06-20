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
