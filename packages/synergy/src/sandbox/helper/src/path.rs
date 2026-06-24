/// Canonicalize a Windows path.
/// MVP: use GetFullPathNameW for basic canonicalization.
/// Phase 4: add GetFinalPathNameByHandleW for symlink/junction resolution.
pub fn canonicalize_win_path(path: &str) -> Result<String, Box<dyn std::error::Error>> {
    use windows_sys::Win32::Storage::FileSystem::GetFullPathNameW;

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
            return Err(format!("GetFullPathNameW failed for: {}", path).into());
        }
        let result = String::from_utf16_lossy(&buffer[..len as usize]);
        Ok(result)
    }
}
