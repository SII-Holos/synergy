import asyncio
import json
from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from synergy_bench.config import ExperimentConfig
from synergy_bench.runner import execute_plan
from synergy_bench.storage import atomic_json, read_json


def configuration(**changes):
    return {"version": 1, "suite": "fixture.json", "variants": {"a": {"model": "fixture/model"}}, **changes}


@pytest.mark.parametrize("value", [1, 48, 128, "auto"])
def test_concurrency_is_one_user_control(value):
    assert ExperimentConfig.model_validate(configuration(concurrency=value)).concurrency == value


@pytest.mark.parametrize("value", [True, 0, -1, 1.5, "48"])
def test_concurrency_requires_auto_or_a_positive_integer(value):
    with pytest.raises(ValidationError):
        ExperimentConfig.model_validate(configuration(concurrency=value))


@pytest.mark.parametrize(
    "retired",
    [
        {"preflight_timeout_seconds": 120},
        {"admission_policy": "continue"},
        {"resources": {"max_concurrency": 8}},
    ],
)
def test_retired_controls_are_rejected(retired):
    with pytest.raises(ValidationError, match="Extra inputs"):
        ExperimentConfig.model_validate(configuration(**retired))


async def test_all_48_cells_can_overlap_including_both_sides_of_each_pair(tmp_path):
    schedule = [{"pair": str(pair), "variant": side} for pair in range(24) for side in ["a", "b"]]
    plan = {"schedule": schedule, "concurrency": 48}
    entered = []
    ready = asyncio.Event()

    async def execute(item, attempt):
        entered.append(item)
        if len(entered) == 48:
            ready.set()
        await asyncio.wait_for(ready.wait(), 1)
        return {"execution": {"outcome": "completed"}, "verifier": {"rewards": {"reward": 0}}}

    await execute_plan(tmp_path, plan, execute)
    assert entered == schedule
    results = [read_json(path) for path in sorted(tmp_path.glob("trials/*/*/evidence.json"))]
    assert len(results) == 48
    assert all(result.get("infrastructure_error") is None for result in results)
    await execute_plan(tmp_path, plan, execute)
    assert len(entered) == 48


async def test_started_cells_are_never_replayed_even_without_terminal_evidence(tmp_path):
    schedule = [{"pair": "p", "variant": side} for side in ["a", "b", "c"]]
    atomic_json(tmp_path / "state.json", {"trials": {"0000": {"status": "running", "attempt": 1}}})
    atomic_json(tmp_path / "trials/0001/attempt-001/trial.json", schedule[1])
    called = []

    async def execute(item, attempt):
        called.append(item["variant"])
        return {"execution": {"outcome": "completed"}}

    await execute_plan(tmp_path, {"schedule": schedule, "concurrency": 2}, execute)
    assert called == ["c"]
    assert not list(tmp_path.glob("trials/*/attempt-002"))
    state = read_json(tmp_path / "state.json")
    assert state["trials"]["0000"]["status"] == "interrupted"
    assert state["trials"]["0001"]["status"] == "interrupted"


async def test_startup_timeout_is_retained_once_and_remaining_cells_continue(tmp_path):
    from synergy_bench.evidence import collect_evidence

    schedule = [{"pair": "p", "variant": side} for side in ["a", "b"]]
    called = []

    async def execute(item, attempt):
        called.append(item["variant"])
        result = collect_evidence(attempt / "native", {})
        result["execution"] = {
            "outcome": "timeout",
            "lifecycle": {"timeout_stage": "startup", "model_started_at": None, "marker_error": None},
        }
        result["evidence"]["archive_valid"] = True
        result["wire_usage"] = {"attempts": 0}
        return result

    await execute_plan(tmp_path, {"schedule": schedule, "concurrency": 1}, execute)
    assert called == ["a", "b"]
    assert len(list(tmp_path.glob("trials/*/attempt-*"))) == 2


def test_memory_budget_accounts_for_other_applications(tmp_path, monkeypatch):
    from synergy_bench import resources
    from synergy_bench.config import Resources

    gib = 1024**3
    memory = SimpleNamespace(total=64 * gib, available=30 * gib)
    memory._asdict = lambda: {"total": memory.total, "available": memory.available}
    monkeypatch.setattr(resources, "command", lambda *args, **kwargs: json.dumps({"NCPU": 28, "MemTotal": 64 * gib}))
    monkeypatch.setattr(resources.psutil, "virtual_memory", lambda: memory)
    monkeypatch.setattr(resources, "host_limits", lambda cpus, total, available: (cpus, total, available))
    host = resources.inspect_host(tmp_path, Resources(reserve_memory_fraction=0, reserve_memory_gib=4))
    assert host["capacity"]["memory_bytes"] == 26 * gib


