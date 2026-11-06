from __future__ import annotations

import asyncio
import json
import os
import time
from dataclasses import dataclass
from typing import Any

import aiohttp

from .prepare import command


class DockerEndpointError(ValueError):
    pass


@dataclass(frozen=True)
class DockerSnapshot:
    captured_at: float
    containers: list[dict[str, Any]]

    @property
    def healthy(self) -> bool:
        return 0 <= time.time() - self.captured_at < 10 and all(
            isinstance(row.get("memory_bytes"), int) and row["memory_bytes"] >= 0 for row in self.containers
        )

    def memory_with_reservations(self, leases: list[dict[str, Any]]) -> int:
        observed: dict[str, int] = {}
        for row in self.containers:
            observed[row["project"]] = observed.get(row["project"], 0) + row["memory_bytes"]
        reserved: dict[str, int] = {}
        unassigned = 0
        for lease in leases:
            if project := lease.get("project"):
                reserved[project] = reserved.get(project, 0) + lease["memory_bytes"]
            else:
                unassigned += lease["memory_bytes"]
        return unassigned + sum(
            max(reserved.get(key, 0), observed.get(key, 0)) for key in reserved.keys() | observed.keys()
        )


class DockerStats:
    def __init__(self) -> None:
        self._endpoint: str | None = None
        self._lock = asyncio.Lock()
        self._snapshot: DockerSnapshot | None = None
        self._previous_cpu: dict[str, dict[str, Any]] = {}

    async def endpoint(self) -> str:
        if self._endpoint is None:
            if os.environ.get("DOCKER_HOST") and not os.environ.get("DOCKER_CONTEXT"):
                self._endpoint = os.environ["DOCKER_HOST"]
            else:
                value = await asyncio.to_thread(
                    command, ["docker", "context", "inspect", "--format", "{{json .Endpoints.docker.Host}}"], timeout=10
                )
                self._endpoint = json.loads(value)
        if not isinstance(self._endpoint, str) or not self._endpoint.startswith("unix://"):
            raise DockerEndpointError("Resource sampling requires the local Docker Unix endpoint")
        return self._endpoint

    async def snapshot(self) -> DockerSnapshot:
        async with self._lock:
            if self._snapshot and time.time() - self._snapshot.captured_at < 1:
                return self._snapshot
            endpoint = await self.endpoint()
            connector = aiohttp.UnixConnector(path=endpoint.removeprefix("unix://"))
            async with aiohttp.ClientSession(connector=connector, timeout=aiohttp.ClientTimeout(total=5)) as client:
                async with client.get("http://docker/containers/json") as response:
                    response.raise_for_status()
                    containers = await response.json()

                async def inspect(row: dict[str, Any]) -> dict[str, Any]:
                    identity = row["Id"]
                    async with client.get(
                        f"http://docker/containers/{identity}/stats", params={"stream": "false", "one-shot": "true"}
                    ) as response:
                        response.raise_for_status()
                        value = await response.json()
                    memory = value.get("memory_stats", {})
                    usage = memory.get("usage")
                    # Docker's Linux working set excludes inactive_file (v2) or total_inactive_file (v1).
                    # https://docs.docker.com/reference/cli/docker/container/stats/
                    inactive = memory.get("stats", {}).get(
                        "inactive_file", memory.get("stats", {}).get("total_inactive_file", 0)
                    )
                    memory_bytes = max(0, usage - inactive) if isinstance(usage, int) else None
                    cpu = value.get("cpu_stats", {})
                    previous = self._previous_cpu.get(identity) or value.get("precpu_stats", {})
                    self._previous_cpu[identity] = cpu
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
                        "project": row.get("Labels", {}).get("com.docker.compose.project", ""),
                        "memory_bytes": memory_bytes,
                        "cpu_percent": cpu_percent,
                    }

                metrics = await asyncio.gather(*(inspect(row) for row in containers))
            self._previous_cpu = {row["ID"]: self._previous_cpu[row["ID"]] for row in metrics}
            self._snapshot = DockerSnapshot(time.time(), metrics)
            return self._snapshot
