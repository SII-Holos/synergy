import asyncio
import os
import uuid

import pytest

from synergy_bench.monitor import ResourceMonitor
from synergy_bench.process import run_process
from synergy_bench.storage import read_json

pytestmark = pytest.mark.skipif(os.environ.get("SYNERGY_BENCH_DOCKER") != "1", reason="Owned kernel OOM injection")


async def test_kernel_oom_is_retained_after_container_removal(tmp_path):
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
        assert record["oom_events"] == 1
        assert record["observed_oom_events"] == 1
    finally:
        await run_process(["docker", "rm", "-f", container], log=tmp_path / "cleanup.log", deadline=15)
