import asyncio
import json
import os
import re
import shlex
import shutil
import sys
import uuid
import zipfile

import pytest
import yaml
from aiohttp import web

from synergy_bench.catalog import tree_digest
from synergy_bench.evaluator import freeze_evaluator, recorded_environment
from synergy_bench.prepare import BENCHMARK, evaluator_identity
from synergy_bench.process import run_process
from synergy_bench.source import git
from synergy_bench.storage import atomic_json, read_json

pytestmark = pytest.mark.skipif(os.environ.get("SYNERGY_BENCH_DOCKER") != "1", reason="Explicit native Docker matrix")


def fixture_profiles(protocol, base_url, *, long_session=False, unattended=False, business=False):
    return {
        name: {
            "model": name,
            "protocol": protocol,
            "base_url": base_url,
            "api_key_env": "BENCH_FIXTURE_KEY",
            "context_window": 65536 if business else 1048576 if unattended else 1000000 if long_session else 32000,
            "max_output_tokens": 2048 if business else 131072 if unattended else 393216 if long_session else 2048,
            "parameters": {"thinking": {"type": "enabled"}, "reasoning_effort": "low", "temperature": 1}
            if unattended
            else {"enable_thinking": False}
            if protocol == "chat-completions"
            else {"reasoning": {"effort": "none"}},
        }
        for name in ("fixture-one", "fixture-two")
    }


def assert_equivalent_profiles(profiles):
    conditions = [{key: value for key, value in profile.items() if key != "model"} for profile in profiles.values()]
    assert conditions and all(value == conditions[0] for value in conditions), "Fixture execution conditions differ"


def assert_fixture_models(manifest, model):
    actual = {call["model"]["modelID"] for snapshot in manifest["snapshots"] for call in snapshot["calls"]}
    assert actual == {model}, f"Native model identity differs: {actual} != {model}"


def assert_fixture_usage(usage, model, *, minimum_requests):
    attempts = usage["attempts"]
    assert attempts >= minimum_requests, "Native request count stopped before the control completed"
    inputs = {"fixture-one": 100, "fixture-two": 200}[model]
    for field, count in {"input": inputs, "output": 10, "total": inputs + 10, "cacheRead": 40, "reasoning": 0}.items():
        assert usage["tokens"][field] == {
            "known": attempts * count,
            "unknown": 0,
            "total": attempts * count,
        }, f"Native {field} usage differs from the deterministic provider"


def assert_native_control(records, *, tool_turns, bun_jit, observations):
    completed = {
        event["part"]["callID"]: event["part"]
        for event in records
        if event.get("type") == "tool_use" and event["part"]["state"]["status"] == "completed"
    }
    assert len(completed) >= tool_turns, "Native tool roundtrips stopped before the control completed"
    outputs = [part["state"]["output"] for part in completed.values() if part["tool"] == "bash"]
    for phase in ["start", "end"]:
        evidence = [output for output in outputs if f"BENCH_NATIVE_PHASE={phase}" in output]
        assert evidence, f"Missing {phase} native process evidence"
        for kind in ["WRAPPER", "CLI"]:
            assert all(
                set(re.findall(rf"^BENCH_SYNERGY_{kind}_BUN_JSC_useJIT=(\S+)$", output, re.MULTILINE))
                == {str(int(bun_jit))}
                for output in evidence
            ), f"Native {phase} {kind} JIT setting differs"
    if observations:
        assert {"bash", "view_file", "revise_file"} <= {part["tool"] for part in completed.values()}
        verified = {
            int(turn)
            for output in outputs
            for turn in re.findall(r"^BENCH_OBSERVATION_VERIFIED=(\d+)$", output, re.MULTILINE)
        }
        assert verified == set(range(3, tool_turns, 4)), "Missing verified file edits"


