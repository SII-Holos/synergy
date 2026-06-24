// ================================================================
// Named pipe I/O — byte-stream framed IPC over Windows named pipes
// ================================================================

use crate::ipc_framed::{read_frame, write_frame, IpcMessage};
use windows_sys::Win32::Foundation::{
    CloseHandle, ERROR_BROKEN_PIPE, ERROR_PIPE_CONNECTED, GENERIC_READ, GENERIC_WRITE,
    GetLastError, HANDLE, INVALID_HANDLE_VALUE, LocalFree, HLOCAL,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, ReadFile, WriteFile, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_READ, FILE_SHARE_WRITE,
    OPEN_EXISTING,
};
use windows_sys::Win32::System::Pipes::{ConnectNamedPipe, CreateNamedPipeW};
use windows_sys::Win32::Storage::FileSystem::PIPE_ACCESS_DUPLEX;
use windows_sys::Win32::Security::{
    SECURITY_ATTRIBUTES, SECURITY_DESCRIPTOR,
    GetTokenInformation, InitializeSecurityDescriptor, SetSecurityDescriptorDacl,
    SID_AND_ATTRIBUTES, ACL,
};
use windows_sys::Win32::Security::Authorization::{
    SetEntriesInAclW, EXPLICIT_ACCESS_W, TRUSTEE_W,
    GRANT_ACCESS, NO_MULTIPLE_TRUSTEE, TRUSTEE_IS_SID, TRUSTEE_IS_USER,
};
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

const PIPE_TYPE_BYTE: u32 = 0x00000000;
const PIPE_READMODE_BYTE: u32 = 0x00000000;
const PIPE_WAIT: u32 = 0x00000000;

// windows-sys 0.59 constants not exported:
const TOKEN_QUERY: u32 = 0x0008;
const TOKEN_USER_CLASS: i32 = 1;
const SECURITY_DESCRIPTOR_REVISION: u32 = 1;

// ================================================================
// Restrictive pipe security: DACL granting GENERIC_READ|GENERIC_WRITE
// to the current user only. Called once per PipeServer::create.
// Falls back to null (current behavior) on any error.
// ================================================================

