import asyncio
import json
from contextlib import asynccontextmanager

import aiohttp
from aiohttp import web

from synergy_bench.config import ModelProfile
from synergy_bench.gateway import Gateway, read_ledger
from synergy_bench.usage import aggregate_usage


@asynccontextmanager
async def provider(handler):
    app = web.Application()
    app.router.add_post("/v1/chat/completions", handler)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    try:
        yield f"http://127.0.0.1:{runner.addresses[0][1]}/v1"
    finally:
        await runner.cleanup()


def model(url):
    return ModelProfile(
        model="fixture-one",
        protocol="chat-completions",
        base_url=url,
        api_key_env="FIXTURE_KEY",
        context_window=32000,
        max_output_tokens=2048,
        parameters={"temperature": 0.2},
    )


def test_model_profile_controls_all_sampling_including_absent_native_defaults(tmp_path):
    gateway = Gateway(model("http://provider.invalid/v1"), tmp_path)
    payload, _ = gateway.effective(
        {
            "model": "fixture-one",
            "messages": [],
            "temperature": 0.9,
            "top_p": 0.4,
            "reasoning_effort": "medium",
            "seed": 19,
        },
        "chat-completions",
    )
    assert payload["temperature"] == 0.2
    assert "reasoning_effort" not in payload
    assert "top_p" not in payload
    assert "seed" not in payload


def test_frozen_thinking_switch_overrides_native_reasoning_defaults(tmp_path):
    profile = model("http://provider.invalid/v1").model_copy(
        update={"parameters": {"enable_thinking": False, "temperature": 1}}
    )
    gateway = Gateway(profile, tmp_path)
    payload, _ = gateway.effective(
        {
            "model": "fixture-one",
            "messages": [],
            "enable_thinking": True,
            "thinking": {"type": "enabled"},
            "reasoning_effort": "max",
        },
        "chat-completions",
    )
    assert payload["enable_thinking"] is False
    assert "thinking" not in payload
    assert "reasoning_effort" not in payload
    without_switch, _ = Gateway(model("http://provider.invalid/v1"), tmp_path).effective(
        {"model": "fixture-one", "messages": [], "enable_thinking": True}, "chat-completions"
    )
    assert "enable_thinking" not in without_switch


async def test_real_stream_tool_roundtrip_has_one_bill_per_call(tmp_path, monkeypatch):
    monkeypatch.setenv("FIXTURE_KEY", "upstream-private-test-key")
    bodies = []

    async def handler(request):
        assert request.headers["Authorization"] == "Bearer upstream-private-test-key"
        body = await request.json()
        bodies.append(body)
        response = web.StreamResponse(headers={"Content-Type": "text/event-stream"})
        await response.prepare(request)
        tool = not any(item["role"] == "tool" for item in body["messages"])
        delta = (
            {"tool_calls": [{"index": 0, "id": "call_1", "function": {"name": "read", "arguments": "{}"}}]}
            if tool
            else {"content": "done"}
        )
        for frame in [
            {"choices": [{"delta": delta}]},
            {"choices": [{"delta": {}, "finish_reason": "tool_calls" if tool else "stop"}]},
            {"choices": [], "usage": {"prompt_tokens": 10, "completion_tokens": 3}},
        ]:
            await response.write(("data: " + json.dumps(frame) + "\n\n").encode())
        await response.write(b"data: [DONE]\n\n")
        return response

    async with (
        provider(handler) as url,
        Gateway(
            model(url).model_copy(update={"parameters": {"temperature": 0.2, "enable_thinking": False}}),
            tmp_path,
            bind="127.0.0.1",
        ) as gateway,
    ):
        async with aiohttp.ClientSession(headers={"Authorization": "Bearer " + gateway.token}) as client:
            for inputs in [
                [{"role": "user", "content": "read"}],
                [
                    {"role": "user", "content": "read"},
                    {"type": "function_call", "name": "read", "call_id": "call_1", "arguments": "{}"},
                    {"type": "function_call_output", "call_id": "call_1", "output": "abc"},
                ],
            ]:
                async with client.post(
                    gateway.url + "/responses",
                    json={
                        "model": "fixture-one",
                        "stream": True,
                        "enable_thinking": True,
                        "tools": [{"type": "function", "name": "read", "parameters": {"type": "object"}}],
                        "input": inputs,
                    },
                ) as response:
                    assert response.status == 200
                    assert "response.completed" in await response.text()
    assert len(bodies) == 2
    assert all(body["temperature"] == 0.2 and body["max_tokens"] == 2048 for body in bodies)
    assert all(body["enable_thinking"] is False for body in bodies)
    records = read_ledger(tmp_path)
    assert aggregate_usage(records)["tokens"]["total"]["total"] == 26
    assert len(records) == 2
    assert all(row["parameter_overrides"]["enable_thinking"] == {"native": True, "effective": False} for row in records)
    assert len({row["downstream_response_id"] for row in records}) == 2
    for row in records:
        raw = (tmp_path / row["id"] / "downstream-response.bin").read_text()
        assert "response.completed" in raw
        assert row["downstream_response_id"] in raw
    assert all(
        "upstream-private-test-key" not in path.read_text(errors="replace")
        for path in tmp_path.rglob("*")
        if path.is_file()
    )


