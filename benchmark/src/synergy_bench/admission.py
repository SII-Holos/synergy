from __future__ import annotations

import hashlib
import json
import tarfile
import zipfile
from collections import Counter
from pathlib import Path, PurePosixPath
from typing import Any

from .evidence import native_archive_readable
from .gateway import read_ledger
from .native_usage import attach_synergy_requests, reconcile_requests
from .results import native_reward
from .storage import atomic_json, digest
from .usage import FIELDS, aggregate_usage, normalize_usage

POLICY = "strict-synergy-v1"


def strict_admission(plan: dict[str, Any]) -> bool:
    return bool(plan.get("config", {}).get("admission_policy") == POLICY)


def require(condition: Any, reason: str) -> None:
    if not condition:
        raise ValueError("Admission stopped: " + reason)


def unique_rows(rows: list[dict[str, Any]], field: str) -> dict[str, dict[str, Any]]:
    keys = [row.get(field) for row in rows]
    require(all(isinstance(key, str) and key for key in keys), "missing request identity")
    require(len(set(keys)) == len(keys), "duplicate request identity")
    return {row[field]: row for row in rows}


def rollout_records(agent: Path) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    with zipfile.ZipFile(agent / "rollout.zip") as archive:
        names = archive.namelist()
        require(len(names) == len(set(names)), "duplicate archive members")
        require(archive.testzip() is None, "invalid archive CRC")
        manifest = json.loads(archive.read("manifest.json"))
    require(manifest.get("format") == "synergy-rollout" and manifest.get("version") == 1, "unknown rollout format")
    captured = attach_synergy_requests(agent, {})
    require(captured and captured.get("source") == "synergy-rollout-v1", "native requests unavailable")
    records = (captured or {})["request_records"]
    unidentified = {row["id"] for row in records if row.get("request_digest") is None}
    artifacts = unique_rows([dict(row, id=row["ref"]["id"]) for row in manifest["artifacts"]], "id")
    unconfirmed = []
    for snapshot in manifest["snapshots"]:
        calls = unique_rows(snapshot["calls"], "id")
        for row in snapshot["attempts"]:
            require(isinstance(row.get("ended"), (int, float)), "nonterminal native request")
            if row["id"] not in unidentified:
                continue
            call, request = calls[row["callID"]], row.get("request") or {}
            artifact = artifacts.get(request.get("id", ""), {})
            require(
                row["status"] == call["status"] == "cancelled"
                and row["ended"] >= row["started"]
                and not row.get("response")
                and not row.get("responseHeaders")
                and not row.get("usage")
                and request.get("bytes") == request.get("chunks") == 0
                and request.get("sha256") is None
                and request.get("status") == "partial"
                and artifact.get("ref") == request
                and artifact.get("files") == []
                and call.get("transportCaptured") is False
                and call.get("sdkUsage") is None,
                "unlinked native request lacks empty cancellation evidence",
            )
            unconfirmed.append({"id": row["id"], "provider_dispatch": "unconfirmed", "usage": None})
    require({row["id"] for row in unconfirmed} == unidentified, "unidentified native request")
    return records, unconfirmed


def transport_records(agent: Path) -> list[dict[str, Any]]:
    archive = agent / "rollout.tar.gz"
    require(native_archive_readable(archive), "invalid native transport archive")
    captured: dict[str, dict[str, Any]] = {}
    with tarfile.open(archive, "r|gz") as stream:
        for member in stream:
            parts = PurePosixPath(member.name).parts
            if len(parts) != 4 or parts[:2] != ("home", "native-wire"):
                continue
            if parts[-1] not in {"request.json", "body.json"}:
                continue
            require(member.isfile() and member.size <= 128 * 1024**2, "invalid native request member")
            content = stream.extractfile(member)
            require(content is not None, "missing native request member")
            assert content is not None
            with content:
                captured.setdefault(parts[2], {})[parts[-1]] = json.load(content)
    rows = []
    for key, files in captured.items():
        require(set(files) == {"request.json", "body.json"}, "incomplete native transport record")
        row = files["request.json"]
        require(row.get("id") == key and row.get("ended_at") is not None, "nonterminal native transport record")
        rows.append({**row, "request_digest": digest(files["body.json"])})
    return rows


def match_requests(
    wire: list[dict[str, Any]], native: list[dict[str, Any]], *, transport: bool
) -> list[tuple[dict[str, Any], dict[str, Any]]]:
    unique_rows(wire, "id")
    remaining = unique_rows(native, "id")
    identified = unique_rows([row for row in native if row.get("response_request_id")], "response_request_id")
    pairs, fallback = [], []
    for row in wire:
        other = (
            remaining.get(row.get("client_request_id", ""))
            if transport
            else identified.get("synergy-benchmark:" + row["id"])
        )
        if other is None:
            require(not transport, "unlinked transport request")
            fallback.append(row)
            continue
        require(other["id"] in remaining, "native request reused")
        pairs.append((row, remaining.pop(other["id"])))
    left = Counter(row.get("request_digest") for row in fallback)
    right = Counter(row.get("request_digest") for row in remaining.values() if not row.get("response_request_id"))
    by_body = {row.get("request_digest"): row for row in remaining.values() if not row.get("response_request_id")}
    for row in fallback:
        key = row.get("request_digest")
        require(key and left[key] == right[key] == 1, "ambiguous or unlinked request body")
        other = by_body[key]
        pairs.append((row, remaining.pop(other["id"])))
    require(not remaining, "native request has no observed dispatch")
    return pairs


