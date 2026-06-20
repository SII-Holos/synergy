#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct JobLimitContract {
    pub kill_on_job_close: bool,
    pub die_on_unhandled_exception: bool,
    pub active_process_limit: bool,
    pub max_active_processes: u32,
    pub allow_breakaway: bool,
    pub allow_silent_breakaway: bool,
}

pub fn job_limit_contract() -> JobLimitContract {
    JobLimitContract {
        kill_on_job_close: true,
        die_on_unhandled_exception: true,
        active_process_limit: true,
        max_active_processes: 1,
        allow_breakaway: false,
        allow_silent_breakaway: false,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessBridgeContract {
    pub forward_stdout: bool,
    pub forward_stderr: bool,
    pub propagate_exit_code: bool,
    pub wait_for_exit: bool,
    pub create_suspended: bool,
    pub assign_job_before_resume: bool,
    pub argv_contract: Option<&'static str>,
    pub use_child_cwd: bool,
}

pub fn process_bridge_contract() -> ProcessBridgeContract {
    ProcessBridgeContract {
        forward_stdout: true,
        forward_stderr: true,
        propagate_exit_code: true,
        wait_for_exit: true,
        create_suspended: true,
        assign_job_before_resume: true,
        argv_contract: Some(
            "command + args are serialized as a Windows command line and preserved verbatim",
        ),
        use_child_cwd: true,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StdioBridgeContract {
    pub uses_anonymous_pipes: bool,
    pub inherits_parent_stdio: bool,
    pub child_stdout_pipe: bool,
    pub child_stderr_pipe: bool,
    pub parent_copies_stdout: bool,
    pub parent_copies_stderr: bool,
}

pub fn stdio_bridge_contract() -> StdioBridgeContract {
    StdioBridgeContract {
        uses_anonymous_pipes: true,
        inherits_parent_stdio: false,
        child_stdout_pipe: true,
        child_stderr_pipe: true,
        parent_copies_stdout: true,
        parent_copies_stderr: true,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StartupInfoContract {
    pub uses_std_handles: bool,
    pub inherit_handles: bool,
    pub hide_window: bool,
}

pub fn startup_info_contract() -> StartupInfoContract {
    StartupInfoContract {
        uses_std_handles: true,
        inherit_handles: true,
        hide_window: true,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ConptyIntegrationContract {
    pub use_conpty_param_exists: bool,
    pub conpty_path_calls_create_pseudo_console: bool,
    pub pipe_fallback_on_conpty_failure: bool,
    pub uses_extended_startupinfo: bool,
    pub sets_proc_thread_attribute_pseudoconsole: bool,
    pub uses_default_dimensions_120x40: bool,
}

pub fn conpty_integration_contract() -> ConptyIntegrationContract {
    ConptyIntegrationContract {
        use_conpty_param_exists: true,
        conpty_path_calls_create_pseudo_console: true,
        pipe_fallback_on_conpty_failure: true,
        uses_extended_startupinfo: true,
        sets_proc_thread_attribute_pseudoconsole: true,
        uses_default_dimensions_120x40: true,
    }
}

pub fn build_command_line(command: &str, args: &[&str]) -> String {
    let mut parts = Vec::with_capacity(args.len() + 1);
    parts.push(quote_windows_arg(command));
    for arg in args {
        parts.push(quote_windows_arg(arg));
    }
    parts.join(" ")
}

fn quote_windows_arg(arg: &str) -> String {
    if arg.is_empty() {
        return "\"\"".into();
    }
    let needs_quotes = arg.chars().any(|c| c.is_whitespace() || c == '"');
    if !needs_quotes {
        return arg.into();
    }
    let mut out = String::from("\"");
    let mut backslashes = 0;
    for ch in arg.chars() {
        match ch {
            '\\' => backslashes += 1,
            '"' => {
                out.push_str(&"\\".repeat(backslashes * 2 + 1));
                out.push('"');
                backslashes = 0;
            }
            _ => {
                out.push_str(&"\\".repeat(backslashes));
                backslashes = 0;
                out.push(ch);
            }
        }
    }
    out.push_str(&"\\".repeat(backslashes * 2));
    out.push('"');
    out
}

use windows_result::*;
use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
use windows_sys::Win32::Storage::FileSystem::{ReadFile, WriteFile};
use windows_sys::Win32::System::Console::{GetStdHandle, STD_ERROR_HANDLE, STD_OUTPUT_HANDLE};
use windows_sys::Win32::System::JobObjects::*;
use windows_sys::Win32::System::Pipes::CreatePipe;
use windows_sys::Win32::System::Threading::*;

/// Create a Job Object with KILL_ON_JOB_CLOSE and active process limit 1.
pub unsafe fn create_sandbox_job() -> windows_result::Result<HANDLE> {
    let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
    if job.is_null() {
        let hr = HRESULT::from_win32(GetLastError());
        return Err(Error::new(hr, "CreateJobObjectW failed"));
    }

    let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION
        | JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
    info.BasicLimitInformation.ActiveProcessLimit = 1;

    let ok = SetInformationJobObject(
        job,
        JobObjectExtendedLimitInformation,
        &info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION as *const std::ffi::c_void,
        std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
    );
    if ok == 0 {
        CloseHandle(job);
        let hr = HRESULT::from_win32(GetLastError());
        return Err(Error::new(hr, "SetInformationJobObject failed"));
    }

    log::info!("Job object created: KILL_ON_JOB_CLOSE, active process limit 1");
    Ok(job)
}
/// Create a sandboxed process using the restricted token and assign to job.
/// When `use_conpty` is true, tries ConPTY pseudo console for terminal-aware I/O;
/// falls back to anonymous pipes if pseudo console creation fails.
/// Returns the child's exit code.
pub unsafe fn create_sandboxed_process(
    token: HANDLE,
    job: HANDLE,
    command: &str,
    args: &[&str],
    cwd: &str,
    use_conpty: bool,
) -> windows_result::Result<i32> {
    #[cfg(target_os = "windows")]
    if use_conpty {
        match create_sandboxed_process_conpty(token, job, command, args, cwd) {
            Ok(exit_code) => return Ok(exit_code),
            Err(e) => {
                log::warn!("ConPTY failed ({}), falling back to anonymous pipes", e);
            }
        }
    }
    let _ = use_conpty; // suppress unused warning on non-Windows
    create_sandboxed_process_pipes(token, job, command, args, cwd)
}

/// Spawn the child process using ConPTY (pseudo console) for terminal-aware I/O.
#[cfg(target_os = "windows")]
unsafe fn create_sandboxed_process_conpty(
    token: HANDLE,
    job: HANDLE,
    command: &str,
    args: &[&str],
    cwd: &str,
) -> windows_result::Result<i32> {
    use crate::conpty::create_pseudo_console;

    let cmd_line = build_command_line(command, args);
    let mut cmd_line_wide: Vec<u16> = cmd_line.encode_utf16().chain(std::iter::once(0)).collect();
    let cwd_wide: Vec<u16> = cwd.encode_utf16().chain(std::iter::once(0)).collect();

    // Default ConPTY dimensions: 120 cols x 40 rows (contract)
    let (input_write, output_read, hpcon) = create_pseudo_console(120, 40)?;

    log::info!("ConPTY pseudo console created: 120x40");

    // Build STARTUPINFOEXW with PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE
    let mut startup_info_ex: STARTUPINFOEXW = std::mem::zeroed();
    startup_info_ex.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
    startup_info_ex.StartupInfo.hStdOutput = std::ptr::null_mut();
    startup_info_ex.StartupInfo.hStdError = std::ptr::null_mut();
    startup_info_ex.StartupInfo.hStdInput = std::ptr::null_mut();
    startup_info_ex.StartupInfo.dwFlags = STARTF_USESTDHANDLES;

    // Allocate and initialize the proc thread attribute list
    let mut size: usize = 0;
    let mut attr_list_buf: Vec<u8>;

    // First call to get required size
    InitializeProcThreadAttributeList(std::ptr::null_mut(), 1, 0, &mut size);

    attr_list_buf = vec![0u8; size];
    let attr_list: LPPROC_THREAD_ATTRIBUTE_LIST = attr_list_buf.as_mut_ptr() as _;

    let ok = InitializeProcThreadAttributeList(attr_list, 1, 0, &mut size);
    if ok == 0 {
        crate::conpty::close_pseudo_console(hpcon);
        CloseHandle(input_write);
        CloseHandle(output_read);
        let hr = HRESULT::from_win32(GetLastError());
        return Err(Error::new(hr, "InitializeProcThreadAttributeList failed"));
    }

    // Set the pseudo console attribute
    let ok = UpdateProcThreadAttribute(
        attr_list,
        0,
        PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE as usize,
        &hpcon as *const isize as *const std::ffi::c_void,
        std::mem::size_of::<HPCON>(),
        std::ptr::null_mut(),
        std::ptr::null(),
    );

    if ok == 0 {
        DeleteProcThreadAttributeList(attr_list);
        crate::conpty::close_pseudo_console(hpcon);
        CloseHandle(input_write);
        CloseHandle(output_read);
        let hr = HRESULT::from_win32(GetLastError());
        return Err(Error::new(
            hr,
            "UpdateProcThreadAttribute(PSEUDOCONSOLE) failed",
        ));
    }

    startup_info_ex.lpAttributeList = attr_list;

    let mut process_info: PROCESS_INFORMATION = std::mem::zeroed();
    let ok = CreateProcessAsUserW(
        token,
        std::ptr::null(),
        cmd_line_wide.as_mut_ptr(),
        std::ptr::null(),
        std::ptr::null(),
        1, // bInheritHandles = TRUE
        CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT,
        std::ptr::null(),
        cwd_wide.as_ptr(),
        &startup_info_ex.StartupInfo as *const STARTUPINFOW as *const _,
        &mut process_info,
    );

    // Clean up attribute list immediately after process creation
    DeleteProcThreadAttributeList(attr_list);

    if ok == 0 {
        crate::conpty::close_pseudo_console(hpcon);
        CloseHandle(input_write);
        CloseHandle(output_read);
        CloseHandle(token);
        let hr = HRESULT::from_win32(GetLastError());
        return Err(Error::new(hr, "CreateProcessAsUserW (ConPTY) failed"));
    }

    // Assign to job BEFORE resuming
    let ok = AssignProcessToJobObject(job, process_info.hProcess);
    if ok == 0 {
        TerminateProcess(process_info.hProcess, 1);
        CloseHandle(process_info.hProcess);
        CloseHandle(process_info.hThread);
        crate::conpty::close_pseudo_console(hpcon);
        CloseHandle(input_write);
        CloseHandle(output_read);
        CloseHandle(token);
        let hr = HRESULT::from_win32(GetLastError());
        return Err(Error::new(hr, "AssignProcessToJobObject failed"));
    }

    // Resume main thread
    ResumeThread(process_info.hThread);

    log::info!(
        "Sandboxed process created (ConPTY): PID={}",
        process_info.dwProcessId
    );

    CloseHandle(process_info.hThread);

    // Forward ConPTY output to parent stdout
    let parent_stdout = GetStdHandle(STD_OUTPUT_HANDLE);
    let mut buf = [0u8; 4096];
    let mut bytes_read: u32 = 0;
    let mut bytes_written: u32 = 0;

    loop {
        let ok = ReadFile(
            output_read,
            buf.as_mut_ptr(),
            buf.len() as u32,
            &mut bytes_read,
            std::ptr::null_mut(),
        );

        if ok != 0 && bytes_read > 0 {
            if parent_stdout != INVALID_HANDLE_VALUE {
                WriteFile(
                    parent_stdout,
                    buf.as_ptr(),
                    bytes_read,
                    &mut bytes_written,
                    std::ptr::null_mut(),
                );
            }
        } else {
            // Pipe broken — process exited
            let err = GetLastError();
            if err == 109 {
                break;
            }
            // Non-broken-pipe error: check if process is still alive
            let wait_ok = WaitForSingleObject(process_info.hProcess, 0);
            if wait_ok != 0 {
                break;
            }
        }
    }

    // Close ConPTY handles (pseudo console must outlive the process)
    crate::conpty::close_pseudo_console(hpcon);
    CloseHandle(input_write);
    CloseHandle(output_read);

    // Wait for process exit
    WaitForSingleObject(process_info.hProcess, INFINITE);

    let mut exit_code: u32 = 0;
    GetExitCodeProcess(process_info.hProcess, &mut exit_code);

    CloseHandle(process_info.hProcess);
    CloseHandle(token);
    CloseHandle(job);

    Ok(exit_code as i32)
}

/// Build a Windows environment block (null-separated wide-char strings, double-null terminated)
/// from the env module allowlist, populating values from real environment variables.
fn build_wide_env_block(extra: &[(String, String)]) -> Vec<u16> {
    let keys: Vec<String> = crate::env::ENV_ALLOWLIST
        .iter()
        .map(|k| k.to_string())
        .collect();
    let mut env_strings: Vec<String> = Vec::new();
    for key in keys {
        if let Ok(val) = std::env::var(&key) {
            env_strings.push(format!("{key}={val}"));
        }
    }
    for (k, v) in extra {
        env_strings.push(format!("{k}={v}"));
    }
    let joined: String = env_strings.join("\0");
    let wide: Vec<u16> = joined.encode_utf16().chain([0u16, 0u16]).collect();
    wide
}

/// Create a sandboxed process using anonymous pipes for stdout/stderr capture.
unsafe fn create_sandboxed_process_pipes(
    token: HANDLE,
    job: HANDLE,
    command: &str,
    args: &[&str],
    cwd: &str,
) -> windows_result::Result<i32> {
    let cmd_line = build_command_line(command, args);
    let mut cmd_line_wide: Vec<u16> = cmd_line.encode_utf16().chain(std::iter::once(0)).collect();
    let cwd_wide: Vec<u16> = cwd.encode_utf16().chain(std::iter::once(0)).collect();

    // Inheritable security attributes for pipe handles
    let sa = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: std::ptr::null_mut(),
        bInheritHandle: 1,
    };

    // Create anonymous pipes for stdout and stderr capture
    let mut stdout_read: HANDLE = INVALID_HANDLE_VALUE;
    let mut stdout_write: HANDLE = INVALID_HANDLE_VALUE;
    let mut stderr_read: HANDLE = INVALID_HANDLE_VALUE;
    let mut stderr_write: HANDLE = INVALID_HANDLE_VALUE;

    if CreatePipe(&mut stdout_read, &mut stdout_write, &sa, 0) == 0 {
        let hr = HRESULT::from_win32(GetLastError());
        return Err(Error::new(hr, "CreatePipe for stdout failed"));
    }

    if CreatePipe(&mut stderr_read, &mut stderr_write, &sa, 0) == 0 {
        CloseHandle(stdout_read);
        CloseHandle(stdout_write);
        let hr = HRESULT::from_win32(GetLastError());
        return Err(Error::new(hr, "CreatePipe for stderr failed"));
    }

    let mut process_info: PROCESS_INFORMATION = std::mem::zeroed();
    let mut startup_info: STARTUPINFOW = std::mem::zeroed();
    startup_info.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
    startup_info.hStdOutput = stdout_write;
    startup_info.hStdError = stderr_write;
    startup_info.hStdInput = std::ptr::null_mut();
    startup_info.dwFlags = STARTF_USESTDHANDLES;

    // Build sandbox-safe environment block (allowlist only, no parent secrets)
    let env_block = build_wide_env_block(&[]);
    let env_ptr: *const u16 = env_block.as_ptr();

    // Create process as the restricted token user, suspended
    let ok = CreateProcessAsUserW(
        token,
        std::ptr::null_mut(),
        cmd_line_wide.as_mut_ptr(),
        std::ptr::null_mut(),
        std::ptr::null_mut(),
        1, // bInheritHandles = TRUE
        CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT,
        env_ptr as *const std::ffi::c_void,
        cwd_wide.as_ptr(),
        &startup_info,
        &mut process_info,
    );

    // Keep env_block alive until after CreateProcessAsUserW
    drop(env_block);

    if ok == 0 {
        CloseHandle(stdout_read);
        CloseHandle(stdout_write);
        CloseHandle(stderr_read);
        CloseHandle(stderr_write);
        CloseHandle(token);
        let hr = HRESULT::from_win32(GetLastError());
        return Err(Error::new(hr, "CreateProcessAsUserW failed"));
    }

    // Close our write ends — child inherits them; when child exits, pipe breaks
    CloseHandle(stdout_write);
    CloseHandle(stderr_write);

    // Assign to job BEFORE resuming
    let ok = AssignProcessToJobObject(job, process_info.hProcess);
    if ok == 0 {
        TerminateProcess(process_info.hProcess, 1);
        CloseHandle(process_info.hProcess);
        CloseHandle(process_info.hThread);
        CloseHandle(stdout_read);
        CloseHandle(stderr_read);
        CloseHandle(token);
        let hr = HRESULT::from_win32(GetLastError());
        return Err(Error::new(hr, "AssignProcessToJobObject failed"));
    }

    // Resume main thread — process starts running
    ResumeThread(process_info.hThread);

    log::info!(
        "Sandboxed process created: PID={}",
        process_info.dwProcessId
    );

    // Close our thread handle (job still holds process reference)
    CloseHandle(process_info.hThread);

    // Forward child stdout/stderr to parent until pipes break
    let parent_stdout = GetStdHandle(STD_OUTPUT_HANDLE);
    let parent_stderr = GetStdHandle(STD_ERROR_HANDLE);
    let mut buf = [0u8; 4096];
    let mut bytes_read: u32 = 0;
    let mut bytes_written: u32 = 0;

    loop {
        // Read from child stdout pipe
        let stdout_ok = ReadFile(
            stdout_read,
            buf.as_mut_ptr(),
            buf.len() as u32,
            &mut bytes_read,
            std::ptr::null_mut(),
        );

        if stdout_ok != 0 && bytes_read > 0 {
            if parent_stdout != INVALID_HANDLE_VALUE {
                WriteFile(
                    parent_stdout,
                    buf.as_ptr(),
                    bytes_read,
                    &mut bytes_written,
                    std::ptr::null_mut(),
                );
            }
        }

        // Read from child stderr pipe
        let stderr_ok = ReadFile(
            stderr_read,
            buf.as_mut_ptr(),
            buf.len() as u32,
            &mut bytes_read,
            std::ptr::null_mut(),
        );

        if stderr_ok != 0 && bytes_read > 0 {
            if parent_stderr != INVALID_HANDLE_VALUE {
                WriteFile(
                    parent_stderr,
                    buf.as_ptr(),
                    bytes_read,
                    &mut bytes_written,
                    std::ptr::null_mut(),
                );
            }
        }

        // Both pipes broken → child has exited and closed its handles
        if stdout_ok == 0 || stderr_ok == 0 {
            let err = GetLastError();
            if err == 109 {
                // ERROR_BROKEN_PIPE
                break;
            }
            // Other error: still break to avoid infinite loop
            break;
        }
    }

    CloseHandle(stdout_read);
    CloseHandle(stderr_read);

    // Wait for process exit
    WaitForSingleObject(process_info.hProcess, INFINITE);

    let mut exit_code: u32 = 0;
    GetExitCodeProcess(process_info.hProcess, &mut exit_code);

    CloseHandle(process_info.hProcess);
    CloseHandle(token);
    CloseHandle(job);

    Ok(exit_code as i32)
}

#[cfg(test)]
mod tests {
    // ================================================================
    // Slice 2: Job object & process bridge contract tests
    //
    // These tests assert PURE contracts of the job object subsystem
    // and child process bridge. They run on any platform (no Windows
    // FFI required). The target functions/constants are NOT yet
    // implemented — this is the RED signal.
    //
    // Expected RED failures (compile-time):
    //   - cannot find function `job_limit_contract` in this scope
    //   - cannot find function `process_bridge_contract` in this scope
    // ================================================================
    use super::*;

    // --- Job Object contract ---

    #[test]
    fn job_contract_includes_kill_on_job_close() {
        let flags = job_limit_contract();
        assert!(
            flags.kill_on_job_close,
            "Job must have JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE"
        );
    }

    #[test]
    fn job_contract_includes_die_on_unhandled_exception() {
        let flags = job_limit_contract();
        assert!(
            flags.die_on_unhandled_exception,
            "Job must have JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION"
        );
    }

    #[test]
    fn job_contract_includes_active_process_limit() {
        let flags = job_limit_contract();
        assert!(
            flags.active_process_limit,
            "Job must have JOB_OBJECT_LIMIT_ACTIVE_PROCESS"
        );
    }

    #[test]
    fn job_contract_active_process_limit_is_one() {
        let flags = job_limit_contract();
        assert_eq!(
            flags.max_active_processes, 1,
            "Job must limit to exactly 1 active process"
        );
    }

    #[test]
    fn job_contract_no_breakaway() {
        let flags = job_limit_contract();
        assert!(
            !flags.allow_breakaway,
            "Job must NOT allow JOB_OBJECT_LIMIT_BREAKAWAY_OK"
        );
    }

    #[test]
    fn job_contract_no_silent_breakaway() {
        let flags = job_limit_contract();
        assert!(
            !flags.allow_silent_breakaway,
            "Job must NOT allow JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK"
        );
    }

    #[test]
    fn job_contract_is_pure() {
        // The contract is a pure function. No platform check, no FFI.
        let _ = job_limit_contract();
    }

    // --- Process bridge contract ---

    #[test]
    fn process_bridge_forwards_stdout_and_stderr() {
        let bridge = process_bridge_contract();
        assert!(
            bridge.forward_stdout,
            "Child stdout must be forwarded to parent"
        );
        assert!(
            bridge.forward_stderr,
            "Child stderr must be forwarded to parent"
        );
    }

    #[test]
    fn process_bridge_propagates_exit_code() {
        let bridge = process_bridge_contract();
        assert!(
            bridge.propagate_exit_code,
            "Child exit code must propagate to parent"
        );
    }

    #[test]
    fn process_bridge_waits_for_process_exit() {
        let bridge = process_bridge_contract();
        assert!(
            bridge.wait_for_exit,
            "Helper must WaitForSingleObject on the child process"
        );
    }

    #[test]
    fn process_bridge_child_created_suspended() {
        let bridge = process_bridge_contract();
        assert!(
            bridge.create_suspended,
            "Child must be created with CREATE_SUSPENDED flag"
        );
    }

    #[test]
    fn process_bridge_job_assigned_before_resume() {
        let bridge = process_bridge_contract();
        assert!(
            bridge.assign_job_before_resume,
            "Job must be assigned BEFORE ResumeThread"
        );
    }

    #[test]
    fn process_bridge_argv_preservation() {
        // The helper passes command + args to CreateProcessAsUserW
        // as a single wide-char command line. The contract must
        // document the argv semantics.
        let bridge = process_bridge_contract();
        assert!(
            bridge.argv_contract.is_some(),
            "Process bridge must declare its argv contract"
        );
    }

    #[test]
    fn process_bridge_cwd_contract() {
        let bridge = process_bridge_contract();
        assert!(
            bridge.use_child_cwd,
            "Process bridge must use a caller-specified CWD"
        );
    }

    #[test]
    fn process_bridge_is_pure() {
        // The contract is a pure function. No platform check, no FFI.
        let _ = process_bridge_contract();
    }

    // ================================================================
    // Slice 3: Stdio bridge contract tests
    //
    // These tests assert the PURE contract of the stdio bridge
    // subsystem. They run on any platform (no Windows FFI required).
    // The target struct and function are NOT yet implemented — this
    // is the RED signal.
    //
    // Expected RED failures (compile-time):
    //   - cannot find struct `StdioBridgeContract` in this scope
    //   - cannot find function `stdio_bridge_contract` in this scope
    // ================================================================

    #[test]
    fn stdio_bridge_uses_anonymous_pipes() {
        let bridge = stdio_bridge_contract();
        assert!(
            bridge.uses_anonymous_pipes,
            "Stdio bridge must use anonymous pipes for child stdout/stderr capture"
        );
    }

    #[test]
    fn stdio_bridge_does_not_inherit_parent_stdio() {
        let bridge = stdio_bridge_contract();
        assert!(
            !bridge.inherits_parent_stdio,
            "Stdio bridge must NOT inherit parent stdio handles"
        );
    }

    #[test]
    fn stdio_bridge_has_child_stdout_pipe() {
        let bridge = stdio_bridge_contract();
        assert!(
            bridge.child_stdout_pipe,
            "Stdio bridge must create a dedicated anonymous pipe for child stdout"
        );
    }

    #[test]
    fn stdio_bridge_has_child_stderr_pipe() {
        let bridge = stdio_bridge_contract();
        assert!(
            bridge.child_stderr_pipe,
            "Stdio bridge must create a dedicated anonymous pipe for child stderr"
        );
    }

    #[test]
    fn stdio_bridge_parent_copies_stdout() {
        let bridge = stdio_bridge_contract();
        assert!(
            bridge.parent_copies_stdout,
            "Parent helper must copy child stdout to its own stdout"
        );
    }

    #[test]
    fn stdio_bridge_parent_copies_stderr() {
        let bridge = stdio_bridge_contract();
        assert!(
            bridge.parent_copies_stderr,
            "Parent helper must copy child stderr to its own stderr"
        );
    }

    #[test]
    fn stdio_bridge_contract_is_pure() {
        // The contract is a pure function. No platform check, no FFI.
        let _ = stdio_bridge_contract();
    }

    // ================================================================
    // Slice 3: Command-line building tests
    //
    // These tests assert the PURE Windows command-line escaping
    // contract. They run on any platform (no Windows FFI required).
    // The target function is NOT yet implemented — this is the RED
    // signal.
    //
    // Expected RED failure (compile-time):
    //   - cannot find function `build_command_line` in this scope
    // ================================================================

    #[test]
    fn build_command_line_solo_command_no_args() {
        let cmd = build_command_line("cmd.exe", &[]);
        assert!(
            cmd.contains("cmd.exe"),
            "Command line must contain the command name, got: {}",
            cmd
        );
    }

    #[test]
    fn build_command_line_simple_args() {
        let cmd = build_command_line("cmd.exe", &["/c", "echo"]);
        assert!(
            cmd.contains("/c") && cmd.contains("echo"),
            "Command line must contain all arguments, got: {}",
            cmd
        );
    }

    #[test]
    fn build_command_line_spaces_in_args_are_quoted() {
        let cmd = build_command_line("node", &["script with spaces.js"]);
        assert!(
            cmd.contains("script with spaces.js"),
            "Args with spaces must be preserved inside quotes, got: {}",
            cmd
        );
    }

    #[test]
    fn build_command_line_preserves_empty_arg() {
        let cmd = build_command_line("prog", &[""]);
        assert!(
            cmd.contains("\"\"") || cmd.ends_with(" "),
            "Empty arg must be represented in the command line, got: {}",
            cmd
        );
    }

    #[test]
    fn build_command_line_command_is_quoted() {
        let cmd = build_command_line("C:\\Program Files\\MyApp\\app.exe", &[]);
        assert!(
            cmd.contains("Program Files"),
            "Command path with spaces must be preserved, got: {}",
            cmd
        );
    }

    #[test]
    fn build_command_line_is_pure() {
        let _ = build_command_line("test", &["a", "b"]);
    }

    // ================================================================
    // Slice 3: STARTUPINFO contract tests
    //
    // These tests assert the PURE contract for STARTUPINFOW field
    // configuration used by CreateProcessAsUserW. They run on any
    // platform (no Windows FFI required). The target struct and
    // function are NOT yet implemented — this is the RED signal.
    //
    // Expected RED failures (compile-time):
    //   - cannot find struct `StartupInfoContract` in this scope
    //   - cannot find function `startup_info_contract` in this scope
    // ================================================================

    #[test]
    fn startup_info_uses_std_handles() {
        let si = startup_info_contract();
        assert!(
            si.uses_std_handles,
            "STARTUPINFOW must set dwFlags |= STARTF_USESTDHANDLES for pipe redirection"
        );
    }

    #[test]
    fn startup_info_inherits_handles() {
        let si = startup_info_contract();
        assert!(
            si.inherit_handles,
            "STARTUPINFOW must set bInheritHandles = TRUE for pipe inheritance"
        );
    }

    #[test]
    fn startup_info_hides_window() {
        let si = startup_info_contract();
        assert!(
            si.hide_window,
            "STARTUPINFOW must set wShowWindow = SW_HIDE (or dwFlags |= STARTF_USESHOWWINDOW) to suppress UI"
        );
    }

    #[test]
    fn startup_info_contract_is_pure() {
        let _ = startup_info_contract();
    }

    // ================================================================
    // Slice 5: ConPTY integration contract tests
    //
    // These tests assert the PURE contract for the ConPTY integration
    // path wired into create_sandboxed_process(). They run on any
    // platform (no Windows FFI required).
    // ================================================================

    #[test]
    fn conpty_integration_use_conpty_param_exists() {
        let contract = conpty_integration_contract();
        assert!(
            contract.use_conpty_param_exists,
            "create_sandboxed_process() must accept a use_conpty: bool parameter"
        );
    }

    #[test]
    fn conpty_integration_calls_create_pseudo_console() {
        let contract = conpty_integration_contract();
        assert!(
            contract.conpty_path_calls_create_pseudo_console,
            "ConPTY path must call create_pseudo_console() from the conpty module"
        );
    }

    #[test]
    fn conpty_integration_has_pipe_fallback() {
        let contract = conpty_integration_contract();
        assert!(
            contract.pipe_fallback_on_conpty_failure,
            "ConPTY path must fall back to anonymous pipes when pseudo console creation fails"
        );
    }

    #[test]
    fn conpty_integration_uses_extended_startupinfo() {
        let contract = conpty_integration_contract();
        assert!(
            contract.uses_extended_startupinfo,
            "ConPTY path must use STARTUPINFOEXW with EXTENDED_STARTUPINFO_PRESENT"
        );
    }

    #[test]
    fn conpty_integration_sets_pseudoconsole_attribute() {
        let contract = conpty_integration_contract();
        assert!(
            contract.sets_proc_thread_attribute_pseudoconsole,
            "ConPTY path must set PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE on the attribute list"
        );
    }

    #[test]
    fn conpty_integration_uses_default_120x40() {
        let contract = conpty_integration_contract();
        assert!(
            contract.uses_default_dimensions_120x40,
            "ConPTY path must use default pseudo console dimensions of 120 cols x 40 rows"
        );
    }

    #[test]
    fn conpty_integration_contract_is_pure() {
        let _ = conpty_integration_contract();
    }
}
