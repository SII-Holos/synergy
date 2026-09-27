use crate::acl::SavedAcl;
use std::sync::Mutex;

#[cfg(test)]
mod tests {
    use super::{pending_count, register_dacl_cleanup, CleanupGuard};
    use crate::acl::SavedAcl;
    use std::sync::Mutex;

    static TEST_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn cleanup_guard_restores_on_scope_exit() {
        let _test_lock = TEST_LOCK.lock().unwrap();
        {
            let _guard = CleanupGuard::new();
            register_dacl_cleanup(vec![SavedAcl {
                path: "test".into(),
                security_descriptor: None,
            }]);
            assert_eq!(pending_count(), 1);
        }
        assert_eq!(pending_count(), 0);
    }

    #[test]
    fn cleanup_guard_restores_during_unwind() {
        let _test_lock = TEST_LOCK.lock().unwrap();
        let result = std::panic::catch_unwind(|| {
            let _guard = CleanupGuard::new();
            register_dacl_cleanup(vec![SavedAcl {
                path: "test".into(),
                security_descriptor: None,
            }]);
            panic!("simulated cancelled run");
        });

        assert!(result.is_err());
        assert_eq!(pending_count(), 0);
    }
}

static DACL_CLEANUP: Mutex<Vec<SavedAcl>> = Mutex::new(Vec::new());

pub struct CleanupGuard;

impl CleanupGuard {
    pub fn new() -> Self {
        Self
    }
}

impl Drop for CleanupGuard {
    fn drop(&mut self) {
        restore_all();
    }
}

pub fn register_dacl_cleanup(acls: Vec<SavedAcl>) {
    let mut guard = DACL_CLEANUP.lock().unwrap();
    guard.extend(acls);
}

pub fn restore_all() {
    let saved = {
        let mut guard = DACL_CLEANUP.lock().unwrap();
        std::mem::take(&mut *guard)
    };

    let total = saved.len();
    let mut restored = 0;
    let mut pending = Vec::new();
    for saved in saved.into_iter().rev() {
        unsafe {
            if crate::acl::restore_acl(&saved) {
                restored += 1;
            } else {
                // Keep ownership of the original descriptor so a later
                // cleanup attempt can retry instead of silently losing the
                // only exact ACL snapshot.
                pending.push(saved);
            }
        }
    }

    if !pending.is_empty() {
        let mut guard = DACL_CLEANUP.lock().unwrap();
        pending.reverse();
        guard.extend(pending);
    }
    log::info!(
        "Cleanup complete: {restored}/{total} DACLs restored ({} pending)",
        total - restored
    );
}

#[cfg(test)]
pub fn pending_count() -> usize {
    DACL_CLEANUP.lock().unwrap().len()
}
