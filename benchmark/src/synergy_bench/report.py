from __future__ import annotations

import csv
import html
import math
import random
import statistics
from collections import defaultdict
from itertools import combinations
from pathlib import Path
from typing import Any

from .gateway import read_ledger
from .results import RESULT_VERSION, native_reward, require_current_plan
from .storage import atomic_json, digest, read_json
from .usage import FIELDS, aggregate_usage

# Wilson, E. B. (1927), Probable inference, the law of succession, and statistical inference.
# https://doi.org/10.1080/01621459.1927.10502953
# Paired task-cluster resampling follows Efron & Tibshirani (1993), An Introduction to the Bootstrap.
# https://doi.org/10.1201/9780429246593 . Repeats are not independent task observations.


def wilson(success: int, count: int) -> list[float] | None:
    if not count:
        return None
    z = statistics.NormalDist().inv_cdf(0.975)
    p = success / count
    divisor = 1 + z * z / count
    center = (p + z * z / (2 * count)) / divisor
    radius = z * math.sqrt(p * (1 - p) / count + z * z / (4 * count * count)) / divisor
    return [max(0, center - radius), min(1, center + radius)]


def percentile(values: list[float], fraction: float) -> float | None:
    if not values:
        return None
    values = sorted(values)
    index = (len(values) - 1) * fraction
    lower, upper = math.floor(index), math.ceil(index)
    return values[lower] + (values[upper] - values[lower]) * (index - lower)


def reward_of(value: dict[str, Any]) -> float | None:
    return native_reward((value.get("verifier") or {}).get("rewards"))


def quantiles(values: list[float]) -> dict[str, float | None]:
    return {name: percentile(values, q) for name, q in [("p50", 0.5), ("p90", 0.9), ("p95", 0.95)]}


def attempt_metrics(rows: list[dict[str, Any]]) -> dict[str, Any]:
    stages: dict[str, list[float]] = defaultdict(list)
    statuses: dict[str, int] = defaultdict(int)
    for row in rows:
        for name, records in row["stages"].items():
            stages[name].extend(record["wall_seconds"] for record in records if record.get("wall_seconds") is not None)
        for code, count in row["provider_statuses"].items():
            statuses[code] += count
    return {
        "count": len(rows),
        "known_tokens": sum(row["known_tokens"] for row in rows),
        "unknown_usage_attempts": sum(row["tokens"] is None for row in rows),
        "request_latency_seconds": quantiles([value for row in rows for value in row["request_latencies"]]),
        "first_byte_seconds": quantiles([value for row in rows for value in row["first_byte_latencies"]]),
        "queue_seconds": quantiles([row["queue_seconds"] for row in rows if row["queue_seconds"] is not None]),
        "stage_seconds": {name: quantiles(values) for name, values in stages.items()},
        "provider_statuses": dict(statuses),
        "wire_bytes": {
            field: {
                "known": sum(row["wire_bytes"][field]["known"] for row in rows),
                "unknown_requests": sum(row["wire_bytes"][field]["unknown_requests"] for row in rows),
            }
            for field in ["request", "response"]
        },
        "oom_events_observed": sum(
            row["resources"].get("observed_oom_events", row["resources"].get("oom_events")) or 0 for row in rows
        ),
        "oom_unknown_attempts": sum(row["resources"].get("oom_coverage") != "live_stream" for row in rows),
        **{
            key: max((row["resources"][key] for row in rows if row["resources"].get(key) is not None), default=None)
            for key in [
                "peak_memory_bytes",
                "peak_cpu_percent",
                "peak_recorder_rss_bytes",
                "peak_process_rss_sum_bytes",
            ]
        },
        "usage_fields": {
            field: {
                "known": sum(row["usage_fields"].get(field, {}).get("known", 0) for row in rows),
                "unknown_attempts": sum(row["usage_fields"].get(field, {}).get("total") is None for row in rows),
            }
            for field in FIELDS
        },
    }


