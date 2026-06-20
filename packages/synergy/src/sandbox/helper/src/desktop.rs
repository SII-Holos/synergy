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
