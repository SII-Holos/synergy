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
    missing_results = []
    missing_names: list[str] = []
    actual_failed: list[str] = []
    raw_cases: dict[str, list[tuple[str, str]]] = {}
    started_tests: set[str] = set()
    completed_tests: set[str] = set()
    timed_out_tests: set[str] = set()
    for file in sorted((trial / "verifier").rglob("*")):
        if not file.is_file() or file.is_symlink():
            continue
        try:
            if file.suffix == ".xml":
                root = ET.parse(file).getroot()
                format_name = "junit"
                observed = 0
                for case in root.iter("testcase"):
                    name = ".".join(part for part in [case.get("classname"), case.get("name")] if part)
                    normalized = re.sub(r"\[ruleset\d+-", "[ruleset-", name)
                    case_status = (
                        "skipped"
                        if case.find("skipped") is not None
                        else "failed"
                        if case.find("failure") is not None or case.find("error") is not None
                        else "passed"
                    )
                    if case_status != "skipped":
                        observed += 1
                    raw_cases.setdefault(normalized, []).append((name, case_status))
            elif file.suffix == ".json":
                # CTRF executed test statuses: https://ctrf.io/docs/specification/overview
                value = read_json(file)
                results = value.get("results") if isinstance(value, dict) else None
                tests = results.get("tests") if isinstance(results, dict) else None
                if not isinstance(tests, list):
                    continue
                format_name = "ctrf"
                reported = [
                    test for test in tests if isinstance(test, dict) and test.get("status") in {"passed", "failed"}
                ]
                # Provenance: docs/research/context-efficiency/2026-09-23-local24-glm-paired-study.md.
                # Local adaptation: DeepSWE synthesizes failures for absent results; those do not prove execution.
                missing = sum(
                    test.get("status") == "failed" and str(test.get("message", "")).startswith("missing from report (")
                    for test in reported
                )
                observed = len(reported) - missing
                for test in reported:
                    test_name = test.get("name")
                    if not isinstance(test_name, str):
                        continue
                    if test.get("status") == "failed" and str(test.get("message", "")).startswith(
                        "missing from report ("
                    ):
                        missing_names.append(test_name)
                    elif test.get("status") == "failed":
                        actual_failed.append(test_name)
                if missing:
                    missing_results.append({"source": file.relative_to(trial).as_posix(), "count": missing})
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
                    if not isinstance(event, dict) or not isinstance(event.get("Test"), str):
                        continue
                    package = event.get("Package", "")
                    name = f"{package}.{event['Test']}" if package else event["Test"]
                    if event.get("Action") == "run":
                        running.add((package, event["Test"]))
                        started_tests.add(name)
                    elif event.get("Action") in {"pass", "fail", "skip"}:
                        completed_tests.add(name)
                    elif event.get("Action") == "output" and "test timed out" in str(event.get("Output", "")):
                        timed_out_tests.add(name)
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
    renumbered = []
    unresolved_missing = []
    for expected in missing_names:
        name = re.sub(r"^\[(?:f2p|p2p)\] ", "", expected)
        normalized = re.sub(r"\[ruleset\d+-", "[ruleset-", name)
        matches = raw_cases.get(normalized, []) if normalized != name else []
        if len(matches) == 1 and matches[0][0] != name:
            renumbered.append({"expected": expected, "observed": matches[0][0], "status": matches[0][1]})
        else:
            unresolved_missing.append(expected)
    started_without_result = [
        name
        for name in unresolved_missing
        if re.sub(r"^\[(?:f2p|p2p)\] ", "", name) in started_tests
        and re.sub(r"^\[(?:f2p|p2p)\] ", "", name) not in completed_tests
    ]
    completed_unmatched = [
        name for name in unresolved_missing if re.sub(r"^\[(?:f2p|p2p)\] ", "", name) in completed_tests
    ]
    return {
        "execution": status,
        "functional_tests": "started" if sources else "unknown",
        "test_count": count,
        "test_count_semantics": "maximum_observed_count_across_overlapping_reports",
        "observations": observations,
        "missing_results": missing_results,
        "test_reconciliation": {
            "actual_failed": actual_failed,
            "renumbered": renumbered,
            "unresolved_missing": unresolved_missing,
            "started_without_result": started_without_result,
            "completed_unmatched": completed_unmatched,
            "not_started": [
                name for name in unresolved_missing if re.sub(r"^\[(?:f2p|p2p)\] ", "", name) not in started_tests
            ],
            "timed_out_tests": sorted(timed_out_tests),
            "verifier_timed_out": status == "timed_out",
        },
        "sources": sources,
        "raw_rewards": (pier.get("verifier_result") or {}).get("rewards"),
    }


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
    external = execution and (
        execution.get("harness") not in {None, "synergy"} or execution.get("runtime_protocol") == "synergy-session-v1"
    )
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
    cleanup_file = trial.parent / "cleanup.json"
    cleanup = (
        read_json(cleanup_file)
        if cleanup_file.exists()
        else {"status": "unknown", "resources_removed": None, "issues": []}
    )
    for name in ["cleanup", "credential-cleanup", "environment-cleanup"]:
        if (agent / f"{name}.json").exists():
            issue = f"{name}_failed"
            if issue not in cleanup["issues"]:
                cleanup["issues"].append(issue)
    if cleanup["issues"] and cleanup["resources_removed"] is not False:
        cleanup["status"] = "warning"
    if cleanup["resources_removed"] is False:
        missing.append("cleanup_unresolved")
    exception = pier.get("exception_info")
    expected = exception and exception.get("exception_type") in {
        "AgentTimeoutError",
        "VerifierTimeoutError",
        "NonZeroAgentExitCodeError",
        "CancelledError",
    }
    if not pier.get("verifier_result") and (exception or {}).get("exception_type") not in {
        "CancelledError",
        "VerifierTimeoutError",
    }:
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
        "cleanup": cleanup,
        "files": files,
    }
    return AttemptResult.model_validate(result).model_dump(exclude_none=False)


def summarize(root: Path, *, category: str = "trials") -> dict[str, Any]:
    from .report import report_data

    report = report_data(root, category=category)
    results = report["scored"]
    failures = [
        row for row in report["all_attempts"] if not row["evidence"].get("valid", False) or row["infrastructure_error"]
    ]
    unresolved = len(failures)
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
        "unresolved_recording_or_infrastructure_failures": unresolved,
        "rewards": [row["raw_rewards"] for row in results],
        "usage": report["usage"],
        "missing": report["missing"],
        "exit_code": 1 if unresolved or report["missing"] else 0,
    }