def report_data(root: Path, *, category: str = "trials") -> dict[str, Any]:
    plan = read_json(root / "plan.json")
    require_current_plan(plan)
    schedule = plan.get("schedule", [])
    state = read_json(root / "state.json") if (root / "state.json").exists() else {}
    attempts = []
    by_trial: dict[str, list[dict[str, Any]]] = defaultdict(list)
    directories = list((root / category).glob("*/attempt-*"))
    if category == "trials":
        directories.extend((root / "debug").glob("*/attempt-*"))
    for directory in sorted(directories):
        purpose = "debug" if directory.parent.parent.name == "debug" else "task"
        trial_id = directory.parent.name
        item = schedule[int(trial_id)] if trial_id.isdecimal() and int(trial_id) < len(schedule) else {}
        if (directory / "trial.json").exists():
            item = read_json(directory / "trial.json")
        file = directory / "evidence.json"
        try:
            result = read_json(file) if file.exists() else None
        except (ValueError, OSError):
            result = {"evidence": {"valid": False, "issues": ["terminal_evidence_unreadable"]}}
        else:
            if result is not None and (not isinstance(result, dict) or result.get("version") != RESULT_VERSION):
                raise ValueError("Unsupported benchmark result version")
        result = result or {}
        scheduling = (
            read_json(directory / "scheduling.json") if (directory / "scheduling.json").exists() else {"events": []}
        )
        phase_queue: dict[str, float] = {}
        for event in scheduling["events"]:
            if "queue_seconds" in event:
                phase = event["phase"]
                phase_queue[phase] = phase_queue.get(phase, 0.0) + event["queue_seconds"]
        recovery = directory / "recovery.json"
        if recovery.exists():
            result["evidence"] = {
                **result.get("evidence", {}),
                "valid": False,
                "issues": [*result.get("evidence", {}).get("issues", []), *read_json(recovery)["issues"]],
            }
        wire = read_ledger(directory / "wire")
        wire_issues = [
            f"{row['id']}:{row[field]}"
            for row in wire
            for field in ["recording_error", "request_body_error"]
            if row.get(field)
        ]
        if wire_issues:
            result["evidence"] = {
                **result.get("evidence", {}),
                "valid": False,
                "issues": sorted(set(result.get("evidence", {}).get("issues", []) + wire_issues)),
            }
        accounting = result.get("wire_usage")
        if wire and (accounting is None or wire_issues):
            accounting = aggregate_usage(wire)
        native_only = accounting is None
        if native_only:
            accounting = result.get("accounting")
        pending = result.get("attempt_status") != "completed"
        usage_fields = {
            field: {**value, "total": None} if pending and isinstance(value, dict) else value
            for field, value in (accounting or {}).get("tokens", {}).items()
        }
        tokens = usage_fields.get("total", {})
        if not isinstance(tokens, dict):
            tokens = {}
        execution = result.get("execution") or {}
        variant = plan.get("variants", {}).get(item.get("variant"), {})
        task = plan.get("tasks", {}).get(item.get("task"), {})
        config = plan.get("config", {})
        policy_fields = [
            "startup_timeout_seconds",
            "request_idle_timeout_seconds",
            "cleanup_seconds",
            "export_timeout_seconds",
            "preparation_timeout_seconds",
            "resources",
        ]
        condition_fields = {
            "task_digest": task.get("digest"),
            "model": variant.get("model_profile"),
            "platform": plan.get("config", {}).get("platform"),
            "task_timeout_seconds": plan.get("task_timeout_seconds"),
            "result_version": plan.get("result_version"),
            "resources": task.get("resources"),
            "evaluator": plan.get("evaluator"),
            "concurrency": plan.get("concurrency"),
            "seed": config.get("seed"),
            "docker": plan.get("host", {}).get("docker"),
            "capacity": plan.get("host", {}).get("capacity"),
            "execution_policy": {key: config[key] for key in policy_fields}
            if all(key in config for key in policy_fields)
            else None,
        }
        required = [
            "task_digest",
            "model",
            "platform",
            "result_version",
            "task_timeout_seconds",
            "resources",
            "evaluator",
            "concurrency",
            "seed",
            "docker",
            "capacity",
            "execution_policy",
        ]
        missing_conditions = [key for key in required if condition_fields[key] is None]
        pairing_exclusions = (
            ["cancelled_execution"] if execution.get("interrupted") or execution.get("outcome") == "cancelled" else []
        )
        if not result.get("evidence", {}).get("valid") or result.get("infrastructure_error"):
            pairing_exclusions.append("invalid_evidence")
        if pending:
            pairing_exclusions.append("nonterminal_execution")
        conditions = None if missing_conditions or pairing_exclusions else digest(condition_fields)
        cleanup = result.get("cleanup", {"status": "unknown", "resources_removed": None, "issues": []})
        failure = result.get("infrastructure_error") or {}
        issues = result.get("evidence", {}).get("issues", [])
        reason = failure.get("message") or failure.get("exception_message") or failure.get("type")
        if not reason and execution.get("outcome") not in {None, "completed"}:
            reason = execution["outcome"]
        if not reason and issues:
            reason = ";".join(issues)
        if not reason and reward_of(result) == 0:
            reason = "native_reward_0"
        row = {
            **item,
            "purpose": purpose,
            "trial": trial_id,
            "attempt": directory.name,
            "result_version": result.get("version"),
            "terminal": result.get("attempt_status") == "completed",
            "status": state.get("trials", {}).get(trial_id, {}).get("status", "unknown"),
            "dispatch_sequence": item.get("dispatch_sequence"),
            "outcome": execution.get("outcome", "unknown"),
            "reward": reward_of(result),
            "raw_rewards": (result.get("verifier") or {}).get("rewards"),
            "cleanup": cleanup,
            "cleanup_status": cleanup["status"],
            "resources_removed": cleanup["resources_removed"],
            "cleanup_issues": ";".join(cleanup["issues"]),
            "failure_reason": reason,
            "evidence_issues": ";".join(issues),
            "grading": result.get("grading", {"execution": "unknown", "functional_tests": "unknown"}),
            "evidence": result.get("evidence", {"valid": False, "issues": ["terminal_evidence_missing"]}),
            "infrastructure_error": result.get("infrastructure_error"),
            "model_started": bool((accounting or {}).get("attempts") or wire)
            if not native_only
            else bool(execution or (accounting or {}).get("attempts")),
            "tokens": tokens.get("total"),
            "known_tokens": tokens.get("known", tokens.get("total", 0)) or 0,
            "unknown_requests": tokens.get("unknown"),
            "native_only": native_only,
            "wall_seconds": execution["wall_ms"] / 1000 if execution.get("wall_ms") is not None else None,
            "conditions": conditions,
            "missing_conditions": missing_conditions,
            "pairing_exclusions": pairing_exclusions,
            "resources": result.get("resources", {}),
            "stages": result.get("stages", {}),
            "queue_seconds": (item.get("queue_seconds") or 0.0) + sum(phase_queue.values()),
            "stage_queue_seconds": phase_queue,
            "scheduling": scheduling,
            "wire_usage": accounting if not native_only else None,
            "request_count": (accounting or {}).get("attempts"),
            "usage_fields": usage_fields,
            **{field + "_tokens": usage_fields.get(field, {}).get("total") for field in FIELDS if field != "total"},
            **{
                "known_" + field + "_tokens": usage_fields.get(field, {}).get("known")
                for field in FIELDS
                if field != "total"
            },
            "comparable_usage": not native_only
            and tokens.get("total") is not None
            and (result.get("reconciliation") or {}).get("status") != "mismatch"
            and (result.get("reconciliation") or {}).get("requests", {}).get("status") == "matched"
            and (result.get("reconciliation") or {}).get("requests", {}).get("coverage") == 1
            and all(
                (result.get("reconciliation") or {}).get("fields", {}).get(field, {}).get("status") == "matched"
                for field in ["input", "output", "total"]
            ),
            "provider_statuses": dict(
                (str(status), sum(record.get("http_status") == status for record in wire))
                for status in {record.get("http_status") for record in wire}
            ),
            "wire_bytes": {
                field: {
                    "known": sum(record.get(field + "_bytes") or 0 for record in wire),
                    "unknown_requests": sum(record.get(field + "_bytes") is None for record in wire)
                    + max(0, ((accounting or {}).get("attempts") or int(bool(execution))) - len(wire)),
                }
                for field in ["request", "response"]
            },
            "request_field_bytes": {
                key: sum(record.get("request_field_bytes", {}).get(key, 0) for record in wire)
                for key in sorted({key for record in wire for key in record.get("request_field_bytes", {})})
            },
            "request_latencies": [
                record["ended_at"] - record["started_at"]
                for record in wire
                if record.get("ended_at") and record.get("started_at")
            ],
            "first_byte_latencies": [
                record["first_byte_at"] - record["started_at"]
                for record in wire
                if record.get("first_byte_at") is not None and record.get("started_at") is not None
            ],
            "reconciliation": result.get("reconciliation"),
        }
        attempts.append(row)
        if purpose == "task":
            by_trial[trial_id].append(row)
    scored = []
    for rows in by_trial.values():
        scored.append(rows[0])
    groups: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    for row in scored:
        groups[(row.get("harness", row.get("variant", "unknown")), row.get("model", "unknown"))].append(row)
    planned_groups: dict[tuple[str, str], int] = defaultdict(int)
    for row in schedule:
        key = (row.get("harness", row.get("variant", "unknown")), row.get("model", "unknown"))
        planned_groups[key] += 1
        groups.setdefault(key, [])
    summaries = []
    for (harness, model), rows in sorted(groups.items()):
        known = [row for row in rows if row["reward"] is not None]
        successes = sum(row["reward"] >= 1 for row in known)
        durations = [row["wall_seconds"] for row in rows if row["wall_seconds"] is not None]
        count = max(planned_groups[(harness, model)], len(rows))
        unknown_rewards = count - len(known)
        summaries.append(
            {
                "harness": harness,
                "model": model,
                "planned": count,
                "scored": len(rows),
                "missing": count - len(rows),
                "rewards_observed": len(known),
                "successes": successes,
                "success_rate": successes / count if count and not unknown_rewards else None,
                "success_bounds": [successes / count, (successes + unknown_rewards) / count] if count else None,
                "observed_success_rate": successes / len(known) if known else None,
                "success_ci95": wilson(successes, len(known)),
                "ci_population": "observed_native_rewards",
                "unknown_rewards": unknown_rewards,
                "raw_reward_mean": statistics.mean(row["reward"] for row in known) if known else None,
                "all_attempts": attempt_metrics(
                    [
                        row
                        for row in attempts
                        if row.get("harness", row.get("variant", "unknown")) == harness
                        and row.get("model", "unknown") == model
                    ]
                ),
                "latency_seconds": {
                    name: percentile(durations, q) for name, q in [("p50", 0.5), ("p90", 0.9), ("p95", 0.95)]
                },
            }
        )
    unknown = sum(row["tokens"] is None for row in attempts)
    known_tokens = sum(row["known_tokens"] for row in attempts)
    planned = {f"{index:04d}" for index in range(len(schedule))}
    missing = [
        {"trial": trial_id, **schedule[int(trial_id)], "reason": "no_attempt"}
        for trial_id in sorted(planned - by_trial.keys())
    ]
    by_id = {row["trial"]: row for row in scored}
    pairs: dict[str, dict[str, Any]] = {}
    for index, item in enumerate(schedule):
        pair_id = item.get("pair") or digest([item.get("task"), item.get("model"), item.get("repeat")])
        pair = pairs.setdefault(
            pair_id,
            {
                "pair": pair_id,
                "task": item.get("task"),
                "model": item.get("model"),
                "repeat": item.get("repeat"),
                "members": [],
            },
        )
        trial_id = f"{index:04d}"
        member = by_id.get(
            trial_id,
            {
                **item,
                "trial": trial_id,
                "status": "not_started",
                "reward": None,
                "tokens": None,
                "known_tokens": None,
                "conditions": None,
                "pairing_exclusions": ["not_started"],
                "failure_reason": "not_started",
                "cleanup_status": "unknown",
            },
        )
        pair["members"].append(member)
    comparisons = []
    for (left_key, left), (right_key, right) in combinations(sorted(groups.items()), 2):
        if left_key[1] == right_key[1]:
            comparisons.append(
                {
                    "left": left_key[0],
                    "right": right_key[0],
                    "model": left_key[1],
                    **paired_compare(left, right, seed=plan.get("config", {}).get("seed", 0)),
                }
            )
    prior_costs = plan.get("config", {}).get("prior_costs", [])
    return {
        "version": 4,
        "prior_costs": prior_costs,
        "family_known_tokens": known_tokens + sum(row["known_tokens"] for row in prior_costs),
        "family_observed_requests": sum(row.get("request_count") or 0 for row in attempts)
        + sum(row["observed_requests"] for row in prior_costs),
        "analysis_seed": plan.get("config", {}).get("seed", 0),
        "status": state.get("status", "unknown"),
        "stop_reason": state.get("stop_reason"),
        "pairs": list(pairs.values()),
        "comparisons": comparisons,
        "scoring_policy": "first_dispatch",
        "planned": len(schedule),
        "completed": sum(row["terminal"] for row in scored),
        "attempts": len(attempts),
        "missing": missing,
        "groups": summaries,
        "scored": scored,
        "all_attempts": attempts,
        "performance": attempt_metrics(attempts),
        "usage": {
            "known_tokens": known_tokens,
            "total_tokens": None if unknown else known_tokens,
            "unknown_attempts": unknown,
            "native_only_attempts": sum(row["native_only"] for row in attempts),
            "coverage": (len(attempts) - unknown) / len(attempts) if attempts else None,
            "fields": {
                field: {
                    "known": sum(
                        row["usage_fields"].get(field, {}).get("known", row["usage_fields"].get(field, {}).get("total"))
                        or 0
                        for row in attempts
                    ),
                    "unknown_attempts": sum(
                        row["usage_fields"].get(field, {}).get("total") is None for row in attempts
                    ),
                }
                for field in FIELDS
            },
        },
        "currency_cost": None,
        "cost_reason": "No versioned price source declared",
    }


