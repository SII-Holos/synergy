from __future__ import annotations

import asyncio
import time
import uuid
from pathlib import Path
from typing import Any

from .bridge import content_text
from .config import ModelProfile
from .gateway import Gateway, read_ledger
from .lifecycle import error_trace
from .resources import Capacity, Request, ResourcePool, admission_for, shared_pool_options
from .storage import atomic_json, read_json
from .trial import BenchmarkTrial
from .usage import normalize_usage


def completed_usage_observed(records: list[dict[str, Any]]) -> bool:
    completed = [row for row in records if row.get("status") == "completed"]
    return bool(completed) and all(
        normalize_usage(row.get("usage"), row["protocol"])["total"] is not None for row in completed
    )


def completed_usage_reconciled(result: dict[str, Any], records: list[dict[str, Any]]) -> bool:
    completed = sum(row.get("status") == "completed" for row in records)
    reconciliation = result.get("reconciliation") or {}
    if not completed or reconciliation.get("status") == "mismatch":
        return False
    requests = reconciliation.get("requests") or {}
    if requests.get("mode") in {"request_id", "request_body_digest", "response_id"}:
        return (
            requests.get("status") != "mismatch" and len(requests.get("completed_usage_crosschecked", [])) == completed
        )
    return all(
        reconciliation.get("fields", {}).get(key, {}).get("status") == "matched" for key in ["input", "output", "total"]
    )


