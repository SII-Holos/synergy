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
from synergy_bench.gateway import read_ledger
from synergy_bench.prepare import BENCHMARK, evaluator_identity
from synergy_bench.process import run_process
from synergy_bench.runner import remove_environment
from synergy_bench.storage import read_json

pytestmark = pytest.mark.skipif(
    os.environ.get("SYNERGY_BENCH_DOCKER") != "1", reason="Owned evaluator SIGKILL recovery"
)


async def test_parent_death_preserves_dispatched_cost_and_never_repeats_terminal_task(tmp_path, monkeypatch):
    create_matrix_suite(tmp_path)
    dispatched = asyncio.Event()
    release = asyncio.Event()
    calls = []

    async def provider(request):
        body = await request.json()
        if "BENCHMARK_TOOL_" in json.dumps(body):
            return await fixture_provider(request)
        calls.append(body)
        response = web.StreamResponse(headers={"Content-Type": "text/event-stream"})
        await response.prepare(request)
        await response.write(b'data: {"choices":[{"delta":{"content":"started"},"index":0}]}\n\n')
        dispatched.set()
        await release.wait()
        return response

    app = web.Application()
    app.router.add_post("/v1/chat/completions", provider)
    server = web.AppRunner(app)
    await server.setup()
    await web.TCPSite(server, "127.0.0.1", 0).start()
    monkeypatch.setenv("BENCH_FIXTURE_KEY", "deterministic-parent-death")
    artifacts = json.loads(os.environ.get("SYNERGY_BENCH_NATIVE_ARTIFACTS", "{}"))
    config = {
        "version": 2,
        "suite": "suite.json",
        "concurrency": 1,
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
        "resources": {"cache_budget_gib": 10, "min_free_disk_gib": 2} if os.environ.get("CI") == "true" else {},
        "cache": str(BENCHMARK.parent / ".artifacts/benchmark/cache"),
        "output": str(BENCHMARK.parent / ".artifacts/benchmark/parent-death"),
    }
    file = tmp_path / "parent-death.yaml"
    file.write_text(yaml.safe_dump(config))
    expected = evaluator_identity()
    preparer = tmp_path / "preparer"
    freeze_evaluator(preparer, expected)
    process = None
    root = None
    try:
        code = await run_process(
            [
                sys.executable,
                "-c",
                "from pathlib import Path;from synergy_bench.runner import initialize;"
                "from synergy_bench.storage import atomic_json;import sys;"
                "atomic_json(Path(sys.argv[2]),{'root':str(initialize(Path(sys.argv[1])))})",
                str(file),
                str(tmp_path / "prepared.json"),
            ],
            env=recorded_environment(preparer, expected),
            log=tmp_path / "prepare.log",
            deadline=1800,
        )
        assert code == 0, (tmp_path / "prepare.log").read_text()[-5000:]
        root = Path(read_json(tmp_path / "prepared.json")["root"])
        print(f"Parent death evidence: {root}", flush=True)
        environment = recorded_environment(root, read_json(root / "plan.json")["evaluator"])
        with (root / "parent.log").open("wb") as output:
            process = await asyncio.create_subprocess_exec(
                sys.executable,
                "-m",
                "synergy_bench.cli",
                "resume",
                str(root),
                env=environment,
                stdout=output,
                stderr=output,
                start_new_session=True,
            )
            async with asyncio.timeout(300):
                while not dispatched.is_set():
                    if process.returncode is not None:
                        pytest.fail("Evaluator exited before dispatch: " + (root / "parent.log").read_text()[-5000:])
                    await asyncio.sleep(0.05)
            process.kill()
            await process.wait()
        attempt = root / "trials/0000/attempt-001"
        ownership = read_json(attempt / "environment.json")
        finished = attempt / ownership["project"] / "agent/finished"
        async with asyncio.timeout(180):
            while True:
                if finished.exists():
                    break
                await asyncio.sleep(0.2)
        assert len(calls) == 1
        code = await run_process(
            [sys.executable, "-m", "synergy_bench.cli", "resume", str(root)],
            env=environment,
            log=root / "recovered.log",
            deadline=180,
        )
        assert code in {0, 1}, (root / "recovered.log").read_text()[-5000:]
        assert len(calls) == 1
        assert (attempt / "evidence.json").exists(), (root / "recovered.log").read_text()[-8000:]
        result = read_json(attempt / "evidence.json")
        assert result["attempt_status"] == "completed"
        assert result["wire_usage"]["tokens"]["total"]["unknown"] == 1
        assert result["wire_usage"]["tokens"]["total"]["total"] is None
        assert len(read_ledger(attempt / "wire")) == 1
        assert read_json(root / "state.json")["trials"]["0000"]["attempt"] == 1
    finally:
        if process and process.returncode is None:
            process.kill()
            await process.wait()
        release.set()
        await server.cleanup()
        if root:
            ownerships = await asyncio.to_thread(lambda: list(root.glob("*/**/attempt-*/environment.json")))
            for ownership in ownerships:
                await asyncio.to_thread(remove_environment, root, ownership)
