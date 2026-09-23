// Provenance: https://docs.rs/portable-pty/0.8.1/portable_pty/ and
// https://github.com/sursaone/bun-pty/blob/v0.4.4/rust-pty/src/lib.rs
// Local adaptation: bounded byte queues, explicit argv/env, and EOF independent of child exit.
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Deserialize;
use std::{
    collections::{HashMap, VecDeque},
    io::{Read, Write},
    sync::{
        atomic::{AtomicI32, AtomicI64, Ordering},
        mpsc::{sync_channel, Receiver, SyncSender, TryRecvError, TrySendError},
        Arc, Mutex, OnceLock,
    },
    thread,
};

const CHUNK: usize = 8192;
const QUEUE: usize = 32;
const ERROR: i32 = -1;
const EOF: i32 = -2;
const FULL: i32 = -3;

#[derive(Deserialize)]
struct Input {
    command: String,
    args: Vec<String>,
    cwd: String,
    env: HashMap<String, String>,
    cols: u16,
    rows: u16,
}

struct Pty {
    output: Receiver<Vec<u8>>,
    input: SyncSender<Vec<u8>>,
    pending: VecDeque<u8>,
    master: Box<dyn MasterPty + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    exit: Arc<AtomicI64>,
    pid: i32,
}

static REGISTRY: OnceLock<Mutex<HashMap<i32, Pty>>> = OnceLock::new();
static NEXT: AtomicI32 = AtomicI32::new(1);
static LAST_ERROR: Mutex<String> = Mutex::new(String::new());

fn registry() -> &'static Mutex<HashMap<i32, Pty>> {
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

fn failure(error: impl std::fmt::Display) -> i32 {
    if let Ok(mut target) = LAST_ERROR.lock() {
        *target = error.to_string().chars().take(2048).collect();
    }
    ERROR
}

