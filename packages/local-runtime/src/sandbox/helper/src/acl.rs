use windows_result::*;
use windows_sys::Win32::Foundation::*;
use windows_sys::Win32::Security::Authorization::*;
use windows_sys::Win32::Security::*;
use windows_sys::Win32::Storage::FileSystem::GetFileAttributesW;

// windows-sys 0.59 doesn't export this from the SDK headers:
const SECURITY_WORLD_RID: u32 = 0x00000000;
// windows-sys 0.59 doesn't export this from the SDK headers:
const GENERIC_READ: u32 = 0x80000000;

pub struct SavedAcl {
    pub path: String,
    pub security_descriptor: Option<*mut core::ffi::c_void>,
}

// SAFETY: the descriptor is uniquely owned by this value and is accessed
// only while protected by the cleanup mutex (or through an exclusive borrow).
// Sending ownership to a cleanup thread is safe; sharing a SavedAcl directly
// is still prevented because this type is not Sync.
unsafe impl Send for SavedAcl {}

impl Drop for SavedAcl {
    fn drop(&mut self) {
        unsafe { clean_sd(self.security_descriptor.take()) };
    }
}

unsafe fn clean_sd(sd: Option<*mut core::ffi::c_void>) {
    if let Some(ptr) = sd {
        if !ptr.is_null() {
            LocalFree(ptr as HLOCAL);
        }
    }
}

unsafe fn clean_acl(acl: *mut ACL) {
    if !acl.is_null() {
        LocalFree(acl as HLOCAL);
    }
}

/// Return whether a Win32 error means that the optional protected path is not
/// present at the time the ACL operation is attempted.
///
/// Keep this deliberately narrow.  In particular, access denied and all
/// other ACL/security errors must still fail sandbox startup instead of being
/// treated as an absent path.
fn is_missing_path_error(code: u32) -> bool {
    code == ERROR_FILE_NOT_FOUND || code == ERROR_PATH_NOT_FOUND
}

/// Confirm that a not-found ACL error really describes an absent path.
///
/// This extra check prevents a future/API-specific not-found error from being
/// mistaken for an optional path when the object is actually present but its
/// ACL operation failed.
unsafe fn protected_path_exists(path: &str) -> core::result::Result<bool, u32> {
    let path_wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
    let attributes = GetFileAttributesW(path_wide.as_ptr());
    if attributes != u32::MAX {
        return Ok(true);
    }

    let code = GetLastError();
    if is_missing_path_error(code) {
        Ok(false)
    } else {
        Err(code)
    }
}

unsafe fn rollback_saved(saved: &mut Vec<SavedAcl>) {
    // Restore in reverse order so nested paths are unwound before their
    // ancestors.  Every entry is attempted even if one restore fails.
    let mut failed = Vec::new();
    for item in saved.drain(..).rev() {
        if !restore_acl(&item) {
            log::error!(
                "ACL rollback failed for {}; retaining the original descriptor for retry",
                item.path
            );
            failed.push(item);
        }
    }
    if !failed.is_empty() {
        failed.reverse();
        crate::cleanup::register_dacl_cleanup(failed);
    }
}

