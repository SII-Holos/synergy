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
from .scheduling import PhaseResources
from .storage import atomic_json


class ResourceRecordingError(RuntimeError):
    pass


class ResourceMonitor:
    def __init__(
        self, directory: Path, project: str, *, interval: float = 1, scheduler: PhaseResources | None = None
    ) -> None:
        self.owner: asyncio.Task[Any] | None = None
        self.scheduler = scheduler
        self.endpoint: str | None = None
        self.previous_cpu: dict[str, dict[str, Any]] = {}
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
        self.owner = asyncio.current_task()
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
        try:
            await self.task
        finally:
            if self.event_task:
                self.event_task.cancel()
                await asyncio.gather(self.event_task, return_exceptions=True)
            await self.collect_events()
            self.persist()

    def persist(self) -> None:
        try:
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
                    "samples": self.samples[-1:],
                    "sample_count": len(self.samples),
                    "samples_file": "resource-samples.jsonl",
                    "errors": self.errors,
                    "peak_memory_bytes": max(
                        (row["memory_bytes"] for row in self.samples if row.get("memory_bytes") is not None),
                        default=None,
                    ),
                    "peak_cpu_percent": max(
                        (row["cpu_percent"] for row in self.samples if row.get("cpu_percent") is not None), default=None
                    ),
                    "peak_recorder_rss_bytes": max((row["recorder_rss_bytes"] for row in self.samples), default=None),
                    "minimum_disk_free_bytes": min((row["disk_free_bytes"] for row in self.samples), default=None),
                },
            )
        except OSError as error:
            raise ResourceRecordingError("Could not persist resource observations") from error

    async def sample(self) -> None:
        self.endpoint = self.endpoint or await self.docker_endpoint()
        if not self.endpoint.startswith("unix://"):
            raise ValueError("Resource sampling requires the local Docker Unix endpoint")
        connector = aiohttp.UnixConnector(path=self.endpoint.removeprefix("unix://"))
        async with aiohttp.ClientSession(connector=connector, timeout=aiohttp.ClientTimeout(total=5)) as client:
            async with client.get("http://docker/containers/json") as response:
                response.raise_for_status()
                containers = [
                    row
                    for row in await response.json()
                    if self.owns(row.get("Labels", {}).get("com.docker.compose.project", ""))
                ]

            async def inspect(row: dict[str, Any]) -> dict[str, Any]:
                identity = row["Id"]
                async with client.get(
                    f"http://docker/containers/{identity}/stats", params={"stream": "false", "one-shot": "true"}
                ) as response:
                    response.raise_for_status()
                    value = await response.json()
                memory = value.get("memory_stats", {})
                usage = memory.get("usage")
                inactive = memory.get("stats", {}).get(
                    "inactive_file", memory.get("stats", {}).get("total_inactive_file", 0)
                )
                memory_bytes = max(0, usage - inactive) if isinstance(usage, int) else None
                cpu = value.get("cpu_stats", {})
                previous = self.previous_cpu.get(identity) or value.get("precpu_stats", {})
                self.previous_cpu[identity] = cpu
                system_delta = cpu.get("system_cpu_usage", 0) - previous.get("system_cpu_usage", 0)
                cpu_delta = cpu.get("cpu_usage", {}).get("total_usage", 0) - previous.get("cpu_usage", {}).get(
                    "total_usage", 0
                )
                cpu_percent = (
                    cpu_delta / system_delta * cpu.get("online_cpus", 1) * 100
                    if previous.get("system_cpu_usage") and system_delta > 0 and cpu_delta >= 0
                    else None
                )
                return {
                    "ID": identity,
                    "Name": row.get("Names", [identity])[0],
                    "project": row["Labels"]["com.docker.compose.project"],
                    "memory_bytes": memory_bytes,
                    "cpu_percent": cpu_percent,
                }

            metrics = await asyncio.gather(*(inspect(row) for row in containers))
        groups: dict[str, tuple[int | None, float | None]] = {}
        for row in metrics:
            memory, cpus = groups.get(row["project"], (0, 0.0))
            groups[row["project"]] = (
                memory + row["memory_bytes"] if memory is not None and row["memory_bytes"] is not None else None,
                cpus + row["cpu_percent"] / 100 if cpus is not None and row["cpu_percent"] is not None else None,
            )
        if self.scheduler:
            await self.scheduler.sample(groups)
        process = psutil.Process()
        self.samples.append(
            {
                "timestamp": time.time(),
                "containers": metrics,
                "memory_bytes": sum(row["memory_bytes"] for row in metrics)
                if metrics and all(row["memory_bytes"] is not None for row in metrics)
                else None,
                "cpu_percent": sum(row["cpu_percent"] for row in metrics)
                if metrics and all(row["cpu_percent"] is not None for row in metrics)
                else None,
                "process_rss_sum_bytes": None,
                "rss_accounting": "Docker cgroup working set; process RSS is not sampled",
                "host_available_memory_bytes": psutil.virtual_memory().available,
                "host_cpu_percent": psutil.cpu_percent(),
                "host_load": list(os.getloadavg()),
                "recorder_rss_bytes": process.memory_info().rss,
                "disk_free_bytes": psutil.disk_usage(str(self.directory)).free,
            }
        )
        try:
            with (self.directory / "resource-samples.jsonl").open("a") as stream:
                stream.write(json.dumps(self.samples[-1]) + "\n")
        except OSError as error:
            raise ResourceRecordingError("Could not append resource observation") from error
        self.persist()

    def owns(self, project: str) -> bool:
        return project == self.project or project.startswith(self.project + "__verifier__")

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
        timestamp = row.get("timeNano")
        identity = row.get("Actor", {}).get("ID")
        for retained in self.events:
            if retained == row or (
                isinstance(timestamp, int)
                and timestamp > 0
                and identity
                and retained.get("timeNano") == timestamp
                and retained.get("Actor", {}).get("ID") == identity
                and retained.get("Action") == row["Action"]
            ):
                return
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
        except (OSError, ValueError, TypeError, KeyError, RuntimeError, TimeoutError, aiohttp.ClientError) as error:
            self.oom_coverage = "partial_live_stream" if self.event_connected else "unknown"
            self.errors.append("live_events:" + type(error).__name__)
        finally:
            self.event_ready.set()

    async def collect_events(self) -> None:
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
            for row in events:
                self.accept_event(row)
            if not self.event_connected:
                self.oom_coverage = "observed_event_window"
        except (OSError, ValueError, RuntimeError, TimeoutError) as error:
            self.errors.append("events:" + type(error).__name__)
            if self.event_connected:
                self.oom_coverage = "partial_live_stream"

    async def run(self) -> None:
        while not self.stop.is_set():
            started = time.monotonic()
            try:
                await self.sample()
            except ResourceRecordingError:
                if self.owner:
                    self.owner.cancel()
                raise
            except (OSError, ValueError, TypeError, KeyError, RuntimeError, TimeoutError, aiohttp.ClientError) as error:
                if self.scheduler:
                    await self.scheduler.sample(None)
                self.errors.append(type(error).__name__)
                self.persist()
            try:
                async with asyncio.timeout(max(0.01, self.interval - (time.monotonic() - started))):
                    await self.stop.wait()
            except TimeoutError:
                pass
