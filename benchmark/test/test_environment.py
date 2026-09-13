from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from synergy_bench.environment import CachedDockerEnvironment, environment_identity
from synergy_bench.storage import atomic_json, digest


async def test_diagnostic_failure_cannot_prevent_environment_stop(monkeypatch):
    from pier.environments.docker.docker import DockerEnvironment

    env = object.__new__(CachedDockerEnvironment)
    env._egress_proxy_compose_path = None
    monkeypatch.setattr(env, "_compose_command", AsyncMock(side_effect=TimeoutError("logs timed out")))
    stop = AsyncMock()
    monkeypatch.setattr(DockerEnvironment, "stop", stop)
    with pytest.raises(TimeoutError):
        await env.stop(delete=False)
    stop.assert_awaited_once_with(delete=False)


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