def paired_compare(
    left: list[dict[str, Any]], right: list[dict[str, Any]], *, seed: int = 0, samples: int = 10000
) -> dict[str, Any]:
    if samples < 1:
        raise ValueError("Bootstrap samples must be positive")

    def keyed(rows: list[dict[str, Any]]) -> dict[tuple[Any, ...], dict[str, Any]]:
        result = {}
        for row in rows:
            if row.get("conditions") is None:
                continue
            key = (row["model"], row["task"], row["repeat"], row["conditions"])
            if key in result:
                raise ValueError("Duplicate paired sample; select exactly one harness per side")
            result[key] = row
        return result

    a, b = keyed(left), keyed(right)
    pairs = sorted(a.keys() & b.keys())
    clusters: dict[str, list[tuple[dict[str, Any], dict[str, Any]]]] = defaultdict(list)
    for key in pairs:
        clusters[key[1]].append((a[key], b[key]))

    def difference(field: str) -> dict[str, Any] | None:
        if field == "tokens" and any(
            not row.get("comparable_usage", False) for key in pairs for row in [a[key], b[key]]
        ):
            return None
        if not pairs or any(a[key].get(field) is None or b[key].get(field) is None for key in pairs):
            return None
        mean = statistics.mean(b[key][field] - a[key][field] for key in pairs)
        if len(clusters) < 2:
            return {"mean": mean, "ci95": None, "reason": "fewer_than_two_tasks"}
        rng = random.Random(seed)
        names = sorted(clusters)
        values = []
        for _ in range(samples):
            draw = [item for name in rng.choices(names, k=len(names)) for item in clusters[name]]
            values.append(statistics.mean(two[field] - one[field] for one, two in draw))
        return {"mean": mean, "ci95": [percentile(values, 0.025), percentile(values, 0.975)]}

    return {
        "version": 1,
        "direction": "right_minus_left",
        "seed": seed,
        "bootstrap_samples": samples,
        "pairs": len(pairs),
        "unpairable_left": [row for row in left if row.get("conditions") is None],
        "unpairable_right": [row for row in right if row.get("conditions") is None],
        "task_clusters": len(clusters),
        "missing_left": [list(key) for key in sorted(b.keys() - a.keys())],
        "missing_right": [list(key) for key in sorted(a.keys() - b.keys())],
        "reward_difference": difference("reward"),
        "token_difference": difference("tokens"),
    }