unsafe fn apply_deny_acl(
    paths: &[String],
    access_mask: u32,
    description: &str,
    allow_missing: bool,
) -> windows_result::Result<Vec<SavedAcl>> {
    let mut saved = Vec::with_capacity(paths.len());

    for path in paths {
        let path_wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();

        let mut original_sd: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
        let mut original_dacl: *mut ACL = std::ptr::null_mut();
        let code = GetNamedSecurityInfoW(
            path_wide.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut original_dacl,
            std::ptr::null_mut(),
            &mut original_sd,
        );
        if code != 0 {
            if allow_missing && is_missing_path_error(code) {
                match protected_path_exists(path) {
                    Ok(false) => {
                        log::warn!(
                            "Skipping optional protected path because it does not exist: {} (Win32 error {})",
                            path,
                            code
                        );
                        continue;
                    }
                    Ok(true) => {
                        log::error!(
                            "ACL lookup reported a missing protected path, but it exists; refusing to ignore the ACL failure: {} (Win32 error {})",
                            path,
                            code
                        );
                    }
                    Err(existence_code) => {
                        rollback_saved(&mut saved);
                        let hr = HRESULT::from_win32(existence_code);
                        return Err(Error::new(
                            hr,
                            format!(
                                "cannot determine whether protected path exists for {} (ACL error {}; existence error {})",
                                path, code, existence_code
                            ),
                        ));
                    }
                }
            }
            rollback_saved(&mut saved);
            let hr = HRESULT::from_win32(code);
            return Err(Error::new(
                hr,
                format!(
                    "GetNamedSecurityInfoW failed for {} (Win32 error {})",
                    path, code
                ),
            ));
        }

        if original_sd.is_null() {
            rollback_saved(&mut saved);
            let hr = HRESULT::from_win32(87); // ERROR_INVALID_PARAMETER
            return Err(Error::new(
                hr,
                format!("GetNamedSecurityInfoW returned no descriptor for {}", path),
            ));
        }
        let saved_original = Some(original_sd as *mut core::ffi::c_void);

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
            rollback_saved(&mut saved);
            let hr = HRESULT::from_win32(GetLastError());
            return Err(Error::new(hr, "AllocateAndInitializeSid for World failed"));
        }

        let ea = EXPLICIT_ACCESS_W {
            grfAccessPermissions: access_mask,
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

        let mut new_dacl: *mut ACL = std::ptr::null_mut();
        let code = SetEntriesInAclW(
            1,
            &ea as *const EXPLICIT_ACCESS_W,
            original_dacl,
            &mut new_dacl,
        );
        FreeSid(world_sid);

        if code != 0 {
            clean_acl(new_dacl);
            clean_sd(saved_original);
            rollback_saved(&mut saved);
            let hr = HRESULT::from_win32(code);
            return Err(Error::new(
                hr,
                format!(
                    "SetEntriesInAclW failed for {} (Win32 error {})",
                    path, code
                ),
            ));
        }

        let code = SetNamedSecurityInfoW(
            path_wide.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            new_dacl,
            std::ptr::null_mut(),
        );
        clean_acl(new_dacl);

        if code != 0 {
            clean_sd(saved_original);
            rollback_saved(&mut saved);
            let hr = HRESULT::from_win32(code);
            return Err(Error::new(
                hr,
                format!(
                    "SetNamedSecurityInfoW failed for {} (Win32 error {})",
                    path, code
                ),
            ));
        }

        saved.push(SavedAcl {
            path: path.clone(),
            security_descriptor: saved_original,
        });

        log::info!("{} DACL applied to protected path: {}", description, path);
    }

    Ok(saved)
}

/// Apply deny-write DACL to protected paths.
/// Returns saved original security descriptors for later restoration.
pub unsafe fn protect_paths(paths: &[String]) -> windows_result::Result<Vec<SavedAcl>> {
    apply_deny_acl(paths, 0x1F01FF, "Deny-write", true)
}

/// Restore original security descriptor for a path.
pub unsafe fn restore_acl(saved: &SavedAcl) -> bool {
    let Some(original_sd) = saved.security_descriptor else {
        return true;
    };

    let path_wide: Vec<u16> = saved
        .path
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    // GetNamedSecurityInfoW returned an owned, self-relative descriptor.
    // Restore from that descriptor rather than replacing it with a null/empty
    // DACL, which would silently change the original access policy.
    let code = SetFileSecurityW(
        path_wide.as_ptr(),
        DACL_SECURITY_INFORMATION,
        original_sd as PSECURITY_DESCRIPTOR,
    );
    if code != 0 {
        log::info!("DACL restored for: {}", saved.path);
        true
    } else {
        log::warn!(
            "DACL restore failed for {}: Win32 error={}",
            saved.path,
            GetLastError()
        );
        false
    }
}

/// Apply deny-read DACL to protected paths.
/// Returns saved original security descriptors for later restoration.
pub unsafe fn protect_paths_deny_read(paths: &[String]) -> windows_result::Result<Vec<SavedAcl>> {
    apply_deny_acl(paths, GENERIC_READ, "Deny-read", false)
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

    #[test]
    fn only_not_found_errors_make_a_protected_path_optional() {
        assert!(is_missing_path_error(ERROR_FILE_NOT_FOUND));
        assert!(is_missing_path_error(ERROR_PATH_NOT_FOUND));
        assert!(!is_missing_path_error(ERROR_ACCESS_DENIED));
        assert!(!is_missing_path_error(ERROR_INVALID_PARAMETER));
    }
}
