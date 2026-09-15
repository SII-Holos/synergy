from __future__ import annotations

import hashlib
import json
import zipfile
from collections import Counter
from pathlib import Path
from typing import Any

from .gateway import read_ledger
from .storage import digest
from .usage import FIELDS, aggregate_usage, normalize_usage


def json_lines(path: Path) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    if not path.exists():
        return records
    with path.open(errors="replace") as file:
        for line in file:
            try:
                row = json.loads(line)
            except ValueError:
                continue
            if isinstance(row, dict):
                records.append(row)
    return records


def native_accounting(agent: Path, kind: str) -> dict[str, Any] | None:
    captured = read_ledger(agent / "home/native-wire")
    if captured:
        return {**aggregate_usage(captured), "source": "native-transport-" + kind, "records": captured}
    records: list[dict[str, Any]] = []
    if kind == "codex":
        per_request = []
        seen = set()
        for path in (agent / "home/codex/sessions").rglob("*.jsonl"):
            for row in json_lines(path):
                if row.get("type") != "token_usage_record":
                    continue
                identity = (str(path), digest(row))
                if identity in seen:
                    continue
                seen.add(identity)
                payload = row.get("payload", {})
                raw = payload.get("usage") or {}
                per_request.append(
                    {
                        "id": payload.get("response_id"),
                        "request_digest": payload.get("response_id"),
                        "status": "completed",
                        "protocol": "responses",
                        "usage": codex_usage(raw),
                    }
                )
            usages = [
                row["payload"]["info"]["total_token_usage"]
                for row in json_lines(path)
                if row.get("payload", {}).get("type") == "token_count"
                and row["payload"].get("info")
                and row["payload"]["info"].get("total_token_usage")
            ]
            if usages:
                raw = usages[-1]
                records.append(
                    {
                        "id": path.name,
                        "protocol": "responses",
                        "usage": {
                            "input_tokens": raw.get("input_tokens"),
                            "output_tokens": raw.get("output_tokens"),
                            "input_tokens_details": {"cached_tokens": raw.get("cached_input_tokens")},
                            "output_tokens_details": {"reasoning_tokens": raw.get("reasoning_output_tokens")},
                        },
                    }
                )
        if per_request:
            aggregate = [{**row, "id": str(i)} for i, row in enumerate(per_request)]
            return {
                **aggregate_usage(aggregate),
                "source": "native-codex-response",
                "request_records": per_request,
                "cumulative": aggregate_usage(records) if records else None,
            }
    elif kind == "pi":
        for index, row in enumerate(json_lines(agent / "events.jsonl")):
            if row.get("type") == "message_end" and row.get("message", {}).get("role") == "assistant":
                records.append(
                    {
                        "id": str(index),
                        "protocol": "pi",
                        "usage": row["message"].get("usage")
                        if row["message"].get("stopReason") not in {"error", "aborted"}
                        else None,
                    }
                )
    elif kind == "opencode":
        for index, row in enumerate(json_lines(agent / "events.jsonl")):
            if row.get("type") == "step_finish":
                raw = row.get("part", {}).get("tokens", {})
                cache = raw.get("cache", {})
                records.append(
                    {
                        "id": str(index),
                        "protocol": "pi",
                        "usage": {
                            "input": raw.get("input"),
                            "output": raw.get("output"),
                            "reasoning": raw.get("reasoning"),
                            "cacheRead": cache.get("read"),
                            "cacheWrite": cache.get("write"),
                        },
                    }
                )
    if not records:
        return None
    return {**aggregate_usage(records), "source": "native-" + kind, "records": records}


def codex_usage(raw: dict[str, Any]) -> dict[str, Any]:
    return {
        "input_tokens": raw.get("input_tokens"),
        "output_tokens": raw.get("output_tokens"),
        "input_tokens_details": {"cached_tokens": raw.get("cached_input_tokens")},
        "output_tokens_details": {"reasoning_tokens": raw.get("reasoning_output_tokens")},
    }


def reconcile_usage(wire: dict[str, Any], native: dict[str, Any] | None) -> dict[str, Any]:
    fields = {}
    for field in FIELDS:
        one = wire.get("tokens", {}).get(field, {}).get("total")
        two = (native or {}).get("tokens", {}).get(field, {}).get("total")
        fields[field] = {
            "wire": one,
            "native": two,
            "status": "unknown" if one is None or two is None else "matched" if one == two else "mismatch",
        }
    statuses = {field["status"] for field in fields.values()}
    return {
        "status": "mismatch" if "mismatch" in statuses else "partial" if "unknown" in statuses else "matched",
        "fields": fields,
    }


