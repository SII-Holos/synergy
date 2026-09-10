from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any

from .results import RESULT_VERSION, AttemptResult
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
    exported = record("export")
    archive = record("archive")
    if not exported or exported.get("status") != "completed":
        missing.append("export_failed")
    files = {}
    for path in sorted(trial.rglob("*")):
        relative = path.relative_to(trial).as_posix()
        try:
            if path.is_file() and not path.is_symlink() and path.name != "evidence.json":
                with path.open("rb") as stream:
                    checksum = hashlib.file_digest(stream, "sha256").hexdigest()
                files[relative] = {"sha256": checksum, "bytes": path.stat().st_size}
        except OSError:
            missing.append(f"file_unreadable:{relative}")
    payload = files.get("agent/rollout.zip")
    structural = bool(
        archive
        and archive.get("valid") is True
        and payload
        and all(payload[key] == archive.get(key) for key in ["sha256", "bytes"])
    )
    if not structural:
        missing.append("archive_invalid" if payload else "rollout_missing")
    recording = archive.get("recording", "unknown") if structural and archive else "unknown"
    if recording not in {"complete", "partial", "failed", "unknown"}:
        missing.append("archive_metadata_invalid")
        recording = "unknown"
    if recording == "failed":
        missing.extend(item for item in (archive.get("issues", []) if archive else []) if isinstance(item, str))
        missing.append("recording_failed")
    if execution and (execution.get("forced") or execution.get("invalid_event_lines")):
        missing.append("execution_truncated")
    for name in ["cleanup", "credential-cleanup", "environment-cleanup"]:
        if (agent / f"{name}.json").exists():
            missing.append(f"{name}_failed")
    exception = pier.get("exception_info")
    expected = exception and exception.get("exception_type") in {
        "AgentTimeoutError",
        "VerifierTimeoutError",
        "NonZeroAgentExitCodeError",
        "CancelledError",
    }
    tokens = accounting.get("tokens", {}) if accounting else {}
    if not isinstance(tokens, dict):
        missing.append("accounting_invalid")
        tokens = {}
    usage = (
        "unknown"
        if not tokens
        else "partial"
        if any(isinstance(value, dict) and value.get("unknown", 0) for value in tokens.values())
        else "complete"
    )
    result = {
        "version": RESULT_VERSION,
        "execution": execution,
        "export": exported,
        "verifier": pier.get("verifier_result"),
        "pier_exception": exception,
        "infrastructure_error": None if expected else exception,
        "accounting": accounting,
        "evidence": {
            "valid": not missing,
            "issues": sorted(set(missing)),
            "archive_valid": structural,
            "recording": recording,
            "usage": usage,
        },
        "files": files,
    }
    return AttemptResult.model_validate(result).model_dump(exclude_none=False)


def summarize(root: Path, *, category: str = "trials") -> dict[str, Any]:
    results = [
        read_json(sorted(directory.glob("attempt-*/evidence.json"))[-1])
        for directory in sorted((root / category).glob("*"))
        if list(directory.glob("attempt-*/evidence.json"))
    ]
    failed = sum(
        not result.get("evidence", {}).get("valid", False) or bool(result.get("infrastructure_error"))
        for result in results
    )
    outcomes: dict[str, int] = {}
    rewards = []
    task_failures = 0
    for result in results:
        outcome = (result.get("execution") or {}).get("outcome", "unknown")
        outcomes[outcome] = outcomes.get(outcome, 0) + 1
        score = (result.get("verifier") or {}).get("rewards")
        rewards.append(score)
        task_failures += (
            (result.get("pier_exception") or {}).get("exception_type") == "VerifierTimeoutError"
            or outcome != "completed"
            or bool(score and all(isinstance(value, (int, float)) and value <= 0 for value in score.values()))
        )
    return {
        "run": str(root),
        "attempts": len(results),
        "outcomes": outcomes,
        "task_failures": task_failures,
        "recording_or_infrastructure_failures": failed,
        "rewards": rewards,
        "exit_code": 1 if failed else 0,
    }