/// Build a SECURITY_ATTRIBUTES with a DACL granting GENERIC_READ|GENERIC_WRITE
/// to the current user. Returns null-pointer SA on any FFI failure (caller falls
/// back to default DACL — graceful degradation).
#[cfg(target_os = "windows")]
unsafe fn build_pipe_sa() -> SECURITY_ATTRIBUTES {
    use std::alloc::{alloc, Layout};

    // 1. Open current process token and get user SID
    let mut token: HANDLE = std::ptr::null_mut();
    if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
        return zero_sa();
    }

    // Get required buffer size
    let mut needed: u32 = 0;
    GetTokenInformation(token, TOKEN_USER_CLASS, std::ptr::null_mut(), 0, &mut needed);
    let expected_err = GetLastError();
    if expected_err != 122 {
        // ERROR_INSUFFICIENT_BUFFER
        CloseHandle(token);
        return zero_sa();
    }

    let mut buf: Vec<u8> = vec![0u8; needed as usize];
    if GetTokenInformation(
        token,
        TOKEN_USER_CLASS,
        buf.as_mut_ptr() as *mut _,
        needed,
        &mut needed,
    ) == 0 {
        CloseHandle(token);
        return zero_sa();
    }
    CloseHandle(token);

    let token_user = buf.as_ptr() as *const SID_AND_ATTRIBUTES;
    let user_sid = (*token_user).Sid;

    // 2. Build a DACL with one ACE: GRANT GENERIC_READ|GENERIC_WRITE to current user
    let ea = EXPLICIT_ACCESS_W {
        grfAccessPermissions: GENERIC_READ | GENERIC_WRITE,
        grfAccessMode: GRANT_ACCESS,
        grfInheritance: 0,
        Trustee: TRUSTEE_W {
            pMultipleTrustee: std::ptr::null_mut(),
            MultipleTrusteeOperation: NO_MULTIPLE_TRUSTEE,
            TrusteeForm: TRUSTEE_IS_SID,
            TrusteeType: TRUSTEE_IS_USER,
            ptstrName: user_sid as *mut u16,
        },
    };

    let mut dacl: *mut ACL = std::ptr::null_mut();
    let code = SetEntriesInAclW(1, &ea as *const EXPLICIT_ACCESS_W, std::ptr::null_mut(), &mut dacl);
    if code != 0 {
        return zero_sa();
    }

    // 3. Build security descriptor and security attributes
    let layout = Layout::new::<SECURITY_DESCRIPTOR>();
    let sd_ptr: *mut SECURITY_DESCRIPTOR = alloc(layout) as *mut SECURITY_DESCRIPTOR;

    if sd_ptr.is_null() {
        if !dacl.is_null() {
            LocalFree(dacl as HLOCAL);
        }
        return zero_sa();
    }

    if InitializeSecurityDescriptor(sd_ptr as *mut _, SECURITY_DESCRIPTOR_REVISION) == 0 {
        if !dacl.is_null() {
            LocalFree(dacl as HLOCAL);
        }
        std::alloc::dealloc(sd_ptr as *mut u8, layout);
        return zero_sa();
    }

    if SetSecurityDescriptorDacl(sd_ptr as *mut _, 1, dacl, 0) == 0 {
        // dacl is owned by the SD now — free dacl, free sd, fall back
        if !dacl.is_null() {
            LocalFree(dacl as HLOCAL);
        }
        std::alloc::dealloc(sd_ptr as *mut u8, layout);
        return zero_sa();
    }
    // dacl is now owned by the security descriptor — do NOT free it separately

    SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: sd_ptr as *mut _,
        bInheritHandle: 0,
    }
}

#[cfg(target_os = "windows")]
unsafe fn zero_sa() -> SECURITY_ATTRIBUTES {
    SECURITY_ATTRIBUTES {
        nLength: 0,
        lpSecurityDescriptor: std::ptr::null_mut(),
        bInheritHandle: 0,
    }
}

/// Server end of a Windows named pipe.
///
/// Creates a named pipe, waits for a single client to connect,
/// then sends/receives length-prefixed IpcMessage frames.
pub struct PipeServer {
    handle: HANDLE,
    name: String,
}

/// Client end of a Windows named pipe.
///
/// Connects to an existing named pipe server, then sends/receives
/// length-prefixed IpcMessage frames.
pub struct PipeClient {
    handle: HANDLE,
}

