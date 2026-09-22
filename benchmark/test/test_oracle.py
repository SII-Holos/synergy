from synergy_bench.oracle import oracle_configuration, oracle_result


def test_oracle_uses_three_hours_for_both_stages_without_harness_or_inference(tmp_path):
    task = {"local_path": str(tmp_path / "task"), "agent_seconds": 51}
    config = oracle_configuration(
        tmp_path, task, tmp_path / "attempt-001", cache=tmp_path / "cache", platform="linux/amd64"
    )
    assert config.agent.name == "oracle"
    assert config.agent.override_timeout_sec == 10800
    assert config.agent.import_path is None
    assert config.agent.model_name is None
    assert config.verifier.override_timeout_sec == 10800
    assert all(mount["target"].startswith("/logs/") for mount in config.environment.mounts)
    assert config.environment.kwargs["inference_port"] is None


async def test_fixed_budget_reaches_pier_execution_timers(tmp_path):
    import shutil

    from synergy_bench.prepare import BENCHMARK
    from synergy_bench.trial import BenchmarkTrial

    task = tmp_path / "task"
    shutil.copytree(BENCHMARK / "test/fixtures/task", task)
    config = oracle_configuration(
        tmp_path, {"local_path": str(task)}, tmp_path / "attempt-001", cache=tmp_path / "cache", platform="linux/amd64"
    )
    trial = await BenchmarkTrial.create(config)
    try:
        assert trial._execution.agent_timeout_sec == 10800
        assert trial._verifier_timeout_sec == 10800
    finally:
        trial._close_logger_handler()


async def test_native_oracle_and_verifier_outlive_upstream_short_deadlines(tmp_path):
    import os
    import shutil
    import uuid

    import pytest

    from synergy_bench.prepare import BENCHMARK
    from synergy_bench.storage import read_json
    from synergy_bench.trial import BenchmarkTrial

    if os.environ.get("SYNERGY_BENCH_DOCKER") != "1":
        pytest.skip("Explicit Docker deadline propagation integration")
    task = tmp_path / "task"
    shutil.copytree(BENCHMARK / "test/fixtures/task", task)
    definition = (task / "task.toml").read_text()
    (task / "task.toml").write_text(
        definition.replace("timeout_sec = 90", "timeout_sec = 0.01").replace("timeout_sec = 30", "timeout_sec = 0.01")
    )
    (task / "solution").mkdir(exist_ok=True)
    (task / "solution/solve.sh").write_text("#!/bin/sh\nsleep 0.1\nprintf verified > /app/marker\n")
    verifier = task / "tests/test.sh"
    verifier.write_text(verifier.read_text().replace("#!/bin/sh", "#!/bin/sh\nsleep 0.1"))
    root = BENCHMARK.parent / ".artifacts/benchmark/oracle-fixed-deadline" / ("run-" + uuid.uuid4().hex[:8])
    attempt = root / "oracles/0000/attempt-001"
    config = oracle_configuration(
        root,
        {"local_path": str(task)},
        attempt,
        cache=BENCHMARK.parent / ".artifacts/benchmark/cache",
        platform="linux/amd64",
    )
    trial = await BenchmarkTrial.create(config)
    result = await trial.run()
    assert result.exception_info is None
    assert result.verifier_result.rewards == {"reward": 1.0}
    stages = read_json(attempt / "stages.json")
    assert stages["agent"][0]["status"] == "completed"
    assert stages["verifier"][0]["status"] == "completed"


def test_oracle_reward_does_not_claim_functional_tests_started(tmp_path):
    trial = tmp_path / "native"
    (trial / "agent").mkdir(parents=True)
    (trial / "agent/oracle.txt").write_text("solution executed\n")
    result = oracle_result(
        trial,
        {"verifier_result": {"rewards": {"reward": 0}}, "agent_execution": {"started_at": "s", "finished_at": "e"}},
    )
    assert result["reward"] == 0
    assert result["grading"]["functional_tests"] == "unknown"
    assert result["solution_exit_code"] is None
    assert result["status"] == "failed"
    assert result["files"]["agent/oracle.txt"]["sha256"]


