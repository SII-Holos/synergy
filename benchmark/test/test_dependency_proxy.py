from __future__ import annotations

import asyncio

import pytest

from synergy_bench.dependency_proxy import (
    DependencyRelay,
    current_dependency_proxy,
    dependency_environment,
    dependency_proxy_identity,
    proxy_from_environment,
)


async def test_resume_freezes_dependency_route_and_scopes_it_to_execution(tmp_path, monkeypatch):
    from synergy_bench import runner
    from synergy_bench.prepare import evaluator_identity
    from synergy_bench.storage import atomic_json, digest

    monkeypatch.setenv("BENCH_TEST_PROXY", "http://proxy.invalid:8080")
    plan = {
        "version": 4,
        "result_version": 5,
        "evaluator": evaluator_identity(),
        "variants": {},
        "tasks": {},
        "config": {"platform": "linux/amd64", "dependency_proxy_env": "BENCH_TEST_PROXY"},
        "schedule": [],
        "dependency_proxy": dependency_proxy_identity("BENCH_TEST_PROXY"),
    }
    plan["digest"] = digest(plan)
    atomic_json(tmp_path / "owner.json", {"kind": "synergy-benchmark-run", "version": 1})
    atomic_json(tmp_path / "plan.json", plan)
    observed = []

    async def execute(*args):
        observed.append(current_dependency_proxy.get())

    monkeypatch.setattr(runner, "execute_plan", execute)
    await runner._resume(tmp_path)
    assert observed == ["http://proxy.invalid:8080"]
    assert current_dependency_proxy.get() is None
    monkeypatch.setenv("BENCH_TEST_PROXY", "http://proxy.invalid:8081")
    with pytest.raises(ValueError, match="Dependency proxy changed"):
        await runner._resume(tmp_path)
    assert len(observed) == 1


def test_proxy_is_explicit_and_credentials_are_not_serialized(monkeypatch):
    monkeypatch.setenv("HTTPS_PROXY", "http://host.invalid:7890")
    assert proxy_from_environment(None) is None
    with pytest.raises(ValueError, match="Missing dependency proxy"):
        proxy_from_environment("BENCH_TEST_PROXY")
    monkeypatch.setenv("BENCH_TEST_PROXY", "http://127.0.0.1:7890")
    assert proxy_from_environment("BENCH_TEST_PROXY") == "http://127.0.0.1:7890"
    for value in ["socks5://localhost:7890", "http://secret:password@localhost:7890", "http://host/?token=secret"]:
        monkeypatch.setenv("BENCH_TEST_PROXY", value)
        with pytest.raises(ValueError) as error:
            proxy_from_environment("BENCH_TEST_PROXY")
        assert "secret" not in str(error.value)
        assert "password" not in str(error.value)


def test_dependency_proxy_bypasses_native_and_recording_loopback():
    env = dependency_environment("http://host.docker.internal:12345")
    assert env["HTTP_PROXY"] == env["http_proxy"] == "http://host.docker.internal:12345"
    assert env["HTTPS_PROXY"] == env["https_proxy"] == env["HTTP_PROXY"]
    assert set(env["NO_PROXY"].split(",")) >= {"localhost", "127.0.0.1", "::1", "host.docker.internal"}


def test_frozen_proxy_identity_detects_route_changes_without_recording_the_endpoint(monkeypatch):
    monkeypatch.setenv("BENCH_TEST_PROXY", "http://127.0.0.1:7890")
    first = dependency_proxy_identity("BENCH_TEST_PROXY")
    assert first == dependency_proxy_identity("BENCH_TEST_PROXY")
    assert "127.0.0.1" not in str(first)
    monkeypatch.setenv("BENCH_TEST_PROXY", "http://127.0.0.1:7891")
    assert first != dependency_proxy_identity("BENCH_TEST_PROXY")
    assert dependency_proxy_identity(None) is None


@pytest.mark.parametrize(
    "payload",
    [b"GET http://dependency.invalid/file HTTP/1.1\r\n\r\n", b"CONNECT dependency.invalid:443 HTTP/1.1\r\n\r\n"],
)
async def test_proxy_relay_preserves_http_and_connect_bytes_and_cleans_up(payload):
    seen = []
    finished = asyncio.Event()

    async def upstream(reader, writer):
        try:
            seen.append(await reader.readuntil(b"\r\n\r\n"))
            writer.write(b"HTTP/1.1 200 OK\r\n\r\n")
            await writer.drain()
            data = await reader.read(4)
            writer.write(data)
            await writer.drain()
        finally:
            writer.close()
            await writer.wait_closed()
            finished.set()

    server = await asyncio.start_server(upstream, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    async with server:
        async with DependencyRelay(f"http://127.0.0.1:{port}", "127.0.0.1") as relay:
            reader, writer = await asyncio.open_connection("127.0.0.1", relay.port)
            writer.write(payload)
            await writer.drain()
            assert await reader.readuntil(b"\r\n\r\n") == b"HTTP/1.1 200 OK\r\n\r\n"
            writer.write(b"body")
            await writer.drain()
            assert await reader.readexactly(4) == b"body"
            writer.close()
            await writer.wait_closed()
            await finished.wait()
        assert not relay.connections
        with pytest.raises(OSError):
            await asyncio.open_connection("127.0.0.1", relay.port)
    assert seen == [payload]


async def test_relay_exit_closes_an_unfinished_download():
    connected = asyncio.Event()
    closed = asyncio.Event()

    async def upstream(reader, writer):
        connected.set()
        try:
            assert await reader.read() == b""
        finally:
            writer.close()
            await writer.wait_closed()
            closed.set()

    server = await asyncio.start_server(upstream, "127.0.0.1", 0)
    async with server:
        port = server.sockets[0].getsockname()[1]
        async with DependencyRelay(f"http://127.0.0.1:{port}", "127.0.0.1") as relay:
            reader, writer = await asyncio.open_connection("127.0.0.1", relay.port)
            await connected.wait()
        await asyncio.wait_for(closed.wait(), 3)
        assert await reader.read() == b""
        writer.close()
        await writer.wait_closed()
        assert not relay.connections
