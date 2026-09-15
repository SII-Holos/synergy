import asyncio
import os
import uuid

import pytest

from synergy_bench.monitor import ResourceMonitor
from synergy_bench.prepare import BENCHMARK
from synergy_bench.process import run_process
from synergy_bench.storage import read_json

pytestmark = pytest.mark.skipif(os.environ.get("SYNERGY_BENCH_DOCKER") != "1", reason="Owned kernel OOM injection")


async def test_native_docker_process_rss_is_observed(tmp_path):
    project = "sb-" + uuid.uuid4().hex[:8] + "-rss"
    container = "synergy-benchmark-rss-" + uuid.uuid4().hex
    try:
        assert (
            await run_process(
                [
                    "docker",
                    "run",
                    "--rm",
                    "-d",
                    "--name",
                    container,
                    "--label",
                    "com.docker.compose.project=" + project,
                    "--platform",
                    "linux/amd64",
                    "--memory",
                    "64m",
                    "--cpus",
                    "0.5",
                    "python:3.12-slim-bookworm",
                    "sleep",
                    "60",
                ],
                log=tmp_path / "start.log",
                deadline=30,
            )
            == 0
        )
        monitor = ResourceMonitor(tmp_path, project)
        await monitor.sample()
        assert monitor.samples[0]["process_rss_sum_bytes"] > 0
        assert monitor.samples[0]["memory_bytes"] > 0
    finally:
        await run_process(["docker", "rm", "-f", container], log=tmp_path / "cleanup.log", deadline=15)


async def test_kernel_oom_is_retained_after_container_removal(tmp_path):
    tmp_path = BENCHMARK.parent / ".artifacts/benchmark/oom-integration" / uuid.uuid4().hex
    tmp_path.mkdir(parents=True)
    project = "sb-" + uuid.uuid4().hex[:8] + "-oom"
    container = "synergy-benchmark-oom-" + uuid.uuid4().hex
    try:
        async with asyncio.timeout(60):
            async with ResourceMonitor(tmp_path, project, interval=0.2):
                code = await run_process(
                    [
                        "docker",
                        "run",
                        "--rm",
                        "--name",
                        container,
                        "--platform",
                        "linux/amd64",
                        "--label",
                        "com.docker.compose.project=" + project,
                        "--memory",
                        "64m",
                        "--memory-swap",
                        "64m",
                        "--cpus",
                        "0.5",
                        "python:3.12-slim-bookworm",
                        "python",
                        "-c",
                        "import time;time.sleep(2);x=bytearray(512*1024**2);time.sleep(2)",
                    ],
                    log=tmp_path / "oom.log",
                    deadline=30,
                )
        assert code == 137
        record = read_json(tmp_path / "resources.json")
        assert record["oom_coverage"] == "live_stream", record
        assert record["oom_events"] == 1, record
        assert record["observed_oom_events"] == 1
    finally:
        await run_process(["docker", "rm", "-f", container], log=tmp_path / "cleanup.log", deadline=15)
