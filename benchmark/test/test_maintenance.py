from synergy_bench.maintenance import prepare_items, probe_observed


def test_prewarm_deduplicates_models_but_not_task_images():
    plan = {
        "schedule": [
            {"task": task, "variant": variant, "harness": "h", "model": variant, "repeat": 0}
            for task in ["t1", "t2"]
            for variant in ["one", "two"]
        ],
        "variants": {"one": {"artifact_id": "same"}, "two": {"artifact_id": "same"}},
    }
    assert len(prepare_items(plan)) == 2


def test_probe_requires_an_actual_tool_result_not_the_prompt_or_answer():
    marker = "probe-unique"
    assert not probe_observed(
        [{"messages": [{"role": "user", "content": marker}, {"role": "assistant", "content": marker}]}], marker
    )
    assert probe_observed([{"messages": [{"role": "tool", "content": marker}]}], marker)
    assert probe_observed([{"input": [{"type": "function_call_output", "call_id": "c", "output": marker}]}], marker)


def test_cancelled_auxiliary_call_does_not_hide_valid_completed_usage():
    from synergy_bench.maintenance import completed_usage_observed

    complete = {
        "id": "a",
        "protocol": "chat-completions",
        "status": "completed",
        "usage": {"prompt_tokens": 10, "completion_tokens": 2},
    }
    interrupted = {"id": "b", "protocol": "chat-completions", "status": "interrupted", "usage": None}
    assert completed_usage_observed([complete, interrupted])
    assert not completed_usage_observed([interrupted])
    assert not completed_usage_observed([{**complete, "usage": None}])


async def test_doctor_retains_each_infrastructure_failure_and_checks_other_cells(tmp_path, monkeypatch):
    import pytest

    from synergy_bench import runner
    from synergy_bench.maintenance import doctor_plan
    from synergy_bench.storage import read_json

    plan = {
        "host": {"capacity": {"cpus": 2, "memory_bytes": 200}},
        "concurrency": 2,
        "schedule": [{"task": name, "variant": "native"} for name in ["first", "second"]],
        "tasks": {name: {"resources": {"cpus": 1, "memory_bytes": 100}} for name in ["first", "second"]},
    }
    called = []

    async def broken(root, plan, item, attempt, **kwargs):
        called.append(item["task"])
        raise ValueError("startup failure")

    monkeypatch.setattr(runner, "execute_trial", broken)
    with pytest.raises(ValueError, match="connectivity failed"):
        await doctor_plan(tmp_path, plan)
    assert set(called) == {"first", "second"}
    assert len(read_json(tmp_path / "doctor.json")["records"]) == 2
    assert len(list(tmp_path.glob("probes/*/attempt-*/evidence.json"))) == 2


async def test_completed_probe_recovers_before_any_new_model_execution(tmp_path, monkeypatch):
    from synergy_bench import runner
    from synergy_bench.maintenance import doctor_plan
    from synergy_bench.storage import atomic_json, read_json

    root = tmp_path / "run-12345678"
    attempt = root / "probes/0000/attempt-001"
    project = "sb-12345678-probes-0000-attempt-001"
    atomic_json(attempt / "environment.json", {"project": project})
    atomic_json(attempt / project / "agent/execution.json", {"version": 3, "outcome": "completed"})
    (attempt / project / "agent/finished").write_text("done")
    atomic_json(attempt / "trial.json", {"task": "fixture", "variant": "native", "purpose": "preflight"})
    atomic_json(attempt / "probe.json", {"status": "completed", "attempt": 1, "tool_roundtrip": True})
    plan = {
        "host": {"capacity": {"cpus": 1, "memory_bytes": 100}},
        "concurrency": 1,
        "config": {"export_timeout_seconds": 1},
        "schedule": [{"task": "fixture", "variant": "native"}],
        "tasks": {"fixture": {"resources": {"cpus": 1, "memory_bytes": 100}}},
    }
    cleanup = []
    monkeypatch.setattr(runner, "remove_environment", lambda *args: cleanup.append(True))

    async def forbidden(*args, **kwargs):
        raise AssertionError("completed probe must not execute again")

    monkeypatch.setattr(runner, "execute_trial", forbidden)
    await doctor_plan(root, plan)
    await doctor_plan(root, plan)
    evidence = read_json(attempt / "evidence.json")
    assert evidence["attempt_status"] == "completed"
    assert "probe.json" in evidence["sidecar_files"]
    assert len(list(attempt.parent.glob("attempt-*"))) == 1
    assert cleanup
    runner.verify_terminal(attempt, evidence)


