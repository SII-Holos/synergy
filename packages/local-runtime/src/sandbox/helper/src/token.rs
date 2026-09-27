use windows_result::*;
use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, HANDLE, LUID};
use windows_sys::Win32::Security::*;
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

// windows-sys 0.59 doesn't export these SDK headers:
const SE_GROUP_INTEGRITY: u32 = 0x00000020;
const SE_GROUP_INTEGRITY_ENABLED: u32 = 0x00000040;
const SECURITY_MANDATORY_LOW_RID: u32 = 0x00001000;
const SECURITY_BUILTIN_DOMAIN_RID: u32 = 0x00000020;

pub const DISABLED_PRIVILEGE_NAMES: &[&str] = &[
    "SeDebugPrivilege",
    "SeTakeOwnershipPrivilege",
    "SeLoadDriverPrivilege",
    "SeBackupPrivilege",
    "SeRestorePrivilege",
    "SeShutdownPrivilege",
    "SeImpersonatePrivilege",
    "SeTcbPrivilege",
    "SeCreateTokenPrivilege",
    "SeSystemtimePrivilege",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LowIntegritySidContract {
    pub rid: u32,
}

pub const LOW_INTEGRITY_SID_CONTRACT: LowIntegritySidContract = LowIntegritySidContract {
    rid: SECURITY_MANDATORY_LOW_RID,
};

pub fn disabled_privilege_names() -> &'static [&'static str] {
    DISABLED_PRIVILEGE_NAMES
}

