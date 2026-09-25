// ================================================================
// IPC framed protocol — length-prefixed JSON wire format
// ================================================================

use serde::{Deserialize, Serialize};

/// IPC protocol version for handshake verification.
pub const IPC_PROTOCOL_VERSION: u32 = 1;

/// Maximum frame size in bytes (1 MiB).
pub const IPC_MAX_FRAME_SIZE: usize = 1_048_576;

/// Length-prefixed framed JSON message envelope.
///
/// Wire format: `<byte-length> <json-payload>\n`
/// Example: `29 {"command":"ack","msg_id":"1"}\n`

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "command")]
pub enum IpcMessage {
    /// Request the sandbox helper to spawn a child process.
    #[serde(rename = "spawn")]
    Spawn {
        program: String,
        args: Vec<String>,
        cwd: String,
        env: Vec<(String, String)>,
        permission_profile: serde_json::Value,
        ipc_version: u32,
    },

    /// Notify that a spawned child process has exited.
    #[serde(rename = "exit")]
    ProcessExit { pid: u32, exit_code: i32 },

    /// Stream a chunk of stdout or stderr (base64-encoded).
    #[serde(rename = "pipe")]
    PipeData {
        pid: u32,
        stream: String,
        data: String,
    },

    /// Send data to the child process stdin (base64-encoded).
    #[serde(rename = "stdin")]
    Stdin { data: String },

    /// Acknowledge a previous request.
    #[serde(rename = "ack")]
    Ack { msg_id: String, detail: String },

    /// Report an error.
    #[serde(rename = "error")]
    Error { msg_id: String, message: String },

    /// Request termination of a child process.
    #[serde(rename = "terminate")]
    Terminate { pid: u32, exit_code: i32 },

    /// Request stdin stream closure for a child process.
    #[serde(rename = "close_stdin")]
    CloseStdin,

    /// Request terminal resize.
    #[serde(rename = "resize")]
    Resize { pid: u32, rows: u16, cols: u16 },
}

/// Serialize a message into a length-prefixed frame.
///
/// Returns the framed string (including trailing newline) or an error
/// if serialization fails or the payload exceeds IPC_MAX_FRAME_SIZE.
pub fn write_frame(msg: &IpcMessage) -> Result<String, Box<dyn std::error::Error>> {
    let json = serde_json::to_string(msg)?;
    let payload = json.as_bytes();
    if payload.len() > IPC_MAX_FRAME_SIZE {
        return Err("frame payload exceeds IPC_MAX_FRAME_SIZE".into());
    }
    Ok(format!("{} {}\n", payload.len(), json))
}

/// Parse a single frame from a byte buffer.
///
/// Returns `Ok(None)` if more data is needed.
/// Returns `Err(...)` for malformed or oversized frames.
pub fn read_frame(buf: &[u8]) -> Result<Option<(IpcMessage, usize)>, Box<dyn std::error::Error>> {
    let input = match std::str::from_utf8(buf) {
        Ok(s) => s,
        Err(_) => return Ok(None), // partial UTF-8 — need more data
    };

    // Find the space separator between length and payload
    let space_pos = match input.find(' ') {
        Some(p) => p,
        None => {
            // Entire buffer is still the length prefix — need more data
            if input.bytes().all(|b| b.is_ascii_digit()) {
                return Ok(None);
            }
            return Err("invalid frame format: missing length-payload separator".into());
        }
    };

    let len_str = &input[..space_pos];
    let declared_len: usize = len_str
        .parse()
        .map_err(|_| format!("invalid frame length header: '{}'", len_str))?;

    if declared_len > IPC_MAX_FRAME_SIZE {
        return Err(format!("frame size {} exceeds IPC_MAX_FRAME_SIZE", declared_len).into());
    }

    let payload_start = space_pos + 1;
    let payload_end = payload_start + declared_len;
    let needed = payload_end + 1; // +1 for trailing newline

    if input.len() < needed {
        return Ok(None);
    }

    if input.as_bytes()[payload_end] != b'\n' {
        return Err("frame must end with newline".into());
    }

    let json_str = &input[payload_start..payload_end];
    let msg: IpcMessage = serde_json::from_str(json_str)?;
    Ok(Some((msg, needed)))
}

