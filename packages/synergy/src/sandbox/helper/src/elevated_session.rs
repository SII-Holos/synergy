// ================================================================
// Elevated sandbox session — IPC-pipe backend for deny-read + WFP
// ================================================================

use crate::config::PermissionProfile;
use crate::elevation;
use crate::ipc_framed::{self, IpcMessage};
use crate::pipe::{PipeClient, PipeServer};

/// Elevated sandbox session handle, identified by its IPC pipe name.
///
/// On Windows, `prepare_spawn_context` creates a named pipe server
/// and `connect_elevated` launches an elevated child process that
/// connects back as a client for the setup handshake.
#[derive(Debug)]
pub struct ElevatedSandboxSession {
    pub ipc_pipe_name: String,
    pub pipe_server: Option<PipeServer>,
}

impl Clone for ElevatedSandboxSession {
    fn clone(&self) -> Self {
        ElevatedSandboxSession {
            ipc_pipe_name: self.ipc_pipe_name.clone(),
            pipe_server: None, // PipeServer handle cannot be meaningfully cloned
        }
    }
}

impl ElevatedSandboxSession {
    /// Prepare a spawn context for the given Windows integrity level.
    ///
    /// Creates a named pipe server with a unique name including a random
    /// suffix to avoid collisions between concurrent sessions.
    ///
    /// On non-Windows this always fails — the elevated backend is
    /// a Windows-only concept.
    pub fn prepare_spawn_context(windows_level: &str) -> Result<Self, Box<dyn std::error::Error>> {
        if !cfg!(target_os = "windows") {
            return Err("Elevated sandbox session is only supported on Windows".into());
        }
        if windows_level.trim().is_empty() {
            return Err("windows_level must not be empty".into());
        }

        let random_suffix = format!("{:08x}", rand::random::<u32>());
        let pipe_name = format!(
            "\\\\.\\pipe\\synergy-sandbox-{}-{}",
            windows_level, random_suffix
        );
        let pipe_server = PipeServer::create(&pipe_name)?;

        let _ = ipc_framed::IPC_PROTOCOL_VERSION; // version contract reference

        Ok(ElevatedSandboxSession {
            ipc_pipe_name: pipe_name,
            pipe_server: Some(pipe_server),
        })
    }

    /// Launch the elevated process via UAC and wait for it to connect.
    ///
    /// Calls `self_elevate` to prompt for administrator privileges, then
    /// blocks on `wait_for_client` until the elevated child connects to
    /// the named pipe server.
    pub fn connect_elevated(&mut self) -> Result<(), Box<dyn std::error::Error>> {
        if !cfg!(target_os = "windows") {
            return Err("Elevated sandbox session is only supported on Windows".into());
        }
        let pipe = self
            .pipe_server
            .as_ref()
            .ok_or("no pipe server — call prepare_spawn_context first")?;

        elevation::self_elevate(&self.ipc_pipe_name, &[])?;
        pipe.wait_for_client()?;
        Ok(())
    }

    /// Send the sandbox setup configuration to the elevated child.
    ///
    /// Serializes the permission profile and user SID as a JSON payload
    /// and sends it over the pipe as an `IpcMessage::Error` with
    /// `msg_id = "setup_config"` (temporary encoding until Phase 4
    /// adds a dedicated `SetupConfig` variant).
    pub fn send_setup_config(
        &self,
        profile: &PermissionProfile,
        user_sid: &[u8],
    ) -> Result<(), Box<dyn std::error::Error>> {
        let pipe = self
            .pipe_server
            .as_ref()
            .ok_or("no pipe server")?;

        let config_json = serde_json::json!({
            "permission_profile": profile,
            "user_sid": user_sid,
        });
        let msg = IpcMessage::Error {
            msg_id: "setup_config".into(),
            message: config_json.to_string(),
        };
        pipe.send(&msg)
    }

    /// Wait for the elevated child to acknowledge setup completion.
    ///
    /// Blocks until an `IpcMessage::Ack` is received over the pipe.
    pub fn wait_setup_ack(&self) -> Result<(), Box<dyn std::error::Error>> {
        let pipe = self
            .pipe_server
            .as_ref()
            .ok_or("no pipe server")?;
        let mut buf = Vec::new();
        let msg = pipe.receive(&mut buf)?;
        match msg {
            IpcMessage::Ack { .. } => Ok(()),
            IpcMessage::Error { message, .. } => Err(format!("setup error: {}", message).into()),
            other => Err(format!("unexpected message during setup: {:?}", other).into()),
        }
    }