impl PipeServer {
    /// Create a new named pipe server listening at `name`.
    ///
    /// Uses byte-mode with a restrictive DACL granting access only
    /// to the current user. Falls back to a null DACL if building the
    /// security descriptor fails (graceful degradation).
    pub fn create(name: &str) -> Result<Self, Box<dyn std::error::Error>> {
        if !cfg!(target_os = "windows") {
            return Err("Named pipes are only available on Windows".into());
        }
        let name_wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
        let sa = unsafe {
            #[cfg(target_os = "windows")]
            { build_pipe_sa() }
            #[cfg(not(target_os = "windows"))]
            { SECURITY_ATTRIBUTES { nLength: 0, lpSecurityDescriptor: std::ptr::null_mut(), bInheritHandle: 0 } }
        };
        let sa_ptr: *const SECURITY_ATTRIBUTES = if sa.nLength > 0 { &sa as *const _ } else { std::ptr::null() };
        let handle = unsafe {
            CreateNamedPipeW(
                name_wide.as_ptr(),
                PIPE_ACCESS_DUPLEX,
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
                1,    // max instances
                4096, // out buffer size
                4096, // in buffer size
                0,    // default timeout
                sa_ptr,
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            return Err(format!(
                "CreateNamedPipeW failed: error {}",
                unsafe { GetLastError() }
            )
            .into());
        }
        Ok(PipeServer {
            handle,
            name: name.to_string(),
        })
    }

    /// Block until a client connects.
    ///
    /// If a client connected between pipe creation and this call,
    /// `ERROR_PIPE_CONNECTED` is treated as success.
    pub fn wait_for_client(&self) -> Result<(), Box<dyn std::error::Error>> {
        if !cfg!(target_os = "windows") {
            return Err("Named pipes are only available on Windows".into());
        }
        let ok = unsafe { ConnectNamedPipe(self.handle, std::ptr::null_mut()) };
        if ok == 0 {
            let err = unsafe { GetLastError() };
            if err != ERROR_PIPE_CONNECTED {
                return Err(format!("ConnectNamedPipe failed: error {}", err).into());
            }
        }
        Ok(())
    }

    /// Serialize and send an IpcMessage to the connected client.
    ///
    /// Handles partial writes with retry.
    pub fn send(&self, msg: &IpcMessage) -> Result<(), Box<dyn std::error::Error>> {
        if !cfg!(target_os = "windows") {
            return Err("Named pipes are only available on Windows".into());
        }
        let frame = write_frame(msg)?;
        let data = frame.as_bytes();
        let mut written_total: u32 = 0;
        while (written_total as usize) < data.len() {
            let mut written: u32 = 0;
            let remaining = data.len() - written_total as usize;
            let to_write = remaining.min(u32::MAX as usize) as u32;
            let ok = unsafe {
                WriteFile(
                    self.handle,
                    data.as_ptr().add(written_total as usize),
                    to_write,
                    &mut written,
                    std::ptr::null_mut(),
                )
            };
            if ok == 0 {
                let err = unsafe { GetLastError() };
                if err == ERROR_BROKEN_PIPE {
                    return Err("pipe broken during send".into());
                }
                return Err(format!("WriteFile failed: error {}", err).into());
            }
            written_total += written;
        }
        Ok(())
    }

    /// Receive and deserialize one IpcMessage from the connected client.
    ///
    /// Reads in 4 KiB chunks, accumulating into `buf`. On success,
    /// consumed bytes are removed from the buffer so it can be reused.
    pub fn receive(&self, buf: &mut Vec<u8>) -> Result<IpcMessage, Box<dyn std::error::Error>> {
        if !cfg!(target_os = "windows") {
            return Err("Named pipes are only available on Windows".into());
        }
        loop {
            // Attempt to parse a complete frame from the accumulated buffer
            if let Some((msg, consumed)) = read_frame(buf)? {
                buf.drain(..consumed);
                return Ok(msg);
            }

            // Read more data
            let mut chunk = vec![0u8; 4096];
            let mut bytes_read: u32 = 0;
            let ok = unsafe {
                ReadFile(
                    self.handle,
                    chunk.as_mut_ptr(),
                    chunk.len() as u32,
                    &mut bytes_read,
                    std::ptr::null_mut(),
                )
            };
            if ok == 0 {
                let err = unsafe { GetLastError() };
                if err == ERROR_BROKEN_PIPE {
                    if buf.is_empty() {
                        return Err("pipe closed with no data".into());
                    }
                    return Err("pipe closed with incomplete frame".into());
                }
                return Err(format!("ReadFile failed: error {}", err).into());
            }
            if bytes_read == 0 {
                return Err("pipe closed (zero-byte read)".into());
            }
            buf.extend_from_slice(&chunk[..bytes_read as usize]);
        }
    }
}

impl Drop for PipeServer {
    fn drop(&mut self) {
        if cfg!(target_os = "windows") && !self.handle.is_null() && self.handle != INVALID_HANDLE_VALUE {
            unsafe {
                CloseHandle(self.handle);
            }
        }
    }
}

impl std::fmt::Debug for PipeServer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PipeServer")
            .field("name", &self.name)
            .finish()
    }
}

