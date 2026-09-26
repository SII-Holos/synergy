import asyncio
import json
import os
import sys
import time
from pathlib import Path

import pytest
import yaml
from aiohttp import web
from test_matrix_docker import create_matrix_suite, fixture_provider

from synergy_bench.evaluator import freeze_evaluator, recorded_environment
from synergy_bench.prepare import BENCHMARK, evaluator_identity
from synergy_bench.process import run_process
from synergy_bench.storage import atomic_json, read_json

pytestmark = pytest.mark.skipif(
    os.environ.get("SYNERGY_BENCH_PERFORMANCE") != "1", reason="Explicit isolated throughput acceptance"
)


async def test_controlled_native_throughput_at_one_two_four_six(tmp_path, monkeypatch):
    create_matrix_suite(tmp_path, workload=True)
    artifact = json.loads(os.environ["SYNERGY_BENCH_NATIVE_ARTIFACTS"])["pi"]
    app = web.Application()

    async def provider(request):
        await asyncio.sleep(2)
        return await fixture_provider(request, command_prefix="python /fixture/workload.py && ")

    app.router.add_post("/v1/chat/completions", provider)
    server = web.AppRunner(app)
    await server.setup()
    await web.TCPSite(server, "127.0.0.1", 0).start()
    monkeypatch.setenv("BENCH_FIXTURE_KEY", "deterministic-only")
    expected = evaluator_identity()
    preparer = tmp_path / "preparer"
    freeze_evaluator(preparer, expected)
    output = BENCHMARK.parent / ".artifacts/benchmark/performance"
    rows = []
    try:
        for concurrency in [1, 2, 4, 6]:
            config = {
                "version": 2,
                "suite": "suite.json",
                "repeat": 12,
                "harnesses": {"pi": {"kind": "pi", "source": {"artifact": artifact}}},
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
                "concurrency": concurrency,
                "cache": str(BENCHMARK.parent / ".artifacts/benchmark/cache"),
                "output": str(output),
            }
            file = tmp_path / "performance.yaml"
            file.write_text(yaml.safe_dump(config))
            prepare_started = time.monotonic()
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
                log=tmp_path / f"prepare-{concurrency}.log",
                deadline=1800,
            )
            assert code == 0
            root = Path(read_json(tmp_path / "prepared.json")["root"])
            row = {
                "concurrency": concurrency,
                "run": str(root),
                "initialize_seconds": time.monotonic() - prepare_started,
            }
            environment = recorded_environment(root, read_json(root / "plan.json")["evaluator"])
            for phase in ["resume"]:
                started = time.monotonic()
                code = await run_process(
                    [sys.executable, "-m", "synergy_bench.cli", phase, str(root)],
                    env=environment,
                    log=root / (phase + "-performance.log"),
                    deadline=1800,
                )
                row[phase + "_seconds"] = time.monotonic() - started
                assert code == 0, (root / (phase + "-performance.log")).read_text()[-12000:]
            results = await asyncio.to_thread(
                lambda root=root: [read_json(file) for file in root.glob("trials/*/attempt-*/evidence.json")]
            )
            assert len(results) == 12
            assert all(result["evidence"]["valid"] for result in results)
            assert all(result["verifier"]["rewards"] == {"reward": 1.0} for result in results)
            assert all(result["resources"]["oom_events"] == 0 for result in results)
            builds = await asyncio.to_thread(lambda root=root: list(root.glob("**/compose/build-*.log")))
            pulls = await asyncio.to_thread(lambda root=root: list(root.glob("**/compose/pull-*.log")))
            row.update(tasks=12, tasks_per_minute=720 / row["resume_seconds"], builds=len(builds), pulls=len(pulls))
            if concurrency != 1:
                assert not builds and not pulls, "Warm preparation repeated a build or download"
            for field in ["memory_bytes", "cpu_percent"]:
                row["peak_task_" + field] = max(
                    (
                        result["resources"]["peak_" + field]
                        for result in results
                        if result["resources"]["peak_" + field] is not None
                    ),
                    default=None,
                )
            rows.append(row)
            atomic_json(
                output / "controlled-throughput.json",
                {
                    "version": 1,
                    "conditions": {
                        "provider_delay_seconds_per_request": 2,
                        "memory_workload_bytes": 192 * 1024**2,
                        "cpu_workload_sha256_iterations": 400000,
                        "harness": "pi",
                        "tasks_per_concurrency": 12,
                        "artifact": artifact,
                        "evaluator": expected,
                        "preparation_cache_scope": "fixed harness artifact; cold then warm task/proxy images",
                    },
                    "rows": rows,
                },
            )
            print(json.dumps(row), flush=True)
    finally:
        await server.cleanup()
