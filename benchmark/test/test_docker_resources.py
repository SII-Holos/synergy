import uuid
from pathlib import Path
from types import SimpleNamespace

import pytest
from aiohttp import web
from fixtures.resources import healthy_docker_snapshot

from synergy_bench.docker_resources import DockerStats


@pytest.fixture
async def docker_observations(monkeypatch):
    state = SimpleNamespace(mode="recover", lists=0, samples=[])
    socket = Path("/tmp") / ("sb-memory-" + uuid.uuid4().hex + ".sock")

    async def containers(request):
        state.lists += 1
        identities = ["owned", "other"]
        if state.mode == "removed" and state.lists > 1:
            identities.remove("other")
        return web.json_response(
            [{"Id": identity, "Labels": {"com.docker.compose.project": "sb-" + identity}} for identity in identities]
        )

    async def stats(request):
        identity = request.match_info["identity"]
        assert request.query == {"stream": "false", "one-shot": "true"}
        memory = {} if identity == "other" and (state.lists == 1 or state.mode == "missing") else {"usage": 64}
        state.samples.append((state.lists, identity, memory.get("usage")))
        return web.json_response({"memory_stats": memory})

    app = web.Application()
    app.router.add_get("/containers/json", containers)
    app.router.add_get("/containers/{identity}/stats", stats)
    server = web.AppRunner(app)
    await server.setup()
    await web.UnixSite(server, str(socket)).start()
    monkeypatch.setenv("DOCKER_HOST", "unix://" + str(socket))
    monkeypatch.delenv("DOCKER_CONTEXT", raising=False)
    try:
        yield DockerStats(), state
    finally:
        await server.cleanup()
        socket.unlink(missing_ok=True)


@pytest.mark.parametrize("mode", ["recover", "removed"])
async def test_fixture_waits_for_complete_daemon_memory_without_requiring_cpu(docker_observations, mode):
    sampler, state = docker_observations
    state.mode = mode
    first = await sampler.snapshot()
    assert not first.healthy
    assert next(row for row in first.containers if row["ID"] == "other")["memory_bytes"] is None
    snapshot = await healthy_docker_snapshot(sampler, timeout_seconds=5)
    assert snapshot.healthy
    assert state.lists >= 2
    assert (1, "other", None) in state.samples
    assert {row["ID"] for row in snapshot.containers} == ({"owned", "other"} if mode == "recover" else {"owned"})
    assert all(row["memory_bytes"] == 64 and row["cpu_percent"] is None for row in snapshot.containers)


async def test_fixture_deadline_rejects_persistently_missing_daemon_memory(docker_observations):
    sampler, state = docker_observations
    state.mode = "missing"
    with pytest.raises(TimeoutError):
        await healthy_docker_snapshot(sampler, timeout_seconds=1.1)
    assert state.lists >= 1
    assert (1, "other", None) in state.samples
    assert all(memory is None for _, identity, memory in state.samples if identity == "other")
