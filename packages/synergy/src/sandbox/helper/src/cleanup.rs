use crate::acl::SavedAcl;
use std::sync::Mutex;

static DACL_CLEANUP: Mutex<Vec<SavedAcl>> = Mutex::new(Vec::new());

pub fn register_dacl_cleanup(acls: Vec<SavedAcl>) {
    let mut guard = DACL_CLEANUP.lock().unwrap();
    guard.extend(acls);
}

pub fn restore_all() {
    let guard = DACL_CLEANUP.lock().unwrap();
    for saved in guard.iter() {
        unsafe {
            crate::acl::restore_acl(saved);
        }
    }
    log::info!("Cleanup complete: {} DACLs restored", guard.len());
}
