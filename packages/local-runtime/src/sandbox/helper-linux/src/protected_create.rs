use crate::error::HelperError;
#[cfg(target_os = "linux")]
use std::collections::HashMap;
#[cfg(target_os = "linux")]
use std::fs;
#[cfg(target_os = "linux")]
use std::path::Path;
/// Default protected metadata directory names to monitor for creation.
const DEFAULT_PROTECTED_NAMES: &[&str] = &[".git", ".agents", ".codex", ".synergy"];

/// Monitors parent directories for creation of protected metadata entries.
///
/// On Linux, uses inotify to detect `IN_CREATE` and `IN_MOVED_TO` events for
/// filenames whose basename matches the protected name set. Violating entries
/// are removed immediately and counted.
///
pub struct ProtectedCreateMonitor {
    #[allow(dead_code)]
    protected_names: Vec<String>,
    violation_count: usize,
    #[cfg(target_os = "linux")]
    inotify_fd: Option<i32>,
    #[cfg(target_os = "linux")]
    watches: HashMap<i32, String>,
}

impl ProtectedCreateMonitor {
    /// Create a new monitor with the given protected basename patterns.
    ///
    /// When `protected_names` is empty, the default set is used:
    /// `.git`, `.agents`, `.codex`, `.synergy`.
    pub fn new(protected_names: Vec<String>) -> Self {
        let names = if protected_names.is_empty() {
            DEFAULT_PROTECTED_NAMES
                .iter()
                .map(|s| s.to_string())
                .collect()
        } else {
            protected_names
        };

        Self {
            protected_names: names,
            violation_count: 0,
            #[cfg(target_os = "linux")]
            inotify_fd: None,
            #[cfg(target_os = "linux")]
            watches: HashMap::new(),
        }
    }

    /// Start watching the given parent directories for protected-name creates.
    ///
    /// On Linux, initialises an inotify instance and adds a watch for each
    /// path. On non-Linux, this is a no-op.
    pub fn start_monitoring(&mut self, paths: &[String]) -> Result<(), HelperError> {
        self.start_monitoring_impl(paths)
    }

    /// Stop monitoring and return the number of detected violations.
    ///
    /// Drains all pending inotify events, processes violations, closes the
    /// inotify file descriptor, and returns the total violation count.
    pub fn stop_monitoring(&mut self) -> Result<usize, HelperError> {
        self.stop_monitoring_impl()
    }

    /// Return the current violation count without stopping monitoring.
    pub fn violation_count(&self) -> usize {
        self.violation_count
    }
}

// ---------------------------------------------------------------------------
// Linux inotify implementation
// ---------------------------------------------------------------------------

#[cfg(target_os = "linux")]
impl ProtectedCreateMonitor {
    fn start_monitoring_impl(&mut self, paths: &[String]) -> Result<(), HelperError> {
        use libc::{
            inotify_add_watch, inotify_init1, IN_CLOEXEC, IN_CREATE, IN_MOVED_TO, IN_NONBLOCK,
        };

        let fd = unsafe { inotify_init1(IN_NONBLOCK | IN_CLOEXEC) };
        if fd < 0 {
            return Err(HelperError::Io(std::io::Error::last_os_error()));
        }
        self.inotify_fd = Some(fd);

        for path in paths {
            let c_path = std::ffi::CString::new(path.as_str())
                .map_err(|e| HelperError::Config(format!("invalid path '{path}': {e}")))?;
            let wd =
                unsafe { inotify_add_watch(fd, c_path.as_ptr(), (IN_CREATE | IN_MOVED_TO) as u32) };
            if wd < 0 {
                let err = std::io::Error::last_os_error();
                self.cleanup_inotify(fd);
                return Err(HelperError::Io(err));
            }
            self.watches.insert(wd, path.clone());
        }

        Ok(())
    }

    fn stop_monitoring_impl(&mut self) -> Result<usize, HelperError> {
        let fd = match self.inotify_fd.take() {
            Some(fd) => fd,
            None => return Ok(self.violation_count),
        };

        self.drain_events(fd);
        self.cleanup_inotify(fd);
        Ok(self.violation_count)
    }

    fn cleanup_inotify(&mut self, fd: i32) {
        unsafe {
            libc::close(fd);
        }
        self.inotify_fd = None;
        self.watches.clear();
    }

