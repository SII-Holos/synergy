from __future__ import annotations

import gzip
import hashlib
import json
import os
import re
import tarfile
import xml.etree.ElementTree as ET
from pathlib import Path, PurePosixPath
from typing import Any

from .results import RESULT_VERSION, AttemptResult
from .storage import read_json


def native_archive_readable(path: Path) -> bool:
    names = set()
    try:
        with gzip.open(path, "rb") as compressed:
            with tarfile.open(fileobj=compressed, mode="r|") as archive:
                for member in archive:
                    name = PurePosixPath(member.name)
                    if name.is_absolute() or ".." in name.parts or member.name in names:
                        return False
                    names.add(member.name)
                    if member.isfile():
                        source = archive.extractfile(member)
                        if source is None:
                            return False
                        with source:
                            while source.read(1024 * 1024):
                                pass
            while compressed.read(1024 * 1024):
                pass
        return {"home", "events.jsonl", "stderr.log", "execution.json"} <= names
    except (OSError, EOFError, tarfile.TarError):
        return False


def grading_evidence(trial: Path, pier: dict[str, Any]) -> dict[str, Any]:
    count = None
    sources = []
    observations = []
    for file in sorted((trial / "verifier").rglob("*")):
        if not file.is_file() or file.is_symlink():
            continue
        try:
            if file.suffix == ".xml":
                root = ET.parse(file).getroot()
                format_name = "junit"
                observed = int(root.get("tests", "0"))
                if not observed:
                    observed = sum(int(suite.get("tests", "0")) for suite in root.findall(".//testsuite"))
            elif file.suffix == ".json":
                # CTRF executed test statuses: https://ctrf.io/docs/specification/overview
                value = read_json(file)
                results = value.get("results") if isinstance(value, dict) else None
                tests = results.get("tests") if isinstance(results, dict) else None
                if not isinstance(tests, list):
                    continue
                format_name = "ctrf"
                observed = sum(isinstance(test, dict) and test.get("status") in {"passed", "failed"} for test in tests)
            elif file.suffix in {".txt", ".log", ".jsonl"}:
                content = file.read_text(errors="replace")
                matches = re.findall(r"running (\d+) tests?\b", content)
                observed = max([int(value) for value in matches], default=0)
                format_name = "native_test_start_log"
                running = set()
                # A run event with a Test identifies execution: https://pkg.go.dev/cmd/test2json
                for line in content.splitlines():
                    if not line.startswith("{"):
                        continue
                    try:
                        event = json.loads(line)
                    except ValueError:
                        continue
                    if isinstance(event, dict) and event.get("Action") == "run" and isinstance(event.get("Test"), str):
                        running.add((event.get("Package", ""), event["Test"]))
                observed = max(observed, len(running))
            else:
                continue
            if observed > 0:
                count = max(count or 0, observed)
                sources.append(file.relative_to(trial).as_posix())
                observations.append({"source": sources[-1], "count": observed, "format": format_name})
        except (ValueError, OSError, ET.ParseError):
            continue
    exception = (pier.get("exception_info") or {}).get("exception_type")
    timing = pier.get("verifier") or {}
    status = (
        "timed_out"
        if exception == "VerifierTimeoutError"
        else "completed"
        if pier.get("verifier_result")
        else "failed"
        if timing.get("started_at")
        else "unknown"
    )
    return {
        "execution": status,
        "functional_tests": "started" if sources else "unknown",
        "test_count": count,
        "test_count_semantics": "maximum_observed_count_across_overlapping_reports",
        "observations": observations,
        "sources": sources,
        "raw_rewards": (pier.get("verifier_result") or {}).get("rewards"),
    }


def collect_evidence(trial: Path, pier: dict[str, Any], *, verification_required: bool = True) -> dict[str, Any]:
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
    for directory, children, names in os.walk(trial):
        children[:] = sorted(
            name
            for name in children
            if Path(directory) / name != agent / "home" and not (Path(directory) / name).is_symlink()
        )
        for name in sorted(names):
            path = Path(directory) / name
            relative = path.relative_to(trial).as_posix()
            try:
                if path.is_file() and not path.is_symlink() and path.name != "evidence.json":
                    with path.open("rb") as stream:
                        checksum = hashlib.file_digest(stream, "sha256").hexdigest()
                    files[relative] = {"sha256": checksum, "bytes": path.stat().st_size}
            except OSError:
                missing.append(f"file_unreadable:{relative}")
    external = execution and execution.get("harness") not in {None, "synergy"}
    payload = files.get("agent/rollout.tar.gz" if external else "agent/rollout.zip")
    structural = bool(
        archive
        and archive.get("valid") is True
        and payload
        and all(payload[key] == archive.get(key) for key in ["sha256", "bytes"])
    )
    if structural and external:
        structural = native_archive_readable(agent / "rollout.tar.gz")
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
    if (
        verification_required
        and not pier.get("verifier_result")
        and (exception or {}).get("exception_type")
        not in {
            "CancelledError",
            "VerifierTimeoutError",
        }
    ):
        missing.append("verifier_missing")
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
        "grading": grading_evidence(trial, pier),
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
    from .report import report_data
    from .runner import startup_retryable

    report = report_data(root, category=category)
    results = report["scored"]
    failures = [
        row for row in report["all_attempts"] if not row["evidence"].get("valid", False) or row["infrastructure_error"]
    ]
    recovered = 0
    for row in failures:
        owner = {"task": "trials", "preflight": "probes", "debug": "debug"}[row["purpose"]]
        attempt = root / owner / row["trial"] / row["attempt"]
        evidence = attempt / "evidence.json"
        if not evidence.exists() or not startup_retryable(attempt, read_json(evidence)):
            continue
        recovered += any(
            later["purpose"] == row["purpose"]
            and later["trial"] == row["trial"]
            and later["attempt"] > row["attempt"]
            and later["terminal"]
            and later["model_started"]
            and later["evidence"].get("valid", False)
            and not later["infrastructure_error"]
            for later in report["all_attempts"]
        )
    unresolved = len(failures) - recovered
    outcomes: dict[str, int] = {}
    for row in results:
        outcomes[row["outcome"]] = outcomes.get(row["outcome"], 0) + 1
    return {
        "run": str(root),
        "attempts": report["attempts"],
        "planned": report["planned"],
        "completed": report["completed"],
        "outcomes": outcomes,
        "task_failures": sum(
            row["outcome"] != "completed" or (row["reward"] is not None and row["reward"] <= 0) for row in results
        ),
        "recording_or_infrastructure_failures": len(failures),
        "recovered_startup_failures": recovered,
        "unresolved_recording_or_infrastructure_failures": unresolved,
        "rewards": [row["raw_rewards"] for row in results],
        "usage": report["usage"],
        "missing": report["missing"],
        "exit_code": 1 if unresolved or report["missing"] else 0,
    }
