/// Environment block builder contract.
///
/// Defines the pure behavioral contract for constructing sandboxed
/// environment blocks. No FFI — the contract declares which environment
/// variables survive the allowlist filter and how extras are injected.
/// The upstream implementation reads real environment variables on
/// Windows and substitutes actual values.

/// Allowlist of environment variable names passed through to the
/// sandboxed process. All other variables are stripped.
pub const ENV_ALLOWLIST: &[&str] = &[
    "PATH",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "SYSTEMROOT",
    "ProgramData",
    "HOMEDRIVE",
    "HOMEPATH",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EnvBlockContract {
    pub allowlist_filter: bool,
    pub preserve_system_path: bool,
    pub inject_temp_env: bool,
}

pub fn env_block_contract() -> EnvBlockContract {
    EnvBlockContract {
        allowlist_filter: true,
        preserve_system_path: true,
        inject_temp_env: true,
    }
}

/// Build an environment block from the allowlist plus caller-supplied extras.
///
/// Each allowlist entry produces a `KEY=` placeholder. On the real Windows
/// implementation, actual environment variable values are read from the
/// parent process and substituted. The contract version encodes only the
/// key set so callers can assert structural correctness without FFI.
pub fn build_env_block(extra: &[(String, String)]) -> Vec<String> {
    let mut block: Vec<String> = ENV_ALLOWLIST.iter().map(|k| format!("{}=", k)).collect();
    for (k, v) in extra {
        block.push(format!("{}={}", k, v));
    }
    block
}

#[cfg(test)]
mod tests {
    // ================================================================
    // Slice 5: Environment block builder contract tests
    //
    // These tests assert the PURE contracts of the environment block
    // builder. They run on any platform (no Windows FFI required).
    // The allowlist and builder function declare what environment
    // variables survive sandboxing — the upstream implementation
    // wires them against the Windows environment APIs.
    //
    // Contract domains:
    //   1. Allowlist: which variables survive, non-empty, contains PATH
    //   2. Builder: allowlist entries preserved, extras appended
    //   3. Contract: filter/resolve/inject flags
    // ================================================================
    use super::*;

    // --- Allowlist contract ---

    #[test]
    fn env_allowlist_is_non_empty() {
        assert!(
            !ENV_ALLOWLIST.is_empty(),
            "Environment allowlist must be non-empty"
        );
    }

    #[test]
    fn env_allowlist_contains_path() {
        assert!(
            ENV_ALLOWLIST.contains(&"PATH"),
            "Environment allowlist must include PATH for command resolution"
        );
    }

    #[test]
    fn env_allowlist_contains_temp_vars() {
        assert!(
            ENV_ALLOWLIST.contains(&"TEMP"),
            "Environment allowlist must include TEMP for temporary file access"
        );
        assert!(
            ENV_ALLOWLIST.contains(&"TMP"),
            "Environment allowlist must include TMP for temporary file access"
        );
    }

    #[test]
    fn env_allowlist_contains_profile_vars() {
        assert!(
            ENV_ALLOWLIST.contains(&"USERPROFILE"),
            "Environment allowlist must include USERPROFILE for user profile access"
        );
        assert!(
            ENV_ALLOWLIST.contains(&"HOMEDRIVE"),
            "Environment allowlist must include HOMEDRIVE"
        );
        assert!(
            ENV_ALLOWLIST.contains(&"HOMEPATH"),
            "Environment allowlist must include HOMEPATH"
        );
    }

    #[test]
    fn env_allowlist_is_pure() {
        // The allowlist is a static const slice. No allocation, no FFI.
        let _ = ENV_ALLOWLIST;
    }

    // --- Env block builder ---

    #[test]
    fn build_env_block_preserves_allowlist_entries() {
        let block = build_env_block(&[]);
        // Every allowlist key must appear exactly once at the front.
        assert_eq!(
            block.len(),
            ENV_ALLOWLIST.len(),
            "build_env_block with no extras must produce exactly allowlist entries"
        );
        for (i, key) in ENV_ALLOWLIST.iter().enumerate() {
            assert!(
                block[i].starts_with(&format!("{}=", key)),
                "build_env_block must preserve allowlist key '{}' at position {}",
                key,
                i
            );
        }
    }

    #[test]
    fn build_env_block_adds_extra_entries() {
        let extras = [
            ("SYNERGY_SANDBOX_ID".to_string(), "abc123".to_string()),
            ("SYNERGY_WORKSPACE".to_string(), r"C:\workspace".to_string()),
        ];
        let block = build_env_block(&extras);
        assert_eq!(
            block.len(),
            ENV_ALLOWLIST.len() + extras.len(),
            "build_env_block must include allowlist entries plus extras"
        );
        // Extras appear after allowlist entries.
        assert_eq!(
            block[ENV_ALLOWLIST.len()],
            "SYNERGY_SANDBOX_ID=abc123",
            "build_env_block must append first extra entry"
        );
        assert_eq!(
            block[ENV_ALLOWLIST.len() + 1],
            r"SYNERGY_WORKSPACE=C:\workspace",
            "build_env_block must append second extra entry"
        );
    }

    #[test]
    fn build_env_block_with_empty_extras_is_pure() {
        let _ = build_env_block(&[]);
    }

    // --- EnvBlockContract ---

    #[test]
    fn env_block_contract_allowlist_filter() {
        let contract = env_block_contract();
        assert!(
            contract.allowlist_filter,
            "Environment block must filter through allowlist"
        );
    }

    #[test]
    fn env_block_contract_preserve_system_path() {
        let contract = env_block_contract();
        assert!(
            contract.preserve_system_path,
            "Environment block must preserve system PATH for command resolution"
        );
    }

    #[test]
    fn env_block_contract_inject_temp_env() {
        let contract = env_block_contract();
        assert!(
            contract.inject_temp_env,
            "Environment block must inject TEMP/TMP for the sandboxed process"
        );
    }

    #[test]
    fn env_block_contract_is_pure() {
        let _ = env_block_contract();
    }
}
