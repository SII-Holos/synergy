from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from synergy_bench.environment import CachedDockerEnvironment, environment_identity
from synergy_bench.storage import atomic_json, digest


def test_independent_caches_do_not_claim_each_others_task_or_proxy_images(tmp_path):
    from pier.models.agent.network import NetworkAllowlist
    from pier.models.task.config import EnvironmentConfig
    from pier.models.trial.paths import TrialPaths

    context = tmp_path / "context"
    context.mkdir()
    (context / "Dockerfile").write_text("FROM scratch\n")

    def images(cache, name):
        env = CachedDockerEnvironment(
            environment_dir=context,
            environment_name="cache-fixture",
            session_id=name,
            trial_paths=TrialPaths(trial_dir=tmp_path / name),
            task_env_config=EnvironmentConfig(network_mode="no-network", allow_internet=False),
            network_allowlist=NetworkAllowlist(domains=["host.docker.internal"]),
            benchmark_cache=str(cache),
            benchmark_platform="linux/amd64",
            inference_port=12345,
        )
        env._prepare_egress_proxy_compose()
        from synergy_bench.storage import read_json

        proxy = read_json(env._egress_proxy_compose_path)["services"]["pier-egress-proxy"]["image"]
        return env._env_vars.main_image_name, proxy

    first = images(tmp_path / "first-cache", "first")
    assert first == images(tmp_path / "first-cache", "warm")
    (tmp_path / "cache-alias").symlink_to(tmp_path / "first-cache")
    assert first == images(tmp_path / "cache-alias", "alias")
    second = images(tmp_path / "second-cache", "second")
    assert first[0] != second[0]
    assert first[1] != second[1]


@pytest.mark.parametrize(
    "operation,command_deadline", [("exec", None), ("exec", 10800), ("exec", 1800), ("build", None)]
)
async def test_native_execution_outlives_preparation_ceiling(tmp_path, monkeypatch, operation, command_deadline):
    import sys

    from pier.models.task.config import EnvironmentConfig
    from pier.models.trial.paths import TrialPaths

    from synergy_bench import environment
    from synergy_bench.process import run_process

    (tmp_path / "Dockerfile").write_text("FROM scratch\n")
    env = CachedDockerEnvironment(
        environment_dir=tmp_path,
        environment_name="deadline-fixture",
        session_id="deadline-fixture",
        trial_paths=TrialPaths(trial_dir=tmp_path / "trial"),
        task_env_config=EnvironmentConfig(),
        benchmark_cache=str(tmp_path / "cache"),
        benchmark_platform="linux/amd64",
    )

    async def execute(args, *, log, deadline, **kwargs):
        # Scale hours to fractions of a second while keeping the real subprocess deadline and cleanup.
        return await run_process(
            [sys.executable, "-c", "import time;time.sleep(.15);print('native work completed')"],
            log=log,
            deadline=None if deadline is None else deadline / 18000,
        )

    monkeypatch.setattr(environment, "run_process", execute)
    monkeypatch.setattr(environment, "run_preparation_process", execute)
    if operation == "build" or command_deadline == 1800:
        with pytest.raises(TimeoutError):
            if operation == "build":
                await env._compose_command(["build"])
            else:
                await env.exec("native work", timeout_sec=command_deadline)
        return
    result = await env.exec("native work", timeout_sec=command_deadline)
    assert result.return_code == 0
    assert result.stdout == "native work completed\n"


async def test_diagnostic_failure_cannot_prevent_environment_stop(monkeypatch):
    env = object.__new__(CachedDockerEnvironment)
    env._egress_proxy_compose_path = None
    env._keep_containers = False
    monkeypatch.setattr(env, "_compose_command", AsyncMock(side_effect=TimeoutError("logs timed out")))
    monkeypatch.setattr(env, "prepare_logs_for_host", AsyncMock())
    monkeypatch.setattr(env, "_cleanup_resources_compose_file", lambda: None)
    stop = AsyncMock()
    monkeypatch.setattr(env, "_run_docker_compose_command", stop)
    with pytest.raises(TimeoutError):
        await env.stop(delete=False)
    stop.assert_awaited_once_with(["down"])


