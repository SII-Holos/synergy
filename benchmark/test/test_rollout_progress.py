import base64
import ctypes
import ctypes.util
import json
import sqlite3
import subprocess
import sys
import zlib
from pathlib import Path

import pytest

# Golden frames captured from the product's `RecordCodec`, not constructed here.
# The codec emits a frame only when it is smaller than the JSON it replaces, so
# each value carries padding that pushes it past the 64-byte floor. Pinning the
# real bytes is what makes this a check on the probe's decoder rather than on a
# fixture that agrees with the probe by construction. Each row has its own
# frame, because a frame decodes to the value it was captured from.
FRAME_CALLS = (
    "1a018f0128b52ffd208f9d0200b2851217a0a73986ed35d22420b21f19edb3e5b01a0b6d26eb2f60899202d93985c4890ed327"
    "f7b1e38e353d852d456746e57da013d4d4840bb8a84c2d3dbc0a7604f8c930d8a0a6cec3272c22010059fa9c51"
)
FRAME_AUXILIARY_CALLS = (
    "1a018c0128b52ffd208c8502002205111690b56d6849e1dab595ae04da0c3988ab9c9831fb3fc7831383d0ac941ca354be257"
    "b86805c7db995e2c1d4f5f23b499c29ee0b0f6c19b83adcf691b078f971eab65e10020048cff360b10905"
)
FRAME_ATTEMPTS = {
    0: "1a016f28b52ffd206fed010034037b22726573706f6e7365223a7b226279746573223a302c22706164223a2270726f766964657220"
    "2070616464696e6720227d7d0200e979ced1ab9e",
    64: "1a017028b52ffd2070f5010044037b22726573706f6e7365223a7b226279746573223a36342c22706164223a2270726f76696465"
    "72202070616464696e6720227d7d0200e9790ed2abca",
}


def frame_encoding_available() -> bool:
    """Whether this host can decode a zstd frame, which the probe needs.

    The probe runs in a Debian-based task image, where libzstd is present as a
    transitive dependency. A macOS development host usually has no libzstd on
    its search path, so the frame case reports itself as skipped there instead
    of failing for a missing shared library. That means the frame case is only
    exercised on Linux; `uv run --project benchmark pytest` on a macOS host does
    not prove it.
    """
    try:
        ctypes.CDLL(ctypes.util.find_library("zstd") or "libzstd.so.1")
        return True
    except OSError:
        return False


@pytest.mark.parametrize("encoding", ["plain", "legacy", "frame"])
@pytest.mark.parametrize("response_bytes", [0, 64])
def test_live_rollout_probe_reads_every_record_encoding(tmp_path: Path, encoding: str, response_bytes: int) -> None:
    if encoding == "frame" and not frame_encoding_available():
        pytest.skip("libzstd is unavailable, so the frame form cannot be decoded on this host")
    (tmp_path / "manifest.json").write_text(json.dumps({"namespace": "fixture"}))
    root = ["sessions", "scope", "session", "rollout", "runs", "run"]
    # The body column has no affinity, which is what lets one column hold the
    # text and byte forms a store may contain in either format.
    with sqlite3.connect(tmp_path / "agent.sqlite") as db:
        db.execute("CREATE TABLE storage_records (namespace TEXT, key_text TEXT, body BLOB, kind TEXT)")
        rows = [
            (root + ["calls", "call"], {"purpose": "fixture-primary", "usageRole": "conversation"}, FRAME_CALLS),
            (
                root + ["attempts", "call", "attempt"],
                {"response": {"bytes": response_bytes}},
                FRAME_ATTEMPTS[response_bytes],
            ),
            (
                root + ["calls", "auxiliary"],
                {"purpose": "fixture-primary", "usageRole": "auxiliary"},
                FRAME_AUXILIARY_CALLS,
            ),
            (root + ["attempts", "auxiliary", "attempt"], {"response": {"bytes": 64}}, FRAME_ATTEMPTS[64]),
        ]
        for key, value, frame in rows:
            if encoding == "frame":
                body: object = sqlite3.Binary(bytes.fromhex(frame))
            elif encoding == "legacy":
                body = "z:" + base64.b64encode(zlib.compress(json.dumps(value).encode())).decode()
            else:
                body = json.dumps(value)
            db.execute("INSERT INTO storage_records VALUES (?, ?, ?, ?)", ("fixture", json.dumps(key), body, "rollout"))
    probe = Path(__file__).parent / "fixtures/rollout_progress.py"
    result = subprocess.run([sys.executable, str(probe), str(tmp_path)], check=True, capture_output=True, text=True)
    assert result.stdout.strip() == str(response_bytes > 0)