async def test_disconnect_retains_an_unknown_request(tmp_path, monkeypatch):
    monkeypatch.setenv("FIXTURE_KEY", "fixture")
    sent = asyncio.Event()

    async def handler(request):
        response = web.StreamResponse(headers={"Content-Type": "text/event-stream"})
        await response.prepare(request)
        await response.write(b'data: {"choices":[{"delta":{"content":"first"}}]}\n\n')
        sent.set()
        await asyncio.sleep(10)
        return response

    async with provider(handler) as url, Gateway(model(url), tmp_path, bind="127.0.0.1") as gateway:
        async with aiohttp.ClientSession(headers={"Authorization": "Bearer " + gateway.token}) as client:
            async with client.post(
                gateway.url + "/chat/completions", json={"model": "fixture-one", "stream": True, "messages": []}
            ) as response:
                await sent.wait()
                await response.content.read(1)
            for _ in range(100):
                if any(row["status"] == "interrupted" for row in read_ledger(tmp_path)):
                    break
                await asyncio.sleep(0.01)
    result = aggregate_usage(read_ledger(tmp_path))
    assert result["attempts"] == 1
    assert result["tokens"]["total"]["unknown"] == 1


async def test_auth_and_model_rejection_cannot_dispatch(tmp_path, monkeypatch):
    monkeypatch.setenv("FIXTURE_KEY", "fixture")
    async with Gateway(model("http://127.0.0.1:1/v1"), tmp_path, bind="127.0.0.1") as gateway:
        async with aiohttp.ClientSession() as client:
            async with client.post(gateway.url + "/chat/completions", json={}) as response:
                assert response.status == 401
            async with client.post(
                gateway.url + "/chat/completions",
                headers={"Authorization": "Bearer " + gateway.token},
                json={"model": "wrong", "messages": []},
            ) as response:
                assert response.status == 400
    assert read_ledger(tmp_path) == []


async def test_large_sse_frame_and_duplicate_cumulative_usage_are_lossless(tmp_path, monkeypatch):
    monkeypatch.setenv("FIXTURE_KEY", "fixture")
    payload = (
        "data: " + json.dumps({"choices": [{"delta": {"content": "a" * 500000}, "finish_reason": "stop"}]}) + "\n\n"
    ).encode()
    usage = b'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n'

    async def handler(request):
        return web.Response(body=payload + usage + usage + b"data: [DONE]\n\n", content_type="text/event-stream")

    async with provider(handler) as url, Gateway(model(url), tmp_path, bind="127.0.0.1") as gateway:
        async with aiohttp.ClientSession(headers={"Authorization": "Bearer " + gateway.token}) as client:
            async with client.post(
                gateway.url + "/chat/completions", json={"model": "fixture-one", "stream": True, "messages": []}
            ) as response:
                assert await response.read() == payload + usage + usage + b"data: [DONE]\n\n"
    records = read_ledger(tmp_path)
    assert records[0]["status"] == "completed"
    assert aggregate_usage(records)["tokens"]["total"]["total"] == 15


async def test_bridge_never_invents_completed_event_for_truncated_stream(tmp_path, monkeypatch):
    monkeypatch.setenv("FIXTURE_KEY", "fixture")

    async def handler(request):
        return web.Response(
            body=b'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n', content_type="text/event-stream"
        )

    body = b""
    async with provider(handler) as url, Gateway(model(url), tmp_path, bind="127.0.0.1") as gateway:
        async with aiohttp.ClientSession(headers={"Authorization": "Bearer " + gateway.token}) as client:
            async with client.post(
                gateway.url + "/responses", json={"model": "fixture-one", "stream": True, "input": "hi"}
            ) as response:
                try:
                    async for chunk in response.content.iter_any():
                        body += chunk
                except aiohttp.ClientPayloadError:
                    pass
    assert b"response.completed" not in body
    assert read_ledger(tmp_path)[0]["status"] == "failed"


async def test_ledger_retains_exact_dispatched_utf8_bytes_and_http_error(tmp_path, monkeypatch):
    monkeypatch.setenv("FIXTURE_KEY", "fixture")
    observed = []

    async def handler(request):
        observed.append(await request.read())
        return web.Response(status=429, text="provider busy", headers={"Retry-After": "1"})

    async with provider(handler) as url, Gateway(model(url), tmp_path, bind="127.0.0.1") as gateway:
        async with aiohttp.ClientSession(headers={"Authorization": "Bearer " + gateway.token}) as client:
            async with client.post(
                gateway.url + "/chat/completions",
                json={"model": "fixture-one", "messages": [{"role": "user", "content": "中文"}]},
            ) as response:
                assert response.status == 429
                assert await response.text() == "provider busy"
    assert len(observed) == 1
    record = read_ledger(tmp_path)[0]
    assert (tmp_path / record["id"] / "upstream.bin").read_bytes() == observed[0]
    assert record["request_bytes"] == len(observed[0])
    assert record["response_bytes"] == len(b"provider busy")
    assert record["retry_after"] == "1"
    assert record["usage"] is None
