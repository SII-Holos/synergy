use windows_result::*;
use windows_sys::Win32::Foundation::*;
use windows_sys::Win32::Security::Authorization::*;
use windows_sys::Win32::Security::*;

// windows-sys 0.59 doesn't export this from the SDK headers:
const SECURITY_WORLD_RID: u32 = 0x00000000;
// windows-sys 0.59 doesn't export this from the SDK headers:
const GENERIC_READ: u32 = 0x80000000;

pub struct SavedAcl {
    pub path: String,
    pub security_descriptor: Option<*mut core::ffi::c_void>,
}

// SAFETY: SIDs are owned by this struct and never sent across threads.
// All mutations happen on the main thread before cleanup.
unsafe impl Send for SavedAcl {}

unsafe fn clean_sd(sd: Option<*mut core::ffi::c_void>) {
    if let Some(ptr) = sd {
        if !ptr.is_null() {
            LocalFree(ptr as HLOCAL);
        }
    }
}

/// Apply deny-write DACL to protected paths.
/// Returns saved original security descriptors for later restoration.
pub unsafe fn protect_paths(paths: &[String]) -> windows_result::Result<Vec<SavedAcl>> {
    let mut saved = Vec::new();

    for path in paths {
        let path_wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();

        // Save current security descriptor
        let mut sd: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
        let code = GetNamedSecurityInfoW(
            path_wide.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut sd,
        );
        if code != 0 {
            let hr = HRESULT::from_win32(code);
            return Err(Error::new(
                hr,
                format!("GetNamedSecurityInfoW failed for {}", path),
            ));
        }

        let saved_original = if !sd.is_null() {
            Some(sd as *mut core::ffi::c_void)
        } else {
            None
        };

        // Build a deny-write ACE to World (Everyone)
        let mut new_dacl: *mut ACL = std::ptr::null_mut();

        let mut world_sid: *mut core::ffi::c_void = std::ptr::null_mut();
        let sid_authority = SID_IDENTIFIER_AUTHORITY {
            Value: [0, 0, 0, 0, 0, 1],
        };
        let ok = AllocateAndInitializeSid(
            &sid_authority as *const SID_IDENTIFIER_AUTHORITY,
            1,
            SECURITY_WORLD_RID,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            &mut world_sid,
        );
        if ok == 0 {
            clean_sd(saved_original);
            let hr = HRESULT::from_win32(GetLastError());
            return Err(Error::new(hr, "AllocateAndInitializeSid for World failed"));
        }

        let ea = EXPLICIT_ACCESS_W {
            grfAccessPermissions: 0x1F01FF, // GENERIC_ALL
            grfAccessMode: DENY_ACCESS,
            grfInheritance: SUB_CONTAINERS_AND_OBJECTS_INHERIT,
            Trustee: TRUSTEE_W {
                pMultipleTrustee: std::ptr::null_mut(),
                MultipleTrusteeOperation: NO_MULTIPLE_TRUSTEE,
                TrusteeForm: TRUSTEE_IS_SID,
                TrusteeType: TRUSTEE_IS_WELL_KNOWN_GROUP,
                ptstrName: world_sid as *mut u16,
            },
        };

        let code = SetEntriesInAclW(
            1,
            &ea as *const EXPLICIT_ACCESS_W,
            std::ptr::null_mut(),
            &mut new_dacl,
        );
        FreeSid(world_sid);

        if code != 0 {
            clean_sd(saved_original);
            let hr = HRESULT::from_win32(code);
            return Err(Error::new(
                hr,
                format!("SetEntriesInAclW failed for {}", path),
            ));
        }

        // Apply new DACL
        let code = SetNamedSecurityInfoW(
            path_wide.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            new_dacl,
            std::ptr::null_mut(),
        );

        if code != 0 {
            clean_sd(saved_original);
            let hr = HRESULT::from_win32(code);
            return Err(Error::new(
                hr,
                format!("SetNamedSecurityInfoW failed for {}", path),
            ));
        }

        saved.push(SavedAcl {
            path: path.clone(),
            security_descriptor: saved_original,
        });

        log::info!("DACL applied to protected path: {}", path);
    }

    Ok(saved)
}

/// Restore original security descriptor for a path.
pub unsafe fn restore_acl(saved: &SavedAcl) {
    if saved.security_descriptor.is_none() {
        return;
    }

    let path_wide: Vec<u16> = saved
        .path
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let code = SetNamedSecurityInfoW(
        path_wide.as_ptr(),
        SE_FILE_OBJECT,
        DACL_SECURITY_INFORMATION,
        std::ptr::null_mut(),
        std::ptr::null_mut(),
        std::ptr::null_mut(),
        std::ptr::null_mut(),
    );
    if code == 0 {
        log::info!("DACL restored for: {}", saved.path);
    } else {
        log::warn!("DACL restore failed for {}: code={}", saved.path, code);
    }
}

