from synergy_bench.maintenance import prepare_items, probe_observed


def test_tool_roundtrip_cannot_admit_invalid_evidence_or_infrastructure_failure(tmp_path):
    from synergy_bench.maintenance import probe_result
    from synergy_bench.storage import atomic_json

    marker = "observed-tool-output"
    atomic_json(
        tmp_path / "wire/completed/upstream.json",
        {"messages": [{"role": "tool", "content": marker}]},
    )
    atomic_json(
        tmp_path / "wire/completed/request.json",
        {
            "id": "completed",
            "protocol": "chat-completions",
            "status": "completed",
            "usage": {"prompt_tokens": 10, "completion_tokens": 2},
        },
    )
    atomic_json(
        tmp_path / "wire/interrupted/request.json",
        {"id": "interrupted", "protocol": "chat-completions", "status": "interrupted", "usage": None},
    )
    result = {
        "execution": {"outcome": "completed"},
        "wire_usage": {"attempts": 2},
        "reconciliation": {
            "status": "partial",
            "requests": {
                "mode": "response_id",
                "status": "partial",
                "completed_usage_crosschecked": ["completed"],
            },
        },
        "evidence": {"valid": True, "archive_valid": True, "recording": "partial", "usage": "partial"},
    }
    row = probe_result({}, tmp_path, marker, 1, result)
    assert row["status"] == "completed"
    assert row["evidence"]["recording"] == "partial"
    for issue in ["environment-cleanup_failed", "credential-cleanup_failed", "execution_truncated", "export_failed"]:
        row = probe_result(
            {},
            tmp_path,
            marker,
            1,
            {**result, "evidence": {**result["evidence"], "valid": False, "issues": [issue]}},
        )
        assert row["status"] == "failed"
        assert row["evidence"]["issues"] == [issue]
    assert (
        probe_result({}, tmp_path, marker, 1, {**result, "infrastructure_error": {"type": "RuntimeError"}})["status"]
        == "failed"
    )


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
    assert all(row["error_trace"][0]["frames"][-1]["function"] == "broken" for row in rows)


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


async def test_doctor_bounds_startup_retries_and_preserves_each_terminal_attempt(tmp_path, monkeypatch):
    import pytest

    from synergy_bench import runner
    from synergy_bench.maintenance import doctor_plan
    from synergy_bench.storage import read_json

    plan = {
        "host": {"capacity": {"cpus": 1, "memory_bytes": 100}},
        "concurrency": 1,
        "schedule": [{"task": "fixture", "variant": "native"}],
        "tasks": {"fixture": {"resources": {"cpus": 1, "memory_bytes": 100}}},
    }

    async def timeout(root, plan, item, attempt, **kwargs):
        from synergy_bench.evidence import collect_evidence

        empty = collect_evidence(attempt / "native", {}, verification_required=False)
        return {
            **empty,
            "execution": {
                "outcome": "timeout",
                "lifecycle": {"timeout_stage": "startup", "model_started_at": None, "marker_error": None},
            },
            "wire_usage": {"attempts": 0},
            "evidence": {**empty["evidence"], "archive_valid": True},
        }

    monkeypatch.setattr(runner, "execute_trial", timeout)
    with pytest.raises(ValueError, match="connectivity failed"):
        await doctor_plan(tmp_path, plan)
    attempts = sorted(tmp_path.glob("probes/0000/attempt-*"))
    assert len(attempts) == 3
    for index, attempt in enumerate(attempts):
        evidence = read_json(attempt / "evidence.json")
        assert evidence["attempt_status"] == "completed"
        assert evidence["execution"]["outcome"] == "timeout"
        runner.verify_terminal(attempt, evidence)
        intent = read_json(attempt / "probe-intent.json")
        assert intent["backoff_seconds"] == (0 if index == 0 else 2 ** (index - 1))
        assert intent["reason"] == ("initial_preflight" if index == 0 else "retry_startup_timeout_before_model")
    assert read_json(tmp_path / "doctor.json")["records"][0]["attempt"] == 3


