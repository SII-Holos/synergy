import asyncio
from pathlib import Path
from types import SimpleNamespace

import pytest
from pier.models.task.config import TaskConfig
from pier.models.verifier.result import VerifierResult
from pier.trial.trial import VerifierTimeoutError

from synergy_bench.trial import BenchmarkTrial


@pytest.mark.parametrize("verifier", [{"environment": {}}, {"environment_mode": "separate"}])
@pytest.mark.asyncio
async def test_verifier_reward_is_committed_before_environment_cleanup(tmp_path: Path, monkeypatch, verifier) -> None:
    from synergy_bench import trial as module

    stopping = asyncio.Event()
    release = asyncio.Event()

    class Environment:
        env_paths = SimpleNamespace(verifier_dir="/logs/verifier", artifacts_dir="/logs/artifacts")

        async def start(self, **kwargs):
            await asyncio.sleep(0.04)

        async def empty_dirs(self, *args, **kwargs):
            pass

        async def stop(self, **kwargs):
            stopping.set()
            await release.wait()

    class Verifier:
        def __init__(self, **kwargs):
            pass

        async def verify(self):
            return VerifierResult(rewards={"reward": 1.0})

    class Artifacts:
        async def upload_artifacts(self, *args, **kwargs):
            pass

    environment = Environment()
    monkeypatch.setattr(module.EnvironmentFactory, "create_environment_from_config", lambda **kwargs: environment)
    monkeypatch.setattr(module, "Verifier", Verifier)
    trial = object.__new__(BenchmarkTrial)
    trial._verifier_environments = []
    trial.config = SimpleNamespace(
        environment=SimpleNamespace(delete=True),
        verifier=SimpleNamespace(env=None),
        agent=SimpleNamespace(kwargs={"settings": {"preparation_timeout_seconds": 1}}),
    )
    trial._task = SimpleNamespace(name="fixture", config=TaskConfig.model_validate({"verifier": verifier}))
    trial._trial_paths = SimpleNamespace(agent_dir=tmp_path)
    trial._environment = environment
    trial._artifact_handler = Artifacts()
    trial._logger = None
    trial._verifier_env_build_context = lambda step: tmp_path
    trial._verifier_env_mounts = lambda config: []
    trial._separate_verifier_session_id = lambda key: "owned"
    trial._cleanup_seconds = 2
    trial._verifier_timeout_sec = 0.02
    trial._result = SimpleNamespace(verifier_result=None)
    from synergy_bench.lifecycle import Lifecycle

    trial._lifecycle = Lifecycle(tmp_path)

    async def verify_once(**kwargs):
        return await trial._verify_with_separate_environment(
            SimpleNamespace(), key="trial", step_cfg=None, verifier_env=None, artifacts_dir=tmp_path
        )

    trial._verify_once = verify_once
    await trial._verify_with_retry()
    result = trial.result.verifier_result
    assert result.rewards == {"reward": 1.0}
    assert not stopping.is_set()
    cleanup = asyncio.create_task(trial._cleanup_verifiers())
    await stopping.wait()
    assert not cleanup.done()
    release.set()
    await cleanup
    assert result.rewards == {"reward": 1.0}


@pytest.mark.asyncio
async def test_verifier_timeout_does_not_resample_grading() -> None:
    trial = object.__new__(BenchmarkTrial)
    trial._verifier_timeout_sec = 0.01
    trial._result = SimpleNamespace(verifier_result=None)
    trial._task = SimpleNamespace(config=TaskConfig())
    calls = 0

    async def verify(**kwargs):
        nonlocal calls
        calls += 1
        await asyncio.Future()

    trial._verify_once = verify
    with pytest.raises(VerifierTimeoutError):
        await trial._verify_with_retry()
    assert calls == 1


@pytest.mark.asyncio
async def test_cleanup_never_deletes_cached_or_shared_images(tmp_path):
    from types import SimpleNamespace

    from synergy_bench.trial import BenchmarkTrial

    observed = []

    class Environment:
        async def stop(self, *, delete):
            observed.append(delete)

    trial = object.__new__(BenchmarkTrial)
    trial._cleanup_seconds = 1
    trial._trial_paths = SimpleNamespace(agent_dir=tmp_path)
    await trial._stop(Environment(), delete=True)
    assert observed == [False]


@pytest.mark.asyncio
async def test_prewarm_starts_both_images_without_agent_or_verifier_execution(tmp_path):
    from types import SimpleNamespace
    from unittest.mock import AsyncMock

    from synergy_bench.trial import BenchmarkTrial

    trial = object.__new__(BenchmarkTrial)
    from synergy_bench.lifecycle import Lifecycle

    trial._task = SimpleNamespace(config=TaskConfig.model_validate({"verifier": {"environment_mode": "separate"}}))
    trial.config = SimpleNamespace(agent=SimpleNamespace(kwargs={"settings": {}}))
    trial._lifecycle = Lifecycle(tmp_path)
    trial._environment = SimpleNamespace(start=AsyncMock(), run_healthcheck=AsyncMock())
    trial._agent = SimpleNamespace(setup=AsyncMock())
    trial._setup_environment = AsyncMock()
    trial._setup_agent = AsyncMock()
    trial._stop_agent_environment = AsyncMock()
    trial._cleanup_verifiers = AsyncMock()
    trial._close_logger_handler = lambda: None
    environment = SimpleNamespace(start=AsyncMock())
    trial._new_verifier_environment = lambda *args, **kwargs: environment
    trial._execute_agent = AsyncMock(side_effect=AssertionError("prewarm cannot run a model"))
    await trial.prewarm()
    trial._agent.setup.assert_awaited_once()
    environment.start.assert_awaited_once_with(force_build=False)
    trial._execute_agent.assert_not_awaited()


async def test_agent_phase_uses_resolved_native_deadline(tmp_path, monkeypatch):
    from unittest.mock import AsyncMock

    from pier.trial.trial import Trial

    from synergy_bench.lifecycle import Lifecycle
    from synergy_bench.storage import read_json

    trial = object.__new__(BenchmarkTrial)
    trial.config = SimpleNamespace(agent=SimpleNamespace(override_timeout_sec=None))
    trial._execution = SimpleNamespace(agent_timeout_sec=10800)
    trial._lifecycle = Lifecycle(tmp_path)
    monkeypatch.setattr(Trial, "_execute_agent", AsyncMock())
    await trial._execute_agent()
    assert read_json(tmp_path / "stages.json")["agent"][0]["deadline_seconds"] == 10800


async def test_outer_agent_deadline_keeps_native_timeout_type_for_grading(tmp_path, monkeypatch):
    from pier.trial.execution import AgentTimeoutError
    from pier.trial.trial import Trial

    from synergy_bench.lifecycle import Lifecycle

    trial = object.__new__(BenchmarkTrial)
    trial._execution = SimpleNamespace(agent_timeout_sec=0.01)
    trial._lifecycle = Lifecycle(tmp_path)

    async def slow(self):
        await asyncio.sleep(10)

    monkeypatch.setattr(Trial, "_execute_agent", slow)
    with pytest.raises(AgentTimeoutError):
        await trial._execute_agent()
