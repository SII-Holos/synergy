import asyncio
import copy
import json
import subprocess

import aiohttp
import pytest
from aiohttp import web
from test_matrix_docker import (
    assert_compaction_continuation,
    assert_equivalent_profiles,
    assert_fixture_models,
    assert_fixture_usage,
    assert_native_control,
    fixture_profiles,
    fixture_provider,
)

from synergy_bench.config import ModelProfile
from synergy_bench.gateway import Gateway, read_ledger
from synergy_bench.usage import aggregate_usage


def test_business_control_rejects_missing_compaction_continuation_and_accounting():
    transcript = {
        "rootSessionID": "session",
        "sessions": [
            {
                "info": {"id": "session"},
                "messages": [
                    {"info": {"role": "assistant", "summary": True, "finish": "stop"}, "parts": []},
                    {
                        "info": {"role": "assistant"},
                        "parts": [
                            {
                                "type": "tool",
                                "tool": "bash",
                                "state": {"status": "completed", "output": "BENCH_OBSERVATION_VERIFIED=7\n"},
                            }
                        ],
                    },
                ],
            }
        ],
    }
    usage = {"attempts": 2, "tokens": {"input": {"known": 300, "unknown": 0, "total": 300}}}
    assert_compaction_continuation(transcript, usage, inputs=[100, 200])
    for messages in [transcript["sessions"][0]["messages"][:1], transcript["sessions"][0]["messages"][1:]]:
        broken = copy.deepcopy(transcript)
        broken["sessions"][0]["messages"] = messages
        with pytest.raises(AssertionError, match="compaction|continued file edits"):
            assert_compaction_continuation(broken, usage, inputs=[100, 200])
    with pytest.raises(AssertionError, match="usage"):
        assert_compaction_continuation(transcript, usage, inputs=[100, 201])


@pytest.mark.parametrize("protocol", ["chat-completions", "responses"])
def test_representative_long_model_keeps_the_same_execution_conditions(protocol):
    profiles = fixture_profiles(protocol, "http://127.0.0.1/v1", long_session=True)
    assert_equivalent_profiles(profiles)
    changed = copy.deepcopy(profiles)
    changed["fixture-two"]["context_window"] //= 2
    with pytest.raises(AssertionError, match="execution conditions"):
        assert_equivalent_profiles(changed)


@pytest.mark.parametrize("protocol", ["chat-completions", "responses"])
@pytest.mark.parametrize("model", ["fixture-one", "fixture-two"])
async def test_native_usage_assertion_checks_the_actual_fixture_wire(tmp_path, monkeypatch, protocol, model):
    monkeypatch.setenv("BENCH_FIXTURE_KEY", "fixture")
    changed_usage = False

    async def handler(request):
        return await fixture_provider(request, input_tokens=999 if changed_usage else None)

    app = web.Application()
    endpoint = "/responses" if protocol == "responses" else "/chat/completions"
    app.router.add_post("/v1" + endpoint, handler)
    server = web.AppRunner(app)
    await server.setup()
    await web.TCPSite(server, "127.0.0.1", 0).start()
    try:
        profiles = fixture_profiles(protocol, f"http://127.0.0.1:{server.addresses[0][1]}/v1", long_session=True)
        async with Gateway(ModelProfile(**profiles[model]), tmp_path, bind="127.0.0.1") as gateway:
            async with aiohttp.ClientSession(headers={"Authorization": "Bearer " + gateway.token}) as client:
                for changed_usage in [False, True]:
                    async with client.post(
                        gateway.url + endpoint,
                        json={"model": model, "input" if protocol == "responses" else "messages": [], "stream": True},
                    ) as response:
                        assert response.status == 200
                        await response.read()
                    usage = aggregate_usage(read_ledger(tmp_path))
                    if changed_usage:
                        with pytest.raises(AssertionError, match="input usage"):
                            assert_fixture_usage(usage, model, minimum_requests=1)
                    else:
                        assert_fixture_usage(usage, model, minimum_requests=1)
                        with pytest.raises(AssertionError, match="request count"):
                            assert_fixture_usage(usage, model, minimum_requests=2)
    finally:
        await server.cleanup()


