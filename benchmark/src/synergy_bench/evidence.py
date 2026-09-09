from __future__ import annotations

import hashlib
import json
import zipfile
from pathlib import Path
from typing import Any

from .storage import read_json


def collect_evidence(trial: Path, pier: dict[str, Any]) -> dict[str, Any]:
    agent = trial / "agent"
    execution = read_json(agent / "execution.json") if (agent / "execution.json").exists() else None
    accounting = read_json(agent / "accounting.json") if (agent / "accounting.json").exists() else None
    missing = []
    manifest = None
    archive = agent / "rollout.zip"
    if archive.exists():
        try:
            with zipfile.ZipFile(archive) as zipped:
                manifest = json.loads(zipped.read("manifest.json"))
                for file in manifest["files"]:
                    content = zipped.read(file["path"])
                    if len(content) != file["bytes"] or hashlib.sha256(content).hexdigest() != file["sha256"]:
                        raise ValueError("Rollout content hash mismatch")
                missing.extend(manifest["integrity"]["missing"])
                if not manifest["integrity"]["complete"]:
                    missing.append("rollout_incomplete")
        except (ValueError, KeyError, zipfile.BadZipFile) as error:
            missing.append(f"invalid_rollout:{type(error).__name__}")
    else:
        missing.append("rollout_missing")
    if execution is None:
        missing.append("execution_missing")
    if accounting is None:
        missing.append("accounting_missing")
    files = {}
    for path in sorted(trial.rglob("*")):
        if path.is_file() and not path.is_symlink() and path.name != "evidence.json":
            with path.open("rb") as stream:
                checksum = hashlib.file_digest(stream, "sha256").hexdigest()
            files[path.relative_to(trial).as_posix()] = {"sha256": checksum, "bytes": path.stat().st_size}
    return {
        "version": 1,
        "execution": execution,
        "verifier": pier.get("verifier_result"),
        "infrastructure_error": pier.get("exception_info"),
        "accounting": accounting,
        "evidence": {"complete": not missing, "missing": missing},
        "files": files,
    }