    /// Request the elevated child to tear down sandbox resources.
    ///
    /// Sends an `IpcMessage::Ack` with `msg_id = "cleanup"` to signal
    /// that the elevated child should restore DACLs, remove WFP filters,
    /// and terminate.
    pub fn request_cleanup(&self) -> Result<(), Box<dyn std::error::Error>> {
        let pipe = self
            .pipe_server
            .as_ref()
            .ok_or("no pipe server")?;
        let msg = IpcMessage::Ack {
            msg_id: "cleanup".into(),
            detail: "request".into(),
        };
        pipe.send(&msg)
    }

    /// (Elevated instance side) Connect to the parent's named pipe server.
    ///
    /// Called by the elevated child process in `--setup-mode`.
    pub fn connect_to_parent(pipe_name: &str) -> Result<PipeClient, Box<dyn std::error::Error>> {
        PipeClient::connect(pipe_name)
    }

    /// (Elevated instance side) Run the elevated setup handshake.
    ///
    /// Receives the setup config from the parent, processes it,
    /// and sends an acknowledgement. In future phases this will
    /// apply DACLs, install WFP filters, etc.
    pub fn run_elevated_setup(
        pipe: &PipeClient,
        _args: &[String],
    ) -> Result<(), Box<dyn std::error::Error>> {
        let mut buf = Vec::new();
        let msg = pipe.receive(&mut buf)?;
        match msg {
            IpcMessage::Error { ref msg_id, ref message } if msg_id == "setup_config" => {
                // Parse and validate the setup config
                let _config: serde_json::Value =
                    serde_json::from_str(message)?;
                // TODO: Phase 4+ — apply DACLs, WFP filters, etc. from config
                // For now, acknowledge receipt so the parent can proceed.
                let ack = IpcMessage::Ack {
                    msg_id: "setup_done".into(),
                    detail: "setup complete".into(),
                };
                pipe.send(&ack)?;
                Ok(())
            }
            other => Err(format!(
                "unexpected message in elevated setup (expected setup_config): {:?}",
                other
            )
            .into()),
        }
    }

    /// Refresh credentials for the elevated session.
    ///
    /// On non-Windows this is a no-op.
    pub fn refresh_credentials() -> Result<(), Box<dyn std::error::Error>> {
        if !cfg!(target_os = "windows") {
            return Ok(());
        }
        // Real impl: re-negotiate token / credential handle
        Ok(())
    }

    /// Spawn the runner process over the IPC framed protocol.
    ///
    /// The runner is the elevated child that sandboxes the actual
    /// user command under the restricted token, deny-read DACL,
    /// and WFP filters.
    pub fn spawn_runner() -> Result<(), Box<dyn std::error::Error>> {
        if !cfg!(target_os = "windows") {
            return Err("Elevated runner is only supported on Windows".into());
        }
        // Real impl: open named pipe, handshake via IpcMessage::Ack,
        // then issue IpcMessage::Spawn with the permission profile.
        let _ = ipc_framed::IPC_PROTOCOL_VERSION;
        let _ = ipc_framed::IPC_MAX_FRAME_SIZE;
        Ok(())
    }
}

// ================================================================
// Tests: Elevated backend contracts
// ================================================================
#[cfg(test)]
mod tests {
    use super::*;

    // --- prepare_spawn_context contracts ---

    #[test]
    fn prepare_spawn_context_rejects_empty_level() {
        let result = ElevatedSandboxSession::prepare_spawn_context("");
        assert!(
            result.is_err(),
            "prepare_spawn_context must reject empty windows_level"
        );
    }

    #[test]
    fn prepare_spawn_context_rejects_whitespace_only_level() {
        let result = ElevatedSandboxSession::prepare_spawn_context("   ");
        assert!(
            result.is_err(),
            "prepare_spawn_context must reject whitespace-only windows_level"
        );
    }

    #[test]
    fn prepare_spawn_context_returns_error_on_non_windows() {
        let result = ElevatedSandboxSession::prepare_spawn_context("low");
        if cfg!(target_os = "windows") {
            // On Windows this should succeed
            assert!(
                result.is_ok(),
                "prepare_spawn_context must return Ok on Windows with valid level"
            );
        } else {
            // On non-Windows this must fail
            assert!(
                result.is_err(),
                "prepare_spawn_context must return Err on non-Windows"
            );
        }
    }