def prepare_items(plan: dict[str, Any]) -> list[dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    for item in plan["schedule"]:
        # All harness bundles are read-only mounts; SynergyAgent.install_spec is shared.
        result.setdefault(item["task"], item)
    return list(result.values())


def probe_observed(requests: list[dict[str, Any]], marker: str) -> bool:
    for request in requests:
        for message in request.get("messages", []):
            if message.get("role") == "tool" and marker in content_text(message.get("content")):
                return True
        inputs = request.get("input", [])
        if not isinstance(inputs, list):
            continue
        for item in inputs:
            if item.get("type") in {"function_call_output", "custom_tool_call_output"} and marker in content_text(
                item.get("output")
            ):
                return True
    return False


async def prewarm_plan(root: Path, plan: dict[str, Any]) -> dict[str, Any]:
    from .runner import audit_environment, progress, trial_configuration

    pool = ResourcePool(
        Capacity(**plan["host"]["capacity"]),
        plan["config"]["resources"]["build_concurrency"],
        admission=admission_for(root, plan),
        **shared_pool_options(root, plan),
    )
    started = time.time()
    records = []
    stamp = uuid.uuid4().hex[:8]

    async def prepare(index: int, item: dict[str, Any]) -> None:
        attempt = root / "prewarming" / f"{index:04d}" / f"attempt-{stamp}"
        attempt.mkdir(parents=True)
        atomic_json(attempt / "trial.json", item)
        row = {**item, "status": "queued", "queued_at": time.time()}
        trial_dir = None
        try:
            request = Request(**plan["tasks"][item["task"]]["resources"])
            async with pool.reserve(request):
                progress(f"prewarm: {item['task']} / {item['variant']}")
                row.update(status="running", started_at=time.time())
                variant = plan["variants"][item["variant"]]
                gateway = None
                if variant.get("model_profile"):
                    gateway = Gateway(ModelProfile.model_validate(variant["model_profile"]), attempt / "wire")
                    gateway.url = "http://host.docker.internal:1/v1"
                config, trial_dir, _ = trial_configuration(
                    root, plan, item, attempt, gateway=gateway, reference="BENCH_PREWARM_UNDISPATCHABLE"
                )
                trial = await BenchmarkTrial.create(config)
                assert isinstance(trial, BenchmarkTrial)
                await trial.prewarm()
                row["status"] = "completed"
        except BaseException as error:
            row.update(
                status="interrupted" if isinstance(error, asyncio.CancelledError) else "failed",
                error=type(error).__name__,
                error_trace=error_trace(error),
            )
            if not isinstance(error, Exception):
                raise
        finally:
            if trial_dir is not None:
                try:
                    await asyncio.to_thread(audit_environment, root, attempt / "environment.json", trial_dir / "agent")
                except Exception as error:
                    row.update(
                        status="failed", cleanup_error=type(error).__name__, cleanup_error_trace=error_trace(error)
                    )
            row["ended_at"] = time.time()
            atomic_json(attempt / "prewarm.json", row)
            records.append(row)

    async def check_budget() -> None:
        from .cache import enforce_budget

        if not plan.get("cache"):
            return
        settings = plan["config"]["resources"]
        await asyncio.to_thread(
            enforce_budget,
            Path(plan["cache"]),
            budget_bytes=int(settings.get("cache_budget_gib", 32) * 1024**3),
            min_free_bytes=int(settings.get("min_free_disk_gib", 20) * 1024**3),
        )

    failure = None
    failure_trace = None
    pending: set[asyncio.Task[None]] = set()
    try:
        items = prepare_items(plan)
        await check_budget()
        pending = {asyncio.create_task(prepare(index, item)) for index, item in enumerate(items)}
        while pending:
            done, pending = await asyncio.wait(pending, return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                task.result()
            await check_budget()
    except BaseException as error:
        failure = type(error).__name__
        failure_trace = error_trace(error)
        raise
    finally:
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)
        report = {
            "version": 1,
            "started_at": started,
            "ended_at": time.time(),
            "records": records,
            "error": failure,
            "error_trace": failure_trace,
            "status": "completed"
            if failure is None
            and len(records) == len(prepare_items(plan))
            and all(row["status"] == "completed" for row in records)
            else "failed",
        }
        atomic_json(root / "prewarm.json", report)
    if report["status"] != "completed":
        raise ValueError("Prewarming failed; inspect every retained preparation record before running tasks")
    return report


async def doctor_plan(
    root: Path,
    plan: dict[str, Any],
    *,
    cell: tuple[str, str] | None = None,
) -> dict[str, Any]:
    from .runner import (
        execute_trial,
        progress,
        reconcile_terminal,
        remove_environment,
        retain_failure,
        seal_attempt,
        startup_retryable,
        verify_terminal,
    )

    pool = ResourcePool(
        Capacity(**plan["host"]["capacity"]),
        plan["concurrency"],
        admission=admission_for(root, plan),
        **shared_pool_options(root, plan),
    )
    selected: dict[tuple[str, str], dict[str, Any]] = {}
    for item in plan["schedule"]:
        selected.setdefault((item["task"], item["variant"]), item)
    indexed = [(index, item) for index, (key, item) in enumerate(selected.items()) if cell is None or key == cell]
    if not indexed:
        raise ValueError("Unknown preflight cell")
    records = []

    async def probe(index: int, item: dict[str, Any]) -> None:
        directory = root / "probes" / f"{index:04d}"
        directory.mkdir(parents=True, exist_ok=True)
        previous = sorted(directory.glob("attempt-*"))
        for retained in previous:
            evidence_file = retained / "evidence.json"
            if not evidence_file.exists():
                recovered = await reconcile_terminal(root, retained, plan)
                if not recovered:
                    ownership = retained / "environment.json"
                    if ownership.exists():
                        await asyncio.to_thread(remove_environment, root, ownership)
                    retain_failure(
                        retained, RuntimeError("Preflight orchestrator interrupted before terminal evidence")
                    )
            verify_terminal(retained, read_json(evidence_file))
            ownership = retained / "environment.json"
            if ownership.exists():
                await asyncio.to_thread(remove_environment, root, ownership)
            if not (retained / "probe.json").exists() and (retained / "probe-intent.json").exists():
                intent = read_json(retained / "probe-intent.json")
                result = read_json(evidence_file)
                row = probe_result(item, retained, intent["marker"], intent["attempt"], result)
                atomic_json(retained / "probe.json", row)
                seal_attempt(retained, result)
                atomic_json(evidence_file, result)
        prior = sorted(directory.glob("attempt-*/probe.json"))
        if prior and read_json(prior[-1]).get("status") == "completed":
            records.append(read_json(prior[-1]))
            return
        first = len(list(directory.glob("attempt-*"))) + 1
        for retry in range(3):
            number = first + retry
            attempt = directory / f"attempt-{number:03d}"
            attempt.mkdir()
            atomic_json(attempt / "trial.json", {**item, "purpose": "preflight", "scoring_eligible": False})
            marker = "BENCHMARK_TOOL_" + uuid.uuid4().hex
            backoff = 2 ** (retry - 1) if retry else 0
            atomic_json(
                attempt / "probe-intent.json",
                {
                    "marker": marker,
                    "attempt": number,
                    "previous_attempt": number - 1 if number > 1 else None,
                    "reason": "retry_startup_timeout_before_model"
                    if retry
                    else "requested_preflight_after_failure"
                    if prior
                    else "initial_preflight",
                    "backoff_seconds": backoff,
                },
            )
            if backoff:
                await asyncio.sleep(backoff)
            async with pool.reserve(Request(**plan["tasks"][item["task"]]["resources"])):
                progress(f"doctor: real tool roundtrip {item['task']} / {item['variant']} / {attempt.name}")
                try:
                    result = await execute_trial(
                        root,
                        plan,
                        item,
                        attempt,
                        probe_instruction=(
                            "This is a benchmark connectivity check in a disposable environment. "
                            "Use your shell tool to run "
                            f"printf '{marker}\\n', read its output, and finish. "
                            "Do not solve the task's original instruction."
                        ),
                    )
                except Exception as error:
                    result = retain_failure(attempt, error)
                result["attempt_status"] = "completed"
                row = probe_result(item, attempt, marker, number, result)
                atomic_json(attempt / "probe.json", row)
                seal_attempt(attempt, result)
                atomic_json(attempt / "evidence.json", result)
            if row["status"] == "completed" or retry == 2 or not startup_retryable(attempt, result):
                records.append(row)
                return

    try:
        async with asyncio.TaskGroup() as group:
            for index, item in indexed:
                group.create_task(probe(index, item))
    finally:
        report = {
            "version": 1,
            "status": "completed"
            if len(records) == len(indexed) and all(row["status"] == "completed" for row in records)
            else "failed",
            "records": records,
        }
        destination = root if cell is None else root / "probes" / f"{indexed[0][0]:04d}"
        atomic_json(destination / "doctor.json", report)
    if report["status"] != "completed":
        raise ValueError("Harness/model connectivity failed; inspect retained preflight attempts before running tasks")
    return report


def probe_result(
    item: dict[str, Any], attempt: Path, marker: str, number: int, result: dict[str, Any]
) -> dict[str, Any]:
    requests = [read_json(file) for file in (attempt / "wire").glob("*/upstream.json")]
    tool = probe_observed(requests, marker)
    usage = result.get("wire_usage") or {}
    status = (
        "completed"
        if tool
        and (result.get("execution") or {}).get("outcome") == "completed"
        and usage.get("attempts", 0) > 0
        and completed_usage_observed(read_ledger(attempt / "wire"))
        and completed_usage_reconciled(result, read_ledger(attempt / "wire"))
        and result.get("evidence", {}).get("archive_valid") is True
        and (result.get("reconciliation") or {}).get("status") != "mismatch"
        else "failed"
    )
    return {
        **item,
        "status": status,
        "tool_roundtrip": tool,
        "attempt": number,
        "usage": usage,
        "completed_usage_observed": completed_usage_observed(read_ledger(attempt / "wire")),
        "completed_usage_reconciled": completed_usage_reconciled(result, read_ledger(attempt / "wire")),
        "ended_at": time.time(),
        "reconciliation": result.get("reconciliation"),
        "evidence": result.get("evidence"),
    }