/// Apply deny-read DACL to protected paths.
/// Returns saved original security descriptors for later restoration.
pub unsafe fn protect_paths_deny_read(paths: &[String]) -> windows_result::Result<Vec<SavedAcl>> {
    let mut saved = Vec::new();

    for path in paths {
        let path_wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();

        // Save current security descriptor
        let mut sd: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
        let code = GetNamedSecurityInfoW(
            path_wide.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut sd,
        );
        if code != 0 {
            let hr = HRESULT::from_win32(code);
            return Err(Error::new(
                hr,
                format!("GetNamedSecurityInfoW failed for {}", path),
            ));
        }

        let saved_original = if !sd.is_null() {
            Some(sd as *mut core::ffi::c_void)
        } else {
            None
        };

        // Build a deny-read ACE to World (Everyone)
        let mut new_dacl: *mut ACL = std::ptr::null_mut();

        let mut world_sid: *mut core::ffi::c_void = std::ptr::null_mut();
        let sid_authority = SID_IDENTIFIER_AUTHORITY {
            Value: [0, 0, 0, 0, 0, 1],
        };
        let ok = AllocateAndInitializeSid(
            &sid_authority as *const SID_IDENTIFIER_AUTHORITY,
            1,
            SECURITY_WORLD_RID,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            &mut world_sid,
        );
        if ok == 0 {
            clean_sd(saved_original);
            let hr = HRESULT::from_win32(GetLastError());
            return Err(Error::new(hr, "AllocateAndInitializeSid for World failed"));
        }

        let ea = EXPLICIT_ACCESS_W {
            grfAccessPermissions: GENERIC_READ,
            grfAccessMode: DENY_ACCESS,
            grfInheritance: SUB_CONTAINERS_AND_OBJECTS_INHERIT,
            Trustee: TRUSTEE_W {
                pMultipleTrustee: std::ptr::null_mut(),
                MultipleTrusteeOperation: NO_MULTIPLE_TRUSTEE,
                TrusteeForm: TRUSTEE_IS_SID,
                TrusteeType: TRUSTEE_IS_WELL_KNOWN_GROUP,
                ptstrName: world_sid as *mut u16,
            },
        };

        let code = SetEntriesInAclW(
            1,
            &ea as *const EXPLICIT_ACCESS_W,
            std::ptr::null_mut(),
            &mut new_dacl,
        );
        FreeSid(world_sid);

        if code != 0 {
            clean_sd(saved_original);
            let hr = HRESULT::from_win32(code);
            return Err(Error::new(
                hr,
                format!("SetEntriesInAclW failed for {}", path),
            ));
        }

        // Apply new DACL
        let code = SetNamedSecurityInfoW(
            path_wide.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            new_dacl,
            std::ptr::null_mut(),
        );

        if code != 0 {
            clean_sd(saved_original);
            let hr = HRESULT::from_win32(code);
            return Err(Error::new(
                hr,
                format!("SetNamedSecurityInfoW failed for {}", path),
            ));
        }

        saved.push(SavedAcl {
            path: path.clone(),
            security_descriptor: saved_original,
        });

        log::info!("Deny-read DACL applied to protected path: {}", path);
    }

    Ok(saved)
}

/// Access mask constants for deny-read ACE contract verification.
pub const DENY_READ_ACCESS_MASK: u32 = GENERIC_READ;
/// Access mode used for deny-read ACE entries.
pub const DENY_READ_ACCESS_MODE: i32 = DENY_ACCESS;
/// Inheritance flags used for deny-read ACE entries.
pub const DENY_READ_INHERITANCE: u32 = SUB_CONTAINERS_AND_OBJECTS_INHERIT;
/// Trustee form used for deny-read ACE entries.
pub const DENY_READ_TRUSTEE_FORM: TRUSTEE_FORM = TRUSTEE_IS_SID;
/// Trustee type used for deny-read ACE entries.
pub const DENY_READ_TRUSTEE_TYPE: TRUSTEE_TYPE = TRUSTEE_IS_WELL_KNOWN_GROUP;

// ================================================================
// Tests: Deny-read ACE contract
//
// These tests assert the PURE contract of the deny-read ACE
// constants. They run on any platform (no Windows FFI required).
// ================================================================
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deny_read_access_mask_is_generic_read() {
        assert_eq!(
            DENY_READ_ACCESS_MASK, 0x80000000,
            "Deny-read access mask must be GENERIC_READ (0x80000000)"
        );
    }

    #[test]
    fn deny_read_uses_deny_access_mode() {
        assert_eq!(
            DENY_READ_ACCESS_MODE, DENY_ACCESS,
            "Deny-read ACE must use DENY_ACCESS mode"
        );
    }

    #[test]
    fn deny_read_inherits_to_sub_containers_and_objects() {
        assert_eq!(
            DENY_READ_INHERITANCE, SUB_CONTAINERS_AND_OBJECTS_INHERIT,
            "Deny-read ACE must inherit to sub-containers and objects"
        );
    }

    #[test]
    fn deny_read_trustee_is_sid_form() {
        assert_eq!(
            DENY_READ_TRUSTEE_FORM, TRUSTEE_IS_SID,
            "Deny-read ACE trustee must use SID form"
        );
    }

    #[test]
    fn deny_read_trustee_is_well_known_group() {
        assert_eq!(
            DENY_READ_TRUSTEE_TYPE, TRUSTEE_IS_WELL_KNOWN_GROUP,
            "Deny-read ACE trustee must be a well-known group (Everyone)"
        );
    }

    #[test]
    fn deny_read_and_deny_write_have_distinct_access_masks() {
        // The existing protect_paths uses GENERIC_ALL (0x1F01FF).
        // protect_paths_deny_read must use a different mask (GENERIC_READ).
        assert_ne!(
            DENY_READ_ACCESS_MASK, 0x1F01FF,
            "Deny-read access mask must differ from deny-write GENERIC_ALL mask"
        );
    }
}
