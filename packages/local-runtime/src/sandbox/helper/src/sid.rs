/// SECURITY_APP_PACKAGE_AUTHORITY = {0,0,0,0,0,15}
///
/// Used for capability SIDs (S-1-15-3-*) and workspace SIDs.
/// Pure function — no FFI or platform dependency.
pub fn capability_sid_authority() -> [u8; 6] {
    [0, 0, 0, 0, 0, 15] // SECURITY_APP_PACKAGE_AUTHORITY
}

/// Generate a deterministic capability SID in binary form.
///
/// Returns the raw bytes of S-1-15-3-{fixed seed}.
/// Uses a constant seed for test reproducibility.
/// Sub-authorities: [3, SEED].
pub fn generate_capability_sid_bytes() -> Vec<u8> {
    build_app_container_sid(0x1234_5678u32)
}

/// Generate a deterministic workspace SID in binary form.
///
/// Returns the raw bytes of S-1-15-3-{fnv32(workspace)}.
/// Same workspace string always produces the same SID.
/// Sub-authorities: [3, fnv32_hash(workspace)].
pub fn generate_workspace_sid_bytes(workspace: &str) -> Vec<u8> {
    let hash = fnv32_hash(workspace.as_bytes());
    build_app_container_sid(hash)
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/// Build an AppContainer-style SID (S-1-15-3-{value}):
///   revision         1 byte  = 1
///   subAuthorityCount 1 byte  = 2
///   authority         6 bytes = SECURITY_APP_PACKAGE_AUTHORITY (big-endian)
///   subAuthority[0]   4 bytes = 3 (little-endian)
///   subAuthority[1]   4 bytes = value (little-endian)
///
/// Total: 16 bytes.
fn build_app_container_sid(sub_authority_value: u32) -> Vec<u8> {
    let authority = capability_sid_authority();
    let mut sid = Vec::with_capacity(16);
    sid.push(1u8); // Revision
    sid.push(2u8); // SubAuthorityCount
    sid.extend_from_slice(&authority); // 6 bytes, big-endian
    sid.extend_from_slice(&3u32.to_le_bytes()); // SubAuthority[0]
    sid.extend_from_slice(&sub_authority_value.to_le_bytes()); // SubAuthority[1]
    sid
}

/// FNV-1a 32-bit hash — deterministic, no external dependencies.
fn fnv32_hash(data: &[u8]) -> u32 {
    const FNV_OFFSET: u32 = 0x811c_9dc5;
    const FNV_PRIME: u32 = 0x0100_0193;
    let mut h = FNV_OFFSET;
    for &b in data {
        h ^= b as u32;
        h = h.wrapping_mul(FNV_PRIME);
    }
    h
}

// ================================================================
// Tests: SID generation contracts
//
// These tests assert the PURE contract of capability and workspace
// SID generation. They run on any platform (no Windows FFI required).
// ================================================================
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capability_sid_has_app_package_authority() {
        let sid = generate_capability_sid_bytes();
        // Binary SID layout: rev(1) | count(1) | authority(6) | sub-auths(8)
        assert_eq!(sid.len(), 16, "SID must be 16 bytes");
        let actual_authority: [u8; 6] = sid[2..8].try_into().unwrap();
        assert_eq!(
            actual_authority,
            capability_sid_authority(),
            "Capability SID must use SECURITY_APP_PACKAGE_AUTHORITY"
        );
    }

    #[test]
    fn capability_sid_starts_with_s_1_15_3() {
        let sid = generate_capability_sid_bytes();
        // Revision
        assert_eq!(sid[0], 1u8, "SID revision must be 1");
        // Authority = SECURITY_APP_PACKAGE_AUTHORITY ({0,0,0,0,0,15}) → authority value 15
        let authority: [u8; 6] = sid[2..8].try_into().unwrap();
        assert_eq!(
            authority,
            [0, 0, 0, 0, 0, 15],
            "Authority must be 15 (APP_PACKAGE)"
        );
        // SubAuthorityCount
        assert_eq!(sid[1], 2u8, "Expected 2 sub-authorities (3, seed)");
        // SubAuthority[0] = 3
        let sub0 = u32::from_le_bytes(sid[8..12].try_into().unwrap());
        assert_eq!(sub0, 3u32, "First sub-authority must be 3 (capability RID)");
        // The SID string would be S-1-15-3-{seed}, confirming it starts with S-1-15-3
    }

    #[test]
    fn workspace_sid_is_deterministic() {
        let a = generate_workspace_sid_bytes("C:\\Users\\sandbox\\project-1");
        let b = generate_workspace_sid_bytes("C:\\Users\\sandbox\\project-1");
        assert_eq!(a, b, "Same workspace must produce identical SID");
    }

    #[test]
    fn workspace_sids_differ_for_different_workspaces() {
        let a = generate_workspace_sid_bytes("C:\\Users\\sandbox\\project-alpha");
        let b = generate_workspace_sid_bytes("C:\\Users\\sandbox\\project-beta");
        assert_ne!(a, b, "Different workspaces must produce different SIDs");
    }

    #[test]
    fn workspace_sid_is_also_app_container_form() {
        let sid = generate_workspace_sid_bytes("any-workspace");
        assert_eq!(sid.len(), 16, "Workspace SID must be 16 bytes");
        assert_eq!(sid[0], 1u8, "Revision must be 1");
        assert_eq!(sid[1], 2u8, "SubAuthorityCount must be 2");
        let actual_authority: [u8; 6] = sid[2..8].try_into().unwrap();
        assert_eq!(
            actual_authority,
            capability_sid_authority(),
            "Workspace SID must also use SECURITY_APP_PACKAGE_AUTHORITY"
        );
    }

    #[test]
    fn capability_sid_returns_same_value_every_call() {
        let a = generate_capability_sid_bytes();
        let b = generate_capability_sid_bytes();
        assert_eq!(a, b, "Capability SID must be deterministic across calls");
    }
}