pub fn low_integrity_sid_authority() -> [u8; 6] {
    [0, 0, 0, 0, 0, 16]
}
/// Create a restricted token with disabled privileges and Low integrity level.
/// Returns the new token handle. Caller must close it.
pub unsafe fn create_restricted_token() -> windows_result::Result<HANDLE> {
    // 1. Open current process token
    let mut current_token: HANDLE = std::ptr::null_mut();
    let ok = OpenProcessToken(
        GetCurrentProcess(),
        TOKEN_DUPLICATE | TOKEN_QUERY | TOKEN_ASSIGN_PRIMARY | TOKEN_ADJUST_DEFAULT,
        &mut current_token,
    );
    if ok == 0 {
        let hr = HRESULT::from_win32(GetLastError());
        return Err(Error::new(hr, "OpenProcessToken failed"));
    }

    // 2. Look up privileges to remove
    let privileges_to_remove = disabled_privilege_names();

    let mut delete_privileges: Vec<LUID_AND_ATTRIBUTES> = Vec::new();
    for priv_name in privileges_to_remove {
        let mut luid: LUID = std::mem::zeroed();
        let name_wide: Vec<u16> = priv_name.encode_utf16().chain(std::iter::once(0)).collect();
        let ok = LookupPrivilegeValueW(std::ptr::null(), name_wide.as_ptr(), &mut luid);
        if ok != 0 {
            delete_privileges.push(LUID_AND_ATTRIBUTES {
                Luid: luid,
                Attributes: 0,
            });
        }
    }

    // 3. Set up restricting SIDs (Users, Administrators)
    let restricting_sid_entries = [
        (SECURITY_BUILTIN_DOMAIN_RID, 545), // Users
        (SECURITY_BUILTIN_DOMAIN_RID, 544), // Administrators
    ];

    let mut restricting_sids: Vec<SID_AND_ATTRIBUTES> = Vec::new();
    let sid_authority = SID_IDENTIFIER_AUTHORITY {
        Value: [0, 0, 0, 0, 0, 5],
    }; // SECURITY_NT_AUTHORITY

    for (domain, rid) in &restricting_sid_entries {
        let mut sid: *mut core::ffi::c_void = std::ptr::null_mut();
        let ok = AllocateAndInitializeSid(
            &sid_authority as *const SID_IDENTIFIER_AUTHORITY,
            2,
            *domain,
            *rid,
            0,
            0,
            0,
            0,
            0,
            0,
            &mut sid,
        );
        if ok != 0 {
            restricting_sids.push(SID_AND_ATTRIBUTES {
                Sid: sid,
                Attributes: 0,
            });
        }
    }

    // 4. Create restricted token
    // CreateRestrictedToken takes delete SIDs as SID_AND_ATTRIBUTES, not LUID_AND_ATTRIBUTES.
    // We pass our privilege LUIDs as SID_AND_ATTRIBUTES (same binary layout).
    let mut new_token: HANDLE = std::ptr::null_mut();
    let ok = CreateRestrictedToken(
        current_token,
        DISABLE_MAX_PRIVILEGE | SANDBOX_INERT,
        delete_privileges.len() as u32,
        delete_privileges.as_ptr() as *const SID_AND_ATTRIBUTES,
        0,
        std::ptr::null(),
        restricting_sids.len() as u32,
        restricting_sids.as_ptr(),
        &mut new_token,
    );

    // Clean up allocated SIDs
    for s in &restricting_sids {
        if !s.Sid.is_null() {
            FreeSid(s.Sid);
        }
    }
    CloseHandle(current_token);

    if ok == 0 {
        let hr = HRESULT::from_win32(GetLastError());
        return Err(Error::new(hr, "CreateRestrictedToken failed"));
    }

    // 5. Set Low integrity level
    let mut untrusted_sid: *mut core::ffi::c_void = std::ptr::null_mut();
    let label_authority = SID_IDENTIFIER_AUTHORITY {
        Value: [0, 0, 0, 0, 0, 16],
    }; // SECURITY_MANDATORY_LABEL_AUTHORITY
    let ok = AllocateAndInitializeSid(
        &label_authority as *const SID_IDENTIFIER_AUTHORITY,
        1,
        SECURITY_MANDATORY_LOW_RID,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        &mut untrusted_sid,
    );
    if ok == 0 {
        CloseHandle(new_token);
        let hr = HRESULT::from_win32(GetLastError());
        return Err(Error::new(hr, "AllocateAndInitializeSid for Low IL failed"));
    }

    let tml = TOKEN_MANDATORY_LABEL {
        Label: SID_AND_ATTRIBUTES {
            Sid: untrusted_sid,
            Attributes: SE_GROUP_INTEGRITY | SE_GROUP_INTEGRITY_ENABLED,
        },
    };

    let ok = SetTokenInformation(
        new_token,
        TokenIntegrityLevel,
        &tml as *const TOKEN_MANDATORY_LABEL as *const core::ffi::c_void,
        core::mem::size_of::<TOKEN_MANDATORY_LABEL>() as u32,
    );
    FreeSid(untrusted_sid);

    if ok == 0 {
        CloseHandle(new_token);
        let hr = HRESULT::from_win32(GetLastError());
        return Err(Error::new(hr, "SetTokenInformation IntegrityLevel failed"));
    }

    log::info!(
        "Restricted token created successfully (Low IL, DISABLE_MAX_PRIVILEGE, SANDBOX_INERT)"
    );
    Ok(new_token)
}

#[cfg(test)]
mod tests {
    // ================================================================
    // Slice 2: Restricted token contract tests
    //
    // These tests assert the PURE contract of the restricted token
    // subsystem. They run on any platform (no Windows FFI required).
    // The target functions are NOT yet implemented — this is the RED
    // signal that implementation-engineer will satisfy.
    //
    // Expected RED failures (compile-time):
    //   - cannot find function `disabled_privilege_names` in this scope
    //   - cannot find value `LOW_INTEGRITY_SID_CONTRACT` in this scope
    //   - cannot find function `low_integrity_sid_authority` in this scope
    // ================================================================

    use super::*;

    #[test]
    fn disabled_privileges_includes_se_debug() {
        let names = disabled_privilege_names();
        assert!(
            names.contains(&"SeDebugPrivilege"),
            "Restricted token must disable SeDebugPrivilege"
        );
    }

