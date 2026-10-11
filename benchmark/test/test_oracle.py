import pytest
from fixtures.task_copy import copy_task_fixture

from synergy_bench.oracle import oracle_configuration, oracle_result


async def test_oracle_uses_stage_leases_and_retains_cleanup_failure_before_stopping(tmp_path, monkeypatch):
    from contextlib import asynccontextmanager
    from types import SimpleNamespace

    import pytest

    from synergy_bench import oracle, runner
    from synergy_bench.catalog import tree_digest
    from synergy_bench.resources import Request
    from synergy_bench.scheduling import current_resources
    from synergy_bench.storage import atomic_json, digest, read_json

    task = tmp_path / "task"
    task.mkdir()
    root = tmp_path / "oracle-12345678"
    atomic_json(root / "owner.json", {"kind": "synergy-benchmark-oracle", "version": 1})
    plan = {
        "evaluator": "fixture",
        "host": {"capacity": {"cpus": 2, "memory_bytes": 2 * 1024**3}},
        "concurrency": 1,
        "cache": str(tmp_path / "cache"),
        "platform": "linux/amd64",
        "config": {"resources": {"cache_budget_gib": 1, "min_free_disk_gib": 0}},
        "tasks": [
            {
                "id": "task",
                "local_path": str(task),
                "digest": tree_digest(task),
                "resources": {"cpus": 1, "memory_bytes": 1024**3},
            }
        ],
    }
    atomic_json(root / "plan.json", {**plan, "digest": digest(plan)})
    monkeypatch.setattr(oracle, "evaluator_identity", lambda: "fixture")
    monkeypatch.setattr(oracle, "enforce_budget", lambda *args, **kwargs: None)
    monkeypatch.setattr(oracle, "admission_for", lambda *args: None)
    monkeypatch.setattr(oracle, "shared_pool_options", lambda *args: {})
    captured = []

    @asynccontextmanager
    async def monitor(*args, **kwargs):
        assert kwargs.get("scheduler") is current_resources.get()
        yield

    async def create(config):
        async def run():
            scheduler = current_resources.get()
            assert scheduler is not None, "Oracle bypassed stage admission"
            assert not scheduler.leases
            captured.append(scheduler)
            await scheduler.acquire(config.trial_name, Request(1, 1024**3))
            return SimpleNamespace(model_dump=lambda **kwargs: {"verifier_result": {"rewards": {"reward": 1}}})

        return SimpleNamespace(run=run)

    def audit(root, ownership, agent):
        atomic_json(ownership.parent / "cleanup.json", {"status": "failed", "resources_removed": False})

    monkeypatch.setattr(oracle, "ResourceMonitor", monitor)
    monkeypatch.setattr(oracle.BenchmarkTrial, "create", create)
    monkeypatch.setattr(runner, "audit_environment", audit)
    try:
        with pytest.raises(ExceptionGroup, match="TaskGroup"):
            await oracle.run_oracle(root)
        record = read_json(root / "oracles/0000/attempt-001/oracle.json")
        assert record["reward"] == 1
        assert record["native_exception"] is None
        assert record["status"] == "failed"
        assert record["cleanup_error"]["resources_removed"] is False
        assert captured[0].pool.active == 1
        assert current_resources.get() is None
    finally:
        for scheduler in captured:
            await scheduler.finish(resources_removed=True)


@pytest.fixture
def oracle_audit(tmp_path, monkeypatch):
    from contextlib import asynccontextmanager

    from synergy_bench import oracle, runner
    from synergy_bench.catalog import tree_digest
    from synergy_bench.scheduling import current_resources
    from synergy_bench.storage import atomic_json, digest

    @asynccontextmanager
    async def monitor(*args, **kwargs):
        assert kwargs["scheduler"] is current_resources.get()
        yield

    def audit(root, ownership, agent):
        atomic_json(ownership.parent / "cleanup.json", {"status": "completed", "resources_removed": True})

    monkeypatch.setattr(oracle, "evaluator_identity", lambda: "fixture")
    monkeypatch.setattr(oracle, "enforce_budget", lambda *args, **kwargs: None)
    monkeypatch.setattr(oracle, "admission_for", lambda *args: None)
    monkeypatch.setattr(oracle, "shared_pool_options", lambda *args: {})
    monkeypatch.setattr(oracle, "ResourceMonitor", monitor)
    monkeypatch.setattr(runner, "audit_environment", audit)

    def prepare(*, count=2, concurrency=1):
        tasks = []
        for index in range(count):
            task = tmp_path / f"task-{index:04d}"
            task.mkdir()
            tasks.append(
                {
                    "id": task.name,
                    "local_path": str(task),
                    "digest": tree_digest(task),
                    "resources": {"cpus": 1, "memory_bytes": 1024**3},
                }
            )
        root = tmp_path / "oracle-12345678"
        atomic_json(root / "owner.json", {"kind": "synergy-benchmark-oracle", "version": 1})
        plan = {
            "evaluator": "fixture",
            "host": {"capacity": {"cpus": 2, "memory_bytes": 4 * 1024**3}},
            "concurrency": concurrency,
            "cache": str(tmp_path / "cache"),
            "platform": "linux/amd64",
            "config": {"resources": {"cache_budget_gib": 1, "min_free_disk_gib": 0}},
            "tasks": tasks,
        }
        atomic_json(root / "plan.json", {**plan, "digest": digest(plan)})
        return root

    return prepare