    fn drain_events(&mut self, fd: i32) {
        use std::mem;

        let mut buf = [0u8; 4096];
        loop {
            let n = unsafe { libc::read(fd, buf.as_mut_ptr() as *mut libc::c_void, buf.len()) };
            if n <= 0 {
                break;
            }
            let bytes_read = n as usize;
            let mut offset: usize = 0;

            while offset + mem::size_of::<libc::inotify_event>() <= bytes_read {
                // SAFETY: the kernel writes properly-aligned inotify_event structs
                // into the buffer. We validate that enough bytes remain for the
                // header before reinterpreting.
                let event = unsafe { &*(buf[offset..].as_ptr() as *const libc::inotify_event) };

                let name_len = event.len as usize;
                let event_size = mem::size_of::<libc::inotify_event>() + name_len;

                if name_len > 0 && offset + event_size <= bytes_read {
                    self.process_event(event, &buf, offset);
                }

                if event_size == 0 {
                    break;
                }
                offset += event_size;
            }
        }
    }

    fn process_event(&mut self, event: &libc::inotify_event, buf: &[u8], offset: usize) {
        use std::mem;

        let name_len = event.len as usize;
        if name_len == 0 {
            return;
        }

        let name_start = offset + mem::size_of::<libc::inotify_event>();
        let name_bytes = &buf[name_start..name_start + name_len];

        let name = match name_bytes.iter().position(|&b| b == 0) {
            Some(null_pos) => match std::str::from_utf8(&name_bytes[..null_pos]) {
                Ok(s) => s,
                Err(_) => return,
            },
            None => return,
        };

        if !self.is_protected_basename(name) {
            return;
        }

        let dir = match self.watches.get(&event.wd) {
            Some(d) => d,
            None => return,
        };

        let full_path = Path::new(dir).join(name);

        // Count the violation regardless of removal success.
        self.violation_count += 1;

        let _ = if full_path.is_dir() {
            fs::remove_dir_all(&full_path)
        } else {
            fs::remove_file(&full_path)
        };
    }

    fn is_protected_basename(&self, name: &str) -> bool {
        self.protected_names.iter().any(|n| n == name)
    }
}

// ---------------------------------------------------------------------------
// Non-Linux no-op implementation
// ---------------------------------------------------------------------------

#[cfg(not(target_os = "linux"))]
impl ProtectedCreateMonitor {
    fn start_monitoring_impl(&mut self, _paths: &[String]) -> Result<(), HelperError> {
        Ok(())
    }

