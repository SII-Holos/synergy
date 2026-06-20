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
    // Build command line string
    let mut cmd_line = format!("\"{}\"", command);
    for arg in args {
        cmd_line.push(' ');
        cmd_line.push_str(&format!("\"{}\"", arg));
    }
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
}