@pytest.mark.parametrize("kind", ["DockerEndpointError", "ResourcePressureError", "ResourceRecordingError"])
@pytest.mark.parametrize("delivery", ["raised", "native"])
async def test_oracle_global_failures_stop_after_evidence_and_release(oracle_audit, monkeypatch, kind, delivery):
    from types import SimpleNamespace

    from pier.models.trial.result import ExceptionInfo

    from synergy_bench import oracle
    from synergy_bench.docker_resources import DockerEndpointError
    from synergy_bench.monitor import ResourceRecordingError
    from synergy_bench.resources import Request, ResourcePressureError
    from synergy_bench.runner import DispatchStopped
    from synergy_bench.scheduling import current_resources
    from synergy_bench.storage import read_json

    root = oracle_audit()
    errors = {error.__name__: error for error in (DockerEndpointError, ResourcePressureError, ResourceRecordingError)}
    schedulers = []

    async def create(config):
        scheduler = current_resources.get()
        schedulers.append(scheduler)

        async def run():
            await scheduler.acquire(config.trial_name, Request(1, 1024**3))
            error = errors[kind]("Fixture global resource failure")
            if delivery == "raised":
                raise error
            native = {"exception_info": ExceptionInfo.from_exception(error).model_dump(mode="json")}
            return SimpleNamespace(model_dump=lambda **kwargs: native)

        return SimpleNamespace(run=run)

    monkeypatch.setattr(oracle.BenchmarkTrial, "create", create)
    with pytest.raises(ExceptionGroup) as raised:
        await oracle.run_oracle(root)
    assert raised.value.subgroup(DispatchStopped) is not None
    assert len(schedulers) == 1
    assert not schedulers[0].leases
    assert schedulers[0].pool.active == 0
    attempt = root / "oracles/0000/attempt-001"
    retained = (attempt / "oracle.json").read_bytes()
    result = read_json(attempt / "oracle.json")
    assert result["native_exception"]["exception_type"] == kind
    assert result["status"] == "failed"
    assert read_json(attempt / "cleanup.json")["resources_removed"] is True
    assert read_json(attempt / "scheduling.json")["events"][-1]["event"] == "released"
    report = read_json(root / "oracle-report.json")
    assert report["completed"] == 1
    assert report["missing"] == ["task-0001"]
    assert current_resources.get() is None

    with pytest.raises(DispatchStopped):
        await oracle.run_oracle(root)
    assert len(schedulers) == 1
    assert (attempt / "oracle.json").read_bytes() == retained
    assert read_json(root / "oracle-report.json")["missing"] == ["task-0001"]


@pytest.mark.parametrize("delivery", ["raised", "native"])
async def test_oracle_task_failure_keeps_following_tasks_and_retained_evidence(oracle_audit, monkeypatch, delivery):
    from types import SimpleNamespace

    from pier.models.trial.result import ExceptionInfo

    from synergy_bench import oracle
    from synergy_bench.storage import read_json

    root = oracle_audit()
    started = []

    async def create(config):
        started.append(config.task.path.name)

        async def run():
            error = ValueError("Fixture task failure")
            if delivery == "raised":
                raise error
            return SimpleNamespace(
                model_dump=lambda **kwargs: {
                    "exception_info": ExceptionInfo.from_exception(error).model_dump(mode="json")
                }
            )

        return SimpleNamespace(run=run)

    monkeypatch.setattr(oracle.BenchmarkTrial, "create", create)
    report = await oracle.run_oracle(root)
    assert started == ["task-0000", "task-0001"]
    assert report["completed"] == 2
    assert report["missing"] == []
    assert all(row["native_exception"]["exception_type"] == "ValueError" for row in report["rows"])
    retained = {file: file.read_bytes() for file in root.glob("oracles/*/attempt-001/oracle.json")}
    assert await oracle.run_oracle(root) == read_json(root / "oracle-report.json")
    assert started == ["task-0000", "task-0001"]
    assert all(file.read_bytes() == content for file, content in retained.items())


