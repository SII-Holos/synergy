use std::error::Error;

use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, GetFileInformationByHandle, GetFinalPathNameByHandleW, GetFullPathNameW,
    BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT,
    FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_DELETE, FILE_SHARE_READ,
    FILE_SHARE_WRITE, OPEN_EXISTING,
};

fn has_parent_component(path: &str) -> bool {
    path.replace('/', "\\")
        .split('\\')
        .any(|component| component == "..")
}

fn is_absolute_win_path(path: &str) -> bool {
    let bytes = path.as_bytes();
    (bytes.len() >= 3 && bytes[1] == b':' && bytes[2] == b'\\' && bytes[0].is_ascii_alphabetic())
        || path.starts_with(r"\\")
}

pub fn is_volume_root(path: &str) -> bool {
    let normalized = path.replace('/', "\\").to_ascii_lowercase();
    let bytes = normalized.as_bytes();

    let is_drive_root = bytes.len() == 2 && bytes[1] == b':'
        || bytes.len() == 3 && bytes[1] == b':' && bytes[2] == b'\\';
    if is_drive_root && bytes[0].is_ascii_alphabetic() {
        return true;
    }

    if let Some(unc) = normalized.strip_prefix(r"\\") {
        return unc.split('\\').filter(|part| !part.is_empty()).count() <= 2;
    }

    false
}

/// Normalize a path that is already known to be absolute.
///
/// This deliberately does not resolve `..`: callers handling security
/// boundaries must reject that input before asking Windows to normalize it.
pub fn normalize_absolute_path(path: &str) -> Result<String, Box<dyn Error>> {
    if path.is_empty() || path.contains('\0') {
        return Err("path is empty or contains an embedded NUL".into());
    }
    if has_parent_component(path) {
        return Err(format!("path contains a parent component: {path}").into());
    }

    let mut normalized = path.replace('/', "\\");
    if !is_absolute_win_path(&normalized) {
        return Err(format!("path is not absolute: {path}").into());
    }
    if normalized.starts_with(r"\\?\") || normalized.starts_with(r"\\.\") {
        return Err(format!("device namespace path is not allowed: {path}").into());
    }

    while normalized.ends_with('\\') && !is_volume_root(&normalized) {
        normalized.pop();
    }
    Ok(normalized)
}

/// Canonicalize a Windows path using GetFullPathNameW.
pub fn canonicalize_win_path(path: &str) -> Result<String, Box<dyn Error>> {
    if path.is_empty() || path.contains('\0') {
        return Err("path is empty or contains an embedded NUL".into());
    }

    let path_wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
    let mut buffer: [u16; 32767] = [0; 32767];

    unsafe {
        let len = GetFullPathNameW(
            path_wide.as_ptr(),
            buffer.len() as u32,
            buffer.as_mut_ptr(),
            std::ptr::null_mut(),
        );
        if len == 0 {
            return Err(format!("GetFullPathNameW failed for {path}").into());
        }
        if len as usize >= buffer.len() {
            return Err(format!("path is too long to canonicalize: {path}").into());
        }
        let result = String::from_utf16(&buffer[..len as usize])
            .map_err(|_| format!("GetFullPathNameW returned invalid UTF-16 for {path}"))?;
        normalize_absolute_path(&result)
    }
}

struct HandleGuard(HANDLE);

impl Drop for HandleGuard {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}

fn inspect_directory_without_following_reparse(path: &str) -> Result<(), Box<dyn Error>> {
    let path_wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
    let handle = unsafe {
        CreateFileW(
            path_wide.as_ptr(),
            0,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            std::ptr::null_mut(),
        )
    };
    if handle.is_null() || handle == INVALID_HANDLE_VALUE {
        return Err(format!(
            "cannot safely open path component {path} (Win32 error {})",
            unsafe { GetLastError() }
        )
        .into());
    }
    let _handle = HandleGuard(handle);

    let mut information: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    if unsafe { GetFileInformationByHandle(handle, &mut information) } == 0 {
        return Err(format!(
            "cannot inspect path component {path} (Win32 error {})",
            unsafe { GetLastError() }
        )
        .into());
    }
    if information.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(
            format!("reparse point or junction is not allowed in deny root: {path}").into(),
        );
    }
    if information.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0 {
        return Err(format!("deny root is not a directory: {path}").into());
    }
    Ok(())
}