fn create(input: Input) -> Result<Pty, Box<dyn std::error::Error + Send + Sync>> {
    if input.cols == 0 || input.rows == 0 || !std::fs::metadata(&input.cwd)?.is_dir() {
        return Err("Invalid PTY size or working directory".into());
    }
    let pair = native_pty_system().openpty(PtySize {
        cols: input.cols,
        rows: input.rows,
        pixel_width: 0,
        pixel_height: 0,
    })?;
    let mut reader = pair.master.try_clone_reader()?;
    let mut writer = pair.master.take_writer()?;
    let mut command = CommandBuilder::new(input.command);
    command.args(input.args);
    command.cwd(input.cwd);
    command.env_clear();
    for (name, value) in input.env {
        command.env(name, value);
    }
    let mut child = pair.slave.spawn_command(command)?;
    let pid = child
        .process_id()
        .ok_or("PTY child has no process identity")? as i32;
    let killer = child.clone_killer();
    drop(pair.slave);
    let (output_tx, output) = sync_channel(QUEUE);
    let (input_tx, input_rx) = sync_channel::<Vec<u8>>(QUEUE);
    let exit = Arc::new(AtomicI64::new(-1));
    let status = exit.clone();
    thread::spawn(move || {
        let code = child
            .wait()
            .map(|status| i64::from(status.exit_code()))
            .unwrap_or(1);
        status.store(code, Ordering::Release);
    });
    thread::spawn(move || {
        let mut buffer = [0_u8; CHUNK];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(size) => {
                    if output_tx.send(buffer[..size].to_vec()).is_err() {
                        break;
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
    });
    thread::spawn(move || {
        while let Ok(bytes) = input_rx.recv() {
            if writer
                .write_all(&bytes)
                .and_then(|_| writer.flush())
                .is_err()
            {
                break;
            }
        }
    });
    Ok(Pty {
        output,
        input: input_tx,
        pending: VecDeque::new(),
        master: pair.master,
        killer,
        exit,
        pid,
    })
}

fn with(handle: i32, action: impl FnOnce(&mut Pty) -> i32) -> i32 {
    match registry().lock() {
        Ok(mut entries) => entries.get_mut(&handle).map(action).unwrap_or(ERROR),
        Err(error) => failure(error),
    }
}

#[no_mangle]
pub extern "C" fn synergy_pty_version() -> i32 {
    2
}

#[no_mangle]
pub unsafe extern "C" fn synergy_pty_spawn(data: *const u8, length: usize) -> i32 {
    if data.is_null() || length == 0 || length > 1024 * 1024 {
        return failure("Invalid PTY configuration length");
    }
    let bytes = unsafe { std::slice::from_raw_parts(data, length) };
    let input = match serde_json::from_slice::<Input>(bytes) {
        Ok(input) => input,
        Err(error) => return failure(error),
    };
    match create(input) {
        Ok(mut pty) => {
            let id = NEXT.fetch_add(1, Ordering::Relaxed);
            if id <= 0 {
                let _ = pty.killer.kill();
                return failure("PTY handle space exhausted");
            }
            match registry().lock() {
                Ok(mut entries) => {
                    entries.insert(id, pty);
                    id
                }
                Err(error) => {
                    let _ = pty.killer.kill();
                    failure(error)
                }
            }
        }
        Err(error) => failure(error),
    }
}

#[no_mangle]
pub unsafe extern "C" fn synergy_pty_read(handle: i32, buffer: *mut u8, length: usize) -> i32 {
    if buffer.is_null() || length == 0 || length > CHUNK {
        return ERROR;
    }
    with(handle, |pty| {
        if pty.pending.is_empty() {
            match pty.output.try_recv() {
                Ok(bytes) => pty.pending.extend(bytes),
                Err(TryRecvError::Empty) => return 0,
                Err(TryRecvError::Disconnected) => return EOF,
            }
        }
        let size = pty.pending.len().min(length);
        for offset in 0..size {
            unsafe {
                *buffer.add(offset) = pty.pending.pop_front().unwrap();
            }
        }
        size as i32
    })
}

#[no_mangle]
pub unsafe extern "C" fn synergy_pty_write(handle: i32, data: *const u8, length: usize) -> i32 {
    if data.is_null() || length == 0 || length > CHUNK {
        return ERROR;
    }
    with(handle, |pty| {
        let bytes = unsafe { std::slice::from_raw_parts(data, length) }.to_vec();
        match pty.input.try_send(bytes) {
            Ok(_) => 0,
            Err(TrySendError::Full(_)) => FULL,
            Err(TrySendError::Disconnected(_)) => ERROR,
        }
    })
}

#[no_mangle]
pub extern "C" fn synergy_pty_resize(handle: i32, cols: u16, rows: u16) -> i32 {
    if cols == 0 || rows == 0 {
        return ERROR;
    }
    with(handle, |pty| {
        pty.master
            .resize(PtySize {
                cols,
                rows,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map(|_| 0)
            .unwrap_or(ERROR)
    })
}

#[no_mangle]
pub extern "C" fn synergy_pty_pid(handle: i32) -> i32 {
    with(handle, |pty| pty.pid)
}

#[no_mangle]
pub extern "C" fn synergy_pty_exit(handle: i32) -> i64 {
    match registry().lock() {
        Ok(entries) => entries
            .get(&handle)
            .map(|pty| pty.exit.load(Ordering::Acquire))
            .unwrap_or(i64::from(ERROR)),
        Err(error) => i64::from(failure(error)),
    }
}

#[no_mangle]
pub extern "C" fn synergy_pty_kill(handle: i32) -> i32 {
    with(handle, |pty| pty.killer.kill().map(|_| 0).unwrap_or(ERROR))
}

#[no_mangle]
pub extern "C" fn synergy_pty_close(handle: i32) {
    if let Ok(mut entries) = registry().lock() {
        entries.remove(&handle);
    }
}

#[no_mangle]
pub unsafe extern "C" fn synergy_pty_error(buffer: *mut u8, length: usize) -> i32 {
    if buffer.is_null() || length == 0 {
        return ERROR;
    }
    if let Ok(error) = LAST_ERROR.lock() {
        let bytes = error.as_bytes();
        let size = bytes.len().min(length);
        unsafe {
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), buffer, size);
        }
        return size as i32;
    }
    ERROR
}