def reconcile_requests(wire: list[dict[str, Any]], native: dict[str, Any] | None) -> dict[str, Any]:
    if native and native.get("source") == "native-codex-response":
        completed = [row for row in wire if row.get("status") == "completed"]
        translated = [{**row, "request_digest": row.get("downstream_response_id")} for row in completed]
        result = reconcile_request_bodies(translated, native["request_records"])
        result.update(mode="response_id", wire_requests=len(wire), interrupted_requests=len(wire) - len(completed))
        if len(wire) != len(completed) and result["status"] == "matched":
            result["status"] = "partial"
        result["coverage"] = len(result["completed_usage_crosschecked"]) / len(wire) if wire else None
        return result
    if native and native.get("source") == "synergy-rollout-v1":
        return reconcile_request_bodies(wire, native["request_records"])
    if not (native or {}).get("source", "").startswith("native-transport-"):
        return {"mode": "aggregate", "status": "unknown", "wire_requests": len(wire), "coverage": None}
    identifiers = {row["id"] for row in (native or {}).get("records", [])}
    observed = Counter(row.get("client_request_id") for row in wire)
    missing_native = sorted(key for key in observed if key is not None and key not in identifiers)
    missing_wire = sorted(identifiers - observed.keys())
    duplicates = sorted(key for key, count in observed.items() if key is not None and count > 1)
    unknown = observed.get(None, 0)
    native_rows = {row["id"]: row for row in (native or {}).get("records", [])}
    mismatches = []
    incomplete = []
    checked = []
    for row in wire:
        key = row.get("client_request_id")
        other = native_rows.get(key)
        if other is None or row.get("status") != "completed" or other.get("status") != "completed":
            continue
        one, two = (
            normalize_usage(row.get("usage"), row["protocol"]),
            normalize_usage(other.get("usage"), other["protocol"]),
        )
        if any(one[field] is not None and two[field] is not None and one[field] != two[field] for field in one):
            mismatches.append(key)
        elif one["total"] is None or two["total"] is None:
            incomplete.append(key)
        else:
            checked.append(key)
    return {
        "mode": "request_id",
        "status": "mismatch"
        if missing_native or missing_wire or duplicates or unknown or mismatches
        else "partial"
        if incomplete
        else "matched",
        "wire_requests": len(wire),
        "native_requests": len(identifiers),
        "missing_native": missing_native,
        "missing_wire": missing_wire,
        "duplicate_client_ids": duplicates,
        "unidentified_wire_requests": unknown,
        "usage_mismatches": sorted(mismatches),
        "unknown_completed_usage": sorted(incomplete),
        "completed_usage_crosschecked": sorted(checked),
        "coverage": len(identifiers & observed.keys()) / len(identifiers | (observed.keys() - {None}))
        if identifiers or observed.keys() - {None}
        else None,
    }


# Public archive contract: packages/harness/src/session/rollout/archive.ts (Manifest v1).
# Enrichment keeps the official aggregate intact and reads retained transport attempts.
def attach_synergy_requests(agent: Path, accounting: dict[str, Any] | None) -> dict[str, Any] | None:
    file = agent / "rollout.zip"
    if accounting is None or not file.exists():
        return accounting
    records = []
    try:
        with zipfile.ZipFile(file) as archive:
            manifest = json.loads(archive.read("manifest.json"))
            if manifest.get("format") != "synergy-rollout" or manifest.get("version") != 1:
                return accounting
            artifacts = {row["ref"]["id"]: row for row in manifest["artifacts"]}
            for snapshot in manifest["snapshots"]:
                calls = {row["id"]: row for row in snapshot["calls"]}
                for attempt in snapshot["attempts"]:
                    artifact = artifacts.get((attempt.get("request") or {}).get("id"))
                    request_digest = None
                    if (
                        artifact
                        and artifact["ref"]["bytes"] <= 128 * 1024**2
                        and sum(archive.getinfo(name).file_size for name in artifact["files"]) <= 128 * 1024**2
                    ):
                        body = b"".join(archive.read(name) for name in artifact["files"])
                        if (
                            len(body) == artifact["ref"]["bytes"]
                            and hashlib.sha256(body).hexdigest() == artifact["ref"]["sha256"]
                        ):
                            request_digest = digest(json.loads(body))
                    raw = (attempt.get("usage") or {}).get("raw")
                    records.append(
                        {
                            "id": attempt["id"],
                            "purpose": calls.get(attempt["callID"], {}).get("purpose"),
                            "request_digest": request_digest,
                            "status": attempt["status"],
                            "protocol": "responses"
                            if attempt["url"].rstrip("/").endswith("/responses")
                            else "chat-completions",
                            "usage": raw if attempt["status"] == "completed" else None,
                            "observed_usage": raw,
                        }
                    )
    except (OSError, ValueError, KeyError, zipfile.BadZipFile):
        return accounting
    return {**accounting, "source": "synergy-rollout-v1", "request_records": records}


def reconcile_request_bodies(wire: list[dict[str, Any]], native: list[dict[str, Any]]) -> dict[str, Any]:
    left = Counter(row.get("request_digest") for row in wire)
    right = Counter(row.get("request_digest") for row in native)
    unique = {key for key in left.keys() & right.keys() if key and left[key] == right[key] == 1}
    native_by_digest = {row.get("request_digest"): row for row in native}
    translated = [
        {**row, "client_request_id": row["request_digest"]} for row in wire if row.get("request_digest") in unique
    ]
    records = [{**native_by_digest[key], "id": key} for key in unique]
    result = reconcile_requests(translated, {"source": "native-transport-public-rollout", "records": records})
    missing_native = sorted(key for key in left.keys() - right.keys() if key)
    missing_wire = sorted(key for key in right.keys() - left.keys() if key)
    ambiguous = sorted(key for key in left.keys() & right.keys() if key and key not in unique)
    if (missing_native and not right.get(None)) or (missing_wire and not left.get(None)):
        result["status"] = "mismatch"
    elif ambiguous or left.get(None) or right.get(None):
        if result["status"] != "mismatch":
            result["status"] = "partial"
    result.update(
        mode="request_body_digest",
        wire_requests=len(wire),
        native_requests=len(native),
        missing_native=missing_native,
        missing_wire=missing_wire,
        ambiguous_request_bodies=ambiguous,
        unidentified_wire_requests=left.get(None, 0),
        unidentified_native_requests=right.get(None, 0),
        coverage=len(unique) / max(len(wire), len(native)) if wire or native else None,
    )
    return result