@pytest.mark.parametrize("command", ["doctor", "prewarm"])
def test_removed_commands_cannot_launch_work(tmp_path, monkeypatch, command):
    from synergy_bench import cli

    monkeypatch.setattr("sys.argv", ["synergy-bench", command, str(tmp_path)])
    monkeypatch.setattr(cli, "resume", lambda *args, **kwargs: pytest.fail("retired command dispatched"))
    with pytest.raises(SystemExit) as error:
        cli.main()
    assert error.value.code == 2


async def test_48_cells_retain_failures_and_continue_without_retries(tmp_path):
    schedule = [{"pair": str(pair), "variant": side} for pair in range(24) for side in ["a", "b"]]
    called = []

    async def execute(item, attempt):
        called.append(item)
        index = int(attempt.parent.name)
        if index in {1, 9, 22}:
            raise RuntimeError("task-specific build, verifier or archive failure")
        return {"execution": {"outcome": "completed"}, "verifier": {"rewards": {"reward": index % 2}}}

    await execute_plan(tmp_path, {"schedule": schedule, "concurrency": 6}, execute)
    assert len(called) == 48
    assert len(list(tmp_path.glob("trials/*/attempt-*/evidence.json"))) == 48
    assert not list(tmp_path.glob("trials/*/attempt-002"))


async def test_unreadable_request_record_retains_unknown_cost_and_continues(tmp_path):
    from synergy_bench.report import report_data

    schedule = [{"pair": "p", "variant": side} for side in ["a", "b"]]
    plan = {"concurrency": 1, "result_version": 4, "schedule": schedule}
    atomic_json(tmp_path / "plan.json", plan)
    called = []

    async def execute(item, attempt):
        called.append(item["variant"])
        if item["variant"] == "a":
            atomic_json(
                attempt / "wire/known/request.json",
                {
                    "id": "known",
                    "status": "completed",
                    "protocol": "chat-completions",
                    "usage": {"prompt_tokens": 10, "completion_tokens": 2},
                },
            )
            broken = attempt / "wire/broken/request.json"
            broken.parent.mkdir(parents=True)
            broken.write_text('{"id":')
            raise ValueError("per-cell request evidence failed")
        return {"execution": {"outcome": "completed"}, "verifier": {"rewards": {"reward": 1}}}

    await execute_plan(tmp_path, plan, execute)
    assert called == ["a", "b"]
    report = report_data(tmp_path)
    first = report["scored"][0]
    assert first["known_tokens"] == 12
    assert first["tokens"] is None
    assert first["unknown_requests"] == 1
    assert first["evidence"]["valid"] is False
    assert "request_record_unreadable" in ";".join(first["evidence"]["issues"])
    assert report["scored"][1]["reward"] == 1
    assert (tmp_path / "trials/0000/attempt-001/wire/broken/request.json").read_text() == '{"id":'


@pytest.mark.parametrize("removed", [True, False])
async def test_cleanup_warning_continues_but_unresolved_resources_stop_dispatch(tmp_path, removed):
    from synergy_bench.runner import DispatchStopped

    schedule = [{"pair": "p", "variant": side} for side in ["a", "b"]]
    called = []

    async def execute(item, attempt):
        called.append(item["variant"])
        return {
            "execution": {"outcome": "completed"},
            "verifier": {"rewards": {"reward": 1}},
            "cleanup": {
                "status": "warning" if removed else "failed",
                "resources_removed": removed,
                "issues": ["environment-cleanup_failed"],
            },
        }

    if removed:
        await execute_plan(tmp_path, {"schedule": schedule, "concurrency": 1}, execute)
        assert called == ["a", "b"]
    else:
        with pytest.raises(DispatchStopped, match="resources"):
            await execute_plan(tmp_path, {"schedule": schedule, "concurrency": 1}, execute)
        assert called == ["a"]
    assert read_json(tmp_path / "trials/0000/attempt-001/evidence.json")["verifier"]["rewards"]["reward"] == 1