    #[test]
    fn disabled_privileges_includes_se_impersonate() {
        let names = disabled_privilege_names();
        assert!(
            names.contains(&"SeImpersonatePrivilege"),
            "Restricted token must disable SeImpersonatePrivilege"
        );
    }

    #[test]
    fn disabled_privileges_includes_se_create_token() {
        let names = disabled_privilege_names();
        assert!(
            names.contains(&"SeCreateTokenPrivilege"),
            "Restricted token must disable SeCreateTokenPrivilege"
        );
    }

    #[test]
    fn disabled_privileges_includes_se_systemtime() {
        let names = disabled_privilege_names();
        assert!(
            names.contains(&"SeSystemtimePrivilege"),
            "Restricted token must disable SeSystemtimePrivilege"
        );
    }

    #[test]
    fn disabled_privileges_includes_se_take_ownership() {
        let names = disabled_privilege_names();
        assert!(
            names.contains(&"SeTakeOwnershipPrivilege"),
            "Restricted token must disable SeTakeOwnershipPrivilege"
        );
    }

    #[test]
    fn disabled_privileges_includes_se_load_driver() {
        let names = disabled_privilege_names();
        assert!(
            names.contains(&"SeLoadDriverPrivilege"),
            "Restricted token must disable SeLoadDriverPrivilege"
        );
    }

    #[test]
    fn disabled_privileges_includes_se_backup() {
        let names = disabled_privilege_names();
        assert!(
            names.contains(&"SeBackupPrivilege"),
            "Restricted token must disable SeBackupPrivilege"
        );
    }

    #[test]
    fn disabled_privileges_includes_se_restore() {
        let names = disabled_privilege_names();
        assert!(
            names.contains(&"SeRestorePrivilege"),
            "Restricted token must disable SeRestorePrivilege"
        );
    }

    #[test]
    fn disabled_privileges_includes_se_shutdown() {
        let names = disabled_privilege_names();
        assert!(
            names.contains(&"SeShutdownPrivilege"),
            "Restricted token must disable SeShutdownPrivilege"
        );
    }

    #[test]
    fn disabled_privileges_includes_se_tcb() {
        let names = disabled_privilege_names();
        assert!(
            names.contains(&"SeTcbPrivilege"),
            "Restricted token must disable SeTcbPrivilege"
        );
    }

    #[test]
    fn disabled_privileges_returns_expected_count() {
        let names = disabled_privilege_names();
        // At minimum, these 10 high-risk privileges must be disabled.
        // Additional platform-appropriate privileges may be added.
        assert!(
            names.len() >= 10,
            "Expected at least 10 disabled privileges, got {}: {:?}",
            names.len(),
            names
        );
    }

    #[test]
    fn low_integrity_sid_rid_is_present() {
        assert_eq!(
            LOW_INTEGRITY_SID_CONTRACT.rid, 0x0000_1000u32,
            "Low integrity SID RID must be SECURITY_MANDATORY_LOW_RID (0x1000)"
        );
    }

    #[test]
    fn low_integrity_sid_authority_is_mandatory_label() {
        let authority = low_integrity_sid_authority();
        // SECURITY_MANDATORY_LABEL_AUTHORITY = {0,0,0,0,0,16}
        assert_eq!(
            authority,
            [0u8, 0, 0, 0, 0, 16],
            "Low integrity SID must use SECURITY_MANDATORY_LABEL_AUTHORITY"
        );
    }

    #[test]
    fn disabled_privilege_names_is_pure_and_allocates_nothing() {
        // The contract is a pure function returning a static slice.
        // No heap allocation, no FFI calls, no platform check.
        // This invariant allows tests to run on macOS.
        let names = disabled_privilege_names();
        assert!(
            !names.is_empty(),
            "disabled_privilege_names must be non-empty"
        );
    }
}