def test_oracle_uses_primary_reward_without_discarding_auxiliary_scores(tmp_path):
    rewards = {"reward": 1, "f2p_total": 88, "p2p_passed": 275, "partial": 1.0}
    result = oracle_result(tmp_path, {"verifier_result": {"rewards": rewards}})
    assert result["reward"] == 1
    assert result["status"] == "passed"
    assert result["native_rewards"] == rewards


def test_oracle_cleanup_failure_blocks_admission_without_changing_native_reward(tmp_path):
    from synergy_bench.oracle import report_oracle
    from synergy_bench.storage import atomic_json

    root = tmp_path / "audit"
    trial = root / "oracles/0000/attempt-001/native"
    failure = {"status": "failed", "errors": ["TimeoutError"]}
    atomic_json(trial / "agent/environment-cleanup.json", failure)
    result = oracle_result(trial, {"verifier_result": {"rewards": {"reward": 1}}})
    assert result["reward"] == 1
    assert result["status"] == "failed"
    assert result["cleanup_error"] == failure

    atomic_json(root / "owner.json", {"kind": "synergy-benchmark-oracle", "version": 1})
    atomic_json(root / "plan.json", {"tasks": [{"id": "task"}]})
    record = trial.parent / "oracle.json"
    atomic_json(record, {**result, "task": "task", "status": "passed", "cleanup_error": None})
    before = record.read_bytes()
    row = report_oracle(root)["rows"][0]
    assert row["recorded_status"] == "passed"
    assert row["status"] == "failed"
    assert row["reward"] == 1
    assert row["cleanup_error"] == failure
    assert record.read_bytes() == before


def test_oracle_report_imports_raw_rewards_without_mutating_or_reexecuting(tmp_path):
    from synergy_bench.oracle import report_oracle
    from synergy_bench.storage import atomic_json

    file = tmp_path / "oracles/0000/attempt-001/oracle.json"
    atomic_json(tmp_path / "owner.json", {"kind": "synergy-benchmark-oracle", "version": 1})
    atomic_json(tmp_path / "plan.json", {"tasks": [{"id": "task"}]})
    atomic_json(
        file,
        {
            "task": "task",
            "status": "failed",
            "reward": None,
            "native_rewards": {"reward": 1, "f2p": 1},
            "native_exception": None,
            "files": {},
            "trial_directory": "native",
        },
    )
    before = file.read_bytes()
    report = report_oracle(tmp_path)
    assert report["rows"][0]["status"] == "passed"
    assert report["rows"][0]["recorded_status"] == "failed"
    assert report["rows"][0]["reward"] == 1
    assert file.read_bytes() == before


async def test_native_oracle_timeout_still_runs_verifier(tmp_path):
    import os
    import shutil
    import uuid

    import pytest

    from synergy_bench.prepare import BENCHMARK
    from synergy_bench.storage import read_json
    from synergy_bench.trial import BenchmarkTrial

    if os.environ.get("SYNERGY_BENCH_DOCKER") != "1":
        pytest.skip("Explicit native oracle timeout integration")
    task = tmp_path / "task"
    shutil.copytree(BENCHMARK / "test/fixtures/task", task)
    (task / "task.toml").write_text(
        (task / "task.toml").read_text().replace("[agent]\ntimeout_sec = 90", "[agent]\ntimeout_sec = 0.1")
    )
    (task / "solution").mkdir(exist_ok=True)
    (task / "solution/solve.sh").write_text("#!/bin/sh\nsleep 60\nprintf verified > /app/marker\n")
    root = BENCHMARK.parent / ".artifacts/benchmark/oracle-timeout" / ("run-" + uuid.uuid4().hex[:8])
    attempt = root / "oracles/0000/attempt-001"
    config = oracle_configuration(
        root,
        {"local_path": str(task)},
        attempt,
        cache=BENCHMARK.parent / ".artifacts/benchmark/cache",
        platform="linux/amd64",
    )
    config.agent.override_timeout_sec = 0.1
    trial = await BenchmarkTrial.create(config)
    result = await trial.run()
    assert result.exception_info.exception_type == "AgentTimeoutError"
    assert result.verifier_result.rewards == {"reward": 0.0}
    assert read_json(attempt / "stages.json")["verifier"][0]["status"] == "completed"