def test_cleanup_timeout_does_not_invalidate_verified_native_result(tmp_path, monkeypatch):
    import hashlib

    from synergy_bench import runner
    from synergy_bench.evidence import collect_evidence

    attempt = tmp_path / "attempt-001"
    trial = attempt / "native"
    agent = trial / "agent"
    atomic_json(attempt / "environment.json", {"project": "owned"})
    atomic_json(agent / "execution.json", {"outcome": "completed"})
    atomic_json(agent / "accounting.json", {"tokens": {"total": {"total": 10}}})
    atomic_json(agent / "export.json", {"status": "completed"})
    (agent / "rollout.zip").write_bytes(b"retained native archive")
    atomic_json(
        agent / "archive.json",
        {
            "valid": True,
            "recording": "complete",
            "bytes": 23,
            "sha256": hashlib.sha256(b"retained native archive").hexdigest(),
        },
    )
    atomic_json(agent / "environment-cleanup.json", {"status": "failed", "errors": ["TimeoutError"]})
    monkeypatch.setattr(runner, "remove_environment", lambda *args: None)
    monkeypatch.setattr(runner, "environment_projects", lambda *args: set())
    runner.audit_environment(tmp_path, attempt / "environment.json", agent)
    result = collect_evidence(trial, {"verifier_result": {"rewards": {"reward": 1}}})
    assert result["evidence"]["valid"], result["evidence"]
    assert result["cleanup"]["status"] == "warning"
    assert result["cleanup"]["resources_removed"] is True
    assert result["verifier"]["rewards"]["reward"] == 1


def test_cgroup_limits_and_live_headroom_bound_the_host_budget(tmp_path, monkeypatch):
    import os

    from synergy_bench.resources import host_limits

    monkeypatch.setattr(os, "sched_getaffinity", lambda pid: set(range(28)), raising=False)
    (tmp_path / "cpu.max").write_text("200000 100000")
    (tmp_path / "memory.max").write_text(str(12 * 1024**3))
    (tmp_path / "memory.current").write_text(str(4 * 1024**3))
    cpus, memory, available = host_limits(28, 64 * 1024**3, 30 * 1024**3, tmp_path)
    assert (cpus, memory, available) == (2, 12 * 1024**3, 8 * 1024**3)


async def test_report_failure_does_not_stop_formal_dispatch(tmp_path, monkeypatch):
    from synergy_bench import report

    schedule = [{"pair": "p", "variant": side} for side in ["a", "b"]]
    atomic_json(tmp_path / "plan.json", {"schedule": schedule})
    monkeypatch.setattr(report, "write_report", lambda *args: (_ for _ in ()).throw(OSError("derived report failed")))
    called = []

    async def execute(item, attempt):
        called.append(item)
        return {"execution": {"outcome": "completed"}}

    await execute_plan(tmp_path, {"schedule": schedule, "concurrency": 1}, execute)
    assert called == schedule
    assert len(list(tmp_path.glob("trials/*/attempt-*/evidence.json"))) == 2


@pytest.mark.parametrize("broken", ["missing", "malformed"])
async def test_resume_records_broken_terminal_and_dispatches_only_unstarted_cells(tmp_path, monkeypatch, broken):
    from synergy_bench import runner
    from synergy_bench.prepare import evaluator_identity
    from synergy_bench.storage import digest

    plan = {
        "version": 3,
        "result_version": 4,
        "evaluator": evaluator_identity(),
        "variants": {},
        "tasks": {},
        "config": {"version": 2, "platform": "linux/amd64"},
        "concurrency": 1,
        "schedule": [{"pair": "p", "variant": side} for side in ["a", "b"]],
    }
    plan["digest"] = digest(plan)
    atomic_json(tmp_path / "owner.json", {"kind": "synergy-benchmark-run", "version": 1})
    atomic_json(tmp_path / "plan.json", plan)
    atomic_json(tmp_path / "state.json", {"trials": {"0000": {"status": "running", "attempt": 1}}})
    attempt = tmp_path / "trials/0000/attempt-001"
    attempt.mkdir(parents=True)
    if broken == "malformed":
        (attempt / "evidence.json").write_text('{"incomplete":')
    called = []

    async def execute(root, plan, item, directory):
        called.append(item["variant"])
        return {"execution": {"outcome": "completed"}}

    monkeypatch.setattr(runner, "execute_trial", execute)
    await runner.resume(tmp_path)
    assert called == ["b"]
    assert read_json(attempt / "recovery.json")["issues"]
    assert not list(tmp_path.glob("trials/*/attempt-002"))
    assert len(read_json(tmp_path / "reports/current/report.json")["pairs"]) == 1