@pytest.mark.parametrize("keep_containers", [False, True])
async def test_failed_native_teardown_is_retained_by_trial(tmp_path, monkeypatch, keep_containers):
    from pier.models.task.config import EnvironmentConfig
    from pier.models.trial.paths import TrialPaths

    from synergy_bench import environment
    from synergy_bench.storage import read_json
    from synergy_bench.trial import BenchmarkTrial

    (tmp_path / "Dockerfile").write_text("FROM scratch\n")
    paths = TrialPaths(trial_dir=tmp_path / "trial")
    env = CachedDockerEnvironment(
        environment_dir=tmp_path,
        environment_name="cleanup-fixture",
        session_id="cleanup-fixture",
        trial_paths=paths,
        task_env_config=EnvironmentConfig(),
        benchmark_cache=str(tmp_path / "cache"),
        benchmark_platform="linux/amd64",
        keep_containers=keep_containers,
    )
    observed = []

    async def compose(args, *, log, **kwargs):
        observed.append(args)
        log.parent.mkdir(parents=True, exist_ok=True)
        log.write_text("native teardown failed\n")
        return 17 if args[-1] in {"down", "stop"} else 0

    monkeypatch.setattr(environment, "run_process", compose)
    monkeypatch.setattr(env, "prepare_logs_for_host", AsyncMock())
    trial = object.__new__(BenchmarkTrial)
    trial._cleanup_seconds = 1
    trial._trial_paths = paths
    await trial._stop(env, delete=True)
    failure = paths.agent_dir / "environment-cleanup.json"
    assert failure.exists(), "Docker cleanup errors must reach terminal evidence"
    assert read_json(failure) == {"status": "failed", "errors": ["RuntimeError"]}
    assert [args[-1] for args in observed] == ["--no-color", "stop" if keep_containers else "down"]
    assert all("--rmi" not in args and "--volumes" not in args for args in observed)


def test_image_identity_changes_with_context_platform_and_native_limits(tmp_path):
    (tmp_path / "Dockerfile").write_text("FROM fixture@sha256:one\n")
    first = environment_identity(tmp_path, {"docker_image": "fixed", "cpus": 1}, None, "linux/amd64")
    assert first != environment_identity(tmp_path, {"docker_image": "fixed", "cpus": 1}, None, "linux/arm64")
    (tmp_path / "Dockerfile").write_text("FROM fixture@sha256:two\n")
    assert first != environment_identity(tmp_path, {"docker_image": "fixed", "cpus": 1}, None, "linux/amd64")


async def test_warm_image_skips_compose_build_and_remote_pull(tmp_path, monkeypatch):

    env = object.__new__(CachedDockerEnvironment)
    env._benchmark_cache = tmp_path
    env._benchmark_identity = {"platform": "linux/amd64", "source": "frozen"}
    key = digest(env._benchmark_identity)
    env._env_vars = SimpleNamespace(main_image_name="synergy-bench-task:" + key)
    env._egress_proxy_compose_path = None
    env._mounts_compose_path = None
    env._benchmark_proxy = None
    atomic_json(
        tmp_path / "images" / f"{key}.json",
        {
            "owner": "synergy-benchmark-image-v1",
            "id": "sha256:fixture",
            "tag": env._env_vars.main_image_name,
            "identity": env._benchmark_identity,
        },
    )

    async def image_id(*args):
        return "sha256:fixture"

    monkeypatch.setattr(env, "_image_id", image_id)
    build = AsyncMock(side_effect=AssertionError("warm image must never rebuild"))
    monkeypatch.setattr(env, "_compose_command", build)
    result = await env._run_docker_compose_command(["build"])
    assert result.return_code == 0
    build.assert_not_awaited()


async def test_missing_frozen_image_cannot_be_rebuilt_silently(tmp_path, monkeypatch):

    env = object.__new__(CachedDockerEnvironment)
    env._benchmark_cache = tmp_path
    env._benchmark_identity = {"platform": "linux/amd64", "source": "frozen"}
    key = digest(env._benchmark_identity)
    env._env_vars = SimpleNamespace(main_image_name="synergy-bench-task:" + key)
    env._mounts_compose_path = None
    env._benchmark_proxy = None
    atomic_json(
        tmp_path / "images" / f"{key}.json",
        {"owner": "synergy-benchmark-image-v1", "id": "sha256:old", "identity": env._benchmark_identity},
    )
    monkeypatch.setattr(env, "_image_id", AsyncMock(return_value=None))
    build = AsyncMock()
    monkeypatch.setattr(env, "_compose_command", build)
    with pytest.raises(ValueError, match="missing"):
        await env._run_docker_compose_command(["build"])
    build.assert_not_awaited()


async def test_finished_build_is_reconciled_after_publisher_exit(tmp_path, monkeypatch):
    env = object.__new__(CachedDockerEnvironment)
    env._benchmark_cache = tmp_path
    env._benchmark_identity = {"platform": "linux/amd64", "source": "frozen"}
    key = digest(env._benchmark_identity)
    env._env_vars = SimpleNamespace(main_image_name="synergy-bench-task:" + key)
    env._mounts_compose_path = None
    env._benchmark_proxy = None
    atomic_json(
        tmp_path / "images" / (key + ".pending.json"),
        {"owner": "synergy-benchmark-image-v1", "identity": env._benchmark_identity},
    )
    monkeypatch.setattr(env, "_image_id", AsyncMock(return_value="sha256:finished"))
    monkeypatch.setattr(env, "_image_cache_key", AsyncMock(return_value=key), raising=False)
    build = AsyncMock(side_effect=AssertionError("completed build must be recovered"))
    monkeypatch.setattr(env, "_compose_command", build)
    await env._run_docker_compose_command(["build"])
    from synergy_bench.storage import read_json

    assert read_json(tmp_path / "images" / (key + ".json"))["id"] == "sha256:finished"
    assert not (tmp_path / "images" / (key + ".pending.json")).exists()
    build.assert_not_awaited()