// --- Base64 (no-padding) ---

const BASE64_TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Encode arbitrary bytes as a no-padding base64 string.
pub fn base64_encode(data: &[u8]) -> String {
    if data.is_empty() {
        return String::new();
    }

    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = if chunk.len() > 1 { chunk[1] as u32 } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as u32 } else { 0 };
        let triple = (b0 << 16) | (b1 << 8) | b2;

        out.push(BASE64_TABLE[((triple >> 18) & 0x3F) as usize] as char);
        out.push(BASE64_TABLE[((triple >> 12) & 0x3F) as usize] as char);

        if chunk.len() > 1 {
            out.push(BASE64_TABLE[((triple >> 6) & 0x3F) as usize] as char);
        }
        if chunk.len() > 2 {
            out.push(BASE64_TABLE[(triple & 0x3F) as usize] as char);
        }
    }
    out
}

/// Decode a no-padding base64 string back to bytes.
pub fn base64_decode(input: &str) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    if input.is_empty() {
        return Ok(Vec::new());
    }

    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity((bytes.len() + 3) / 4 * 3);
    let mut i = 0;

    while i < bytes.len() {
        let mut quad = [0u8; 4];
        let mut quad_len = 0;

        for j in 0..4 {
            if i + j < bytes.len() {
                let b = bytes[i + j];
                let val: u8 = match b {
                    b'A'..=b'Z' => b - b'A',
                    b'a'..=b'z' => b - b'a' + 26,
                    b'0'..=b'9' => b - b'0' + 52,
                    b'+' => 62,
                    b'/' => 63,
                    _ => {
                        return Err(format!(
                            "invalid base64 character '{}' at offset {}",
                            b as char,
                            i + j
                        )
                        .into());
                    }
                };
                quad[j] = val;
                quad_len += 1;
            } else {
                break;
            }
        }
        i += quad_len;

        if quad_len >= 2 {
            out.push((quad[0] << 2) | (quad[1] >> 4));
        }
        if quad_len >= 3 {
            out.push(((quad[1] & 0x0F) << 4) | (quad[2] >> 2));
        }
        if quad_len >= 4 {
            out.push(((quad[2] & 0x03) << 6) | quad[3]);
        }
    }

    Ok(out)
}

// ================================================================
// Tests: IPC framed protocol contracts
// ================================================================
#[cfg(test)]
mod tests {
    #[allow(unused_imports)]
    use super::*;

    // --- Framing round-trip ---

    #[test]
    fn framed_round_trip() {
        let msg = IpcMessage::Spawn {
            program: "cmd.exe".into(),
            args: vec!["/c".into(), "echo hello".into()],
            cwd: "C:\\sandbox".into(),
            env: vec![("SYNERGY_ID".into(), "abc123".into())],
            permission_profile: serde_json::json!({"network": {"mode": "restricted"}}),
            ipc_version: IPC_PROTOCOL_VERSION,
        };

        let frame = write_frame(&msg).expect("write_frame must succeed");
        assert!(frame.ends_with('\n'), "Frame must end with newline");

        let (decoded, consumed) = read_frame(frame.as_bytes())
            .expect("read_frame must succeed")
            .expect("read_frame must return Some");

        assert_eq!(
            consumed,
            frame.len(),
            "read_frame must consume entire frame"
        );
        assert_eq!(decoded, msg, "Round-tripped message must equal original");
    }

