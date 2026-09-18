import base64
import json
import sqlite3
import sys
import zlib
from contextlib import closing
from pathlib import Path


def decode(body: str):
    if body.startswith("z:"):
        body = zlib.decompress(base64.b64decode(body[2:], validate=True)).decode()
    return json.loads(body)


root = Path(sys.argv[1] if len(sys.argv) > 1 else "/logs/agent/home/.synergy/data/storage")
namespace = json.loads((root / "manifest.json").read_text())["namespace"]
with closing(sqlite3.connect((root / "agent.sqlite").as_uri() + "?mode=ro", uri=True)) as db:
    rows = [
        (json.loads(key), decode(body))
        for key, body in db.execute(
            "SELECT key_text, body FROM storage_records WHERE namespace=? AND kind='rollout' AND body IS NOT NULL",
            (namespace,),
        )
    ]
calls = {
    (tuple(key[:6]), key[7])
    for key, value in rows
    if len(key) == 8 and key[4] == "runs" and key[6] == "calls" and value["purpose"] == "synergy"
}
print(
    any(
        len(key) == 9
        and key[6] == "attempts"
        and (tuple(key[:6]), key[7]) in calls
        and (value.get("response") or {}).get("bytes", 0) > 0
        for key, value in rows
    )
)