def family_report(root: Path, related: list[Path]) -> dict[str, Any]:
    roots = [root.resolve(), *(path.resolve() for path in related)]
    if len(set(roots)) != len(roots):
        raise ValueError("A run cannot be counted twice in an experiment family")
    reports = [report_data(path) for path in roots]
    value = reports[0]
    attempts = [
        {**row, "run": path.name, "scoring_run": index == 0}
        for index, (path, report) in enumerate(zip(roots, reports, strict=True))
        for row in report["all_attempts"]
    ]
    value.update(
        all_attempts=attempts,
        attempts=len(attempts),
        performance=attempt_metrics(attempts),
        scoring_run=roots[0].name,
        included_runs=[
            {"run": path.name, "evaluator": read_json(path / "plan.json").get("evaluator")} for path in roots
        ],
    )
    unknown = sum(report["usage"]["unknown_attempts"] for report in reports)
    known = sum(report["usage"]["known_tokens"] for report in reports)
    prior_by_digest: dict[str, dict[str, Any]] = {}
    for report in reports:
        for cost in report["prior_costs"]:
            if cost["sha256"] in prior_by_digest and prior_by_digest[cost["sha256"]] != cost:
                raise ValueError("Conflicting sealed prior cost summary")
            prior_by_digest[cost["sha256"]] = cost
    value["prior_costs"] = list(prior_by_digest.values())
    value["family_known_tokens"] = known + sum(cost["known_tokens"] for cost in value["prior_costs"])
    value["family_observed_requests"] = sum(row.get("request_count") or 0 for row in attempts) + sum(
        cost["observed_requests"] for cost in value["prior_costs"]
    )
    value["usage"] = {
        "known_tokens": known,
        "total_tokens": None if unknown else known,
        "unknown_attempts": unknown,
        "coverage": (len(attempts) - unknown) / len(attempts) if attempts else None,
        "fields": value["performance"]["usage_fields"],
    }
    for group in value["groups"]:
        group["all_attempts"] = attempt_metrics(
            [
                row
                for row in attempts
                if row.get("harness", row.get("variant")) == group["harness"] and row.get("model") == group["model"]
            ]
        )
    return value