def test_native_control_rejects_wrong_identity_jit_and_early_completion():
    records = [
        {
            "type": "tool_use",
            "part": {"callID": str(index), "tool": tool, "state": {"status": "completed", "output": output}},
        }
        for index, (tool, output) in enumerate(
            [
                (
                    "bash",
                    "BENCH_NATIVE_PHASE=start\nBENCH_SYNERGY_WRAPPER_BUN_JSC_useJIT=1\n"
                    "BENCH_SYNERGY_CLI_BUN_JSC_useJIT=1\n",
                ),
                ("view_file", "[/app/observation.txt#abc]\n0|row 0 中😀\n"),
                ("revise_file", "changed 2"),
                (
                    "bash",
                    "BENCH_NATIVE_PHASE=end\nBENCH_SYNERGY_WRAPPER_BUN_JSC_useJIT=1\n"
                    "BENCH_SYNERGY_CLI_BUN_JSC_useJIT=1\nBENCH_OBSERVATION_VERIFIED=3\n",
                ),
            ]
        )
    ]
    assert_native_control(records, tool_turns=4, bun_jit=True, observations=True)
    with pytest.raises(AssertionError, match="tool roundtrips"):
        assert_native_control(records[:-1], tool_turns=4, bun_jit=True, observations=True)
    wrong_jit = json.loads(json.dumps(records).replace("CLI_BUN_JSC_useJIT=1", "CLI_BUN_JSC_useJIT=0"))
    with pytest.raises(AssertionError, match="CLI JIT"):
        assert_native_control(wrong_jit, tool_turns=4, bun_jit=True, observations=True)
    mixed_jit = copy.deepcopy(records)
    mixed_jit[-1]["part"]["state"]["output"] += "BENCH_SYNERGY_CLI_BUN_JSC_useJIT=0\n"
    with pytest.raises(AssertionError, match="end CLI JIT"):
        assert_native_control(mixed_jit, tool_turns=4, bun_jit=True, observations=True)
    missing_edit = json.loads(json.dumps(records).replace("BENCH_OBSERVATION_VERIFIED=3", "unverified"))
    with pytest.raises(AssertionError, match="verified file edits"):
        assert_native_control(missing_edit, tool_turns=4, bun_jit=True, observations=True)
    manifest = {"snapshots": [{"calls": [{"model": {"modelID": "fixture-two"}}]}]}
    assert_fixture_models(manifest, "fixture-two")
    with pytest.raises(AssertionError, match="model identity"):
        assert_fixture_models(manifest, "fixture-one")


async def test_observation_fixture_requires_the_file_edit_to_reach_the_disk(tmp_path):
    async def handler(request):
        return await fixture_provider(
            request, observation_turn=int(request.query["turn"]), observation_directory=str(tmp_path)
        )

    app = web.Application()
    app.router.add_post("/v1/chat/completions", handler)
    server = web.AppRunner(app)
    await server.setup()
    await web.TCPSite(server, "127.0.0.1", 0).start()
    tools = [
        {"type": "function", "function": {"name": name, "parameters": {"properties": properties}}}
        for name, properties in [("bash", {"command": {"type": "string"}}), ("view_file", {}), ("revise_file", {})]
    ]
    try:
        async with aiohttp.ClientSession() as client:
            commands = []
            for turn in range(4):
                async with client.post(
                    f"http://127.0.0.1:{server.addresses[0][1]}/v1/chat/completions",
                    params={"turn": turn},
                    json={
                        "model": "fixture-one",
                        "messages": [{"role": "user", "content": f"[{tmp_path}/observation.txt#abc]"}],
                        "tools": tools,
                    },
                ) as response:
                    assert response.status == 200
                    function = (await response.json())["choices"][0]["message"]["tool_calls"][0]["function"]
                    commands.append((function["name"], json.loads(function["arguments"])))
        assert [name for name, _ in commands] == ["bash", "view_file", "revise_file", "bash"]
        await asyncio.to_thread(subprocess.run, ["sh", "-c", commands[0][1]["command"]], check=True, timeout=10)
        file = tmp_path / "observation.txt"
        assert "中😀" in file.read_text()
        assert commands[1][1] == {"filePath": str(file), "limit": 32}
        assert commands[2][1]["input"] == f"[{file}#abc]\nSWAP 1..1:\n+changed 2"
        for edited in [False, True]:
            if edited:
                file.write_text("changed 2\n" + "\n".join(file.read_text().splitlines()[1:]))
            result = await asyncio.to_thread(
                subprocess.run,
                ["sh", "-c", commands[3][1]["command"]],
                capture_output=True,
                text=True,
                timeout=10,
            )
            assert (result.returncode == 0) is edited
            assert ("BENCH_OBSERVATION_VERIFIED=3" in result.stdout) is edited
    finally:
        await server.cleanup()