    #[test]
    fn spawn_request_serializes_all_fields() {
        let msg = IpcMessage::Spawn {
            program: "node.exe".into(),
            args: vec!["script.js".into(), "--verbose".into()],
            cwd: "C:\\workspace".into(),
            env: vec![
                ("NODE_ENV".into(), "sandbox".into()),
                ("DEBUG".into(), "1".into()),
            ],
            permission_profile: serde_json::json!({
                "fileSystem": {"workspace": "C:\\workspace"},
                "network": {"mode": "proxy_only"}
            }),
            ipc_version: IPC_PROTOCOL_VERSION,
        };

        let json = serde_json::to_string(&msg).expect("serialization must succeed");

        assert!(
            json.contains("\"command\":\"spawn\""),
            "JSON must contain command=spawn"
        );
        assert!(
            json.contains("\"program\":\"node.exe\""),
            "JSON must contain program"
        );
        assert!(json.contains("\"args\""), "JSON must contain args array");
        assert!(
            json.contains("script.js"),
            "JSON must contain arg: script.js"
        );
        assert!(
            json.contains("--verbose"),
            "JSON must contain arg: --verbose"
        );
        assert!(
            json.contains("\"cwd\":\"C:\\\\workspace\""),
            "JSON must contain cwd"
        );
        assert!(
            json.contains("\"NODE_ENV\""),
            "JSON must contain env var NODE_ENV"
        );
        assert!(
            json.contains("\"sandbox\""),
            "JSON must contain env val sandbox"
        );
        assert!(
            json.contains("\"permission_profile\""),
            "JSON must contain permission_profile"
        );
        assert!(
            json.contains("\"proxy_only\""),
            "JSON must contain network mode proxy_only"
        );
        assert!(
            json.contains("\"ipc_version\""),
            "JSON must contain ipc_version"
        );
    }