def audit_attempt(attempt: Path, result: dict[str, Any], *, preflight: bool) -> dict[str, Any]:
    from .runner import verify_terminal

    verify_terminal(attempt, result)
    require(result.get("attempt_status") == "completed", "attempt is not terminal")
    evidence = result.get("evidence") or {}
    require(evidence.get("valid") is True and evidence.get("archive_valid") is True, "invalid terminal evidence")
    require(not result.get("infrastructure_error"), "infrastructure failure")
    outcome = (result.get("execution") or {}).get("outcome")
    require(outcome in {"completed", "failed", "timeout"}, "execution is incomplete")
    require(not (result.get("execution") or {}).get("interrupted"), "execution was cancelled")
    if not preflight:
        grading = result.get("grading") or {}
        require(grading.get("execution") == "completed", "verifier did not complete")
        require(grading.get("functional_tests") == "started", "native tests did not start")
        require(native_reward((result.get("verifier") or {}).get("rewards")) is not None, "native reward missing")
    agent = attempt / result["trial_directory"] / "agent"
    accounting = result.get("accounting") or {}
    transport = accounting.get("source") == "native-transport-synergy"
    require(transport or accounting.get("source") == "synergy-rollout-v1", "unsupported accounting source")
    payload = "agent/rollout.tar.gz" if transport else "agent/rollout.zip"
    require(payload in result["files"], "archive is not checksummed")
    unconfirmed: list[dict[str, Any]] = []
    if transport:
        native = transport_records(agent)
        retained = accounting.get("records", [])
        derived = [{key: value for key, value in row.items() if key != "request_digest"} for row in native]
    else:
        native, unconfirmed = rollout_records(agent)
        retained = accounting.get("request_records", [])
        derived = native
    require(unique_rows(retained, "id") == unique_rows(derived, "id"), "native records disagree with archive")
    wire = read_ledger(attempt / "wire")
    require(wire, "no observed model requests")
    for file in (attempt / "wire").rglob("*"):
        require(not file.is_symlink(), "wire contains a symlink")
        if file.is_file():
            require(file.relative_to(attempt).as_posix() in result["sidecar_files"], "unsealed wire evidence")
    require(aggregate_usage(wire) == result.get("wire_usage"), "wire accounting changed")
    raw_check = reconcile_requests(wire, accounting)
    require(raw_check == (result.get("reconciliation") or {}).get("requests"), "request reconciliation changed")
    require((result.get("reconciliation") or {}).get("status") != "mismatch", "aggregate usage mismatch")
    omitted = {row["id"] for row in unconfirmed}
    pairs = match_requests(wire, [row for row in native if row["id"] not in omitted], transport=transport)
    completed, unknown = 0, []
    for row, other in pairs:
        require(row.get("ended_at") is not None, "nonterminal observed request")
        require(row.get("request_digest") and row["request_digest"] == other.get("request_digest"), "body mismatch")
        require(row["protocol"] == other["protocol"], "protocol mismatch")
        if row["status"] == "completed":
            require(other["status"] == "completed", "native completion missing")
            one, two = (normalize_usage(item.get("usage"), item["protocol"]) for item in (row, other))
            require(all(one[key] is not None and one[key] == two[key] for key in FIELDS[:4]), "incomplete core usage")
            for item, normalized in [(row, one), (other, two)]:
                raw_total = item["usage"].get("total_tokens")
                require(raw_total is None or raw_total == normalized["total"], "inconsistent provider total")
            require(all(one[key] == two[key] for key in FIELDS), "per-request usage mismatch")
            completed += 1
        else:
            require(row["status"] in {"interrupted", "failed", "http_error"}, "unknown wire terminal status")
            require(other["status"] in {"interrupted", "cancelled", "failed", "http_error"}, "native status mismatch")
            require(row.get("usage") is None and other.get("usage") is None, "invented interrupted usage")
            unknown.append({"wire_id": row["id"], "native_id": other["id"], "usage": None})
    return {
        "status": "passed",
        "completed_usage_crosschecked": completed,
        "unknown_usage_requests": len(unknown),
        "unknown_requests": unknown,
        "unconfirmed_native_dispatches": unconfirmed,
        "recorded_request_coverage": raw_check["coverage"],
        "observed_wire_request_coverage": 1,
        "known_tokens": result["wire_usage"]["tokens"]["total"]["known"],
        "exact_total_tokens": None if unknown or unconfirmed else result["wire_usage"]["tokens"]["total"]["total"],
    }


def admit_attempt(attempt: Path, result: dict[str, Any], *, preflight: bool = False) -> dict[str, Any]:
    receipt = {
        "policy": POLICY,
        "preflight": preflight,
        "evidence_sha256": hashlib.sha256((attempt / "evidence.json").read_bytes()).hexdigest(),
    }
    try:
        receipt.update(audit_attempt(attempt, result, preflight=preflight))
    except (OSError, ValueError, KeyError, TypeError, zipfile.BadZipFile, tarfile.TarError) as error:
        atomic_json(attempt / "admission.json", {**receipt, "status": "failed", "reason": str(error)})
        raise ValueError(f"Admission stopped; inspect {attempt / 'admission.json'}") from error
    atomic_json(attempt / "admission.json", receipt)
    return receipt
