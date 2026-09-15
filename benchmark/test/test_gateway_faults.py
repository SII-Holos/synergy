import asyncio
import errno
import os
import signal
import socket
import sys

import aiohttp
import pytest
from aiohttp import web
from test_gateway import model, provider

from synergy_bench.gateway import Gateway, read_ledger
from synergy_bench.prepare import BENCHMARK
from synergy_bench.storage import read_json
from synergy_bench.usage import aggregate_usage


@pytest.mark.parametrize("status", [429, 500, 502, 503, 504])
async def test_provider_failure_is_one_retained_attempt_without_observer_retry(tmp_path, monkeypatch, status):
    monkeypatch.setenv("FIXTURE_KEY", "fixture")
    calls = []

    async def handler(request):
        calls.append(await request.json())
        return web.Response(status=status, text="native failure")

    async with provider(handler) as url, Gateway(model(url), tmp_path, bind="127.0.0.1") as gateway:
        async with aiohttp.ClientSession() as client:
            async with client.post(
                gateway.url + "/chat/completions",
                headers={"Authorization": "Bearer " + gateway.token},
                json={"model": "fixture-one", "messages": []},
            ) as response:
                assert response.status == status
                assert await response.text() == "native failure"
    assert len(calls) == 1
    assert aggregate_usage(read_ledger(tmp_path))["tokens"]["total"]["unknown"] == 1


@pytest.mark.parametrize("first_byte", [False, True])
async def test_first_byte_and_midstream_deadlines_preserve_unknown_usage(tmp_path, monkeypatch, first_byte):
    monkeypatch.setenv("FIXTURE_KEY", "fixture")
    release = asyncio.Event()

    async def handler(request):
        response = web.StreamResponse(headers={"Content-Type": "text/event-stream"})
        if first_byte:
            await response.prepare(request)
            await response.write(b'data: {"choices":[{"delta":{"content":"retained"}}]}\n\n')
        await release.wait()
        return response

    try:
        async with (
            provider(handler) as url,
            Gateway(model(url), tmp_path, bind="127.0.0.1", stream_timeout=0.05) as gateway,
        ):
            async with aiohttp.ClientSession() as client:
                async with client.post(
                    gateway.url + "/responses",
                    headers={"Authorization": "Bearer " + gateway.token},
                    json={"model": "fixture-one", "stream": True, "input": "hello"},
                ) as response:
                    try:
                        await response.read()
                    except aiohttp.ClientPayloadError:
                        pass
            release.set()
    finally:
        release.set()
    records = read_ledger(tmp_path)
    assert len(records) == 1 and records[0]["status"] == "failed"
    assert aggregate_usage(records)["tokens"]["total"]["unknown"] == 1
    if first_byte:
        assert b"retained" in (tmp_path / records[0]["id"] / "response.bin").read_bytes()


async def test_proxy_failure_is_durable_before_any_provider_response(tmp_path, monkeypatch):
    monkeypatch.setenv("FIXTURE_KEY", "fixture")
    monkeypatch.setenv("HTTP_PROXY", "http://127.0.0.1:1")
    monkeypatch.setenv("NO_PROXY", "")
    async with Gateway(
        model("http://unresolvable.invalid/v1"), tmp_path, bind="127.0.0.1", connect_timeout=0.05
    ) as gateway:
        async with aiohttp.ClientSession(trust_env=False) as client:
            async with client.post(
                gateway.url + "/chat/completions",
                headers={"Authorization": "Bearer " + gateway.token},
                json={"model": "fixture-one", "messages": []},
            ) as response:
                assert response.status == 502
    record = read_ledger(tmp_path)[0]
    assert record["status"] == "failed" and record["usage"] is None
    assert (tmp_path / record["id"] / "upstream.bin").exists()


async def test_dns_failure_retains_one_unknown_request_without_proxy(tmp_path, monkeypatch):
    monkeypatch.setenv("FIXTURE_KEY", "fixture")
    monkeypatch.setenv("NO_PROXY", "*")
    monkeypatch.setenv("no_proxy", "*")
    loop = asyncio.get_running_loop()
    original = loop.getaddrinfo
    lookups = []

    async def resolve(host, *args, **kwargs):
        if host == "unresolvable.invalid":
            lookups.append(host)
            raise socket.gaierror(socket.EAI_NONAME, "deterministic DNS failure")
        return await original(host, *args, **kwargs)

    monkeypatch.setattr(loop, "getaddrinfo", resolve)
    async with Gateway(model("http://unresolvable.invalid/v1"), tmp_path, bind="127.0.0.1") as gateway:
        async with aiohttp.ClientSession(trust_env=False) as client:
            async with client.post(
                gateway.url + "/chat/completions",
                headers={"Authorization": "Bearer " + gateway.token},
                json={"model": "fixture-one", "messages": []},
            ) as response:
                assert response.status == 502
    records = read_ledger(tmp_path)
    assert lookups == ["unresolvable.invalid"]
    assert len(records) == 1 and records[0]["status"] == "failed"
    assert records[0]["usage"] is None and records[0]["http_status"] is None
    assert aggregate_usage(records)["tokens"]["total"]["unknown"] == 1
    assert (tmp_path / records[0]["id"] / "upstream.bin").exists()


