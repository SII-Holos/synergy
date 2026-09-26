import asyncio
import os
import uuid

import pytest
from pier.models.task.config import EnvironmentConfig
from pier.models.trial.paths import TrialPaths

from synergy_bench.dependency_proxy import current_dependency_proxy, dependency_proxy
from synergy_bench.environment import CachedDockerEnvironment
from synergy_bench.prepare import command

pytestmark = pytest.mark.skipif(
    os.environ.get("SYNERGY_BENCH_DOCKER") != "1", reason="Explicit Docker integration suite"
)


async def test_container_uses_loopback_proxy_for_dependency_dns_and_cleans_up(tmp_path, monkeypatch):
    requests = []

    async def upstream(reader, writer):
        try:
            requests.append(await reader.readuntil(b"\r\n\r\n"))
            writer.write(b"HTTP/1.1 200 OK\r\nContent-Length: 7\r\nConnection: close\r\n\r\nfixture")
            await writer.drain()
        finally:
            writer.close()
            await writer.wait_closed()

    server = await asyncio.start_server(upstream, "127.0.0.1", 0)
    monkeypatch.setenv("BENCH_TEST_PROXY", f"http://127.0.0.1:{server.sockets[0].getsockname()[1]}")
    (tmp_path / "Dockerfile").write_text("FROM python:3.12-slim-bookworm\n")
    project = "sb-dependency-" + uuid.uuid4().hex[:10]
    async with server, dependency_proxy("BENCH_TEST_PROXY"):
        env = CachedDockerEnvironment(
            environment_dir=tmp_path,
            environment_name="dependency-proxy",
            session_id=project,
            trial_paths=TrialPaths(trial_dir=tmp_path / "trial"),
            task_env_config=EnvironmentConfig(
                docker_image="python:3.12-slim-bookworm", cpus=1, memory_mb=256, allow_internet=True
            ),
            benchmark_cache=str(tmp_path / "cache"),
            benchmark_platform="linux/amd64",
            dependency_proxy_url=current_dependency_proxy.get(),
        )
        try:
            await env.start(force_build=False)
            result = await env.exec(
                "python -c 'import urllib.request; "
                'assert urllib.request.urlopen("http://nonexistent.invalid/dep", timeout=10).read() == b"fixture"'
                "'",
                timeout_sec=30,
            )
            assert result.return_code == 0, result.stdout
        finally:
            await env.stop(delete=False)
    assert current_dependency_proxy.get() is None
    assert len(requests) == 1
    assert requests[0].startswith(b"GET http://nonexistent.invalid/dep HTTP/1.1")
    assert not await asyncio.to_thread(
        command, ["docker", "ps", "-aq", "--filter", f"label=com.docker.compose.project={project}"]
    )
