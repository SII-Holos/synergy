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
from synergy_bench.runner import startup_retryable, verify_terminal
from synergy_bench.source import git
from synergy_bench.storage import atomic_json, read_json

pytestmark = pytest.mark.skipif(os.environ.get("SYNERGY_BENCH_DOCKER") != "1", reason="Explicit native Docker matrix")


async def fixture_provider(request, *, command_prefix="", input_tokens=None, force_tool=None, observation_turn=None):
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
    message = {"role": "assistant", "content": "Done"}
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
            phase = observation_turn % 4
            if phase in (1, 2):
                name = "view_file" if phase == 1 else "revise_file"
                selected = next(tool for tool in functions if tool["name"].split("__")[-1] == name)
                namespace = selected.get("namespace")
                if phase == 1:
                    args = {"filePath": "/app/observation.txt", "limit": 32}
                else:
                    headers = re.findall(r"\[[^\]\n]*observation\.txt#([A-Za-z0-9]+)\]", json.dumps(messages))
                    assert headers, "Native view_file did not return an anchored snapshot"
                    args = {"input": f"[/app/observation.txt#{headers[-1]}]\nSWAP 1..1:\n+changed {observation_turn}"}
            else:
                script = (
                    "from pathlib import Path; memory=bytearray(8*1024**2); "
                    "Path('/app/observation.txt').write_text(''.join("
                    "f'row {i} '+('中😀'*128)+'\\n' for i in range(500))); "
                    "Path('/app/marker').write_text('verified')"
                    if phase == 0
                    else "from pathlib import Path; "
                    "assert Path('/app/observation.txt').read_text().startswith('changed ')"
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
                "content": [{"type": "output_text", "text": "Done", "annotations": []}],
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
                        "delta": "Done",
                    },
                    {
                        "type": "response.output_text.done",
                        "item_id": item["id"],
                        "output_index": 0,
                        "content_index": 0,
                        "text": "Done",
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


@pytest.mark.parametrize("protocol", ["chat-completions", "responses"])
async def test_native_matrix_uses_restricted_egress_and_two_independent_models(tmp_path, monkeypatch, protocol):
    await run_native_matrix(tmp_path, monkeypatch, protocol)


@pytest.mark.parametrize("protocol", ["chat-completions", "responses"])
@pytest.mark.parametrize("tool_turns", [1, 120], ids=["short", "long"])
@pytest.mark.parametrize("bun_jit", [False, True], ids=["jitless", "jit"])
async def test_synergy_long_sessions_preserve_native_tools_and_usage(
    tmp_path, monkeypatch, protocol, tool_turns, bun_jit
):
    if "synergy" not in os.environ.get("SYNERGY_BENCH_TEST_HARNESSES", "synergy").split(","):
        pytest.skip("Synergy long-session control belongs to the Synergy native matrix")
    await run_native_matrix(tmp_path, monkeypatch, protocol, long_session=True, tool_turns=tool_turns, bun_jit=bun_jit)


@pytest.mark.parametrize("empty_stop", [False, True], ids=["tool-roundtrip", "empty-provider-stop"])
async def test_synergy_preserves_task_home_and_native_stopping(tmp_path, monkeypatch, empty_stop):
    if "synergy" not in os.environ.get("SYNERGY_BENCH_TEST_HARNESSES", "synergy").split(","):
        pytest.skip("Task-home and native-stop controls belong to the Synergy native matrix")
    await run_native_matrix(
        tmp_path,
        monkeypatch,
        "chat-completions",
        long_session=True,
        tool_turns=3,
        bun_jit=True,
        task_home=True,
        empty_stop=empty_stop,
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
):
    create_matrix_suite(tmp_path, task_home=task_home)

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
        body = await request.json()
        if protocol == "chat-completions":
            assert body["enable_thinking"] is False
            assert "reasoning_effort" not in body
        messages = body.get("messages", body.get("input", []))
        count = sum(
            message.get("role") == "tool" or message.get("type") == "function_call_output"
            for message in messages
            if isinstance(message, dict)
        )
        probe = "BENCHMARK_TOOL_" in json.dumps(messages)
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
        return await fixture_provider(
            request,
            command_prefix='printf "BENCH_JIT=%s\\n" "${BUN_JSC_useJIT-unset}"; '
            + native_probe
            + "; "
            + environment_check,
            force_tool=count < tool_turns if long_session and not probe else None,
            observation_turn=count if long_session and not probe and not task_home else None,
        )

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
    if long_session:
        harnesses = {
            "synergy-jit" if bun_jit else "synergy-jitless": {
                **harnesses["synergy"],
                "runtime": "full",
                "agent": "synergy-max",
                "bun_jit": bun_jit,
            }
        }
    else:
        for kind in ["synergy", "opencode"]:
            if kind in harnesses:
                harnesses[kind + "-jitless"] = {**harnesses[kind], "bun_jit": False}
    monkeypatch.setenv("BENCH_FIXTURE_KEY", "fixture-key-private")
    profiles = {
        name: {
            "model": name,
            "protocol": protocol,
            "base_url": f"http://127.0.0.1:{provider.addresses[0][1]}/v1",
            "api_key_env": "BENCH_FIXTURE_KEY",
            "context_window": 1000000 if long_session else 32000,
            "max_output_tokens": 393216 if long_session else 2048,
            "parameters": {"enable_thinking": False}
            if protocol == "chat-completions"
            else {"reasoning": {"effort": "none"}},
        }
        for name in ["fixture-one", "fixture-two"]
    }
    config = {
        "version": 2,
        "suite": "suite.json",
        "harnesses": harnesses,
        "models": profiles,
        "concurrency": 1 if long_session else 4,
        "timeout_seconds": 900 if long_session else "native",
        "preflight_timeout_seconds": 600 if long_session else 120,
        "resources": {"cache_budget_gib": 10, "min_free_disk_gib": 2} if os.environ.get("CI") == "true" else {},
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
            deadline=2400 if long_session else 1200,
        )
        assert code == 0, (root / "integration-cli.log").read_text()[-20000:]

        def retained_results():
            results = []
            for trial in sorted((root / "trials").iterdir()):
                attempts = sorted(trial.glob("attempt-*"))
                assert 1 <= len(attempts) <= 3
                for attempt in attempts:
                    result = read_json(attempt / "evidence.json")
                    verify_terminal(attempt, result)
                    if attempt != attempts[-1]:
                        assert startup_retryable(attempt, result), result
                        continue
                    results.append(result)
                    harness = read_json(attempt / "trial.json")["harness"]
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
                            completed = {
                                event["part"]["callID"]
                                for event in records
                                if event.get("type") == "tool_use" and event["part"]["state"]["status"] == "completed"
                            }
                            assert len(completed) >= tool_turns
                            assert result["wire_usage"]["attempts"] >= tool_turns + 1
                            if tool_turns >= 4:
                                assert {"bash", "view_file", "revise_file"} <= {
                                    event["part"]["tool"]
                                    for event in records
                                    if event.get("type") == "tool_use"
                                    and event["part"]["state"]["status"] == "completed"
                                }
            return results

        results = await asyncio.to_thread(retained_results)
        assert len(results) == 2 * len(harnesses)
        assert all((result["execution"] or {}).get("outcome") == "completed" for result in results), results
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
                    assert any(b'"empty-stop"' in body for body in bodies)
                    assert result["wire_usage"]["attempts"] >= tool_turns + 1

        await asyncio.to_thread(check_native_transport)
        assert read_json(root / "doctor.json")["status"] == "completed"
        for attempt in (root / "probes").glob("*/attempt-*"):
            assert read_json(attempt / "inputs/options.json")["timeout_seconds"] == config["preflight_timeout_seconds"]
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
                    "agent_seconds": 90,
                    "verifier_seconds": 30,
                }
            ],
        },
    )