@pytest.mark.parametrize("kind", ["DockerEndpointError", "ResourcePressureError", "ResourceRecordingError", "cleanup"])
async def test_oracle_retained_global_failure_prevents_any_new_dispatch(oracle_audit, monkeypatch, kind):
    from types import SimpleNamespace

    from synergy_bench import oracle
    from synergy_bench.runner import DispatchStopped
    from synergy_bench.storage import atomic_json, read_json

    root = oracle_audit(count=3, concurrency=2)
    plan = read_json(root / "plan.json")
    retained = {}
    for index in (1, 2):
        trial = root / "oracles" / f"{index:04d}" / "attempt-001/native"
        native = {"verifier_result": {"rewards": {"reward": 1}}}
        if index == 1 and kind != "cleanup":
            native["exception_info"] = {"exception_type": kind, "exception_message": "Retained global failure"}
        atomic_json(trial / "result.json", native)
        result = {**oracle_result(trial, native), "task": plan["tasks"][index]["id"]}
        if index == 1 and kind == "cleanup":
            result.update(status="failed", cleanup_error={"status": "failed", "resources_removed": False})
        file = trial.parent / "oracle.json"
        atomic_json(file, result)
        retained[file] = file.read_bytes()
    started = []

    async def create(config):
        started.append(config.task.path.name)

        async def run():
            return SimpleNamespace(model_dump=lambda **kwargs: {})

        return SimpleNamespace(run=run)

    monkeypatch.setattr(oracle.BenchmarkTrial, "create", create)
    with pytest.raises(DispatchStopped):
        await oracle.run_oracle(root)
    assert started == []
    report = read_json(root / "oracle-report.json")
    assert report["completed"] == 2
    assert {row["task"] for row in report["rows"]} == {"task-0001", "task-0002"}
    assert report["missing"] == ["task-0000"]
    assert all(file.read_bytes() == content for file, content in retained.items())


async def test_oracle_global_failure_cancels_and_cleans_active_sibling(oracle_audit, monkeypatch):
    import asyncio
    from types import SimpleNamespace

    from pier.models.trial.result import ExceptionInfo

    from synergy_bench import oracle
    from synergy_bench.resources import Request, ResourcePressureError
    from synergy_bench.runner import DispatchStopped
    from synergy_bench.scheduling import current_resources
    from synergy_bench.storage import read_json

    root = oracle_audit(count=3, concurrency=2)
    sibling_started = asyncio.Event()
    cancelled = asyncio.Event()
    schedulers = []

    async def create(config):
        scheduler = current_resources.get()
        schedulers.append(scheduler)

        async def run():
            await scheduler.acquire(config.trial_name, Request(1, 1024**3))
            await scheduler.sample({config.trial_name: (1024**3, 0.25)})
            if config.task.path.name == "task-0000":
                await sibling_started.wait()
                error = ResourcePressureError("Fixture shared pressure failure")
                return SimpleNamespace(
                    model_dump=lambda **kwargs: {
                        "exception_info": ExceptionInfo.from_exception(error).model_dump(mode="json")
                    }
                )
            sibling_started.set()
            try:
                await asyncio.Future()
            except asyncio.CancelledError:
                cancelled.set()
                raise

        return SimpleNamespace(run=run)

    monkeypatch.setattr(oracle.BenchmarkTrial, "create", create)
    async with asyncio.timeout(10):
        with pytest.raises(ExceptionGroup) as raised:
            await oracle.run_oracle(root)
    assert raised.value.subgroup(DispatchStopped) is not None
    assert cancelled.is_set()
    assert len(schedulers) == 2
    assert all(not scheduler.leases and scheduler.pool.active == 0 for scheduler in schedulers)
    report = read_json(root / "oracle-report.json")
    assert report["completed"] == 2
    assert report["missing"] == ["task-0002"]
    assert report["rows"][1]["native_exception"]["exception_type"] == "CancelledError"
    assert all(read_json(scheduler.directory / "cleanup.json")["resources_removed"] is True for scheduler in schedulers)
    assert current_resources.get() is None


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
    from synergy_bench.prepare import BENCHMARK
    from synergy_bench.trial import BenchmarkTrial

    task = tmp_path / "task"
    copy_task_fixture(BENCHMARK / "test/fixtures/task", task)
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
    import uuid

    import pytest

    from synergy_bench.prepare import BENCHMARK
    from synergy_bench.storage import read_json
    from synergy_bench.trial import BenchmarkTrial

    if os.environ.get("SYNERGY_BENCH_DOCKER") != "1":
        pytest.skip("Explicit Docker deadline propagation integration")
    task = tmp_path / "task"
    copy_task_fixture(BENCHMARK / "test/fixtures/task", task)
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
    import uuid

    import pytest

    from synergy_bench.prepare import BENCHMARK
    from synergy_bench.storage import read_json
    from synergy_bench.trial import BenchmarkTrial

    if os.environ.get("SYNERGY_BENCH_DOCKER") != "1":
        pytest.skip("Explicit native oracle timeout integration")
    task = tmp_path / "task"
    copy_task_fixture(BENCHMARK / "test/fixtures/task", task)
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