def assert_compaction_continuation(transcript, usage, *, inputs):
    session = next(
        session for session in transcript["sessions"] if session["info"]["id"] == transcript["rootSessionID"]
    )
    messages = session["messages"]
    boundary = next(
        (
            index
            for index, message in enumerate(messages)
            if message["info"].get("summary") and message["info"].get("finish")
        ),
        None,
    )
    assert boundary is not None, "Missing committed native compaction"
    assert any(
        part.get("type") == "tool"
        and part.get("tool") == "bash"
        and part["state"]["status"] == "completed"
        and "BENCH_OBSERVATION_VERIFIED=" in part["state"]["output"]
        for message in messages[boundary + 1 :]
        for part in message["parts"]
    ), "Missing continued file edits after compaction"
    assert usage["attempts"] == len(inputs), "Native usage lost a request"
    assert usage["tokens"]["input"] == {"known": sum(inputs), "unknown": 0, "total": sum(inputs)}, (
        "Native usage differs"
    )


async def fixture_provider(
    request,
    *,
    command_prefix="",
    input_tokens=None,
    force_tool=None,
    observation_turn=None,
    observation_directory="/app",
    completion="Done",
    allocation_pressure=True,
):
    body = await request.json()
    responses = request.path.endswith("/responses")
    messages = body["input"] if responses else body["messages"]
    if isinstance(messages, str):
        messages = [{"role": "user", "content": messages}]
    tools = body.get("tools", [])
    call = bool(tools) and not any(
        message.get("role") == "tool" or message.get("type") == "function_call_output" for message in messages
    )
    if force_tool is not None:
        call = bool(tools) and force_tool
    call_id = "fixture-call-" + uuid.uuid4().hex
    message = {"role": "assistant", "content": completion}
    namespace = None
    if call:
        functions = []
        for tool in tools:
            if tool["type"] == "namespace":
                functions.extend({**nested, "namespace": tool["name"]} for nested in tool["tools"])
            elif tool["type"] == "function":
                functions.append(tool.get("function", tool))
        selected = next(
            tool
            for tool in functions
            if tool["name"].split("__")[-1].lower() in {"bash", "exec_command", "shell", "shell_command"}
        )
        namespace = selected.get("namespace")
        properties = selected.get("parameters", {}).get("properties", {})
        args = {}
        for key in selected.get("parameters", {}).get("required", []):
            spec = properties.get(key, {})
            args[key] = (
                False
                if spec.get("type") == "boolean"
                else 1000
                if spec.get("type") in {"number", "integer"}
                else "benchmark fixture"
            )
        marker = re.search(r"BENCHMARK_TOOL_[a-f0-9]{32}", json.dumps(messages))
        command = "printf '" + marker[0] + "\\n'" if marker else "printf verified > /app/marker"
        command = command_prefix + command
        field = next((key for key in ["command", "cmd", "code"] if key in properties), "command")
        args[field] = ["sh", "-c", command] if properties.get(field, {}).get("type") == "array" else command
        if observation_turn is not None:
            observation_file = observation_directory + "/observation.txt"
            phase = observation_turn % 4
            if phase in (1, 2):
                name = "view_file" if phase == 1 else "revise_file"
                selected = next(tool for tool in functions if tool["name"].split("__")[-1] == name)
                namespace = selected.get("namespace")
                if phase == 1:
                    args = {"filePath": observation_file, "limit": 32}
                else:
                    headers = re.findall(r"\[[^\]\n]*observation\.txt#([A-Za-z0-9]+)\]", json.dumps(messages))
                    assert headers, "Native view_file did not return an anchored snapshot"
                    args = {"input": f"[{observation_file}#{headers[-1]}]\nSWAP 1..1:\n+changed {observation_turn}"}
            else:
                script = (
                    "from pathlib import Path; "
                    + ("memory=bytearray(8*1024**2); " if allocation_pressure else "")
                    + f"Path({observation_file!r}).write_text(''.join("
                    "f'row {i} '+('中😀'*128)+'\\n' for i in range(500))); "
                    f"Path({(observation_directory + '/marker')!r}).write_text('verified')"
                    if phase == 0
                    else "from pathlib import Path; "
                    f"assert Path({observation_file!r}).read_text().startswith('changed {observation_turn - 1}\\n'); "
                    f"print('BENCH_OBSERVATION_VERIFIED={observation_turn}')"
                )
                command = command_prefix + shlex.join(["python3", "-c", script])
                args[field] = command
        message = {
            "role": "assistant",
            "tool_calls": [
                {
                    "index": 0,
                    "id": call_id,
                    "type": "function",
                    "function": {"name": selected["name"], "arguments": json.dumps(args)},
                }
            ],
        }
    usage = {
        "prompt_tokens": input_tokens if input_tokens is not None else 100 if body["model"] == "fixture-one" else 200,
        "completion_tokens": 10,
        "prompt_tokens_details": {"cached_tokens": 40},
        "completion_tokens_details": {"reasoning_tokens": 0},
    }
    reason = "tool_calls" if call else "stop"
    common = {"id": "fixture", "created": 0, "model": body["model"]}
    if responses:
        function = message.get("tool_calls", [{}])[0].get("function", {})
        item = (
            {
                "type": "function_call",
                "id": "fc_fixture",
                "call_id": call_id,
                "name": function.get("name"),
                "arguments": function.get("arguments"),
                "status": "completed",
                **({"namespace": namespace} if namespace else {}),
            }
            if call
            else {
                "type": "message",
                "id": "msg_fixture",
                "role": "assistant",
                "status": "completed",
                "content": [{"type": "output_text", "text": completion, "annotations": []}],
            }
        )
        terminal = {
            "id": "resp_fixture_" + uuid.uuid4().hex,
            "object": "response",
            "created_at": 0,
            "status": "completed",
            "model": body["model"],
            "output": [item],
            "usage": {
                "input_tokens": usage["prompt_tokens"],
                "output_tokens": 10,
                "total_tokens": usage["prompt_tokens"] + 10,
                "input_tokens_details": {"cached_tokens": 40},
                "output_tokens_details": {"reasoning_tokens": 0},
            },
        }
        if not body.get("stream"):
            return web.json_response(terminal)
        events = [
            {
                "type": "response.created",
                "response": {**terminal, "status": "in_progress", "output": [], "usage": None},
            },
            {
                "type": "response.output_item.added",
                "output_index": 0,
                "item": {**item, "status": "in_progress", **({"arguments": ""} if call else {"content": []})},
            },
        ]
        if call:
            events.extend(
                [
                    {
                        "type": "response.function_call_arguments.delta",
                        "item_id": item["id"],
                        "output_index": 0,
                        "delta": function["arguments"],
                    },
                    {
                        "type": "response.function_call_arguments.done",
                        "item_id": item["id"],
                        "output_index": 0,
                        "arguments": function["arguments"],
                    },
                ]
            )
        else:
            events.extend(
                [
                    {
                        "type": "response.content_part.added",
                        "item_id": item["id"],
                        "output_index": 0,
                        "content_index": 0,
                        "part": {"type": "output_text", "text": "", "annotations": []},
                    },
                    {
                        "type": "response.output_text.delta",
                        "item_id": item["id"],
                        "output_index": 0,
                        "content_index": 0,
                        "delta": completion,
                    },
                    {
                        "type": "response.output_text.done",
                        "item_id": item["id"],
                        "output_index": 0,
                        "content_index": 0,
                        "text": completion,
                    },
                    {
                        "type": "response.content_part.done",
                        "item_id": item["id"],
                        "output_index": 0,
                        "content_index": 0,
                        "part": item["content"][0],
                    },
                ]
            )
        events.extend(
            [
                {"type": "response.output_item.done", "output_index": 0, "item": item},
                {"type": "response.completed", "response": terminal},
            ]
        )
        return web.Response(
            body="".join(
                "event: " + event["type"] + "\ndata: " + json.dumps({**event, "sequence_number": index}) + "\n\n"
                for index, event in enumerate(events)
            ),
            content_type="text/event-stream",
        )
    if not body.get("stream"):
        return web.json_response(
            {
                **common,
                "object": "chat.completion",
                "choices": [{"index": 0, "message": message, "finish_reason": reason}],
                "usage": usage,
            }
        )
    response = web.StreamResponse(headers={"Content-Type": "text/event-stream"})
    await response.prepare(request)
    for frame in [
        {
            **common,
            "object": "chat.completion.chunk",
            "choices": [{"index": 0, "delta": message, "finish_reason": None}],
        },
        {**common, "object": "chat.completion.chunk", "choices": [{"index": 0, "delta": {}, "finish_reason": reason}]},
        {"choices": [], "usage": usage},
    ]:
        await response.write(("data: " + json.dumps(frame) + "\n\n").encode())
    await response.write(b"data: [DONE]\n\n")
    return response


