import asyncio
from pathlib import Path
from types import SimpleNamespace

import pytest
from pier.models.verifier.result import VerifierResult
from pier.trial.trial import VerifierTimeoutError

from synergy_bench.trial import BenchmarkTrial


@pytest.mark.asyncio
async def test_verifier_reward_is_committed_before_environment_cleanup(tmp_path: Path, monkeypatch) -> None:
    from synergy_bench import trial as module

    stopping = asyncio.Event()
    release = asyncio.Event()

    class Environment:
        env_paths = SimpleNamespace(verifier_dir="/logs/verifier", artifacts_dir="/logs/artifacts")

        async def start(self, **kwargs):
            pass

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
    trial.config = SimpleNamespace(environment=SimpleNamespace(delete=True), verifier=SimpleNamespace(env=None))
    trial._task = SimpleNamespace(name="fixture", config=SimpleNamespace(verifier=SimpleNamespace(user=None)))
    trial._trial_paths = SimpleNamespace(agent_dir=tmp_path)
    trial._environment = environment
    trial._artifact_handler = Artifacts()
    trial._logger = None
    trial._verifier_env_build_context = lambda step: tmp_path
    trial._verifier_env_mounts = lambda config: []
    trial._separate_verifier_session_id = lambda key: "owned"
    trial._cleanup_seconds = 2
    result = await trial._verify_with_separate_environment(
        SimpleNamespace(), key="trial", step_cfg=None, verifier_env=None, artifacts_dir=tmp_path
    )
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
    calls = 0

    async def verify(**kwargs):
        nonlocal calls
        calls += 1
        await asyncio.Future()

    trial._verify_once = verify
    with pytest.raises(VerifierTimeoutError):
        await trial._verify_with_retry()
    assert calls == 1