async def test_disk_full_before_dispatch_never_calls_provider_or_discards_prior_evidence(tmp_path, monkeypatch):
    from synergy_bench.storage import atomic_json

    monkeypatch.setenv("FIXTURE_KEY", "fixture")
    calls = []

    async def handler(request):
        calls.append(await request.json())
        return web.json_response({"choices": [], "usage": {"prompt_tokens": 3, "completion_tokens": 2}})

    async with provider(handler) as url, Gateway(model(url), tmp_path, bind="127.0.0.1") as gateway:
        async with aiohttp.ClientSession() as client:
            options = {
                "headers": {"Authorization": "Bearer " + gateway.token},
                "json": {"model": "fixture-one", "messages": []},
            }
            async with client.post(gateway.url + "/chat/completions", **options) as response:
                assert response.status == 200
                await response.read()
            prior = read_ledger(tmp_path)
            prior_bytes = (tmp_path / prior[0]["id"] / "request.json").read_bytes()

            def persist(path, value):
                if path.name == "request.json":
                    raise OSError(errno.ENOSPC, "deterministic disk full")
                atomic_json(path, value)

            monkeypatch.setattr("synergy_bench.gateway.atomic_json", persist)
            async with client.post(gateway.url + "/chat/completions", **options) as response:
                assert response.status == 500
                await response.read()
    assert len(calls) == 1
    assert read_ledger(tmp_path) == prior
    assert (tmp_path / prior[0]["id"] / "request.json").read_bytes() == prior_bytes
    assert len(list(tmp_path.glob("*/upstream.bin"))) == 2


@pytest.mark.skipif(os.name == "nt", reason="POSIX parent kill contract")
async def test_killed_recorder_keeps_dispatch_intent_and_already_forwarded_bytes(tmp_path, monkeypatch):
    monkeypatch.setenv("FIXTURE_KEY", "fixture")
    release = asyncio.Event()
    raw = b'data: {"choices":[{"delta":{"content":"survives-parent-kill"}}]}\n\n'

    async def handler(request):
        response = web.StreamResponse(headers={"Content-Type": "text/event-stream"})
        await response.prepare(request)
        await response.write(raw)
        await release.wait()
        return response

    script = """import asyncio,sys
from pathlib import Path
from synergy_bench.gateway import Gateway
from synergy_bench.config import ModelProfile
from synergy_bench.storage import atomic_json
async def main():
    root=Path(sys.argv[2])
    model=ModelProfile(model="fixture-one",protocol="chat-completions",base_url=sys.argv[1],api_key_env="FIXTURE_KEY",context_window=32000,max_output_tokens=2048)
    async with Gateway(model,root/"wire",bind="127.0.0.1") as gateway:
        atomic_json(root/"ready.json",{"url":gateway.url,"token":gateway.token})
        await asyncio.Future()
asyncio.run(main())
"""
    async with provider(handler) as url:
        env = {**os.environ, "PYTHONPATH": str(BENCHMARK / "src")}
        with (tmp_path / "child.log").open("w") as log:
            child = await asyncio.create_subprocess_exec(
                sys.executable, "-c", script, url, str(tmp_path), env=env, stdout=log, stderr=log
            )
            try:
                async with asyncio.timeout(10):
                    while not (tmp_path / "ready.json").exists():
                        if child.returncode is not None:
                            pytest.fail((tmp_path / "child.log").read_text())
                        await asyncio.sleep(0.02)
                ready = read_json(tmp_path / "ready.json")
                async with aiohttp.ClientSession() as client:
                    async with client.post(
                        ready["url"] + "/chat/completions",
                        headers={"Authorization": "Bearer " + ready["token"]},
                        json={"model": "fixture-one", "messages": [], "stream": True},
                    ) as response:
                        assert await response.content.readexactly(len(raw)) == raw
                        os.kill(child.pid, signal.SIGKILL)
                        await asyncio.wait_for(child.wait(), timeout=5)
                records = read_ledger(tmp_path / "wire")
                assert len(records) == 1 and records[0]["status"] == "dispatching"
                assert aggregate_usage(records)["tokens"]["total"]["unknown"] == 1
                assert (tmp_path / "wire" / records[0]["id"] / "response.bin").read_bytes() == raw
            finally:
                release.set()
                if child.returncode is None:
                    child.kill()
                await asyncio.wait_for(child.wait(), timeout=5)