@pytest.mark.parametrize(
    ("protocol", "model"),
    [("chat-completions", "fixture-one"), ("responses", "fixture-two")],
    ids=["chat-completions", "responses"],
)
async def test_native_matrix_preserves_protocol_and_adapter_behavior(tmp_path, monkeypatch, protocol, model):
    await run_native_matrix(tmp_path, monkeypatch, protocol, models=(model,))


@pytest.mark.skipif(
    os.environ.get("SYNERGY_BENCH_LONG_DIAGNOSTIC") != "1", reason="Historical sustained JIT diagnostic"
)
@pytest.mark.parametrize("protocol", ["chat-completions", "responses"])
@pytest.mark.parametrize("bun_jit", [False, True], ids=["jitless", "jit"])
async def test_synergy_diagnostic_120_rounds(tmp_path, monkeypatch, protocol, bun_jit):
    await run_native_matrix(
        tmp_path, monkeypatch, protocol, long_session=True, tool_turns=120, bun_jit=bun_jit, models=("fixture-one",)
    )


async def test_synergy_compaction_preserves_file_edits_recording_and_usage(tmp_path, monkeypatch):
    if "synergy" not in os.environ.get("SYNERGY_BENCH_TEST_HARNESSES", "synergy").split(","):
        pytest.skip("Synergy compaction belongs to the Synergy native matrix")
    await run_native_matrix(
        tmp_path,
        monkeypatch,
        "responses",
        long_session=True,
        business=True,
        tool_turns=48,
        bun_jit=True,
        models=("fixture-one",),
    )


