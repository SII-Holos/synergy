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
# fixture that agrees with the probe by construction.
FRAME_RESPONSE_BYTES = {
    0: "1a016f28b52ffd206fed010034037b22726573706f6e7365223a7b226279746573223a302c22706164223a2270726f766964657220"
    "2070616464696e6720227d7d0200e979ced1ab9e",
    64: "1a017028b52ffd2070f5010044037b22726573706f6e7365223a7b226279746573223a36342c22706164223a2270726f76696465"
    "72202070616464696e6720227d7d0200e9790ed2abca",
}


def frame_encoding_available() -> bool:
    """Whether this host can decode a zstd frame, which the probe needs.

    The probe runs through `docker exec` in a Debian-based task image, where
    libzstd ships as a transitive dependency and this is always true. A macOS
    development host often has no libzstd on its search path, so the frame case
    reports itself as skipped instead of failing for a missing shared library.
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
            (root + ["calls", "call"], {"purpose": "synergy"}),
            (root + ["attempts", "call", "attempt"], {"response": {"bytes": response_bytes}}),
        ]
        for key, value in rows:
            if encoding == "frame":
                body: object = sqlite3.Binary(bytes.fromhex(FRAME_RESPONSE_BYTES[response_bytes]))
            elif encoding == "legacy":
                body = "z:" + base64.b64encode(zlib.compress(json.dumps(value).encode())).decode()
            else:
                body = json.dumps(value)
            db.execute("INSERT INTO storage_records VALUES (?, ?, ?, ?)", ("fixture", json.dumps(key), body, "rollout"))
    probe = Path(__file__).parent / "fixtures/rollout_progress.py"
    result = subprocess.run([sys.executable, str(probe), str(tmp_path)], check=True, capture_output=True, text=True)
    assert result.stdout.strip() == str(response_bytes > 0)
