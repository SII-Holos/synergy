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
