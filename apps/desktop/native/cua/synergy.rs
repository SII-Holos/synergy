//! Synergy's observation proof extends Cua's native per-PID admission and immutable captures.
//! Upstream: trycua/cua bf6c76786d938070f4ecf1e44004752f69f518b8 (MIT).
use crate::ax::{bindings::*, cache::RetainedElement};
use async_trait::async_trait;
use base64::{engine::general_purpose::STANDARD, Engine};
use core_foundation::base::{CFEqual, CFRelease, CFTypeRef};
use cua_driver_core::{
    protocol::{Content, ToolResult},
    tool::{Tool, ToolDef},
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

pub(crate) struct Identity {
    pid: i32,
    window_id: u32,
    process_start: (u64, u64),
    window: RetainedElement,
    pub frame: [f64; 4],
    cg_frame: [f64; 4],
}
impl Identity {
    fn matches(&self, other: &Self) -> bool {
        self.pid == other.pid
            && self.window_id == other.window_id
            && self.process_start == other.process_start
            && self.frame == other.frame
            && self.cg_frame == other.cg_frame
            && unsafe {
                CFEqual(
                    self.window.as_ptr() as CFTypeRef,
                    other.window.as_ptr() as CFTypeRef,
                ) != 0
            }
    }
}

pub(crate) fn identity(pid: i32, window_id: u32) -> Option<Identity> {
    let cg = crate::windows::window_info_by_id(window_id)?;
    if cg.pid != pid {
        return None;
    }
    unsafe {
        let mut info: libc::proc_bsdinfo = std::mem::zeroed();
        let size = std::mem::size_of_val(&info) as i32;
        if libc::proc_pidinfo(
            pid,
            libc::PROC_PIDTBSDINFO,
            0,
            &mut info as *mut _ as *mut _,
            size,
        ) != size
        {
            return None;
        }
        let app = AXUIElementCreateApplication(pid);
        if app.is_null() {
            return None;
        }
        AXUIElementSetMessagingTimeout(app, 0.2);
        let windows = copy_ax_windows_including(app, pid, window_id);
        CFRelease(app as CFTypeRef);
        let mut selected = None;
        for window in windows {
            if selected.is_none() && ax_get_window_id(window) == Some(window_id) {
                AXUIElementSetMessagingTimeout(window, 0.2);
                if let Some(frame) = element_screen_rect(window) {
                    if frame.iter().all(|v| v.is_finite()) && frame[2] > 0.0 && frame[3] > 0.0 {
                        selected = Some(Identity {
                            pid,
                            window_id,
                            process_start: (info.pbi_start_tvsec, info.pbi_start_tvusec),
                            window: RetainedElement::retain(window as usize),
                            frame,
                            cg_frame: [cg.bounds.x, cg.bounds.y, cg.bounds.width, cg.bounds.height],
                        });
                    }
                }
            }
            CFRelease(window as CFTypeRef);
        }
        selected
    }
}

pub(crate) fn same_plane(logical: [f64; 4], rendered: [f64; 4], scale: f64) -> bool {
    scale.is_finite()
        && scale > 0.0
        && logical
            .iter()
            .zip(rendered)
            .all(|(a, b)| a.is_finite() && b.is_finite() && (a - b).abs() <= 2.0 + 1.0 / scale)
}

struct Observation {
    identity: Identity,
    session: String,
    expires: Instant,
    pixels: bool,
}
#[derive(Default)]
pub(crate) struct Observations(Mutex<HashMap<String, Arc<Observation>>>);
impl Observations {
    pub fn retire_session(&self, session: &str) {
        self.0
            .lock()
            .unwrap()
            .retain(|_, observed| observed.session != session);
    }
}
tokio::task_local! { static ACTION: Arc<Observation>; }

pub(crate) fn allows_pixels() -> bool {
    ACTION.try_with(|o| o.pixels).unwrap_or(true)
}
fn refusal(code: &str) -> ToolResult {
    ToolResult::error(format!(
        "{code}. Observe the window again before choosing another action."
    ))
    .with_structured(json!({"refusal":{"code":code}}))
}

pub(crate) async fn check(pid: i32, window_id: u32, pixels: bool) -> Result<(), ToolResult> {
    let Ok(observed) = ACTION.try_with(Arc::clone) else {
        return Ok(());
    };
    if cua_driver_core::session::is_session_ended(&observed.session)
        || observed.expires <= Instant::now()
        || pid != observed.identity.pid
        || window_id != observed.identity.window_id
    {
        return Err(refusal("computer_observation_stale"));
    }
    if pixels && !observed.pixels {
        return Err(refusal("capture_unavailable_for_action"));
    }
    let valid = tokio::task::spawn_blocking(move || {
        let same = identity(pid, window_id).is_some_and(|now| observed.identity.matches(&now));
        same && (!pixels
            || crate::capture::screenshot_window_bytes_verified(pid, window_id).is_ok())
    })
    .await
    .unwrap_or(false);
    if valid {
        Ok(())
    } else {
        Err(refusal("computer_target_changed"))
    }
}

pub(crate) struct GuardedTool<T> {
    inner: T,
    def: ToolDef,
    observations: Arc<Observations>,
}
impl<T: Tool> GuardedTool<T> {
    pub fn new(inner: T, observations: Arc<Observations>) -> Self {
        let mut def = inner.def().clone();
        def.input_schema["properties"]["synergy"] = json!({"type":"boolean"});
        def.input_schema["properties"]["synergy_guard"] = json!({"type":"string"});
        Self {
            inner,
            def,
            observations,
        }
    }
}
#[async_trait]
impl<T: Tool> Tool for GuardedTool<T> {
    fn def(&self) -> &ToolDef {
        &self.def
    }
    async fn invoke(&self, args: Value) -> ToolResult {
        let pid = args["pid"].as_i64().unwrap_or(0) as i32;
        let window_id = args["window_id"].as_u64().unwrap_or(0) as u32;
        let session = args["_session_id"].as_str().unwrap_or("").to_owned();
        if self.def.name == "get_window_state" && args["synergy"] == true {
            let before = tokio::task::spawn_blocking(move || identity(pid, window_id))
                .await
                .ok()
                .flatten();
            let mut result = self.inner.invoke(args).await;
            let after = tokio::task::spawn_blocking(move || identity(pid, window_id))
                .await
                .ok()
                .flatten();
            let stable = before
                .as_ref()
                .zip(after.as_ref())
                .is_some_and(|(a, b)| a.matches(b));
            let mut quality = json!({"image_status":"unavailable", "reason":"capture_unavailable", "source":"screencapturekit_window"});
            let image = result.content.iter().find_map(|c| match c {
                Content::Image { data, .. } => STANDARD.decode(data).ok(),
                _ => None,
            });
            if let Some(bytes) = image {
                if stable && bytes.len() <= 6 * 1024 * 1024 {
                    if let Ok(decoded) =
                        image::load_from_memory_with_format(&bytes, image::ImageFormat::Png)
                    {
                        if decoded.width().max(decoded.height()) <= 2048 {
                            quality = json!({"image_status":"valid", "source":"screencapturekit_window", "width": decoded.width(), "height":decoded.height(), "sha256":format!("{:x}",Sha256::digest(&bytes))});
                        }
                    }
                }
                if quality["image_status"] != "valid" {
                    quality["image_status"] = json!("invalid");
                    quality["reason"] = json!("capture_validation_failed");
                }
            }
            if !stable {
                quality["image_status"] = json!("unverified");
                quality["reason"] = json!("target_identity_unverified");
            }
            if let Some(structured) = result.structured_content.as_ref() {
                if structured["screenshot_error"]["reason"]
                    .as_str()
                    .is_some_and(|reason| reason.contains("capture_representation_mismatch"))
                {
                    quality["image_status"] = json!("invalid");
                    quality["reason"] = json!("capture_representation_mismatch");
                }
            }
            let pixels = quality["image_status"] == "valid";
            if !pixels {
                result
                    .content
                    .retain(|c| !matches!(c, Content::Image { .. }));
            }
            if stable
                && result.is_error != Some(true)
                && !session.is_empty()
                && !cua_driver_core::session::is_session_ended(&session)
            {
                let mut records = self.observations.0.lock().unwrap();
                records.retain(|_, o| {
                    o.expires > Instant::now()
                        && !(o.identity.pid == pid && o.identity.window_id == window_id)
                });
                if records.len() < 64 {
                    let token = uuid::Uuid::new_v4().to_string();
                    records.insert(
                        token.clone(),
                        Arc::new(Observation {
                            identity: after.unwrap(),
                            session,
                            expires: Instant::now() + Duration::from_secs(60),
                            pixels,
                        }),
                    );
                    quality["token"] = json!(token);
                }
            }
            let structured = result.structured_content.get_or_insert(json!({}));
            structured["synergy"] = quality;
            if !pixels {
                structured.as_object_mut().unwrap().remove("capture_id");
                structured["screenshot_frame_valid"] = json!(false);
            }
            return result;
        }
        if let Some(token) = args["synergy_guard"].as_str() {
            let observation = self.observations.0.lock().unwrap().remove(token);
            let Some(observation) = observation else {
                return refusal("computer_observation_stale");
            };
            if observation.session != session
                || observation.identity.pid != pid
                || observation.identity.window_id != window_id
                || args["delivery_mode"] != "background"
            {
                return refusal("computer_target_mismatch");
            }
            return ACTION.scope(observation, self.inner.invoke(args)).await;
        }
        self.inner.invoke(args).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn representation_proof_preserves_narrow_windows_and_rounding() {
        assert!(same_plane(
            [-800.0, 20.0, 120.0, 700.0],
            [-800.0, 20.0, 120.5, 700.0],
            2.0
        ));
        assert!(same_plane(
            [0.0, 0.0, 500.0, 500.0],
            [0.0, 0.0, 502.5, 500.0],
            2.0
        ));
        assert!(!same_plane(
            [0.0, 0.0, 1200.0, 800.0],
            [0.0, 0.0, 160.0, 100.0],
            2.0
        ));
        assert!(!same_plane(
            [0.0, 0.0, 500.0, 500.0],
            [0.0, 0.0, 503.0, 500.0],
            2.0
        ));
        assert!(!same_plane(
            [0.0, 0.0, 500.0, 500.0],
            [0.0, 0.0, 500.0, 500.0],
            f64::NAN
        ));
    }
}