@pytest.mark.parametrize(
    ("bun_jit", "protocol", "model"),
    [
        pytest.param(True, "chat-completions", "fixture-one", id="jit-chat-completions-fixture-one"),
        pytest.param(True, "responses", "fixture-two", id="jit-responses-fixture-two"),
        pytest.param(False, "chat-completions", "fixture-two", id="jitless-chat-completions-fixture-two"),
        pytest.param(False, "responses", "fixture-one", id="jitless-responses-fixture-one"),
    ],
)
async def test_synergy_native_semantics(tmp_path, monkeypatch, bun_jit, protocol, model):
    if "synergy" not in os.environ.get("SYNERGY_BENCH_TEST_HARNESSES", "synergy").split(","):
        pytest.skip("Synergy native semantics belong to the Synergy native matrix")
    await run_native_matrix(
        tmp_path,
        monkeypatch,
        protocol,
        long_session=True,
        tool_turns=2,
        bun_jit=bun_jit,
        observations=False,
        models=(model,),
    )


@pytest.mark.parametrize("empty_stop", [False, True], ids=["tool-roundtrip", "empty-provider-stop"])
async def test_synergy_preserves_task_home_and_native_stopping(tmp_path, monkeypatch, empty_stop):
    if "synergy" not in os.environ.get("SYNERGY_BENCH_TEST_HARNESSES", "synergy").split(","):
        pytest.skip("Task-home and native-stop controls belong to the Synergy native matrix")
    await run_native_matrix(
        tmp_path,
        monkeypatch,
        "chat-completions",
        long_session=True,
        tool_turns=2,
        bun_jit=True,
        task_home=True,
        empty_stop=empty_stop,
        models=("fixture-one",),
    )


async def test_synergy_unattended_sessions_inherit_and_exclude_question(tmp_path, monkeypatch):
    await run_native_matrix(
        tmp_path, monkeypatch, "chat-completions", unattended=True, bun_jit=True, models=("fixture-two",)
    )