def test_full_local24_preset_contains_exactly_48_cells():
    from pathlib import Path

    from synergy_bench.runner import inspect_config

    config, suite, plan = inspect_config(Path(__file__).parents[1] / "configs/local24-boyue.yaml")
    assert len(suite.tasks) == 24
    assert len(plan["schedule"]) == 48
    assert len({item["pair"] for item in plan["schedule"]}) == 24
    assert config.concurrency == "auto"
    assert config.harnesses["baseline"].source.revision == "024dd683e091d9fce3d1d26b79b2e188ce636b52"
    assert config.harnesses["candidate"].source.revision == "ecf1426a47bf8bbd13b13bd9c47d28b39bdeff05"


async def test_failed_terminal_persistence_stops_new_dispatch(tmp_path, monkeypatch):
    from synergy_bench import runner

    original = runner.atomic_json
    called = []

    def write(path, value):
        if path.name == "evidence.json":
            raise OSError("injected terminal persistence failure")
        original(path, value)

    async def execute(item, attempt):
        called.append(item["variant"])
        return {"execution": {"outcome": "completed"}}

    monkeypatch.setattr(runner, "atomic_json", write)
    plan = {"concurrency": 1, "schedule": [{"pair": "p", "variant": side} for side in ["a", "b"]]}
    with pytest.raises(OSError, match="persistence"):
        await runner.execute_plan(tmp_path, plan, execute)
    assert called == ["a"]
    assert read_json(tmp_path / "state.json")["status"] == "blocked"


async def test_global_failure_drains_active_cells_without_starting_waiters(tmp_path):
    from synergy_bench.runner import DispatchStopped

    active = asyncio.Event()
    cancelled = asyncio.Event()
    called = []

    async def execute(item, attempt):
        called.append(item["variant"])
        if item["variant"] == "a":
            await active.wait()
            return {"cleanup": {"resources_removed": False}}
        active.set()
        try:
            await asyncio.Future()
        finally:
            cancelled.set()

    plan = {"concurrency": 2, "schedule": [{"pair": "p", "variant": side} for side in ["a", "b", "c"]]}
    with pytest.raises(DispatchStopped, match="resources"):
        await execute_plan(tmp_path, plan, execute)
    assert called == ["a", "b"]
    assert cancelled.is_set()
    assert read_json(tmp_path / "state.json")["trials"]["0001"]["status"] == "interrupted"


def test_report_lists_all_pairs_and_retains_missing_and_cleanup_warnings(tmp_path):
    import csv

    from synergy_bench.report import write_report

    schedule = [
        {"pair": str(pair), "task": str(pair), "variant": side, "harness": side, "model": "m", "repeat": 0}
        for pair in range(24)
        for side in ["a", "b"]
    ]
    atomic_json(tmp_path / "plan.json", {"version": 3, "result_version": 4, "schedule": schedule})
    atomic_json(
        tmp_path / "trials/0000/attempt-001/evidence.json",
        {
            "version": 4,
            "attempt_status": "completed",
            "execution": {"outcome": "completed"},
            "verifier": {"rewards": {"reward": 0}},
            "evidence": {"valid": True},
            "cleanup": {"status": "warning", "resources_removed": True, "issues": ["environment-cleanup_failed"]},
        },
    )
    report = write_report(tmp_path, tmp_path / "reports")
    assert len(report["pairs"]) == 24
    assert sum(len(pair["members"]) for pair in report["pairs"]) == 48
    assert len(report["missing"]) == 47
    assert report["pairs"][0]["members"][0]["reward"] == 0
    assert report["pairs"][0]["members"][0]["cleanup"]["status"] == "warning"
    assert report["pairs"][0]["members"][1]["reward"] is None
    assert report["usage"]["total_tokens"] is None
    assert (tmp_path / "reports/pairs.csv").read_text().count("\n") == 49
    with (tmp_path / "reports/pairs.csv").open() as stream:
        rows = list(csv.DictReader(stream))
    assert rows[0]["cleanup_status"] == "warning"
    assert rows[0]["cleanup_issues"] == "environment-cleanup_failed"
    assert rows[1]["failure_reason"] == "not_started"