    fn stop_monitoring_impl(&mut self) -> Result<usize, HelperError> {
        Ok(self.violation_count)
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    // --- platform-independent struct tests ---

    #[test]
    fn new_uses_default_protected_names_when_empty() {
        let monitor = ProtectedCreateMonitor::new(vec![]);
        assert_eq!(monitor.protected_names.len(), DEFAULT_PROTECTED_NAMES.len());
        for name in DEFAULT_PROTECTED_NAMES {
            assert!(
                monitor.protected_names.iter().any(|n| n == name),
                "default protected set should include {name}"
            );
        }
    }

    #[test]
    fn new_uses_custom_protected_names() {
        let custom = vec![".hg".to_string(), ".svn".to_string()];
        let monitor = ProtectedCreateMonitor::new(custom.clone());
        assert_eq!(monitor.protected_names, custom);
    }

    #[test]
    fn violation_count_starts_at_zero() {
        let monitor = ProtectedCreateMonitor::new(vec![]);
        assert_eq!(monitor.violation_count(), 0);
    }

    #[test]
    fn stop_monitoring_without_start_is_noop() {
        let mut monitor = ProtectedCreateMonitor::new(vec![]);
        let count = monitor
            .stop_monitoring()
            .expect("stop without start should not error");
        assert_eq!(count, 0);
    }

    // --- Linux inotify integration tests ---

    #[cfg(target_os = "linux")]
    mod linux {
        use super::*;
        use std::io::Write;

        fn tmp_dir() -> std::path::PathBuf {
            let dir = std::env::temp_dir()
                .join(format!("synergy-protected-create-{}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            dir
        }

        #[test]
        fn start_monitoring_opens_inotify_fd() {
            let dir = tmp_dir();
            let mut monitor = ProtectedCreateMonitor::new(vec![".synergy".to_string()]);

            monitor
                .start_monitoring(&[dir.to_string_lossy().into_owned()])
                .expect("start_monitoring should succeed");
            assert!(
                monitor.inotify_fd.is_some(),
                "inotify fd should be set after start"
            );

            let _ = monitor.stop_monitoring();
        }

        #[test]
        fn stop_monitoring_closes_inotify_fd() {
            let dir = tmp_dir();
            let mut monitor = ProtectedCreateMonitor::new(vec![".synergy".to_string()]);

            monitor
                .start_monitoring(&[dir.to_string_lossy().into_owned()])
                .expect("start_monitoring should succeed");

            let count = monitor
                .stop_monitoring()
                .expect("stop_monitoring should succeed");
            assert_eq!(count, 0);
            assert!(
                monitor.inotify_fd.is_none(),
                "inotify fd should be cleared after stop"
            );
        }

        #[test]
        fn detects_protected_file_create() {
            let dir = tmp_dir();
            let mut monitor = ProtectedCreateMonitor::new(vec![".synergy".to_string()]);

            monitor
                .start_monitoring(&[dir.to_string_lossy().into_owned()])
                .expect("start_monitoring should succeed");

            // Create a protected file inside the watched directory.
            let protected = dir.join(".synergy");
            fs::write(&protected, b"should not exist").expect("write should succeed");

            let count = monitor
                .stop_monitoring()
                .expect("stop_monitoring should succeed");

            assert_eq!(count, 1, "should detect one protected create violation");
            assert!(
                !protected.exists(),
                "protected file should have been removed"
            );
        }

        #[test]
        fn detects_protected_dir_create() {
            let dir = tmp_dir();
            let mut monitor = ProtectedCreateMonitor::new(vec![".git".to_string()]);

            monitor
                .start_monitoring(&[dir.to_string_lossy().into_owned()])
                .expect("start_monitoring should succeed");

            // Create a protected directory inside the watched directory.
            let protected = dir.join(".git");
            fs::create_dir_all(&protected).expect("mkdir should succeed");
            fs::write(protected.join("config"), b"bad").expect("write should succeed");

            let count = monitor
                .stop_monitoring()
                .expect("stop_monitoring should succeed");

            assert_eq!(count, 1, "should detect one protected create violation");
            assert!(
                !protected.exists(),
                "protected directory should have been removed"
            );
        }

        #[test]
        fn ignores_non_protected_creates() {
            let dir = tmp_dir();
            let mut monitor = ProtectedCreateMonitor::new(vec![".synergy".to_string()]);

            monitor
                .start_monitoring(&[dir.to_string_lossy().into_owned()])
                .expect("start_monitoring should succeed");

            // Create a non-protected file — should be ignored.
            let safe = dir.join("hello.txt");
            let mut f = fs::File::create(&safe).expect("create should succeed");
            f.write_all(b"safe content").expect("write should succeed");
            drop(f);

            let count = monitor
                .stop_monitoring()
                .expect("stop_monitoring should succeed");

            assert_eq!(count, 0, "non-protected creates should not be violations");
            assert!(safe.exists(), "non-protected file should still exist");
        }

        #[test]
        fn detects_violation_with_disjoint_name_set() {
            let dir = tmp_dir();
            let mut monitor =
                ProtectedCreateMonitor::new(vec![".git".to_string(), ".svn".to_string()]);

            monitor
                .start_monitoring(&[dir.to_string_lossy().into_owned()])
                .expect("start_monitoring should succeed");

            let protected = dir.join(".svn");
            fs::create_dir_all(&protected).expect("mkdir should succeed");

            let count = monitor
                .stop_monitoring()
                .expect("stop_monitoring should succeed");

            assert_eq!(count, 1, "should detect .svn violation");
            assert!(
                !protected.exists(),
                ".svn directory should have been removed"
            );
        }

        #[test]
        fn watches_multiple_directories() {
            let dir1 = tmp_dir();
            let dir2 = tmp_dir();
            let mut monitor = ProtectedCreateMonitor::new(vec![".git".to_string()]);

            monitor
                .start_monitoring(&[
                    dir1.to_string_lossy().into_owned(),
                    dir2.to_string_lossy().into_owned(),
                ])
                .expect("start_monitoring should succeed");

            // Create protected entries in both directories.
            let p1 = dir1.join(".git");
            let p2 = dir2.join(".git");
            fs::create_dir_all(&p1).expect("mkdir should succeed");
            fs::create_dir_all(&p2).expect("mkdir should succeed");

            let count = monitor
                .stop_monitoring()
                .expect("stop_monitoring should succeed");

            assert_eq!(count, 2, "should detect violations in both directories");
            assert!(!p1.exists());
            assert!(!p2.exists());
        }
    }
}