impl PipeClient {
    /// Connect to an existing named pipe server at `name`.
    pub fn connect(name: &str) -> Result<Self, Box<dyn std::error::Error>> {
        if !cfg!(target_os = "windows") {
            return Err("Named pipes are only available on Windows".into());
        }
        let name_wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
        let handle = unsafe {
            CreateFileW(
                name_wide.as_ptr(),
                GENERIC_READ | GENERIC_WRITE,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                std::ptr::null(),
                OPEN_EXISTING,
                FILE_ATTRIBUTE_NORMAL,
                0 as HANDLE,
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            return Err(format!(
                "CreateFileW (pipe connect) failed: error {}",
                unsafe { GetLastError() }
            )
            .into());
        }
        Ok(PipeClient { handle })
    }

    /// Serialize and send an IpcMessage to the server.
    ///
    /// Handles partial writes with retry.
    pub fn send(&self, msg: &IpcMessage) -> Result<(), Box<dyn std::error::Error>> {
        if !cfg!(target_os = "windows") {
            return Err("Named pipes are only available on Windows".into());
        }
        let frame = write_frame(msg)?;
        let data = frame.as_bytes();
        let mut written_total: u32 = 0;
        while (written_total as usize) < data.len() {
            let mut written: u32 = 0;
            let remaining = data.len() - written_total as usize;
            let to_write = remaining.min(u32::MAX as usize) as u32;
            let ok = unsafe {
                WriteFile(
                    self.handle,
                    data.as_ptr().add(written_total as usize),
                    to_write,
                    &mut written,
                    std::ptr::null_mut(),
                )
            };
            if ok == 0 {
                let err = unsafe { GetLastError() };
                if err == ERROR_BROKEN_PIPE {
                    return Err("pipe broken during send".into());
                }
                return Err(format!("WriteFile failed: error {}", err).into());
            }
            written_total += written;
        }
        Ok(())
    }

    /// Receive and deserialize one IpcMessage from the server.
    ///
    /// Reads in 4 KiB chunks, accumulating into `buf`. On success,
    /// consumed bytes are removed from the buffer so it can be reused.
    pub fn receive(&self, buf: &mut Vec<u8>) -> Result<IpcMessage, Box<dyn std::error::Error>> {
        if !cfg!(target_os = "windows") {
            return Err("Named pipes are only available on Windows".into());
        }
        loop {
            if let Some((msg, consumed)) = read_frame(buf)? {
                buf.drain(..consumed);
                return Ok(msg);
            }

            let mut chunk = vec![0u8; 4096];
            let mut bytes_read: u32 = 0;
            let ok = unsafe {
                ReadFile(
                    self.handle,
                    chunk.as_mut_ptr(),
                    chunk.len() as u32,
                    &mut bytes_read,
                    std::ptr::null_mut(),
                )
            };
            if ok == 0 {
                let err = unsafe { GetLastError() };
                if err == ERROR_BROKEN_PIPE {
                    if buf.is_empty() {
                        return Err("pipe closed with no data".into());
                    }
                    return Err("pipe closed with incomplete frame".into());
                }
                return Err(format!("ReadFile failed: error {}", err).into());
            }
            if bytes_read == 0 {
                return Err("pipe closed (zero-byte read)".into());
            }
            buf.extend_from_slice(&chunk[..bytes_read as usize]);
        }
    }
}

impl Drop for PipeClient {
    fn drop(&mut self) {
        if cfg!(target_os = "windows") && !self.handle.is_null() && self.handle != INVALID_HANDLE_VALUE {
            unsafe {
                CloseHandle(self.handle);
            }
        }
    }
}

impl std::fmt::Debug for PipeClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PipeClient")
            .field("handle", &format_args!("{:p}", self.handle as *const ()))
            .finish()
    }
}