def write_report(root: Path, destination: Path, *, related: list[Path] | None = None) -> dict[str, Any]:
    value = family_report(root, related) if related else report_data(root)
    destination.mkdir(parents=True, exist_ok=True)
    atomic_json(destination / "report.json", value)
    columns = [
        "run",
        "purpose",
        "trial",
        "attempt",
        "harness",
        "model",
        "task",
        "repeat",
        "terminal",
        "outcome",
        "status",
        "dispatch_sequence",
        "failure_reason",
        "evidence_issues",
        "cleanup_status",
        "resources_removed",
        "cleanup_issues",
        "pairing_exclusions",
        "reward",
        "tokens",
        "known_tokens",
        "unknown_requests",
        "native_only",
        "wall_seconds",
        "queue_seconds",
        *[field + "_tokens" for field in FIELDS if field != "total"],
        *["known_" + field + "_tokens" for field in FIELDS if field != "total"],
    ]
    with (destination / "attempts.csv").open("w", newline="") as file:
        writer = csv.DictWriter(file, fieldnames=columns, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(
            {**row, "pairing_exclusions": ";".join(row["pairing_exclusions"])} for row in value["all_attempts"]
        )

    paired_rows = [member for pair in value["pairs"] for member in pair["members"]]
    with (destination / "pairs.csv").open("w", newline="") as file:
        writer = csv.DictWriter(file, fieldnames=columns, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(
            {**row, "pairing_exclusions": ";".join(row.get("pairing_exclusions", []))} for row in paired_rows
        )

    def cell(item: Any) -> str:
        return html.escape("未知" if item is None else str(item))

    rows = "".join(
        "<tr>" + "".join("<td>" + cell(row.get(key)) + "</td>" for key in columns) + "</tr>"
        for row in value["all_attempts"]
    )
    pair_columns = [
        "task",
        "harness",
        "status",
        "failure_reason",
        "cleanup_status",
        "reward",
        "tokens",
        "known_tokens",
        "wall_seconds",
        "pairing_exclusions",
    ]
    pair_rows = "".join(
        "<tr>" + "".join("<td>" + cell(row.get(key)) + "</td>" for key in pair_columns) + "</tr>" for row in paired_rows
    )
    group_rows = "".join(
        "<tr>"
        + "".join(
            "<td>" + cell(row.get(key)) + "</td>"
            for key in ["harness", "model", "scored", "successes", "unknown_rewards", "success_ci95"]
        )
        + "</tr>"
        for row in value["groups"]
    )
    body = f"""<!doctype html><html lang="zh-CN">
<meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Benchmark 实验报告</title>
<style>
body{{font:16px system-ui;max-width:1400px;margin:40px auto;padding:0 24px;color:#202020;background:#fafafa}}
table{{border-collapse:collapse;width:100%;font-size:13px}}
th,td{{text-align:left;padding:8px;border-bottom:1px solid #ccc}}.scroll{{overflow:auto}}p{{line-height:1.7}}
</style><h1>Benchmark 实验报告</h1>
<p>计划 {value["planned"]}；完成 {value["completed"]}；全部尝试 {value["attempts"]}。</p>
<p>全部尝试已知 token 下界 {value["usage"]["known_tokens"]}；
精确总量 {cell(value["usage"]["total_tokens"])}；用量未知尝试 {value["usage"]["unknown_attempts"]}。</p>
<p>含封存历史的已观察请求 {value["family_observed_requests"]}；
已知 token 下界 {value["family_known_tokens"]}。历史缺失用量与未确认派发保留在 report.json 的 prior_costs 中，
不把下界当作精确累计总量。</p>
<p>评分规则：每个计划单元的首次派发；准备失败和中断保持原记录。
已启动项不重跑，未知评分不补零；封存历史成本不进入本次评分。</p>
<p>完整成功率仅在所有计划单元的原生 reward 已知时给出，其他情况给出上下界。
95% Wilson 区间只描述已观测 reward；重复之间存在任务相关性，横向差值采用按任务聚类的配对 bootstrap。
原始 reward 不证明功能测试启动；未知状态保持未知。费用未声明价格来源，不换算货币。</p>
<h2>分组结果</h2><table><tr><th>Harness</th><th>模型</th><th>评分数</th>
<th>成功数</th><th>未知 reward</th><th>已观测成功率 95% 区间</th></tr>{group_rows}</table>
<h2>逐题配对</h2><div class="scroll"><table><tr>
{"".join("<th>" + cell(key) + "</th>" for key in pair_columns)}</tr>{pair_rows}</table></div>
<h2>全部尝试</h2><div class="scroll"><table><tr>
{"".join("<th>" + cell(key) + "</th>" for key in columns)}</tr>{rows}</table></div>
<p>分析 seed：{value["analysis_seed"]}。
分阶段记录、归档完整性、缺失清单与原始 reward 见同目录 report.json；表格见 attempts.csv。</p></html>"""
    (destination / "index.html").write_text(body)
    return value
