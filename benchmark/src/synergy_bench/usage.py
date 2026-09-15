from __future__ import annotations

from collections.abc import Iterable
from typing import Any

FIELDS = ("input", "output", "total", "cacheRead", "cacheWrite", "reasoning")


def count(value: Any) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None


def normalize_usage(usage: dict[str, Any] | None, protocol: str) -> dict[str, int | None]:
    value = usage or {}
    cache_write = None
    if protocol == "pi":
        parts = [count(value.get(key)) for key in ["input", "cacheRead", "cacheWrite"]]
        inp = sum(part for part in parts if part is not None) if all(part is not None for part in parts) else None
        out = count(value.get("output"))
        cache = count(value.get("cacheRead"))
        cache_write = count(value.get("cacheWrite"))
        reasoning = count(value.get("reasoning"))
    elif protocol in {"chat-completions", "responses"}:
        prefix, suffix = ("prompt", "completion") if protocol == "chat-completions" else ("input", "output")
        inp, out = count(value.get(f"{prefix}_tokens")), count(value.get(f"{suffix}_tokens"))
        input_details, output_details = value.get(f"{prefix}_tokens_details"), value.get(f"{suffix}_tokens_details")
        cache = count(input_details.get("cached_tokens")) if isinstance(input_details, dict) else None
        if cache is None:
            cache = count(value.get("prompt_cache_hit_tokens"))
        reasoning = count(output_details.get("reasoning_tokens")) if isinstance(output_details, dict) else None
    else:
        raise ValueError(f"Unknown usage protocol: {protocol}")
    if inp is not None and cache is not None and cache > inp:
        cache = None
    if out is not None and reasoning is not None and reasoning > out:
        reasoning = None
    return {
        "input": inp,
        "output": out,
        "total": inp + out if inp is not None and out is not None else None,
        "cacheRead": cache,
        "cacheWrite": cache_write,
        "reasoning": reasoning,
    }


def aggregate_usage(records: Iterable[dict[str, Any]]) -> dict[str, Any]:
    attempts: dict[str, dict[str, Any]] = {}
    for record in records:
        identity = record.get("id")
        if not isinstance(identity, str) or not identity:
            raise ValueError("Request ledger entry has no attempt identity")
        previous = attempts.get(identity)
        if previous and previous.get("usage") is not None:
            if record.get("usage") is not None and record["usage"] != previous["usage"]:
                raise ValueError("Conflicting terminal usage for the same request")
            continue
        attempts[identity] = record
    normalized = [normalize_usage(row.get("usage"), row["protocol"]) for row in attempts.values()]
    bounds = [
        normalize_usage(row.get("usage") or row.get("observed_usage"), row["protocol"]) for row in attempts.values()
    ]
    tokens = {}
    for field in FIELDS:
        known = sum(value for row in bounds if (value := row[field]) is not None)
        if field == "total":
            known = sum((row["input"] or 0) + (row["output"] or 0) for row in bounds)
        unknown = sum(row[field] is None for row in normalized)
        tokens[field] = {"known": known, "unknown": unknown, "total": None if unknown else known}
    return {"version": 1, "attempts": len(attempts), "tokens": tokens}
