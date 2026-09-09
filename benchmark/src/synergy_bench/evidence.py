from __future__ import annotations

import hashlib
import json
import zipfile
from pathlib import Path
from typing import Any

from .storage import read_json


def collect_evidence(trial: Path, pier: dict[str, Any]) -> dict[str, Any]:
    agent = trial / "agent"
    missing: list[str] = []

    def record(name: str) -> dict[str, Any] | None:
        path = agent / f"{name}.json"
        if not path.exists():
            missing.append(f"{name}_missing")
            return None
        try:
            value = read_json(path)
            if not isinstance(value, dict):
                raise ValueError("Expected a JSON object")
            return value
        except (ValueError, OSError):
            missing.append(f"{name}_invalid")
            return None

    execution = record("execution")
    accounting = record("accounting")
    manifest = None
    archive = agent / "rollout.zip"
    if archive.exists():
        try:
            with zipfile.ZipFile(archive) as zipped:
                manifest = json.loads(zipped.read("manifest.json"))
                for file in manifest["files"]:
                    info = zipped.getinfo(file["path"])
                    with zipped.open(info) as stream:
                        hasher = hashlib.sha256()
                        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                            hasher.update(chunk)
                        checksum = hasher.hexdigest()
                    if info.file_size != file["bytes"] or checksum != file["sha256"]:
                        raise ValueError("Rollout content hash mismatch")
                missing.extend(manifest["integrity"]["missing"])
                if not manifest["integrity"]["complete"]:
                    missing.append("rollout_incomplete")
        except (ValueError, TypeError, KeyError, OSError, zipfile.BadZipFile) as error:
            missing.append(f"invalid_rollout:{type(error).__name__}")
    else:
        missing.append("rollout_missing")
    files = {}
    for path in sorted(trial.rglob("*")):
        if path.is_file() and not path.is_symlink() and path.name != "evidence.json":
            with path.open("rb") as stream:
                checksum = hashlib.file_digest(stream, "sha256").hexdigest()
            files[path.relative_to(trial).as_posix()] = {"sha256": checksum, "bytes": path.stat().st_size}
    exception = pier.get("exception_info")
    expected_execution_failure = exception and exception.get("exception_type") in {
        "AgentTimeoutError",
        "NonZeroAgentExitCodeError",
    }
    return {
        "version": 1,
        "execution": execution,
        "verifier": pier.get("verifier_result"),
        "pier_exception": exception,
        "infrastructure_error": None if expected_execution_failure else exception,
        "accounting": accounting,
        "evidence": {"complete": not missing, "missing": missing},
        "files": files,
    }