async def test_prewarm_records_all_setup_failures(tmp_path, monkeypatch):
    import pytest

    from synergy_bench import runner
    from synergy_bench.maintenance import prewarm_plan
    from synergy_bench.storage import read_json

    plan = {
        "host": {"capacity": {"cpus": 2, "memory_bytes": 200}},
        "config": {"resources": {"build_concurrency": 2}},
        "schedule": [{"task": task, "variant": "native"} for task in ["one", "two"]],
        "tasks": {task: {"resources": {"cpus": 1, "memory_bytes": 100}} for task in ["one", "two"]},
        "variants": {"native": {"artifact_id": "fixed"}},
    }
    monkeypatch.setattr("synergy_bench.maintenance.admission_for", lambda *args: lambda: True)

    def broken(*args, **kwargs):
        raise ValueError("invalid preparation")

    monkeypatch.setattr(runner, "trial_configuration", broken)
    with pytest.raises(ValueError, match="Prewarming failed"):
        await prewarm_plan(tmp_path, plan)
    rows = read_json(tmp_path / "prewarm.json")["records"]
    assert len(rows) == 2 and all(row["status"] == "failed" for row in rows)


def test_readonly_harness_bundles_share_the_same_task_image_prewarm():
    plan = {
        "schedule": [{"task": "fixture", "variant": name} for name in ["synergy", "codex", "pi"]],
        "variants": {name: {"artifact_id": name} for name in ["synergy", "codex", "pi"]},
    }
    assert len(prepare_items(plan)) == 1


async def test_budget_failure_after_prewarm_cannot_publish_completed_gate(tmp_path, monkeypatch):
    import pytest

    from synergy_bench import cache, runner
    from synergy_bench.maintenance import prewarm_plan
    from synergy_bench.storage import read_json

    plan = {
        "host": {"capacity": {"cpus": 1, "memory_bytes": 100}},
        "cache": str(tmp_path / "cache"),
        "config": {"resources": {"build_concurrency": 1}},
        "schedule": [{"task": "fixture", "variant": "native"}],
        "tasks": {"fixture": {"resources": {"cpus": 1, "memory_bytes": 100}}},
        "variants": {"native": {"artifact_id": "fixed"}},
    }
    monkeypatch.setattr("synergy_bench.maintenance.admission_for", lambda *args: lambda: True)
    monkeypatch.setattr("synergy_bench.maintenance.shared_pool_options", lambda *args: {})
    calls = []

    def budget(*args, **kwargs):
        calls.append(True)
        if len(calls) == 2:
            raise ValueError("protected budget exhausted")

    monkeypatch.setattr(cache, "enforce_budget", budget)

    async def prewarm(self):
        return None

    monkeypatch.setattr("synergy_bench.trial.BenchmarkTrial.prewarm", prewarm)

    async def create(config):
        from synergy_bench.trial import BenchmarkTrial

        return object.__new__(BenchmarkTrial)

    monkeypatch.setattr("synergy_bench.trial.BenchmarkTrial.create", create)
    monkeypatch.setattr(runner, "trial_configuration", lambda *args, **kwargs: (None, tmp_path / "trial", "trial"))
    monkeypatch.setattr(runner, "audit_environment", lambda *args: None)
    with pytest.raises(ValueError, match="budget exhausted"):
        await prewarm_plan(tmp_path, plan)
    report = read_json(tmp_path / "prewarm.json")
    assert report["status"] == "failed"
    assert report["records"][0]["status"] == "completed"
    assert report["error"] == "ValueError"


def test_completed_calls_need_independent_native_usage_confirmation():
    from synergy_bench.maintenance import completed_usage_reconciled

    calls = [{"status": "completed"}, {"status": "interrupted"}]
    assert not completed_usage_reconciled({}, calls)
    individual = {
        "reconciliation": {
            "status": "partial",
            "requests": {
                "mode": "request_id",
                "status": "matched",
                "completed_usage_crosschecked": ["completed"],
            },
        }
    }
    assert completed_usage_reconciled(individual, calls)
    assert not completed_usage_reconciled(individual, calls + [{"status": "completed"}])
    aggregate = {
        "reconciliation": {
            "status": "partial",
            "fields": {key: {"status": "matched"} for key in ["input", "output", "total"]},
            "requests": {"mode": "aggregate", "status": "unknown"},
        }
    }
    assert completed_usage_reconciled(aggregate, calls)
