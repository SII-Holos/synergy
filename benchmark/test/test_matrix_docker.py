import asyncio
import json
import os
import re
import shutil
import sys
import uuid

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


async def fixture_provider(request, *, command_prefix="", input_tokens=None, force_tool=None):
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
    create_matrix_suite(tmp_path)

    async def provider_with_runtime_evidence(request):
        return await fixture_provider(request, command_prefix='printf "BENCH_JIT=%s\\n" "${BUN_JSC_useJIT-unset}"; ')

    app = web.Application()
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
            else {"path": str(BENCHMARK.parent)}
            if kind == "synergy"
            else {},
        }
        for kind in kinds
    }
    if "opencode" in harnesses:
        harnesses["opencode-jitless"] = {**harnesses["opencode"], "bun_jit": False}
    monkeypatch.setenv("BENCH_FIXTURE_KEY", "fixture-key-private")
    profiles = {
        name: {
            "model": name,
            "protocol": protocol,
            "base_url": f"http://127.0.0.1:{provider.addresses[0][1]}/v1",
            "api_key_env": "BENCH_FIXTURE_KEY",
            "context_window": 32000,
            "max_output_tokens": 2048,
        }
        for name in ["fixture-one", "fixture-two"]
    }
    config = {
        "version": 2,
        "suite": "suite.json",
        "harnesses": harnesses,
        "models": profiles,
        "concurrency": 4,
        "resources": {"cache_budget_gib": 10, "min_free_disk_gib": 2} if os.environ.get("CI") == "true" else {},
        "cache": str(BENCHMARK.parent / ".artifacts/benchmark/cache"),
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
            deadline=1200,
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
                    if read_json(attempt / "trial.json")["harness"] == "opencode-jitless":
                        assert read_json(attempt / "inputs/options.json")["native"]["env"]["BUN_JSC_useJIT"] == "0"
                        events = next(attempt.glob("*/agent/events.jsonl")).read_text()
                        assert "BENCH_JIT=0" in events
            return results

        results = await asyncio.to_thread(retained_results)
        assert len(results) == 2 * len(harnesses)
        assert all((result["execution"] or {}).get("outcome") == "completed" for result in results), results
        assert all((result["verifier"] or {}).get("rewards") == {"reward": 1.0} for result in results), results
        assert all(result["evidence"]["valid"] for result in results), results
        assert all(result["reconciliation"]["status"] != "mismatch" for result in results), results
        assert all(result["wire_usage"]["tokens"]["total"]["unknown"] == 0 for result in results), results
        assert read_json(root / "doctor.json")["status"] == "completed"
    finally:
        await provider.cleanup()


def create_matrix_suite(tmp_path, *, workload: bool = False):
    dataset = tmp_path / "dataset"
    task = dataset / "tasks/marker"
    shutil.copytree(BENCHMARK / "test/fixtures/task", task)
    dockerfile = task / "environment/Dockerfile"
    dockerfile.write_text(
        dockerfile.read_text() + "\nRUN git init --quiet && git -c user.name=Fixture "
        "-c user.email=fixture@example.test commit --quiet --allow-empty -m fixture\n"
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