// ================================================================
// Tests: Named pipe I/O contracts
// ================================================================
#[cfg(test)]
mod tests {
    use super::*;
    /// Integration test: server creates, client connects, messages flow.
    #[cfg(target_os = "windows")]
    #[test]
    fn pipe_create_connect_round_trip() {
        let pipe_name = format!(
            "\\\\.\\pipe\\synergy-test-pipe-{}",
            std::process::id()
        );
        let server = PipeServer::create(&pipe_name).expect("PipeServer::create must succeed");

        // Client connects in a thread so the server's wait_for_client doesn't deadlock
        let client_pipe_name = pipe_name.clone();
        let client_handle = std::thread::spawn(move || {
            PipeClient::connect(&client_pipe_name).expect("PipeClient::connect must succeed")
        });

        server
            .wait_for_client()
            .expect("wait_for_client must succeed");
        let client = client_handle
            .join()
            .expect("client thread must not panic");

        // Round-trip a message
        let msg = IpcMessage::Ack {
            msg_id: "test1".into(),
            detail: "hello from server".into(),
        };
        server.send(&msg).expect("server send must succeed");

        let mut buf = Vec::new();
        let received = client.receive(&mut buf).expect("client receive must succeed");
        assert_eq!(received, msg);

        // Client sends back
        let reply = IpcMessage::Ack {
            msg_id: "test2".into(),
            detail: "hello from client".into(),
        };
        client.send(&reply).expect("client send must succeed");

        let mut buf = Vec::new();
        let received = server.receive(&mut buf).expect("server receive must succeed");
        assert_eq!(received, reply);
    }

    /// A large message that might be fragmented across multiple ReadFile calls.
    #[cfg(target_os = "windows")]
    #[test]
    fn pipe_fragmented_receive() {
        let pipe_name = format!(
            "\\\\.\\pipe\\synergy-test-frag-{}",
            std::process::id()
        );
        let server = PipeServer::create(&pipe_name).expect("PipeServer::create must succeed");

        let client_pipe_name = pipe_name.clone();
        let client_handle = std::thread::spawn(move || {
            PipeClient::connect(&client_pipe_name).expect("PipeClient::connect must succeed")
        });

        server
            .wait_for_client()
            .expect("wait_for_client must succeed");
        let client = client_handle
            .join()
            .expect("client thread must not panic");

        // Send a message with a large payload
        let large_msg = IpcMessage::Ack {
            msg_id: "frag".into(),
            detail: "x".repeat(32 * 1024), // 32 KiB — larger than a single 4 KiB chunk
        };
        server
            .send(&large_msg)
            .expect("server send must succeed");

        let mut buf = Vec::new();
        let received = client
            .receive(&mut buf)
            .expect("client receive must succeed");
        assert_eq!(received, large_msg, "fragmented receive must reassemble");
    }

    /// PipeServer::create fails with a descriptive error on non-Windows.
    #[test]
    fn pipe_create_fails_on_non_windows() {
        if cfg!(target_os = "windows") {
            return; // Skip on Windows, test the non-Windows path
        }
        let result = PipeServer::create("\\\\.\\pipe\\test");
        assert!(
            result.is_err(),
            "PipeServer::create must fail on non-Windows"
        );
        let err = result.unwrap_err().to_string();
        assert!(
            err.contains("Windows"),
            "Error must mention Windows: {}",
            err
        );
    }

    /// PipeClient::connect fails with a descriptive error on non-Windows.
    #[test]
    fn pipe_connect_fails_on_non_windows() {
        if cfg!(target_os = "windows") {
            return; // Skip on Windows, test the non-Windows path
        }
        let result = PipeClient::connect("\\\\.\\pipe\\test");
        assert!(
            result.is_err(),
            "PipeClient::connect must fail on non-Windows"
        );
        let err = result.unwrap_err().to_string();
        assert!(
            err.contains("Windows"),
            "Error must mention Windows: {}",
            err
        );
    }
}
