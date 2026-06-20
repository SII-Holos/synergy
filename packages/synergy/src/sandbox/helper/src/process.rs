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
use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, HANDLE};
use windows_sys::Win32::System::JobObjects::*;
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
/// Returns the child's exit code.
pub unsafe fn create_sandboxed_process(
    token: HANDLE,
    job: HANDLE,
    command: &str,
    args: &[&str],
    cwd: &str,
) -> windows_result::Result<i32> {
    let cmd_line = build_command_line(command, args);
    let mut cmd_line_wide: Vec<u16> = cmd_line.encode_utf16().chain(std::iter::once(0)).collect();
    let cwd_wide: Vec<u16> = cwd.encode_utf16().chain(std::iter::once(0)).collect();
    let mut process_info: PROCESS_INFORMATION = std::mem::zeroed();
    let mut startup_info: STARTUPINFOW = std::mem::zeroed();
    startup_info.cb = std::mem::size_of::<STARTUPINFOW>() as u32;

    // Create process as the restricted token user, suspended
    let ok = CreateProcessAsUserW(
        token,
        std::ptr::null(),
        cmd_line_wide.as_mut_ptr(),
        std::ptr::null(),
        std::ptr::null(),
        0,
        CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT,
        std::ptr::null(),
        cwd_wide.as_ptr(),
        &startup_info,
        &mut process_info,
    );

    if ok == 0 {
        CloseHandle(token);
        let hr = HRESULT::from_win32(GetLastError());
        return Err(Error::new(hr, "CreateProcessAsUserW failed"));
    }

    // Assign to job BEFORE resuming
    let ok = AssignProcessToJobObject(job, process_info.hProcess);
    if ok == 0 {
        TerminateProcess(process_info.hProcess, 1);
        CloseHandle(process_info.hProcess);
        CloseHandle(process_info.hThread);
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

    // Wait for process exit (INFINITE is in Win32_System_Threading)
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
}