def test_probe_retry_requires_positive_startup_evidence_and_no_possible_request(tmp_path):
    from synergy_bench.runner import startup_retryable
    from synergy_bench.storage import atomic_json

    result = {
        "execution": {
            "outcome": "timeout",
            "lifecycle": {"timeout_stage": "startup", "model_started_at": None, "marker_error": None},
        },
        "wire_usage": {"attempts": 0},
        "evidence": {"archive_valid": True},
    }
    assert startup_retryable(tmp_path, result)
    assert not startup_retryable(tmp_path, {**result, "execution": {"outcome": "timeout"}})
    assert not startup_retryable(tmp_path, {**result, "wire_usage": {"attempts": 1}})
    assert not startup_retryable(tmp_path, {**result, "evidence": {"archive_valid": False}})
    assert not startup_retryable(
        tmp_path, {**result, "evidence": {"archive_valid": True, "issues": ["environment-cleanup_failed"]}}
    )
    for lifecycle in [
        {"timeout_stage": "agent", "model_started_at": 123},
        {"timeout_stage": "startup", "model_started_at": 123},
        {"timeout_stage": "startup", "model_started_at": None, "marker_error": "SyntaxError"},
    ]:
        assert not startup_retryable(tmp_path, {**result, "execution": {"outcome": "timeout", "lifecycle": lifecycle}})
    atomic_json(tmp_path / "wire/possible-request/downstream.json", {"model": "fixture"})
    assert not startup_retryable(tmp_path, result)


async def test_successful_startup_retry_is_reused_without_repeating_model_work(tmp_path, monkeypatch):
    from synergy_bench import runner
    from synergy_bench.evidence import collect_evidence
    from synergy_bench.maintenance import doctor_plan
    from synergy_bench.storage import atomic_json, read_json
    from synergy_bench.usage import aggregate_usage

    plan = {
        "host": {"capacity": {"cpus": 1, "memory_bytes": 100}},
        "concurrency": 1,
        "schedule": [{"task": "fixture", "variant": "native"}],
        "tasks": {"fixture": {"resources": {"cpus": 1, "memory_bytes": 100}}},
    }
    called = []

    async def execute(root, plan, item, attempt, **kwargs):
        called.append(attempt)
        result = collect_evidence(attempt / "native", {}, verification_required=False)
        result["evidence"]["archive_valid"] = True
        if len(called) == 1:
            result["execution"] = {
                "outcome": "timeout",
                "lifecycle": {"timeout_stage": "startup", "model_started_at": None, "marker_error": None},
            }
            result["wire_usage"] = {"attempts": 0}
            return result
        marker = read_json(attempt / "probe-intent.json")["marker"]
        call = {
            "id": "request",
            "protocol": "chat-completions",
            "status": "completed",
            "usage": {"prompt_tokens": 10, "completion_tokens": 2},
        }
        atomic_json(attempt / "wire/request/request.json", call)
        atomic_json(attempt / "wire/request/upstream.json", {"messages": [{"role": "tool", "content": marker}]})
        result["execution"] = {"outcome": "completed"}
        result["evidence"].update(valid=True, issues=[])
        result["wire_usage"] = aggregate_usage([call])
        result["reconciliation"] = {
            "status": "matched",
            "requests": {"mode": "request_id", "status": "matched", "completed_usage_crosschecked": ["native"]},
        }
        return result

    monkeypatch.setattr(runner, "execute_trial", execute)
    first = await doctor_plan(tmp_path, plan)
    second = await doctor_plan(tmp_path, plan)
    assert first == second
    assert first["status"] == "completed"
    assert first["records"][0]["attempt"] == 2
    assert len(called) == 2
    assert read_json(called[0] / "probe.json")["status"] == "failed"
    assert read_json(called[1] / "probe.json")["status"] == "completed"