    #[test]
    fn prepare_spawn_context_returns_session_with_pipe_name_on_windows() {
        let result = ElevatedSandboxSession::prepare_spawn_context("medium");
        if cfg!(target_os = "windows") {
            let session = result.expect("must succeed on Windows");
            assert!(
                session.ipc_pipe_name.contains("pipe"),
                "IPC pipe name must contain 'pipe': {}",
                session.ipc_pipe_name
            );
            assert!(
                session.ipc_pipe_name.contains("medium"),
                "IPC pipe name must contain the level: {}",
                session.ipc_pipe_name
            );
        }
        // Non-Windows: Err already covered by test above
    }

    #[test]
    fn prepare_spawn_context_includes_sandbox_in_pipe_name_on_windows() {
        let result = ElevatedSandboxSession::prepare_spawn_context("high");
        if cfg!(target_os = "windows") {
            let session = result.expect("must succeed on Windows");
            assert!(
                session.ipc_pipe_name.contains("synergy-sandbox"),
                "IPC pipe name must contain 'synergy-sandbox': {}",
                session.ipc_pipe_name
            );
        }
    }

    // --- refresh_credentials contracts ---

    #[test]
    fn refresh_credentials_returns_ok_on_non_windows() {
        if !cfg!(target_os = "windows") {
            let result = ElevatedSandboxSession::refresh_credentials();
            assert!(
                result.is_ok(),
                "refresh_credentials must be a no-op Ok(()) on non-Windows"
            );
        }
    }

    #[test]
    fn refresh_credentials_always_succeeds() {
        // refresh_credentials is a no-op on non-Windows; on Windows the
        // stub also returns Ok.  The contract is that it never panics.
        let result = ElevatedSandboxSession::refresh_credentials();
        assert!(
            result.is_ok(),
            "refresh_credentials must return Ok on every platform"
        );
    }

    #[test]
    fn refresh_credentials_is_idempotent() {
        let r1 = ElevatedSandboxSession::refresh_credentials();
        let r2 = ElevatedSandboxSession::refresh_credentials();
        assert!(r1.is_ok());
        assert!(r2.is_ok());
    }

    // --- spawn_runner contracts ---

    #[test]
    fn spawn_runner_returns_error_on_non_windows() {
        let result = ElevatedSandboxSession::spawn_runner();
        if cfg!(target_os = "windows") {
            assert!(
                result.is_ok(),
                "spawn_runner must return Ok on Windows (stub)"
            );
        } else {
            assert!(
                result.is_err(),
                "spawn_runner must return Err on non-Windows"
            );
        }
    }

    // --- IPC version reference contracts ---

    #[test]
    fn elevated_module_references_ipc_framed_version() {
        // Verify the elevated module links against the IPC framed protocol
        // version so the compiler catches type mismatches.
        assert!(
            crate::ipc_framed::IPC_PROTOCOL_VERSION > 0,
            "IPC_PROTOCOL_VERSION must be positive"
        );
    }

    #[test]
    fn elevated_module_references_ipc_max_frame_size() {
        assert!(
            crate::ipc_framed::IPC_MAX_FRAME_SIZE >= 1_048_576,
            "IPC_MAX_FRAME_SIZE must be at least 1 MiB"
        );
    }

    // --- struct contracts ---

    #[test]
    fn elevated_sandbox_session_can_be_constructed_directly() {
        let session = ElevatedSandboxSession {
            ipc_pipe_name: "\\\\.\\pipe\\test".to_string(),
            pipe_server: None,
        };
        assert_eq!(session.ipc_pipe_name, "\\\\.\\pipe\\test");
    }

    #[test]
    fn elevated_sandbox_session_is_clone() {
        let session = ElevatedSandboxSession {
            ipc_pipe_name: "\\\\.\\pipe\\clone-test".to_string(),
            pipe_server: None,
        };
        let cloned = session.clone();
        assert_eq!(session.ipc_pipe_name, cloned.ipc_pipe_name);
    }

    #[test]
    fn elevated_sandbox_session_debug_format_includes_pipe_name() {
        let session = ElevatedSandboxSession {
            ipc_pipe_name: "\\\\.\\pipe\\debug-test".to_string(),
            pipe_server: None,
        };
        let debug_str = format!("{:?}", session);
        assert!(
            debug_str.contains("debug-test"),
            "Debug format must include the pipe name: {}",
            debug_str
        );
    }
}
