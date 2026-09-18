import base64
import json
import sqlite3
import subprocess
import sys
import zlib
from pathlib import Path

import pytest


@pytest.mark.parametrize("compressed", [False, True])
@pytest.mark.parametrize("response_bytes", [0, 64])
def test_live_rollout_probe_reads_both_record_encodings(tmp_path: Path, compressed: bool, response_bytes: int) -> None:
    (tmp_path / "manifest.json").write_text(json.dumps({"namespace": "fixture"}))
    root = ["sessions", "scope", "session", "rollout", "runs", "run"]
    with sqlite3.connect(tmp_path / "agent.sqlite") as db:
        db.execute("CREATE TABLE storage_records (namespace TEXT, key_text TEXT, body TEXT, kind TEXT)")
        for key, value in [
            (root + ["calls", "call"], {"purpose": "synergy"}),
            (root + ["attempts", "call", "attempt"], {"response": {"bytes": response_bytes}}),
        ]:
            body = json.dumps(value)
            if compressed:
                body = "z:" + base64.b64encode(zlib.compress(body.encode())).decode()
            db.execute("INSERT INTO storage_records VALUES (?, ?, ?, ?)", ("fixture", json.dumps(key), body, "rollout"))
    probe = Path(__file__).parent / "fixtures/rollout_progress.py"
    result = subprocess.run([sys.executable, str(probe), str(tmp_path)], check=True, capture_output=True, text=True)
    assert result.stdout.strip() == str(response_bytes > 0)
