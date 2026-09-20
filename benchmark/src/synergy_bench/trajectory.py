"""Offline, payload-free diagnostics over retained benchmark wire and Synergy rollouts.

Provenance: benchmark/README.md, evidence and accounting contracts.
Local adaptation: preserves individual dispatches, uses interval unions for elapsed
time, and measures content in UTF-8 bytes without inventing token attribution.
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import zipfile
from collections import Counter, defaultdict
from collections.abc import Iterable
from pathlib import Path
from typing import Any

from .storage import atomic_json, digest, read_json
from .usage import normalize_usage

Row = dict[str, Any]
TOKEN_FIELDS = ("input", "output", "total", "cache_read", "reasoning", "uncached")
CONTENT_FIELDS = (
    "system_bytes",
    "user_bytes",
    "assistant_bytes",
    "historical_reasoning_bytes",
    "tool_result_bytes",
    "tool_call_bytes",
    "tool_schema_bytes",
    "other_content_bytes",
)


def interval_seconds(intervals: Iterable[tuple[float, float]], clip: tuple[float, float] | None = None) -> float:
    values = sorted((max(a, clip[0]), min(b, clip[1])) if clip else (a, b) for a, b in intervals)
    total = 0.0
    end = float("-inf")
    for a, b in values:
        if b > max(a, end):
            total += b - max(a, end)
            end = b
    return total


def json_bytes(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode()


def content_bytes(value: Any) -> int:
    if value is None:
        return 0
    return len(value.encode()) if isinstance(value, str) else len(json_bytes(value))


def payload_profile(body: Row) -> Row:
    profile: Row = dict.fromkeys(CONTENT_FIELDS, 0)
    messages = body.get("messages", [])
    profile["messages"] = len(messages)
    profile["schema_count"] = len(body.get("tools", []))
    profile["tool_schema_bytes"] = len(json_bytes(body["tools"])) if body.get("tools") else 0
    for message in messages:
        key = {
            "system": "system_bytes",
            "developer": "system_bytes",
            "user": "user_bytes",
            "assistant": "assistant_bytes",
            "tool": "tool_result_bytes",
        }.get(message.get("role"), "other_content_bytes")
        profile[key] += content_bytes(message.get("content"))
        profile["historical_reasoning_bytes"] += content_bytes(message.get("reasoning_content"))
        if message.get("tool_calls"):
            profile["tool_call_bytes"] += len(json_bytes(message["tool_calls"]))
    return profile


def quantiles(values: Iterable[float | int | None]) -> Row:
    ordered = sorted(float(v) for v in values if v is not None)
    if not ordered:
        return {"n": 0}
    result: Row = {"n": len(ordered), "min": ordered[0], "max": ordered[-1], "sum": sum(ordered)}
    for label, fraction in [("p50", 0.5), ("p90", 0.9), ("p95", 0.95), ("p99", 0.99)]:
        position = (len(ordered) - 1) * fraction
        low = int(position)
        result[label] = ordered[low] + (ordered[min(low + 1, len(ordered) - 1)] - ordered[low]) * (position - low)
    return result


def request_summary(rows: list[Row], *, terminal: bool = True) -> Row:
    result: Row = {"requests": len(rows), "http_status": dict(Counter(str(r.get("http_status")) for r in rows))}
    for key in TOKEN_FIELDS:
        result[f"known_{key}"] = sum(r.get(key) or 0 for r in rows)
        result[f"unknown_{key}_requests"] = sum(r.get(key) is None for r in rows)
    result["known_total"] = result["known_input"] + result["known_output"]
    result["unknown_usage_requests"] = sum(not r["usage_complete"] for r in rows)
    result["total_tokens"] = result["known_total"] if terminal and not result["unknown_usage_requests"] else None
    result["usage_request_coverage"] = 1 - result["unknown_usage_requests"] / len(rows) if rows else None
    for name, numerator, denominator in [
        ("cache_rate_known", "cache_read", "input"),
        ("reasoning_share_known", "reasoning", "output"),
    ]:
        partial_pair = any((r.get(numerator) is None) != (r.get(denominator) is None) for r in rows)
        result[name] = (
            result[f"known_{numerator}"] / result[f"known_{denominator}"]
            if result[f"known_{denominator}"] and not partial_pair
            else None
        )
    for key in ("duration_seconds", "first_byte_seconds", "input", "output", "reasoning"):
        result[key + "_distribution"] = quantiles(r.get(key) for r in rows)
    for key in CONTENT_FIELDS:
        result[key] = sum(r.get(key) or 0 for r in rows)
    result["request_union_seconds"] = interval_seconds(
        (r["started_at"], r["ended_at"]) for r in rows if r.get("ended_at") is not None
    )
    return result


def grouped(rows: list[Row], key: str) -> list[Row]:
    groups: dict[str, list[Row]] = defaultdict(list)
    for row in rows:
        groups[str(row.get(key, "unknown"))].append(row)
    return [{key: value, **request_summary(items)} for value, items in sorted(groups.items())]


def stream_profile(path: Path) -> Row:
    result: Row = {
        "response_reasoning_bytes": 0,
        "response_text_bytes": 0,
        "response_tool_argument_bytes": 0,
        "response_tool_calls": 0,
        "stream_usage_frames": 0,
        "stream_invalid_lines": 0,
        "finish_reasons": "",
    }
    reasons: set[str] = set()
    calls: set[tuple[int, int]] = set()
    if not path.exists():
        result["stream_missing"] = True
        return result
    with path.open("rb") as stream:
        for line in stream:
            if not line.startswith(b"data:") or line[5:].strip() == b"[DONE]":
                continue
            try:
                event = json.loads(line[5:])
            except (ValueError, UnicodeDecodeError):
                result["stream_invalid_lines"] += 1
                continue
            if event.get("usage"):
                result["stream_usage_frames"] += 1
            for choice in event.get("choices", []):
                delta = choice.get("delta") or {}
                result["response_reasoning_bytes"] += content_bytes(delta.get("reasoning_content"))
                result["response_text_bytes"] += content_bytes(delta.get("content"))
                for call in delta.get("tool_calls") or []:
                    calls.add((choice.get("index", 0), call.get("index", 0)))
                    result["response_tool_argument_bytes"] += content_bytes(call.get("function", {}).get("arguments"))
                if choice.get("finish_reason"):
                    reasons.add(choice["finish_reason"])
    result["response_tool_calls"] = len(calls)
    result["finish_reasons"] = ",".join(sorted(reasons))
    return result


def tool_category(name: str, args: Row) -> str:
    if name in {"view_file", "read", "glob", "scan_files", "grep", "file_search"}:
        return "read_search"
    if name in {"save_file", "revise_file", "write", "edit", "apply_patch"}:
        return "edit"
    if name.startswith("dag") or name in {"task", "task_output", "todowrite"}:
        return "coordination"
    if name == "process":
        return "process_control"
    if name == "bash":
        command = str(args.get("command", ""))
        if re.search(r"\b(pytest|cargo test|go test|bun test|npm test|pnpm test|jest|vitest|unittest)\b", command):
            return "shell_test"
        if re.search(r"\bgit (status|log|diff|branch|checkout|switch|add|commit)\b", command):
            return "shell_git"
        if re.search(r"\b(pip|apt|npm install|pnpm install|yarn install|curl|wget)\b", command):
            return "shell_setup_network"
        return "shell_other"
    return "other"


def load_rollout(attempt: Path) -> tuple[Row, Row]:
    archives = sorted(attempt.glob("*/agent/rollout.zip"))
    if not archives:
        return {}, {}
    if len(archives) != 1:
        raise ValueError(f"Ambiguous rollout archive under {attempt.name}")
    with zipfile.ZipFile(archives[0]) as archive:
        manifest = json.loads(archive.read("manifest.json"))
        if manifest.get("format") != "synergy-rollout" or manifest.get("version") != 1:
            raise ValueError("Unsupported rollout format/version")
        return manifest, json.loads(archive.read("transcript.json"))


def rollout_tables(manifest: Row, transcript: Row, base: Row) -> tuple[list[Row], list[Row], list[Row], dict[str, Row]]:
    tools: list[Row] = []
    sessions: list[Row] = []
    messages: list[Row] = []
    native: dict[str, Row] = {}
    parts: dict[tuple[int, str], Row] = {}
    session_index = {s["info"]["id"]: index for index, s in enumerate(transcript.get("sessions", []))}
    for session in transcript.get("sessions", []):
        info = session["info"]
        owner = session_index[info["id"]]
        root = info["id"] == manifest.get("rootSessionID")
        session_base = {**base, "owner": owner, "is_root": root}
        for index, message in enumerate(session.get("messages", [])):
            mi = message["info"]
            mp = message.get("parts", [])
            parts.update({(owner, p["callID"]): p for p in mp if p.get("type") == "tool"})
            context = mi.get("contextUsage") or {}
            row = {
                **session_base,
                "message_index": index,
                "role": mi.get("role"),
                "agent": mi.get("agent"),
                "created_at": (mi.get("time", {}).get("created") or 0) / 1000,
                "completed_at": (mi.get("time", {}).get("completed") or 0) / 1000,
                "finish": mi.get("finish"),
                "tool_count": sum(p.get("type") == "tool" for p in mp),
                "reasoning_bytes": sum(content_bytes(p.get("text")) for p in mp if p.get("type") == "reasoning"),
                "text_bytes": sum(content_bytes(p.get("text")) for p in mp if p.get("type") == "text"),
                "compaction_parts": sum(p.get("type") == "compaction" for p in mp),
                "context_input": context.get("totalInput"),
                "call_ids": ",".join(mi.get("accounting", {}).get("callIDs", [])),
            }
            for category, values in context.get("categories", {}).items():
                row[f"context_{category}_attributed"] = values.get("attributedTokens")
            messages.append(row)
        sm = [r for r in messages if r["owner"] == owner]
        times = [r["completed_at"] for r in sm if r["role"] == "assistant" and r["completed_at"]]
        sessions.append(
            {
                **session_base,
                "messages": len(sm),
                "assistant_messages": sum(r["role"] == "assistant" for r in sm),
                "last_assistant_at": max(times) if times else None,
                "parent_present": bool(info.get("parentID")),
                "compaction_parts": sum(r["compaction_parts"] for r in sm),
            }
        )
    operations: Counter[tuple[int, str, str]] = Counter()
    for snapshot in manifest.get("snapshots", []):
        sid = snapshot.get("owner", {}).get("sessionID")
        owner = session_index.get(sid, -1)
        root = sid == manifest.get("rootSessionID")
        calls = {c["id"]: c for c in snapshot.get("calls", [])}
        for attempt in snapshot.get("attempts", []):
            call = calls.get(attempt.get("callID"), {})
            native[attempt["id"]] = {
                "owner": owner,
                "is_root": root,
                "purpose": call.get("purpose"),
                "call_id": call.get("id"),
                "native_started": attempt.get("started", 0) / 1000,
                "call_started_at": call.get("started", 0) / 1000,
            }
        for item in sorted(snapshot.get("tools", []), key=lambda t: t.get("started", 0)):
            part = parts.get((owner, item.get("toolCallID", "")), {})
            state = part.get("state") or {}
            args = state.get("input") or {}
            operation = {k: v for k, v in args.items() if k not in {"description", "title"}}
            signature = digest(operation)
            key = (owner, item["tool"], signature)
            operations[key] += 1
            metadata = state.get("metadata") or {}
            row = {
                **base,
                "owner": owner,
                "is_root": root,
                "tool": item["tool"],
                "tool_call_id": item.get("toolCallID"),
                "message_id": item.get("messageID"),
                "status": item.get("status"),
                "category": tool_category(item["tool"], args),
                "started_at": item.get("started", 0) / 1000,
                "ended_at": item["ended"] / 1000 if item.get("ended") else None,
                "duration_seconds": (item["ended"] - item["started"]) / 1000 if item.get("ended") else None,
                "input_bytes": len(json_bytes(args)),
                "output_bytes": content_bytes(state.get("output")),
                "input_digest": signature,
                "output_digest": digest(state.get("output")),
                "same_operation_ordinal": operations[key],
                "exit_code": metadata.get("exit"),
                "output_truncated": metadata.get("truncated"),
                "process_action": args.get("action"),
            }
            tools.append(row)
    return tools, sessions, messages, native


def prefix_profile(previous: Row | None, current: Row) -> Row:
    if previous is None:
        return {"previous_prefix_bytes": None, "previous_prefix_messages": None, "prefix_break_role": None}
    left = previous.get("messages", [])
    right = current.get("messages", [])
    count = 0
    size = 0
    for a, b in zip(left, right, strict=False):
        if a != b:
            break
        count += 1
        size += len(json_bytes(a))
    role = right[count].get("role") if count < min(len(left), len(right)) else "append_or_shorten"
    return {
        "previous_prefix_bytes": size,
        "previous_prefix_messages": count,
        "prefix_break_role": role,
        "schema_changed": previous.get("tools") != current.get("tools"),
        "history_shrank": len(right) < len(left),
    }


def analyze_attempt(
    path: Path, root: Path, blocks: dict[tuple[str, str, str], Row], schemas: dict[tuple[str, str, str], Row]
) -> Row:
    relative = path.relative_to(root)
    group, trial = relative.parts[:2]
    evidence = read_json(path / "evidence.json") if (path / "evidence.json").exists() else {}
    trial_data = read_json(path / "trial.json") if (path / "trial.json").exists() else {}
    base = {"group": group, "trial": trial, "attempt": path.name, "task": trial_data.get("task")}
    manifest, transcript = load_rollout(path)
    tools, sessions, messages, native = rollout_tables(manifest, transcript, base)
    native_groups: dict[str, list[Row]] = defaultdict(list)
    for record in (evidence.get("accounting") or {}).get("request_records", []):
        if record.get("request_digest"):
            native_groups[record["request_digest"]].append({**record, **native.get(record["id"], {})})
    for items in native_groups.values():
        items.sort(key=lambda r: r.get("native_started", 0))
    records: list[Row] = []
    wire_groups: dict[str, list[Row]] = defaultdict(list)
    for directory in path.glob("wire/*"):
        if directory.is_dir() and not (directory / "request.json").is_file():
            raise ValueError(f"Missing request metadata in {directory.relative_to(root)}")
    for file in sorted(path.glob("wire/*/request.json")):
        record = read_json(file)
        if record.get("protocol") != "chat-completions":
            raise ValueError("Trajectory content analysis requires chat-completions wire evidence")
        body_path = file.parent / "downstream.json"
        body = read_json(body_path) if body_path.exists() else {}
        record["body_digest"] = digest(body) if body_path.exists() else None
        record["directory"] = file.parent
        records.append(record)
        if record["body_digest"]:
            wire_groups[record["body_digest"]].append(record)
    for key, items in wire_groups.items():
        items.sort(key=lambda r: r.get("started_at", 0))
        peers = native_groups.get(key, [])
        if len(items) == len(peers):
            for record, peer in zip(items, peers, strict=True):
                record["native"] = peer
                record["match"] = "unique" if len(items) == 1 else "ordered_duplicate"
    requests: list[Row] = []
    previous: dict[tuple[Any, Any], Row] = {}
    body_seen: Counter[str] = Counter()
    exposures: dict[tuple[int | None, str], Row] = {}
    for index, record in enumerate(sorted(records, key=lambda r: r.get("started_at", 0))):
        directory = record["directory"]
        peer = record.get("native", {})
        body_path = directory / "upstream.json"
        body = read_json(body_path) if body_path.exists() else {}
        usage = normalize_usage(record.get("usage") or record.get("observed_usage"), "chat-completions")
        complete_usage = normalize_usage(record.get("usage"), "chat-completions")
        start, end = record.get("started_at", 0), record.get("ended_at")
        tokens = {("cache_read" if k == "cacheRead" else k): v for k, v in usage.items() if k != "cacheWrite"}
        tokens["uncached"] = (
            usage["input"] - usage["cacheRead"]
            if (usage["input"] is not None and usage["cacheRead"] is not None)
            else None
        )
        conversation_key = (peer.get("owner"), peer.get("purpose"))
        row = {
            **base,
            "index": index,
            "request_id": record["id"],
            "body_digest": record["body_digest"],
            "purpose": peer.get("purpose", "unknown"),
            "owner": peer.get("owner"),
            "is_root": peer.get("is_root"),
            "call_id": peer.get("call_id"),
            "match": record.get("match", "unmatched"),
            "http_status": record.get("http_status"),
            "status": record.get("status"),
            "started_at": start,
            "ended_at": end,
            "duration_seconds": end - start if end else None,
            "first_byte_seconds": record["first_byte_at"] - start if record.get("first_byte_at") else None,
            "header_seconds": record["headers_at"] - start if record.get("headers_at") else None,
            "retry_after": record.get("retry_after"),
            "call_to_wire_seconds": start - peer["call_started_at"] if peer.get("call_started_at") else None,
            "usage_complete": complete_usage["total"] is not None,
            **tokens,
            "cache_rate": usage["cacheRead"] / usage["input"]
            if usage["input"] and usage["cacheRead"] is not None
            else None,
            "request_bytes": record.get("request_bytes"),
            "response_bytes": record.get("response_bytes"),
            **payload_profile(body),
            **stream_profile(directory / "response.bin"),
            **prefix_profile(previous.get(conversation_key) if peer else None, body),
            "system_digest": digest([m for m in body.get("messages", []) if m.get("role") in {"system", "developer"}]),
            "schema_digest": digest(body.get("tools", [])),
            "reasoning_effort": body.get("reasoning_effort"),
            "max_tokens": body.get("max_tokens"),
            "thinking_clear": (body.get("thinking") or {}).get("clear_thinking"),
        }
        native_usage = normalize_usage(peer.get("usage") or peer.get("observed_usage"), "chat-completions")
        row["native_usage_match"] = usage == native_usage if peer and usage["total"] is not None else None
        body_seen[record["body_digest"]] += 1
        row["same_body_ordinal"] = body_seen[record["body_digest"]]
        if peer and record.get("http_status") == 200:
            previous[conversation_key] = body
        requests.append(row)
        tool_names = {
            call["id"]: call.get("function", {}).get("name", "unknown")
            for message in body.get("messages", [])
            for call in message.get("tool_calls", [])
        }
        for message in body.get("messages", []):
            if message.get("role") == "tool":
                identity = message.get("tool_call_id", "unknown")
                exposure = exposures.setdefault(
                    (peer.get("owner"), identity),
                    {
                        **base,
                        "owner": peer.get("owner"),
                        "tool_call_id": identity,
                        "tool": tool_names.get(identity, "unknown"),
                        "exposures": 0,
                        "exposure_bytes": 0,
                        "successful_exposure_bytes": 0,
                    },
                )
                size = content_bytes(message.get("content"))
                exposure["exposures"] += 1
                exposure["exposure_bytes"] += size
                exposure["successful_exposure_bytes"] += size if record.get("http_status") == 200 else 0
            for field in ["content", "reasoning_content", "tool_calls"]:
                content = message.get(field)
                if not content:
                    continue
                role = (
                    "reasoning"
                    if field == "reasoning_content"
                    else "tool_calls"
                    if field == "tool_calls"
                    else message.get("role", "other")
                )
                block_key = (group, role, digest(content))
                block = blocks.setdefault(
                    block_key,
                    {
                        "group": group,
                        "role": role,
                        "digest": block_key[2],
                        "bytes": content_bytes(content),
                        "exposures": 0,
                        "successful_exposures": 0,
                        "trials": set(),
                    },
                )
                block["exposures"] += 1
                block["successful_exposures"] += int(record.get("http_status") == 200)
                block["trials"].add(str(relative))
        for schema in body.get("tools", []):
            name = schema.get("function", {}).get("name", "unknown")
            schema_key = (group, name, digest(schema))
            item = schemas.setdefault(
                schema_key,
                {
                    "group": group,
                    "tool": name,
                    "digest": schema_key[2],
                    "bytes": len(json_bytes(schema)),
                    "exposures": 0,
                    "successful_exposures": 0,
                    "trials": set(),
                },
            )
            item["exposures"] += 1
            item["successful_exposures"] += int(record.get("http_status") == 200)
            item["trials"].add(str(relative))
    execution = evidence.get("execution") or {}
    start = execution["started_at"] / 1000 if execution.get("started_at") is not None else None
    end = execution["ended_at"] / 1000 if execution.get("ended_at") is not None else None
    clip = (start, end) if start is not None and end is not None and end > start else None
    ri = [(r["started_at"], r["ended_at"]) for r in requests if r["ended_at"] is not None]
    ti = [(t["started_at"], t["ended_at"]) for t in tools if t["ended_at"] is not None]
    resources = evidence.get("resources") or {}
    last_root = max((s["last_assistant_at"] or 0 for s in sessions if s["is_root"]), default=0)
    native_attempts = sum(len(s.get("attempts", [])) for s in manifest.get("snapshots", []))
    missing_wire = max(0, native_attempts - len(requests))
    summary = request_summary(requests, terminal=bool(evidence) and not missing_wire)
    attempt_row = {
        **base,
        **{k: v for k, v in summary.items() if not isinstance(v, dict)},
        "terminal_evidence": bool(evidence),
        "reward": (evidence.get("verifier") or {}).get("rewards", {}).get("reward"),
        "outcome": execution.get("outcome"),
        "timed_out": execution.get("timed_out"),
        "exit_code": execution.get("exit_code"),
        "evidence_valid": (evidence.get("evidence") or {}).get("valid"),
        "started_at": start,
        "ended_at": end,
        "execution_seconds": execution["wall_ms"] / 1000 if execution.get("wall_ms") is not None else None,
        "request_union_seconds": interval_seconds(ri, clip),
        "tool_union_seconds": interval_seconds(ti, clip),
        "model_or_tool_union_seconds": interval_seconds(ri + ti, clip),
        "model_tool_overlap_seconds": interval_seconds(ri, clip)
        + interval_seconds(ti, clip)
        - interval_seconds(ri + ti, clip),
        "uncovered_seconds": max(0, clip[1] - clip[0] - interval_seconds(ri + ti, clip)) if clip else None,
        "first_tool_seconds": min(t["started_at"] for t in tools) - clip[0] if tools and clip else None,
        "post_last_assistant_seconds": clip[1] - last_root if last_root and clip else None,
        "owners": len(manifest.get("snapshots", [])),
        "sessions": len(sessions),
        "tools": len(tools),
        "native_calls": sum(len(s.get("calls", [])) for s in manifest.get("snapshots", [])),
        "native_transport_attempts": native_attempts,
        "missing_wire_attempts": missing_wire,
        "unmatched_wire": sum(r["match"] == "unmatched" for r in requests),
        "peak_memory_bytes": resources.get("peak_memory_bytes"),
        "peak_cpu_percent": resources.get("peak_cpu_percent"),
        "oom_events": resources.get("oom_events"),
        "compaction_parts": sum(s["compaction_parts"] for s in sessions),
        "max_input": max((r["input"] or 0 for r in requests), default=0),
    }
    for name, stages in (evidence.get("stages") or {}).items():
        attempt_row[f"stage_{name}_seconds"] = sum(s.get("wall_seconds", 0) for s in stages)
    return {
        "attempt": attempt_row,
        "requests": requests,
        "tools": tools,
        "sessions": sessions,
        "messages": messages,
        "tool_exposures": list(exposures.values()),
        "calls": [
            {
                **base,
                "purpose": c.get("purpose"),
                "status": c.get("status"),
                "started_at": c.get("started", 0) / 1000,
                "duration_seconds": (c["ended"] - c["started"]) / 1000 if c.get("ended") else None,
                "transport_captured": c.get("transportCaptured"),
            }
            for s in manifest.get("snapshots", [])
            for c in s.get("calls", [])
        ],
    }


def analyze_run(root: Path) -> Row:
    root = root.resolve()
    plan = read_json(root / "plan.json")
    tables: Row = {
        key: [] for key in ["attempts", "requests", "tools", "sessions", "messages", "calls", "tool_exposures"]
    }
    blocks: dict[tuple[str, str, str], Row] = {}
    schemas: dict[tuple[str, str, str], Row] = {}
    paths = sorted(
        {
            p.parent
            for group in ["trials", "probes", "debug", "recoveries"]
            for p in (root / group).glob("*/attempt-*/*")
            if p.name in {"wire", "evidence.json", "trial.json"}
        }
    )
    for path in paths:
        result = analyze_attempt(path, root, blocks, schemas)
        tables["attempts"].append(result.pop("attempt"))
        for key, values in result.items():
            tables[key].extend(values)
    for name, records in [("content_blocks", blocks), ("schemas", schemas)]:
        tables[name] = [
            {
                **{k: v for k, v in r.items() if k != "trials"},
                "attempt_count": len(r["trials"]),
                "exposure_bytes": r["bytes"] * r["exposures"],
            }
            for r in records.values()
        ]
        tables[name].sort(key=lambda r: r["exposure_bytes"], reverse=True)
    tool_counts = Counter(t["tool"] for t in tables["tools"])
    group_tool_counts = Counter((t["group"], t["tool"]) for t in tables["tools"])
    for schema in tables["schemas"]:
        schema["observed_invocations_in_group"] = group_tool_counts[(schema["group"], schema["tool"])]
    summary = {}
    for group in ["trials", "probes", "debug", "recoveries"]:
        attempts = [a for a in tables["attempts"] if a["group"] == group]
        rows = [r for r in tables["requests"] if r["group"] == group]
        summary[group] = {
            **request_summary(
                rows, terminal=all(a["terminal_evidence"] and not a["missing_wire_attempts"] for a in attempts)
            ),
            "attempts": len(attempts),
            "execution_seconds": quantiles(a["execution_seconds"] for a in attempts),
        }
    tables["by_purpose"] = grouped([r for r in tables["requests"] if r["group"] == "trials"], "purpose")
    tables["by_tool"] = []
    for name in sorted(tool_counts):
        rows = [t for t in tables["tools"] if t["tool"] == name and t["group"] == "trials"]
        tables["by_tool"].append(
            {
                "tool": name,
                "calls": len(rows),
                "duration_seconds": quantiles(t["duration_seconds"] for t in rows),
                "output_bytes": sum(t["output_bytes"] for t in rows),
                "errors": sum(t["status"] not in {"completed"} for t in rows),
                "same_operation_repeats": sum(t["same_operation_ordinal"] > 1 for t in rows),
            }
        )
    tables["summary"] = summary
    tables["metadata"] = {
        "version": 1,
        "plan_digest": plan.get("digest"),
        "planned_trials": len(plan.get("schedule", [])),
        "concurrency": plan.get("concurrency"),
        "source_commits": sorted(
            {v.get("source_receipt", {}).get("commit", "unknown") for v in plan.get("variants", {}).values()}
        ),
        "units": "Provider tokens; UTF-8 content/JSON bytes; seconds. Cache/reasoning are subsets.",
        "limits": [
            "No quota or currency inference",
            "Repeated content is not proven unnecessary",
            "Ordered duplicate matching is inferred by timestamp, not unique identity",
            "Prefix comparison measures whole-message equality, not provider cache keys",
            "Tool categories are heuristics; incomplete intervals are not fabricated",
            "Native context attribution is an estimator, not tokenizer ground truth",
            "Attempt rows retain all rewards; do not select best retries",
        ],
    }
    return tables


def write_analysis(result: Row, output: Path, source: Path) -> None:
    output = output.resolve()
    source = source.resolve()
    if output == source or source in output.parents or output in source.parents:
        raise ValueError("Analysis output must be outside the input evidence tree")
    output.mkdir(parents=True, exist_ok=True)
    atomic_json(output / "analysis.json", result)
    for name, rows in result.items():
        if not isinstance(rows, list) or not rows:
            continue
        columns = list(dict.fromkeys(key for row in rows for key in row))
        with (output / f"{name}.csv").open("w", newline="") as stream:
            writer = csv.DictWriter(stream, columns)
            writer.writeheader()
            writer.writerows(
                {k: json.dumps(v, ensure_ascii=False) if isinstance(v, (dict, list)) else v for k, v in row.items()}
                for row in rows
            )


def main() -> None:
    parser = argparse.ArgumentParser(
        description="只读分析 benchmark wire 与 Synergy rollout；输出不含提示词或工具内容。"
    )
    parser.add_argument("run", type=Path, help="包含 plan.json 的运行目录")
    parser.add_argument("--output", type=Path, required=True, help="证据目录之外的输出目录")
    args = parser.parse_args()
    if args.output.resolve() == args.run.resolve() or args.run.resolve() in args.output.resolve().parents:
        parser.error("--output must be outside the input evidence tree")
    result = analyze_run(args.run)
    write_analysis(result, args.output, args.run)
    print(json.dumps(result["summary"], ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