    #[test]
    fn terminate_message_round_trip() {
        let msg = IpcMessage::Terminate {
            pid: 4242,
            exit_code: 1,
        };

        let frame = write_frame(&msg).expect("write_frame must succeed");
        let (decoded, consumed) = read_frame(frame.as_bytes())
            .expect("read_frame must succeed")
            .expect("read_frame must return Some");

        assert_eq!(consumed, frame.len());
        assert_eq!(decoded, msg);

        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("\"command\":\"terminate\""));
        assert!(json.contains("\"pid\":4242"));
        assert!(json.contains("\"exit_code\":1"));
    }

    #[test]
    fn version_field_preserved() {
        let msg = IpcMessage::Spawn {
            program: "test.exe".into(),
            args: vec![],
            cwd: ".".into(),
            env: vec![],
            permission_profile: serde_json::json!({}),
            ipc_version: IPC_PROTOCOL_VERSION,
        };

        let frame = write_frame(&msg).expect("write_frame must succeed");
        let (decoded, _) = read_frame(frame.as_bytes())
            .expect("read_frame must succeed")
            .expect("read_frame must return Some");

        if let IpcMessage::Spawn { ipc_version, .. } = decoded {
            assert_eq!(
                ipc_version, IPC_PROTOCOL_VERSION,
                "IPC_PROTOCOL_VERSION must survive round-trip, expected {} got {}",
                IPC_PROTOCOL_VERSION, ipc_version
            );
        } else {
            panic!("Expected Spawn variant after round-trip");
        }
    }

    #[test]
    fn base64_round_trip() {
        let test_cases: Vec<Vec<u8>> = vec![
            vec![],
            vec![0x00],
            vec![0xFF],
            b"Hello, World!".to_vec(),
            (0u8..=255u8).collect(),
            vec![0x41; 1000],
        ];

        for (i, data) in test_cases.iter().enumerate() {
            let encoded = base64_encode(data);
            assert!(
                !encoded.contains('='),
                "base64_encode must produce no-padding output (case {})",
                i
            );
            let decoded =
                base64_decode(&encoded).expect(&format!("base64_decode must succeed (case {})", i));
            assert_eq!(
                &decoded, data,
                "base64 round-trip must be identity (case {})",
                i
            );
        }
    }

    #[test]
    fn base64_encode_empty_returns_empty() {
        let encoded = base64_encode(b"");
        assert!(encoded.is_empty(), "Empty input must produce empty output");
        let decoded = base64_decode("").expect("decode empty must succeed");
        assert!(decoded.is_empty(), "Empty decode must produce empty output");
    }

    #[test]
    fn ipc_max_frame_size_is_reasonable() {
        assert!(
            IPC_MAX_FRAME_SIZE >= 65536,
            "IPC_MAX_FRAME_SIZE must be >= 64 KiB, got {}",
            IPC_MAX_FRAME_SIZE
        );
        assert!(
            IPC_MAX_FRAME_SIZE <= 16_777_216,
            "IPC_MAX_FRAME_SIZE must be <= 16 MiB, got {}",
            IPC_MAX_FRAME_SIZE
        );
    }

    #[test]
    fn read_frame_returns_none_for_incomplete_input() {
        let result = read_frame(b"12").expect("read_frame must succeed");
        assert!(result.is_none(), "Incomplete frame must return None");

        let frame_start = b"100 ";
        let result = read_frame(frame_start).expect("read_frame must succeed");
        assert!(result.is_none(), "Partial frame must return None");
    }

    #[test]
    fn read_frame_rejects_oversized_frame() {
        let oversized_len = IPC_MAX_FRAME_SIZE + 1;
        let frame = format!("{} x\n", oversized_len);
        let result = read_frame(frame.as_bytes());
        assert!(result.is_err(), "Oversized frame must be rejected");
    }

    #[test]
    fn write_frame_rejects_oversized_payload() {
        let huge_env: Vec<(String, String)> = (0..100_000)
            .map(|i| (format!("KEY_{}", i), "x".to_string()))
            .collect();
        let msg = IpcMessage::Spawn {
            program: "test.exe".into(),
            args: vec![],
            cwd: ".".into(),
            env: huge_env,
            permission_profile: serde_json::json!({}),
            ipc_version: IPC_PROTOCOL_VERSION,
        };

        let result = write_frame(&msg);
        assert!(
            result.is_err(),
            "Oversized message must be rejected by write_frame"
        );
    }

    #[test]
    fn ipc_protocol_version_is_positive() {
        assert!(
            IPC_PROTOCOL_VERSION > 0,
            "IPC_PROTOCOL_VERSION must be positive"
        );
    }

    #[test]
    fn pipe_data_message_round_trip() {
        let binary_data = vec![0xDE, 0xAD, 0xBE, 0xEF, 0x00, 0x01, 0x02, 0x03];
        let encoded = base64_encode(&binary_data);

        let msg = IpcMessage::PipeData {
            pid: 1234,
            stream: "stdout".into(),
            data: encoded,
        };

        let frame = write_frame(&msg).expect("write_frame must succeed");
        let (decoded, _) = read_frame(frame.as_bytes())
            .expect("read_frame must succeed")
            .expect("read_frame must return Some");

        if let IpcMessage::PipeData { pid, stream, data } = decoded {
            assert_eq!(pid, 1234);
            assert_eq!(stream, "stdout");
            let decoded_bytes = base64_decode(&data).expect("base64_decode must succeed");
            assert_eq!(
                decoded_bytes, binary_data,
                "Binary payload must survive full pipeline"
            );
        } else {
            panic!("Expected PipeData variant after round-trip");
        }
    }

    #[test]
    fn ack_message_round_trip() {
        let msg = IpcMessage::Ack {
            msg_id: "req_001".into(),
            detail: "filters installed".into(),
        };

        let frame = write_frame(&msg).expect("write_frame must succeed");
        let (decoded, _) = read_frame(frame.as_bytes())
            .expect("read_frame must succeed")
            .expect("read_frame must return Some");

        assert_eq!(decoded, msg);
    }

    #[test]
    fn error_message_round_trip() {
        let msg = IpcMessage::Error {
            msg_id: "req_002".into(),
            message: "permission denied".into(),
        };

        let frame = write_frame(&msg).expect("write_frame must succeed");
        let (decoded, _) = read_frame(frame.as_bytes())
            .expect("read_frame must succeed")
            .expect("read_frame must return Some");

        assert_eq!(decoded, msg);
    }

    #[test]
    fn process_exit_message_round_trip() {
        let msg = IpcMessage::ProcessExit {
            pid: 9999,
            exit_code: 42,
        };

        let frame = write_frame(&msg).expect("write_frame must succeed");
        let (decoded, _) = read_frame(frame.as_bytes())
            .expect("read_frame must succeed")
            .expect("read_frame must return Some");

        assert_eq!(decoded, msg);
    }

    #[test]
    fn serialize_then_write_frame_is_deterministic() {
        let msg = IpcMessage::Terminate {
            pid: 1,
            exit_code: 0,
        };
        let frame1 = write_frame(&msg).unwrap();
        let frame2 = write_frame(&msg).unwrap();
        assert_eq!(frame1, frame2, "write_frame must be deterministic");
    }

    #[test]
    fn base64_encode_is_deterministic() {
        let data = b"deterministic test";
        let a = base64_encode(data);
        let b = base64_encode(data);
        assert_eq!(a, b, "base64_encode must be deterministic");
    }
}
