import asyncio
import json
import os
import sys
from pathlib import Path

import pytest
import yaml
from aiohttp import web
from test_matrix_docker import create_matrix_suite, fixture_provider

from synergy_bench.evaluator import freeze_evaluator, recorded_environment
from synergy_bench.native_usage import json_lines
from synergy_bench.prepare import BENCHMARK, evaluator_identity
from synergy_bench.process import run_process
from synergy_bench.storage import read_json

pytestmark = pytest.mark.skipif(os.environ.get("SYNERGY_BENCH_DOCKER") != "1", reason="Native compaction integration")


async def test_native_pi_compaction_is_included_in_per_request_accounting(tmp_path, monkeypatch):
    create_matrix_suite(tmp_path)
    tool_calls = 0
    calls = []

    async def provider(request):
        nonlocal tool_calls
        body = await request.json()
        calls.append(body)
        if "BENCHMARK_TOOL_" in json.dumps(body):
            return await fixture_provider(request)
        call = bool(body.get("tools")) and tool_calls < 3
        if call:
            tool_calls += 1
        return await fixture_provider(
            request,
            input_tokens=30000 if call else None,
            force_tool=call,
            command_prefix="python -c \"print(('x'*79+'\\n')*600)\" && " if call else "",
        )

    app = web.Application()
    app.router.add_post("/v1/chat/completions", provider)
    server = web.AppRunner(app)
    await server.setup()
    await web.TCPSite(server, "127.0.0.1", 0).start()
    artifacts = json.loads(os.environ.get("SYNERGY_BENCH_NATIVE_ARTIFACTS", "{}"))
    monkeypatch.setenv("BENCH_FIXTURE_KEY", "deterministic-only")
    config = {
        "version": 2,
        "suite": "suite.json",
        "harnesses": {"pi": {"kind": "pi", **({"source": {"artifact": artifacts["pi"]}} if "pi" in artifacts else {})}},
        "models": {
            "fixture": {
                "model": "fixture-one",
                "protocol": "chat-completions",
                "base_url": f"http://127.0.0.1:{server.addresses[0][1]}/v1",
                "api_key_env": "BENCH_FIXTURE_KEY",
                "context_window": 32000,
                "max_output_tokens": 2048,
            }
        },
        "concurrency": 1,
        "resources": {"cache_budget_gib": 10, "min_free_disk_gib": 2} if os.environ.get("CI") == "true" else {},
        "cache": str(BENCHMARK.parent / ".artifacts/benchmark/cache"),
        "output": str(BENCHMARK.parent / ".artifacts/benchmark/compaction-integration"),
    }
    path = tmp_path / "compaction.yaml"
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
        assert code == 0, (tmp_path / "prepare.log").read_text()[-12000:]
        root = Path(read_json(tmp_path / "prepared.json")["root"])
        print(f"Native compaction evidence: {root}", flush=True)
        code = await run_process(
            [sys.executable, "-m", "synergy_bench.cli", "resume", str(root)],
            env=recorded_environment(root, read_json(root / "plan.json")["evaluator"]),
            log=root / "integration-cli.log",
            deadline=1200,
        )
        assert code == 0, (root / "integration-cli.log").read_text()[-12000:]
        result = await asyncio.to_thread(lambda: read_json(next(root.glob("trials/*/attempt-001/evidence.json"))))
        assert result["verifier"]["rewards"] == {"reward": 1.0}
        sessions = await asyncio.to_thread(
            lambda: [
                row for file in root.glob("trials/*/attempt-001/*/agent/home/pi/**/*.jsonl") for row in json_lines(file)
            ]
        )
        assert any(row.get("type") == "compaction" for row in sessions)
        requests = result["reconciliation"]["requests"]
        assert requests["status"] == "matched"
        assert len(requests["completed_usage_crosschecked"]) >= 3
        assert any(not body.get("tools") for body in calls)
    finally:
        await server.cleanup()