async def run_native_matrix(
    tmp_path,
    monkeypatch,
    protocol,
    *,
    long_session=False,
    tool_turns=120,
    bun_jit=False,
    task_home=False,
    empty_stop=False,
    unattended=False,
    business=False,
    observations=True,
    models=("fixture-one", "fixture-two"),
):
    from synergy_bench.runner import verify_terminal

    create_matrix_suite(tmp_path, task_home=task_home)
    business_turns = 0
    continue_until = None
    business_inputs = []

    native_probe = shlex.join(
        [
            "python3",
            "-c",
            "from pathlib import Path; "
            "pid=Path('/logs/agent/runner.pid').read_text().strip(); "
            "root=Path('/proc')/pid; "
            "synergy=any(entry in (root/'cmdline').read_bytes().split(bytes([0])) for entry in "
            "[b'/opt/synergy/runtime/trial.ts',b'/opt/synergy/runtime/external.mjs']); "
            "children=(root/'task'/pid/'children').read_text().split(); "
            "processes=[('WRAPPER',pid),*[('CLI',child) for child in children]] if synergy else []; "
            "[(print('BENCH_SYNERGY_'+kind+'_'+value.decode())) for kind,child in processes "
            "for value in (Path('/proc')/child/'environ').read_bytes().split(bytes([0])) "
            "if value.startswith(b'BUN_JSC_useJIT=')]",
        ]
    )

    async def provider_with_runtime_evidence(request):
        nonlocal business_turns, continue_until
        body = await request.json()
        if unattended:
            assert body["thinking"] == {"type": "enabled"}
            assert body["reasoning_effort"] == "low"
            assert body["max_tokens"] == 131072
            assert all(
                tool.get("function", tool).get("name", "").split("__")[-1] != "question"
                for tool in body.get("tools", [])
            )
        elif protocol == "chat-completions":
            assert body["enable_thinking"] is False
            assert "reasoning_effort" not in body
        messages = body.get("messages", body.get("input", []))
        functions = [
            nested
            for tool in body.get("tools", [])
            for nested in (tool["tools"] if tool["type"] == "namespace" else [tool.get("function", tool)])
        ]
        native_tools = any(tool.get("name", "").split("__")[-1] == "bash" for tool in functions)
        count = sum(
            message.get("role") == "tool" or message.get("type") == "function_call_output"
            for message in messages
            if isinstance(message, dict)
        )
        probe = "BENCHMARK_TOOL_" in json.dumps(messages)
        compacting = business and "Write the compaction continuation summary now." in json.dumps(messages)
        if business and compacting and continue_until is None:
            continue_until = ((business_turns + 3) // 4 + 1) * 4
        if business and not probe:
            count = business_turns
        target = continue_until if business and continue_until is not None else tool_turns
        phase = "start" if count == 0 else "end" if count == target - 1 else None
        process_evidence = (
            (f"printf 'BENCH_NATIVE_PHASE={phase}\\n'; " if long_session and phase else "")
            + 'printf "BENCH_JIT=%s\\n" "${BUN_JSC_useJIT-unset}"; '
            + native_probe
            + "; "
            if not long_session or probe or phase
            else ""
        )
        if empty_stop and not probe and count >= tool_turns:
            return web.Response(
                text='data: {"id":"empty-stop","object":"chat.completion.chunk","created":0,'
                '"model":"fixture","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n'
                'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":0}}\n\n'
                "data: [DONE]\n\n",
                content_type="text/event-stream",
            )
        environment_check = (
            shlex.join(
                [
                    "python3",
                    "-c",
                    "from pathlib import Path; "
                    "pid=Path('/logs/agent/runner.pid').read_text().strip(); "
                    "children=(Path('/proc')/pid/'task'/pid/'children').read_text().split(); "
                    "assert children; "
                    "expected={b'HOME':b'/root',b'XDG_CONFIG_HOME':b'/root/native-config',"
                    "b'XDG_DATA_HOME':b'/root/native-data',b'XDG_CACHE_HOME':b'/root/native-cache'}; "
                    "environments=[dict(entry.split(b'=',1) for entry in "
                    "(Path('/proc')/child/'environ').read_bytes().split(bytes([0])) if b'=' in entry) "
                    "for child in [pid,*children]]; "
                    "assert all({key:env.get(key) for key in expected}==expected for env in environments); "
                    "print('BENCH_NATIVE_TASK_HOME_PRESERVED')",
                ]
            )
            + ' && test "$HOME" = /root && test "$(cat "$HOME/preinstalled-fixture")" = native-cache && '
            if task_home
            else ""
        )
        force_tool = count < min(target, tool_turns) if long_session and not probe else None
        if compacting or (business and not native_tools):
            force_tool = False
        inputs = 100 + len(json.dumps(body, ensure_ascii=False).encode()) // 3 if business else None
        if business:
            business_inputs.append(inputs)
        anchors = re.findall(r"\[[^\]\n]*observation\.txt#[A-Za-z0-9]+\]", json.dumps(messages))
        response = await fixture_provider(
            request,
            command_prefix=process_evidence
            + environment_check
            + (
                shlex.join(
                    [
                        "env",
                        "SYNERGY_HOME=/logs/agent/home",
                        "/opt/synergy/bin/bun",
                        "--eval",
                        (BENCHMARK / "test/fixtures/unattended-check.mjs").read_text(),
                    ]
                )
                + " && "
                if unattended
                else ""
            ),
            force_tool=force_tool,
            input_tokens=inputs,
            observation_turn=count
            if long_session and observations and not probe and not task_home and force_tool
            else None,
            completion=(
                "# Continuation\nThe file /app/observation.txt was read and edited. "
                + (f"Latest observed snapshot: {anchors[-1]}. " if anchors else "")
                + "Continue the pending file verification, then read, edit and verify the file again."
                if compacting
                else "Done"
            ),
            allocation_pressure=not business,
        )
        if business and not probe and force_tool and body.get("tools"):
            business_turns += 1
        return response

    app = web.Application(client_max_size=128 * 1024**2)
    app.router.add_post("/v1/chat/completions", provider_with_runtime_evidence)
    app.router.add_post("/v1/responses", provider_with_runtime_evidence)
    provider = web.AppRunner(app)
    await provider.setup()
    await web.TCPSite(provider, "127.0.0.1", 0).start()
    artifacts = json.loads(os.environ.get("SYNERGY_BENCH_NATIVE_ARTIFACTS", "{}"))
    kinds = os.environ.get("SYNERGY_BENCH_TEST_HARNESSES", "synergy,codex,opencode,pi,deepseek").split(",")
    harnesses = {
        kind: {
            "kind": kind,
            "source": {"artifact": artifacts[kind]}
            if kind in artifacts
            else {
                "path": str(BENCHMARK.parent),
                **(
                    {"revision": os.environ["SYNERGY_BENCH_TEST_SYNERGY_REVISION"]}
                    if os.environ.get("SYNERGY_BENCH_TEST_SYNERGY_REVISION")
                    else {}
                ),
            }
            if kind == "synergy"
            else {},
        }
        for kind in kinds
    }
    if long_session or unattended:
        harnesses = {
            "synergy-unattended" if unattended else "synergy-jit" if bun_jit else "synergy-jitless": {
                **harnesses["synergy"],
                "runtime": "full",
                "agent": "synergy-max",
                "bun_jit": bun_jit,
            }
        }
        if business:
            atomic_json(tmp_path / "compaction-config.json", {"library": {"memory": {"enabled": False}}})
            for harness in harnesses.values():
                harness["config"] = "compaction-config.json"
    else:
        for kind in ["opencode"]:
            if kind in harnesses:
                harnesses[kind + "-jitless"] = {**harnesses[kind], "bun_jit": False}
    monkeypatch.setenv("BENCH_FIXTURE_KEY", "fixture-key-private")
    profiles = fixture_profiles(
        protocol,
        f"http://127.0.0.1:{provider.addresses[0][1]}/v1",
        long_session=long_session,
        unattended=unattended,
        business=business,
    )
    assert_equivalent_profiles(profiles)
    profiles = {name: profiles[name] for name in models}
    config = {
        "version": 2,
        "platform": os.environ.get("SYNERGY_BENCH_TEST_PLATFORM", "linux/amd64"),
        "suite": "suite.json",
        "harnesses": harnesses,
        "models": profiles,
        "concurrency": 1 if long_session else 4,
        "resources": {"cache_budget_gib": 10, "min_free_disk_gib": 2}
        if os.environ.get("CI") == "true"
        else {"cache_budget_gib": 384},
        "cache": os.environ.get("SYNERGY_BENCH_TEST_CACHE", str(BENCHMARK.parent / ".artifacts/benchmark/cache")),
        "output": str(BENCHMARK.parent / ".artifacts/benchmark/matrix-integration"),
    }
    path = tmp_path / "matrix.yaml"
    path.write_text(yaml.safe_dump(config))
    try:
        expected = evaluator_identity()
        preparer = tmp_path / "preparer"
        freeze_evaluator(preparer, expected)
        code = await run_process(
            [
                sys.executable,
                "-c",
                "from pathlib import Path;from synergy_bench.runner import initialize;"
                "from synergy_bench.storage import atomic_json;import sys;"
                "atomic_json(Path(sys.argv[2]),{'root':str(initialize(Path(sys.argv[1])))})",
                str(path),
                str(tmp_path / "prepared.json"),
            ],
            env=recorded_environment(preparer, expected),
            log=tmp_path / "prepare.log",
            deadline=1800,
        )
        assert code == 0, (tmp_path / "prepare.log").read_text()[-20000:]
        from pathlib import Path

        root = Path(read_json(tmp_path / "prepared.json")["root"])
        print(f"Matrix evidence: {root}", flush=True)
        code = await run_process(
            [sys.executable, "-m", "synergy_bench.cli", "resume", str(root)],
            env=recorded_environment(root, read_json(root / "plan.json")["evaluator"]),
            log=root / "integration-cli.log",
            deadline=420 if business else 2400 if long_session else 1200,
        )
        assert code == 0, (root / "integration-cli.log").read_text()[-20000:]

        def retained_results():
            results = []
            identities = set()
            for trial in sorted((root / "trials").iterdir()):
                attempts = sorted(trial.glob("attempt-*"))
                assert len(attempts) == 1
                for attempt in attempts:
                    result = read_json(attempt / "evidence.json")
                    verify_terminal(attempt, result)
                    results.append(result)
                    identity = read_json(attempt / "trial.json")
                    harness = identity["harness"]
                    identities.add((harness, identity["model"]))
                    if long_session and not empty_stop and not business:
                        assert_fixture_usage(result["wire_usage"], identity["model"], minimum_requests=tool_turns + 1)
                    if harness.endswith(("-jitless", "-jit")):
                        options = read_json(attempt / "inputs/options.json")
                        enabled = harness.endswith("-jit")
                        assert options["bun_jit"] is enabled
                        if harness == "opencode-jitless":
                            assert options["native"]["env"]["BUN_JSC_useJIT"] == "0"
                        events = next(attempt.glob("*/agent/events.jsonl")).read_text()
                        if harness.startswith("synergy-"):
                            assert f"BENCH_SYNERGY_WRAPPER_BUN_JSC_useJIT={int(enabled)}" in events
                            assert f"BENCH_SYNERGY_CLI_BUN_JSC_useJIT={int(enabled)}" in events
                        else:
                            assert "BENCH_JIT=0" in events
                        if long_session:
                            records = [json.loads(line) for line in events.splitlines()]
                            assert_native_control(
                                records,
                                tool_turns=business_turns if business else tool_turns,
                                bun_jit=bun_jit,
                                observations=observations and not task_home,
                            )
                            assert result["wire_usage"]["attempts"] >= (business_turns if business else tool_turns) + 1
            assert identities == {(harness, model) for harness in harnesses for model in profiles}
            return results

        results = await asyncio.to_thread(retained_results)
        if unattended:
            for attempt in await asyncio.to_thread(lambda: list(root.glob("trials/*/attempt-*"))):
                parent = read_json(next(attempt.glob("*/agent/unattended.json")))
                child = read_json(next(attempt.glob("*/agent/unattended-child.json")))
                assert parent["interaction"] == {"mode": "unattended", "source": "benchmark"}
                assert child["parent"] == child["child"] == parent["interaction"]
                assert child["question_disabled"] is True
        assert len(results) == len(profiles) * len(harnesses)
        expected_outcome = "failed" if empty_stop else "completed"
        assert all((result["execution"] or {}).get("outcome") == expected_outcome for result in results), results
        if empty_stop:
            assert all((result["execution"] or {}).get("exit_code") == 2 for result in results), results
        assert all((result["verifier"] or {}).get("rewards") == {"reward": 1.0} for result in results), results
        assert all(result["evidence"]["valid"] for result in results), results
        assert all(result["reconciliation"]["status"] != "mismatch" for result in results), results
        assert all(result["wire_usage"]["tokens"]["total"]["unknown"] == 0 for result in results), results
        for result in results:
            assert not any(result["execution"].get(key) for key in ["timed_out", "interrupted", "forced"])
        assert all(result["reconciliation"]["requests"]["coverage"] == 1 for result in results), results

        def check_native_transport():
            for archive_path in root.glob("trials/*/attempt-*/*/agent/rollout.zip"):
                with zipfile.ZipFile(archive_path) as archive:
                    manifest = json.loads(archive.read("manifest.json"))
                    if business:
                        assert_compaction_continuation(
                            json.loads(archive.read("transcript.json")),
                            results[0]["wire_usage"],
                            inputs=business_inputs,
                        )
                    if empty_stop:
                        transcript = json.loads(archive.read("transcript.json"))
                        session = next(
                            session
                            for session in transcript["sessions"]
                            if session["info"]["id"] == transcript["rootSessionID"]
                        )
                        terminal = session["messages"][-1]["info"]
                        assert terminal["role"] == "assistant"
                        assert terminal["finish"] == "error"
                        assert terminal["error"]["name"] == "APIError"
                        assert terminal["error"]["data"]["metadata"]["code"] == "empty_response"
                        assert terminal["error"]["data"]["isRetryable"] is True
                        assert terminal["accounting"]["summary"]["attempts"] > 1
                identity = read_json(archive_path.parents[2] / "trial.json")
                if long_session and identity["harness"].startswith("synergy-"):
                    assert_fixture_models(manifest, profiles[identity["model"]]["model"])
                attempts = [attempt for snapshot in manifest["snapshots"] for attempt in snapshot["attempts"]]
                assert attempts
                assert all(
                    attempt.get("responseHeaders", {}).get("x-request-id", "").startswith("synergy-benchmark:")
                    for attempt in attempts
                    if attempt["status"] == "completed"
                )
            if empty_stop:
                for file in root.glob("trials/*/attempt-*/evidence.json"):
                    result = read_json(file)
                    bodies = [path.read_bytes() for path in (file.parent / "wire").glob("*/response.bin")]
                    assert sum(b'"empty-stop"' in body for body in bodies) > 1
                    assert result["wire_usage"]["attempts"] >= tool_turns + 1

        await asyncio.to_thread(check_native_transport)
        assert not (root / "doctor.json").exists()
        assert not (root / "probes").exists()
        assert not (root / "prewarming").exists()
    finally:
        await provider.cleanup()


def create_matrix_suite(tmp_path, *, workload: bool = False, task_home: bool = False):
    dataset = tmp_path / "dataset"
    task = dataset / "tasks/marker"
    shutil.copytree(BENCHMARK / "test/fixtures/task", task)
    dockerfile = task / "environment/Dockerfile"
    dockerfile.write_text(
        dockerfile.read_text() + "\nRUN git init --quiet && git -c user.name=Fixture "
        "-c user.email=fixture@example.test commit --quiet --allow-empty -m fixture\n"
    )
    if task_home:
        dockerfile.write_text(
            dockerfile.read_text()
            + "\nENV HOME=/root XDG_CONFIG_HOME=/root/native-config XDG_DATA_HOME=/root/native-data "
            "XDG_CACHE_HOME=/root/native-cache\nRUN printf native-cache > /root/preinstalled-fixture\n"
        )
    if workload:
        (task / "environment/workload.py").write_text(
            "import hashlib\ndata = bytearray(192 * 1024**2)\n"
            "for index in range(400000): hashlib.sha256(str(index).encode()).digest()\n"
        )
        dockerfile.write_text(dockerfile.read_text() + "COPY workload.py /fixture/workload.py\n")
    for args in [
        ("init", "--quiet"),
        ("add", "."),
        ("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--quiet", "-m", "fixture"),
    ]:
        git(dataset, *args)
    atomic_json(
        tmp_path / "suite.json",
        {
            "version": 1,
            "name": "matrix-fixture",
            "selection": "native transport and evaluator integration",
            "sources": {
                "fixture": {
                    "url": str(dataset),
                    "commit": git(dataset, "rev-parse", "HEAD").decode().strip(),
                    "license": "fixture",
                }
            },
            "tasks": [
                {
                    "id": "fixture/marker",
                    "source": "fixture",
                    "path": "tasks/marker",
                    "digest": tree_digest(task),
                    "tags": [],
                }
            ],
        },
    )
