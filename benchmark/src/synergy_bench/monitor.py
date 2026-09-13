from __future__ import annotations

import asyncio
import json
import os
import time
from datetime import UTC, datetime
from pathlib import Path
from types import TracebackType
from typing import Any

import aiohttp
import psutil

from .process import run_process
from .resources import parse_bytes
from .storage import atomic_json


class ResourceMonitor:
    def __init__(self, directory: Path, project: str, *, interval: float = 2) -> None:
        self.directory = directory
        self.project = project
        self.interval = interval
        self.stop = asyncio.Event()
        self.task: asyncio.Task[None] | None = None
        self.started_at = time.time()
        self.events: list[dict[str, Any]] = []
        self.oom_coverage = "unknown"
        self.event_task: asyncio.Task[None] | None = None
        self.event_ready = asyncio.Event()
        self.event_connected = False
        self.samples: list[dict[str, Any]] = []
        self.errors: list[str] = []

    async def __aenter__(self) -> ResourceMonitor:
        self.event_task = asyncio.create_task(self.observe_events())
        try:
            await self.event_ready.wait()
        except BaseException:
            self.event_task.cancel()
            await asyncio.gather(self.event_task, return_exceptions=True)
            raise
        self.task = asyncio.create_task(self.run())
        return self

    async def __aexit__(
        self, exc_type: type[BaseException] | None, exc: BaseException | None, tb: TracebackType | None
    ) -> None:
        self.stop.set()
        assert self.task is not None
        await self.task
        if self.event_task:
            self.event_task.cancel()
            await asyncio.gather(self.event_task, return_exceptions=True)
        await self.collect_events()
        self.persist()

    def persist(self) -> None:
        atomic_json(
            self.directory / "resources.json",
            {
                "version": 1,
                "oom_events": len(self.events) if self.oom_coverage == "live_stream" else None,
                "observed_oom_events": len(self.events),
                "peak_semantics": "maximum_observed_sample; short peaks may be missed",
                "oom_coverage": self.oom_coverage,
                "container_events": self.events,
                "peak_process_rss_sum_bytes": max(
                    (
                        row["process_rss_sum_bytes"]
                        for row in self.samples
                        if row.get("process_rss_sum_bytes") is not None
                    ),
                    default=None,
                ),
                "sample_interval_seconds": self.interval,
                "samples": self.samples,
                "errors": self.errors,
                "peak_memory_bytes": max(
                    (row["memory_bytes"] for row in self.samples if row.get("memory_bytes") is not None), default=None
                ),
                "peak_cpu_percent": max(
                    (row["cpu_percent"] for row in self.samples if row.get("cpu_percent") is not None), default=None
                ),
                "peak_recorder_rss_bytes": max((row["recorder_rss_bytes"] for row in self.samples), default=None),
                "minimum_disk_free_bytes": min((row["disk_free_bytes"] for row in self.samples), default=None),
            },
        )

    async def sample(self) -> None:
        log = self.directory / "monitor-current.log"
        log.unlink(missing_ok=True)
        code = await run_process(
            ["docker", "ps", "--format", '{{.ID}} {{.Label "com.docker.compose.project"}}'], log=log, deadline=10
        )
        if code:
            raise RuntimeError("Docker inspection failed")
        containers = [
            line.split()[0]
            for line in log.read_text().splitlines()
            if len(line.split()) > 1
            and (line.split()[1] == self.project or line.split()[1].startswith(self.project + "__verifier__"))
        ]
        metrics = []
        if containers:
            log.unlink()
            code = await run_process(
                ["docker", "stats", "--no-stream", "--format", "{{json .}}", *containers], log=log, deadline=15
            )
            if code:
                raise RuntimeError("Docker stats failed")
            metrics = [json.loads(line) for line in log.read_text().splitlines()]
        memory = [parse_bytes(row.get("MemUsage", "").split("/")[0]) for row in metrics]
        rss_values = []
        for container in containers:
            log.unlink(missing_ok=True)
            code = await run_process(["docker", "top", container, "-eo", "pid,rss"], log=log, deadline=5)
            lines = [line.split() for line in log.read_text().splitlines()[1:]]
            rss_values.append(
                sum(int(line[1]) * 1024 for line in lines)
                if code == 0
                and lines
                and all(len(line) == 2 and all(value.isdecimal() for value in line) for line in lines)
                else None
            )
        process = psutil.Process()
        self.samples.append(
            {
                "timestamp": time.time(),
                "containers": metrics,
                "process_rss_sum_bytes": sum(value for value in rss_values if value is not None)
                if rss_values and all(value is not None for value in rss_values)
                else None,
                "rss_accounting": "sum_process_RSS_shared_pages_may_be_counted_more_than_once",
                "memory_bytes": sum(value for value in memory if value is not None)
                if metrics and all(value is not None for value in memory)
                else None,
                "cpu_percent": sum(float(row["CPUPerc"].removesuffix("%")) for row in metrics) if metrics else None,
                "host_available_memory_bytes": psutil.virtual_memory().available,
                "host_cpu_percent": psutil.cpu_percent(),
                "host_load": list(os.getloadavg()),
                "recorder_rss_bytes": process.memory_info().rss,
                "disk_free_bytes": psutil.disk_usage(str(self.directory)).free,
            }
        )
        log.unlink(missing_ok=True)
        self.persist()

    async def docker_endpoint(self) -> str:
        if os.environ.get("DOCKER_HOST") and not os.environ.get("DOCKER_CONTEXT"):
            return os.environ["DOCKER_HOST"]
        log = self.directory / "docker-context.log"
        code = await run_process(
            ["docker", "context", "inspect", "--format", "{{json .Endpoints.docker.Host}}"], log=log, deadline=10
        )
        if code:
            raise RuntimeError("Docker context unavailable")
        endpoint = json.loads(log.read_text())
        if not isinstance(endpoint, str):
            raise ValueError("Invalid Docker endpoint")
        log.unlink(missing_ok=True)
        return endpoint

    def accept_event(self, row: dict[str, Any]) -> None:
        project = row.get("Actor", {}).get("Attributes", {}).get("com.docker.compose.project", "")
        if row.get("Action") != "oom" or not (
            project == self.project or project.startswith(self.project + "__verifier__")
        ):
            return
        if row not in self.events:
            self.events.append(row)
            self.persist()

    async def observe_events(self) -> None:
        # Continuous Engine API subscription avoids the finite retrospective event window.
        # https://docs.docker.com/reference/api/engine/version/v1.45/#tag/System/operation/SystemEvents
        try:
            endpoint = await self.docker_endpoint()
            if not endpoint.startswith("unix://"):
                raise ValueError("Live event coverage requires a local Unix Docker endpoint")
            connector = aiohttp.UnixConnector(path=endpoint.removeprefix("unix://"))
            timeout = aiohttp.ClientTimeout(total=None, connect=10, sock_read=None)
            async with aiohttp.ClientSession(connector=connector, timeout=timeout) as client:
                async with asyncio.timeout(10):
                    response = await client.get(
                        "http://docker/events",
                        params={
                            "since": str(int(self.started_at)),
                            "filters": json.dumps({"type": ["container"], "event": ["oom"]}),
                        },
                    )
                async with response:
                    response.raise_for_status()
                    self.event_connected = True
                    self.oom_coverage = "live_stream"
                    self.event_ready.set()
                    log = self.directory / "container-events-live.jsonl"
                    with log.open("ab", buffering=0) as output:
                        try:
                            async for line in response.content:
                                output.write(line)
                                self.accept_event(json.loads(line))
                        finally:
                            os.fsync(output.fileno())
                    if not self.stop.is_set():
                        self.oom_coverage = "partial_live_stream"
        except asyncio.CancelledError:
            if not self.stop.is_set():
                self.oom_coverage = "partial_live_stream"
            raise
        except (OSError, ValueError, RuntimeError, TimeoutError, aiohttp.ClientError) as error:
            self.oom_coverage = "partial_live_stream" if self.event_connected else "unknown"
            self.errors.append("live_events:" + type(error).__name__)
        finally:
            self.event_ready.set()

    async def collect_events(self) -> None:
        if self.event_connected:
            return
        log = self.directory / "container-events.log"
        log.unlink(missing_ok=True)
        try:
            code = await run_process(
                [
                    "docker",
                    "events",
                    "--since",
                    str(int(self.started_at)),
                    "--until",
                    datetime.now(UTC).isoformat(),
                    "--filter",
                    "type=container",
                    "--filter",
                    "event=oom",
                    "--format",
                    "{{json .}}",
                ],
                log=log,
                deadline=10,
            )
            if code:
                raise RuntimeError("Docker event history unavailable")
            events = [json.loads(line) for line in log.read_text().splitlines()]
            self.events = [
                row
                for row in events
                if (project := row.get("Actor", {}).get("Attributes", {}).get("com.docker.compose.project", ""))
                == self.project
                or project.startswith(self.project + "__verifier__")
            ]
            self.oom_coverage = "observed_event_window"
        except (OSError, ValueError, RuntimeError, TimeoutError) as error:
            self.errors.append("events:" + type(error).__name__)

    async def run(self) -> None:
        while not self.stop.is_set():
            try:
                await self.sample()
            except (OSError, ValueError, RuntimeError, TimeoutError) as error:
                self.errors.append(type(error).__name__)
                self.persist()
            try:
                async with asyncio.timeout(self.interval):
                    await self.stop.wait()
            except TimeoutError:
                pass