fn final_directory_path(path: &str) -> Result<String, Box<dyn Error>> {
    let path_wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
    let handle = unsafe {
        CreateFileW(
            path_wide.as_ptr(),
            0,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS,
            std::ptr::null_mut(),
        )
    };
    if handle.is_null() || handle == INVALID_HANDLE_VALUE {
        return Err(format!(
            "cannot resolve final path {path} (Win32 error {})",
            unsafe { GetLastError() }
        )
        .into());
    }
    let _handle = HandleGuard(handle);

    let mut buffer = [0u16; 32768];
    let len =
        unsafe { GetFinalPathNameByHandleW(handle, buffer.as_mut_ptr(), buffer.len() as u32, 0) };
    if len == 0 || len as usize >= buffer.len() {
        return Err(format!(
            "cannot obtain final path for {path} (Win32 error {})",
            unsafe { GetLastError() }
        )
        .into());
    }
    let final_path = String::from_utf16(&buffer[..len as usize])
        .map_err(|_| format!("final path for {path} is not valid UTF-16"))?;
    let dos_path = if let Some(unc) = final_path.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{unc}")
    } else if let Some(dos) = final_path.strip_prefix(r"\\?\") {
        dos.to_string()
    } else {
        return Err(format!("final path uses an unsupported namespace: {final_path}").into());
    };
    normalize_absolute_path(&dos_path)
}

fn directory_prefixes(path: &str) -> Result<Vec<String>, Box<dyn Error>> {
    let path = path.replace('/', "\\");
    let bytes = path.as_bytes();
    if bytes.len() >= 3 && bytes[1] == b':' && bytes[2] == b'\\' {
        let mut prefixes = vec![path[..3].to_string()];
        let mut current = prefixes[0].clone();
        for component in path[3..].split('\\').filter(|part| !part.is_empty()) {
            current.push_str(component);
            prefixes.push(current.clone());
            current.push('\\');
        }
        return Ok(prefixes);
    }

    if let Some(unc) = path.strip_prefix(r"\\") {
        let components: Vec<&str> = unc.split('\\').filter(|part| !part.is_empty()).collect();
        if components.len() < 2 {
            return Err(format!("invalid UNC path: {path}").into());
        }
        let mut current = format!(r"\\{}\{}", components[0], components[1]);
        let mut prefixes = vec![current.clone()];
        for component in &components[2..] {
            current.push('\\');
            current.push_str(component);
            prefixes.push(current.clone());
        }
        return Ok(prefixes);
    }

    Err(format!("path is not an absolute Windows path: {path}").into())
}

/// Resolve an existing directory and prove that every directory component is
/// a normal directory. Opening with FILE_FLAG_OPEN_REPARSE_POINT means a
/// junction/symlink is observed rather than followed and is rejected before
/// the resolved path is used.
pub fn canonicalize_existing_win_path(path: &str) -> Result<String, Box<dyn Error>> {
    let lexical = canonicalize_win_path(path)?;
    for prefix in directory_prefixes(&lexical)? {
        inspect_directory_without_following_reparse(&prefix)?;
    }
    final_directory_path(&lexical)
}

/// Canonicalize a deny root and reject inputs that could target an unexpected
/// directory. In addition to rejecting `..` and volume roots, this refuses
/// reparse/junction components and returns the final, non-alias DOS path for
/// comparison and ACL application.
pub fn canonicalize_deny_root(path: &str) -> Result<String, Box<dyn Error>> {
    if has_parent_component(path) {
        return Err(format!("deny root contains '..' and is refused: {path}").into());
    }

    let lexical = canonicalize_win_path(path)?;
    if is_volume_root(&lexical) {
        return Err(format!("volume root is not a valid deny root: {path}").into());
    }

    let canonical = canonicalize_existing_win_path(&lexical)?;
    if is_volume_root(&canonical) {
        return Err(format!("resolved deny root is a volume root: {path}").into());
    }
    Ok(canonical)
}

#[cfg(test)]
mod tests {
    use super::{is_volume_root, normalize_absolute_path};

    #[test]
    fn normalization_rejects_parent_components_instead_of_resolving_them() {
        assert!(normalize_absolute_path(r"C:\Users\alice\..\secrets").is_err());
    }

    #[test]
    fn normalization_rejects_device_namespace_paths() {
        assert!(normalize_absolute_path(r"\\?\C:\Users\alice\secrets").is_err());
    }

    #[test]
    fn volume_root_detection_handles_drive_and_unc_roots() {
        assert!(is_volume_root(r"C:\"));
        assert!(is_volume_root(r"\\server\share\"));
        assert!(!is_volume_root(r"C:\Users\alice"));
        assert!(!is_volume_root(r"\\server\share\alice"));
    }
}
