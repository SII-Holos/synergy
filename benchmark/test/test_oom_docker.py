import asyncio
import json
import os
import signal
import uuid

import pytest

from synergy_bench.monitor import ResourceMonitor
from synergy_bench.prepare import BENCHMARK
from synergy_bench.process import run_process
from synergy_bench.storage import read_json

pytestmark = pytest.mark.skipif(os.environ.get("SYNERGY_BENCH_DOCKER") != "1", reason="Owned kernel OOM injection")


async def test_native_docker_working_set_is_observed(tmp_path):
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
        assert monitor.samples[0]["process_rss_sum_bytes"] is None
        assert monitor.samples[0]["memory_bytes"] > 0
    finally:
        await run_process(["docker", "rm", "-f", container], log=tmp_path / "cleanup.log", deadline=15)


async def test_kernel_oom_is_retained_after_container_removal(tmp_path, monkeypatch):
    tmp_path = BENCHMARK.parent / ".artifacts/benchmark/oom-integration" / uuid.uuid4().hex
    tmp_path.mkdir(parents=True)
    project = "sb-" + uuid.uuid4().hex[:8] + "-oom"
    container = "synergy-benchmark-oom-" + uuid.uuid4().hex
    process = None
    observed = asyncio.Event()
    monitor = ResourceMonitor(tmp_path, project, interval=0.2)
    accept = monitor.accept_event

    def accepted(row):
        accept(row)
        if row in monitor.events:
            observed.set()

    monkeypatch.setattr(monitor, "accept_event", accepted)
    try:
        with (tmp_path / "oom.log").open("ab", buffering=0) as output:
            async with asyncio.timeout(60), monitor:
                process = await asyncio.create_subprocess_exec(
                    *[
                        "docker",
                        "run",
                        "--rm",
                        "-i",
                        "--name",
                        container,
                        "--network",
                        "none",
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
                        (BENCHMARK / "test/fixtures/oom.py").read_text(),
                    ],
                    stdin=asyncio.subprocess.PIPE,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=output,
                )
                assert process.stdout and process.stdin
                line = await process.stdout.readline()
                output.write(line)
                proof = json.loads(line)
                assert proof["child_exit_code"] == -signal.SIGKILL, proof
                assert proof["oom_kill_after"] - proof["oom_kill_before"] == 1, proof
                await observed.wait()
                assert len(monitor.events) == 1
                assert monitor.events[0]["Actor"]["Attributes"]["name"] == container
                process.stdin.write(b"release\n")
                await process.stdin.drain()
                process.stdin.close()
                await process.stdin.wait_closed()
                assert await process.wait() == 0
                assert (
                    await run_process(
                        ["docker", "ps", "-aq", "--filter", "label=com.docker.compose.project=" + project],
                        log=tmp_path / "removed.log",
                        deadline=10,
                    )
                    == 0
                )
                assert not (tmp_path / "removed.log").read_text().strip()
                output.write(b'{"container_removed": true}\n')
        record = read_json(tmp_path / "resources.json")
        assert record["oom_coverage"] == "partial_live_stream", record
        assert record["oom_events"] is None, record
        assert record["observed_oom_events"] == 1, record
        assert len(record["container_events"]) == 1
    finally:
        try:
            await run_process(["docker", "rm", "-f", container], log=tmp_path / "cleanup.log", deadline=15)
        finally:
            if process and process.returncode is None:
                process.kill()
                await process.wait()
