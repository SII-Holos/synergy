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
        max_active_processes: MAX_ACTIVE_PROCESSES,
        allow_breakaway: false,
        allow_silent_breakaway: false,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessBridgeContract {
    pub forward_stdout: bool,
    pub forward_stderr: bool,
    pub forward_stdin: bool,
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
        forward_stdin: true,
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
    pub drains_streams_concurrently: bool,
    pub parent_read_ends_are_not_inherited: bool,
    pub closes_job_before_joining_drains: bool,
    pub cancels_blocked_drains: bool,
    pub bounded_drain_shutdown: bool,
    pub detaches_drain_after_shutdown_timeout: bool,
    pub child_stdin_is_inheritable_parent_stdin: bool,
}

pub fn stdio_bridge_contract() -> StdioBridgeContract {
    StdioBridgeContract {
        uses_anonymous_pipes: true,
        inherits_parent_stdio: false,
        child_stdout_pipe: true,
        child_stderr_pipe: true,
        parent_copies_stdout: true,
        parent_copies_stderr: true,
        drains_streams_concurrently: true,
        parent_read_ends_are_not_inherited: true,
        closes_job_before_joining_drains: true,
        cancels_blocked_drains: true,
        bounded_drain_shutdown: true,
        detaches_drain_after_shutdown_timeout: true,
        child_stdin_is_inheritable_parent_stdin: true,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ConptyStartupStage {
    BeforeSpawn,
    AfterSpawn,
}

impl ConptyStartupStage {
    const fn allows_pipe_fallback(self) -> bool {
        matches!(self, Self::BeforeSpawn)
    }
}

#[cfg(target_os = "windows")]
struct ConptyProcessError {
    stage: ConptyStartupStage,
    error: Error,
}

#[cfg(target_os = "windows")]
impl ConptyProcessError {
    fn before_spawn(error: Error) -> Self {
        Self {
            stage: ConptyStartupStage::BeforeSpawn,
            error,
        }
    }

    fn after_spawn(error: Error) -> Self {
        Self {
            stage: ConptyStartupStage::AfterSpawn,
            error,
        }
    }

    fn allows_pipe_fallback(&self) -> bool {
        self.stage.allows_pipe_fallback()
    }

    fn into_error(self) -> Error {
        self.error
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
use windows_sys::Win32::Foundation::{
    CloseHandle, DuplicateHandle, GetLastError, SetHandleInformation, DUPLICATE_SAME_ACCESS,
    HANDLE, INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
use windows_sys::Win32::Storage::FileSystem::{ReadFile, WriteFile};
use windows_sys::Win32::System::Console::{
    GetStdHandle, HPCON, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE,
};
use windows_sys::Win32::System::JobObjects::*;
use windows_sys::Win32::System::Pipes::CreatePipe;
use windows_sys::Win32::System::Threading::*;
use windows_sys::Win32::System::IO::CancelSynchronousIo;

/// Keep the process tree bounded while allowing a shell to spawn its command.
pub const MAX_ACTIVE_PROCESSES: u32 = 16;

const ERROR_BROKEN_PIPE: u32 = 109;
const ERROR_HANDLE_EOF: u32 = 38;
const WAIT_FAILED: u32 = 0xffff_ffff;
const WAIT_OBJECT_0: u32 = 0;
const WAIT_TIMEOUT: u32 = 258;
const HANDLE_FLAG_INHERIT: u32 = 0x0000_0001;
// CancelSynchronousIo is expected to wake a pipe drain promptly. This upper
// bound keeps a broken Job Object or a stuck console handle from turning the
// helper's exit path into an unbounded join.
const DRAIN_SHUTDOWN_TIMEOUT_MS: u32 = 1_000;

fn error_with_last_win32(message: &'static str) -> Error {
    let hr = HRESULT::from_win32(unsafe { GetLastError() });
    Error::new(hr, message)
}

fn error_with_message(message: String) -> Error {
    // Errors originating in a drain thread no longer have a meaningful
    // thread-local GetLastError value. Preserve the diagnostic text while
    // returning a normal windows-result error to the caller.
    Error::new(HRESULT::from_win32(1), message)
}

/// Create a Job Object with KILL_ON_JOB_CLOSE and a bounded process count.
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
    info.BasicLimitInformation.ActiveProcessLimit = MAX_ACTIVE_PROCESSES;

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

    log::info!(
        "Job object created: KILL_ON_JOB_CLOSE, active process limit {}",
        MAX_ACTIVE_PROCESSES
    );
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
    let result = {
        #[cfg(target_os = "windows")]
        if use_conpty {
            match create_sandboxed_process_conpty(token, job, command, args, cwd) {
                Ok(exit_code) => Ok(exit_code),
                Err(error) if error.allows_pipe_fallback() => {
                    log::warn!(
                        "ConPTY failed ({}), falling back to anonymous pipes",
                        error.error
                    );
                    create_sandboxed_process_pipes(token, job, command, args, cwd)
                }
                Err(error) => Err(error.into_error()),
            }
        } else {
            create_sandboxed_process_pipes(token, job, command, args, cwd)
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = use_conpty;
            create_sandboxed_process_pipes(token, job, command, args, cwd)
        }
    };

    // The two implementation paths borrow these handles. Keeping ownership
    // here makes ConPTY fallback safe: a failed first path cannot invalidate
    // the token or Job Object before the pipe path uses them.
    close_if_valid(token);
    close_if_valid(job);
    result
}

/// Spawn the child process using ConPTY (pseudo console) for terminal-aware I/O.
#[cfg(target_os = "windows")]
unsafe fn create_sandboxed_process_conpty(
    token: HANDLE,
    job: HANDLE,
    command: &str,
    args: &[&str],
    cwd: &str,
) -> std::result::Result<i32, ConptyProcessError> {
    use crate::conpty::create_pseudo_console;

    let cmd_line = build_command_line(command, args);
    let mut cmd_line_wide: Vec<u16> = cmd_line.encode_utf16().chain(std::iter::once(0)).collect();
    let cwd_wide: Vec<u16> = cwd.encode_utf16().chain(std::iter::once(0)).collect();

    // Default ConPTY dimensions: 120 cols x 40 rows (contract)
    let (input_write, output_read, hpcon) =
        create_pseudo_console(120, 40).map_err(ConptyProcessError::before_spawn)?;

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
        return Err(ConptyProcessError::before_spawn(Error::new(
            hr,
            "InitializeProcThreadAttributeList failed",
        )));
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
        return Err(ConptyProcessError::before_spawn(Error::new(
            hr,
            "UpdateProcThreadAttribute(PSEUDOCONSOLE) failed",
        )));
    }

    startup_info_ex.lpAttributeList = attr_list;

    // ConPTY must use the same restricted environment as the pipe fallback;
    // passing a null environment pointer would reintroduce the helper's full
    // environment only on the terminal path.
    let env_block = build_wide_env_block(&[]);
    let env_ptr = env_block.as_ptr() as *const std::ffi::c_void;
    let mut process_info: PROCESS_INFORMATION = std::mem::zeroed();
    let ok = CreateProcessAsUserW(
        token,
        std::ptr::null(),
        cmd_line_wide.as_mut_ptr(),
        std::ptr::null(),
        std::ptr::null(),
        1, // bInheritHandles = TRUE
        CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT,
        env_ptr,
        cwd_wide.as_ptr(),
        &startup_info_ex.StartupInfo as *const STARTUPINFOW as *const _,
        &mut process_info,
    );

    // Clean up attribute list immediately after process creation
    DeleteProcThreadAttributeList(attr_list);
    drop(env_block);

    if ok == 0 {
        crate::conpty::close_pseudo_console(hpcon);
        close_if_valid(input_write);
        close_if_valid(output_read);
        let hr = HRESULT::from_win32(GetLastError());
        return Err(ConptyProcessError::before_spawn(Error::new(
            hr,
            "CreateProcessAsUserW (ConPTY) failed",
        )));
    }

    // Assign to job BEFORE resuming
    let ok = AssignProcessToJobObject(job, process_info.hProcess);
    if ok == 0 {
        TerminateProcess(process_info.hProcess, 1);
        close_if_valid(process_info.hProcess);
        close_if_valid(process_info.hThread);
        crate::conpty::close_pseudo_console(hpcon);
        close_if_valid(input_write);
        close_if_valid(output_read);
        let hr = HRESULT::from_win32(GetLastError());
        return Err(ConptyProcessError::after_spawn(Error::new(
            hr,
            "AssignProcessToJobObject failed",
        )));
    }

    // Resume main thread. A return value of u32::MAX means the call failed.
    if ResumeThread(process_info.hThread) == u32::MAX {
        let error = error_with_last_win32("ResumeThread failed");
        TerminateProcess(process_info.hProcess, 1);
        close_if_valid(process_info.hProcess);
        close_if_valid(process_info.hThread);
        crate::conpty::close_pseudo_console(hpcon);
        close_if_valid(input_write);
        close_if_valid(output_read);
        return Err(ConptyProcessError::after_spawn(error));
    }

    log::info!(
        "Sandboxed process created (ConPTY): PID={}",
        process_info.dwProcessId
    );

    close_if_valid(process_info.hThread);

    // Drain ConPTY output independently while the child runs. The same
    // ordering rule as the anonymous-pipe path applies: wait for the primary
    // process first, terminate the Job to close descendant handles, then
    // cancel and boundedly finish the drain thread.
    let parent_stdout = GetStdHandle(STD_OUTPUT_HANDLE);
    let output_thread = spawn_drain_thread(output_read, parent_stdout, "conpty output");

    let parent_stdin = GetStdHandle(STD_INPUT_HANDLE);
    let (stdin_thread, native_stdin_thread) = if is_valid_handle(parent_stdin) {
        let (thread, native_thread) = spawn_conpty_stdin_forwarder(input_write, parent_stdin);
        (Some(thread), native_thread)
    } else {
        close_if_valid(input_write);
        (None, std::ptr::null_mut())
    };

    // Wait for process exit.
    let wait_result = WaitForSingleObject(process_info.hProcess, INFINITE);
    let mut process_error = if wait_result == WAIT_FAILED {
        Some(error_with_last_win32("WaitForSingleObject failed"))
    } else if wait_result != WAIT_OBJECT_0 {
        Some(error_with_message(format!(
            "WaitForSingleObject returned unexpected status {wait_result}"
        )))
    } else {
        None
    };
    let mut exit_code = 1u32;
    if process_error.is_none() && GetExitCodeProcess(process_info.hProcess, &mut exit_code) == 0 {
        process_error = Some(error_with_last_win32("GetExitCodeProcess failed"));
    }

    let mut job_error = None;
    if TerminateJobObject(job, 1) == 0 {
        let error = GetLastError();
        log::warn!(
            "TerminateJobObject after ConPTY child exit failed (win32 error {})",
            error
        );
        job_error = Some(format!(
            "TerminateJobObject after ConPTY child exit failed (win32 error {error})"
        ));
    }

    // Cancel a synchronous ReadFile on helper stdin before boundedly finishing
    // the forwarder. Without this, an interactive stdin can keep the helper
    // alive after the child has already exited.
    let stdin_error = stdin_thread.and_then(|thread| unsafe {
        finish_plain_thread(thread, native_stdin_thread, "ConPTY stdin forwarder")
    });

    // Closing the pseudo console releases the output side after all Job
    // members have been terminated. The output thread owns output_read.
    crate::conpty::close_pseudo_console(hpcon);
    close_if_valid(process_info.hProcess);

    let output_error = unsafe { finish_drain_thread(output_thread, "ConPTY output") };

    if let Some(error) = process_error {
        return Err(ConptyProcessError::after_spawn(error));
    }
    if let Some(error) = job_error {
        return Err(ConptyProcessError::after_spawn(error_with_message(error)));
    }
    if let Some(error) = output_error {
        return Err(ConptyProcessError::after_spawn(error_with_message(error)));
    }
    if let Some(error) = stdin_error {
        return Err(ConptyProcessError::after_spawn(error_with_message(error)));
    }

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

fn is_valid_handle(handle: HANDLE) -> bool {
    !handle.is_null() && handle != INVALID_HANDLE_VALUE
}

unsafe fn close_if_valid(handle: HANDLE) {
    if is_valid_handle(handle) {
        CloseHandle(handle);
    }
}

struct OwnedHandle(HANDLE);

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        unsafe { close_if_valid(self.0) };
    }
}

unsafe fn make_handle_non_inheritable(
    handle: HANDLE,
    description: &'static str,
) -> windows_result::Result<()> {
    if SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0) == 0 {
        let hr = HRESULT::from_win32(GetLastError());
        return Err(Error::new(hr, description));
    }
    Ok(())
}

unsafe fn duplicate_inheritable_handle(handle: HANDLE) -> windows_result::Result<HANDLE> {
    if !is_valid_handle(handle) {
        return Ok(std::ptr::null_mut());
    }

    let current_process = GetCurrentProcess();
    let mut duplicate = std::ptr::null_mut();
    if DuplicateHandle(
        current_process,
        handle,
        current_process,
        &mut duplicate,
        0,
        1,
        DUPLICATE_SAME_ACCESS,
    ) == 0
    {
        let hr = HRESULT::from_win32(GetLastError());
        return Err(Error::new(hr, "DuplicateHandle for child stdin failed"));
    }
    Ok(duplicate)
}

unsafe fn write_all(handle: HANDLE, bytes: &[u8]) -> std::result::Result<(), String> {
    if !is_valid_handle(handle) {
        return Ok(());
    }

    let mut offset = 0;
    while offset < bytes.len() {
        let mut written = 0u32;
        if WriteFile(
            handle,
            bytes[offset..].as_ptr(),
            (bytes.len() - offset) as u32,
            &mut written,
            std::ptr::null_mut(),
        ) == 0
        {
            return Err(format!(
                "WriteFile failed while forwarding output (win32 error {})",
                GetLastError()
            ));
        }
        if written == 0 {
            return Err("WriteFile returned success without writing output".to_string());
        }
        offset += written as usize;
    }
    Ok(())
}

#[cfg(target_os = "windows")]
unsafe fn spawn_conpty_stdin_forwarder(
    input_write: HANDLE,
    parent_stdin: HANDLE,
) -> (std::thread::JoinHandle<()>, HANDLE) {
    let (thread_handle_sender, thread_handle_receiver) = std::sync::mpsc::sync_channel::<usize>(1);
    let input_write_value = input_write as usize;
    let parent_stdin_value = parent_stdin as usize;
    let thread = std::thread::spawn(move || {
        let input_write = input_write_value as HANDLE;
        let parent_stdin = parent_stdin_value as HANDLE;
        let _input_write = OwnedHandle(input_write);
        let current_process = GetCurrentProcess();
        let mut native_thread = std::ptr::null_mut();
        if DuplicateHandle(
            current_process,
            GetCurrentThread(),
            current_process,
            &mut native_thread,
            0,
            0,
            DUPLICATE_SAME_ACCESS,
        ) == 0
        {
            let _ = thread_handle_sender.send(0);
            return;
        }
        let _ = thread_handle_sender.send(native_thread as usize);

        let mut buffer = [0u8; 16 * 1024];
        loop {
            let mut bytes_read = 0u32;
            if ReadFile(
                parent_stdin,
                buffer.as_mut_ptr(),
                buffer.len() as u32,
                &mut bytes_read,
                std::ptr::null_mut(),
            ) == 0
                || bytes_read == 0
            {
                break;
            }
            if write_all(input_write, &buffer[..bytes_read as usize]).is_err() {
                break;
            }
        }
    });

    let native_thread = thread_handle_receiver
        .recv()
        .map(|handle| handle as HANDLE)
        .unwrap_or(std::ptr::null_mut());
    (thread, native_thread)
}

struct DrainThread {
    join: std::thread::JoinHandle<Option<String>>,
    native_thread: HANDLE,
    setup_error: Option<String>,
}

unsafe fn spawn_drain_thread(
    read_handle: HANDLE,
    parent_handle: HANDLE,
    stream: &'static str,
) -> DrainThread {
    let (thread_handle_sender, thread_handle_receiver) =
        std::sync::mpsc::sync_channel::<std::result::Result<usize, String>>(1);
    let read_handle_value = read_handle as usize;
    let parent_handle_value = parent_handle as usize;
    let thread = std::thread::spawn(move || {
        let read_handle = read_handle_value as HANDLE;
        let parent_handle = parent_handle_value as HANDLE;
        let current_process = GetCurrentProcess();
        let mut native_thread = std::ptr::null_mut();
        let setup_result = if DuplicateHandle(
            current_process,
            GetCurrentThread(),
            current_process,
            &mut native_thread,
            0,
            0,
            DUPLICATE_SAME_ACCESS,
        ) == 0
        {
            Err(format!(
                "DuplicateHandle for {stream} drain thread failed (win32 error {})",
                GetLastError()
            ))
        } else {
            Ok(native_thread as usize)
        };
        let _ = thread_handle_sender.send(setup_result);

        drain_output_pipe(read_handle, parent_handle, stream)
    });

    match thread_handle_receiver.recv() {
        Ok(Ok(native_thread)) => DrainThread {
            join: thread,
            native_thread: native_thread as HANDLE,
            setup_error: None,
        },
        Ok(Err(error)) => DrainThread {
            join: thread,
            native_thread: std::ptr::null_mut(),
            setup_error: Some(error),
        },
        Err(_) => DrainThread {
            join: thread,
            native_thread: std::ptr::null_mut(),
            setup_error: Some(format!(
                "{stream} drain thread exited before publishing its native handle"
            )),
        },
    }
}

fn append_thread_error(error: &mut Option<String>, detail: impl Into<String>) {
    let detail = detail.into();
    if let Some(error) = error {
        error.push_str("; ");
        error.push_str(&detail);
    } else {
        *error = Some(detail);
    }
}

unsafe fn finish_plain_thread(
    thread: std::thread::JoinHandle<()>,
    native_thread: HANDLE,
    description: &'static str,
) -> Option<String> {
    if !is_valid_handle(native_thread) {
        drop(thread);
        return Some(format!(
            "{description} has no native cancellation handle; thread detached"
        ));
    }

    if CancelSynchronousIo(native_thread) == 0 {
        log::debug!(
            "CancelSynchronousIo for {description} returned win32 error {}",
            GetLastError()
        );
    }

    let wait_result = WaitForSingleObject(native_thread, DRAIN_SHUTDOWN_TIMEOUT_MS);
    close_if_valid(native_thread);
    match wait_result {
        WAIT_OBJECT_0 => match thread.join() {
            Ok(()) => None,
            Err(_) => Some(format!("{description} panicked")),
        },
        WAIT_TIMEOUT => {
            drop(thread);
            Some(format!(
                "{description} did not exit within {DRAIN_SHUTDOWN_TIMEOUT_MS} ms; thread detached"
            ))
        }
        WAIT_FAILED => {
            drop(thread);
            Some(format!(
                "WaitForSingleObject for {description} failed (win32 error {})",
                GetLastError()
            ))
        }
        status => {
            drop(thread);
            Some(format!(
                "WaitForSingleObject for {description} returned unexpected status {status}; thread detached"
            ))
        }
    }
}

unsafe fn finish_drain_thread(
    drain_thread: DrainThread,
    description: &'static str,
) -> Option<String> {
    let DrainThread {
        join,
        native_thread,
        mut setup_error,
    } = drain_thread;

    if !is_valid_handle(native_thread) {
        drop(join);
        append_thread_error(
            &mut setup_error,
            format!("{description} thread detached because cancellation is unavailable"),
        );
        return setup_error;
    }

    if CancelSynchronousIo(native_thread) == 0 {
        log::debug!(
            "CancelSynchronousIo for {description} returned win32 error {}",
            GetLastError()
        );
    }

    let wait_result = WaitForSingleObject(native_thread, DRAIN_SHUTDOWN_TIMEOUT_MS);
    close_if_valid(native_thread);
    match wait_result {
        WAIT_OBJECT_0 => {
            let drain_result = match join.join() {
                Ok(result) => result,
                Err(_) => Some(format!("{description} drain thread panicked")),
            };
            if let Some(error) = drain_result {
                append_thread_error(&mut setup_error, error);
            }
            setup_error
        }
        WAIT_TIMEOUT => {
            drop(join);
            append_thread_error(
                &mut setup_error,
                format!(
                    "{description} drain did not exit within {DRAIN_SHUTDOWN_TIMEOUT_MS} ms; thread detached"
                ),
            );
            setup_error
        }
        WAIT_FAILED => {
            let error = GetLastError();
            drop(join);
            append_thread_error(
                &mut setup_error,
                format!(
                    "WaitForSingleObject for {description} drain failed (win32 error {error}); thread detached"
                ),
            );
            setup_error
        }
        status => {
            drop(join);
            append_thread_error(
                &mut setup_error,
                format!(
                    "WaitForSingleObject for {description} drain returned unexpected status {status}; thread detached"
                ),
            );
            setup_error
        }
    }
}

/// Drain one anonymous pipe until EOF, forwarding bytes to the given parent
/// handle. Each stream gets its own thread so a full stderr pipe cannot stop
/// stdout (or vice versa) from being drained.
unsafe fn drain_output_pipe(
    read_handle: HANDLE,
    parent_handle: HANDLE,
    stream: &'static str,
) -> Option<String> {
    let _read_handle = OwnedHandle(read_handle);
    let mut buffer = [0u8; 16 * 1024];
    let mut first_error = None;

    loop {
        let mut bytes_read = 0u32;
        if ReadFile(
            read_handle,
            buffer.as_mut_ptr(),
            buffer.len() as u32,
            &mut bytes_read,
            std::ptr::null_mut(),
        ) == 0
        {
            let error = GetLastError();
            if error != ERROR_BROKEN_PIPE && error != ERROR_HANDLE_EOF {
                first_error.get_or_insert_with(|| {
                    format!("ReadFile failed for {stream} (win32 error {error})")
                });
            }
            break;
        }

        if bytes_read == 0 {
            break;
        }

        // Keep draining even if the parent output handle fails. Otherwise a
        // child producing enough output can block forever on its pipe.
        if let Err(error) = write_all(parent_handle, &buffer[..bytes_read as usize]) {
            first_error.get_or_insert(error);
        }
    }

    first_error
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
        close_if_valid(stdout_read);
        close_if_valid(stdout_write);
        let hr = HRESULT::from_win32(GetLastError());
        return Err(Error::new(hr, "CreatePipe for stderr failed"));
    }

    // CreatePipe makes both ends inheritable when given inheritable security
    // attributes. The child must inherit only the write ends; an inherited
    // read end would keep EOF from ever reaching the parent drain thread.
    if let Err(error) = make_handle_non_inheritable(
        stdout_read,
        "SetHandleInformation for stdout read end failed",
    ) {
        close_if_valid(stdout_read);
        close_if_valid(stdout_write);
        close_if_valid(stderr_read);
        close_if_valid(stderr_write);
        return Err(error);
    }
    if let Err(error) = make_handle_non_inheritable(
        stderr_read,
        "SetHandleInformation for stderr read end failed",
    ) {
        close_if_valid(stdout_read);
        close_if_valid(stdout_write);
        close_if_valid(stderr_read);
        close_if_valid(stderr_write);
        return Err(error);
    }

    let mut process_info: PROCESS_INFORMATION = std::mem::zeroed();
    let mut startup_info: STARTUPINFOW = std::mem::zeroed();
    startup_info.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
    startup_info.hStdOutput = stdout_write;
    startup_info.hStdError = stderr_write;
    // The helper's stdin is the child stdin. This keeps piped input and
    // interactive input available without introducing another buffering
    // thread or changing the helper's public process API.
    let parent_stdin = GetStdHandle(STD_INPUT_HANDLE);
    let child_stdin = match duplicate_inheritable_handle(parent_stdin) {
        Ok(handle) => handle,
        Err(error) => {
            close_if_valid(stdout_read);
            close_if_valid(stdout_write);
            close_if_valid(stderr_read);
            close_if_valid(stderr_write);
            return Err(error);
        }
    };
    startup_info.hStdInput = child_stdin;
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
        close_if_valid(stdout_read);
        close_if_valid(stdout_write);
        close_if_valid(stderr_read);
        close_if_valid(stderr_write);
        close_if_valid(child_stdin);
        let hr = HRESULT::from_win32(GetLastError());
        return Err(Error::new(hr, "CreateProcessAsUserW failed"));
    }

    // Close our copies immediately. The child owns the inherited write ends;
    // the parent retains only the non-inheritable read ends.
    close_if_valid(stdout_write);
    close_if_valid(stderr_write);
    close_if_valid(child_stdin);

    // Assign to job BEFORE resuming
    let ok = AssignProcessToJobObject(job, process_info.hProcess);
    if ok == 0 {
        TerminateProcess(process_info.hProcess, 1);
        close_if_valid(process_info.hProcess);
        close_if_valid(process_info.hThread);
        close_if_valid(stdout_read);
        close_if_valid(stderr_read);
        let hr = HRESULT::from_win32(GetLastError());
        return Err(Error::new(hr, "AssignProcessToJobObject failed"));
    }

    // Resume main thread — process starts running.
    if ResumeThread(process_info.hThread) == u32::MAX {
        let error = error_with_last_win32("ResumeThread failed");
        TerminateProcess(process_info.hProcess, 1);
        close_if_valid(process_info.hProcess);
        close_if_valid(process_info.hThread);
        close_if_valid(stdout_read);
        close_if_valid(stderr_read);
        return Err(error);
    }

    log::info!(
        "Sandboxed process created: PID={}",
        process_info.dwProcessId
    );

    // Close our thread handle (job still holds process reference).
    close_if_valid(process_info.hThread);

    // Drain stdout and stderr concurrently. Sequential blocking reads can
    // deadlock when the child fills stderr while stdout is being read.
    let parent_stdout = GetStdHandle(STD_OUTPUT_HANDLE);
    let parent_stderr = GetStdHandle(STD_ERROR_HANDLE);
    let stdout_thread = spawn_drain_thread(stdout_read, parent_stdout, "stdout");
    let stderr_thread = spawn_drain_thread(stderr_read, parent_stderr, "stderr");

    // Wait for the primary process before joining readers. A child can leave
    // a descendant in the Job holding a pipe write end; waiting for EOF first
    // would make the helper hang forever in that case.
    let wait_result = WaitForSingleObject(process_info.hProcess, INFINITE);
    let mut process_error = if wait_result == WAIT_FAILED {
        Some(error_with_last_win32("WaitForSingleObject failed"))
    } else if wait_result != WAIT_OBJECT_0 {
        Some(error_with_message(format!(
            "WaitForSingleObject returned unexpected status {wait_result}"
        )))
    } else {
        None
    };

    let mut exit_code: u32 = 1;
    if process_error.is_none() && GetExitCodeProcess(process_info.hProcess, &mut exit_code) == 0 {
        process_error = Some(error_with_last_win32("GetExitCodeProcess failed"));
    }

    // Reap the whole job before joining the drain threads. This closes any
    // inherited write ends held by descendants and guarantees EOF delivery.
    let mut job_error = None;
    if TerminateJobObject(job, 1) == 0 {
        let error = GetLastError();
        log::warn!(
            "TerminateJobObject after child exit failed (win32 error {})",
            error
        );
        job_error = Some(format!(
            "TerminateJobObject after child exit failed (win32 error {error})"
        ));
    }
    close_if_valid(process_info.hProcess);

    // Finish both readers after the job has been terminated. If termination
    // failed, CancelSynchronousIo and the bounded native wait still prevent an
    // unbounded Rust join; a timed-out thread keeps ownership of its read end.
    let stdout_result = finish_drain_thread(stdout_thread, "stdout");
    let stderr_result = finish_drain_thread(stderr_thread, "stderr");

    if let Some(error) = process_error {
        return Err(error);
    }
    if let Some(error) = job_error {
        return Err(error_with_message(error));
    }

    if let Some(error) = stdout_result {
        return Err(error_with_message(error));
    }
    if let Some(error) = stderr_result {
        return Err(error_with_message(error));
    }

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
    fn job_contract_active_process_limit_is_bounded_for_shell_children() {
        let flags = job_limit_contract();
        assert_eq!(
            flags.max_active_processes, MAX_ACTIVE_PROCESSES,
            "Job contract must expose the configured process limit"
        );
        assert!(
            flags.max_active_processes > 1,
            "Job must allow a shell and at least one child process"
        );
        assert!(
            flags.max_active_processes <= 64,
            "Job process limit must remain bounded"
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
    fn process_bridge_forwards_stdin() {
        let bridge = process_bridge_contract();
        assert!(
            bridge.forward_stdin,
            "Child stdin must be connected to helper stdin"
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
    fn stdio_bridge_drains_both_streams_concurrently() {
        assert!(
            stdio_bridge_contract().drains_streams_concurrently,
            "stdout and stderr must be drained by independent readers"
        );
    }

    #[test]
    fn stdio_bridge_does_not_inherit_parent_read_ends() {
        assert!(
            stdio_bridge_contract().parent_read_ends_are_not_inherited,
            "Child must not inherit pipe read ends or EOF can be delayed forever"
        );
    }

    #[test]
    fn stdio_bridge_terminates_job_before_joining_drains() {
        assert!(
            stdio_bridge_contract().closes_job_before_joining_drains,
            "Job descendants must be terminated before drain threads are joined"
        );
    }

    #[test]
    fn stdio_bridge_cancels_blocked_drains() {
        assert!(
            stdio_bridge_contract().cancels_blocked_drains,
            "Blocked synchronous drain reads must be cancelled during shutdown"
        );
    }

    #[test]
    fn stdio_bridge_shutdown_is_bounded() {
        assert!(
            stdio_bridge_contract().bounded_drain_shutdown,
            "Drain shutdown must use a bounded native wait before joining"
        );
        assert!(
            DRAIN_SHUTDOWN_TIMEOUT_MS > 0,
            "Drain shutdown timeout must be a positive finite bound"
        );
    }

    #[test]
    fn stdio_bridge_detaches_after_drain_shutdown_timeout() {
        assert!(
            stdio_bridge_contract().detaches_drain_after_shutdown_timeout,
            "A drain that ignores cancellation must be detached instead of joined forever"
        );
    }

    #[test]
    fn stdio_bridge_connects_child_stdin_to_parent_stdin() {
        assert!(
            stdio_bridge_contract().child_stdin_is_inheritable_parent_stdin,
            "Child stdin must use an inheritable duplicate of helper stdin"
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
    fn conpty_post_spawn_error_does_not_allow_fallback() {
        assert!(
            ConptyStartupStage::BeforeSpawn.allows_pipe_fallback(),
            "ConPTY setup errors before child creation may use the pipe fallback"
        );
        assert!(
            !ConptyStartupStage::AfterSpawn.allows_pipe_fallback(),
            "Errors after child creation must be returned without rerunning the command"
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
