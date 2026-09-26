from __future__ import annotations

import asyncio
import fcntl
import json
import math
import os
import re
import shutil
import subprocess
import time
import uuid
from collections.abc import AsyncIterator, Callable, Iterator
from contextlib import asynccontextmanager, contextmanager
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

import aiohttp
import psutil

from .cache import cache_lock
from .config import Resources
from .docker_resources import DockerSnapshot, DockerStats
from .prepare import command
from .storage import atomic_json, read_json


@dataclass(frozen=True)
class Request:
    cpus: float
    memory_bytes: int

    def __post_init__(self) -> None:
        if not math.isfinite(self.cpus) or self.cpus <= 0 or self.memory_bytes <= 0:
            raise ValueError("Resource requests must be positive")


@dataclass(frozen=True)
class Capacity:
    cpus: float
    memory_bytes: int


@dataclass(eq=False)
class Waiting:
    request: Request
    bypasses: int = 0
    priority: int = 0


class ResourceLease:
    def __init__(self, pool: ResourcePool, key: str, request: Request, adaptive: bool, project: str | None) -> None:
        self.pool = pool
        self.key = key
        self.initial = request
        self.request = request
        self.adaptive = adaptive
        self.project = project
        self.sampled_at: float | None = None
        self.peak_memory = 0
        self.last_memory = 0
        self.stage = "agent"

    @property
    def healthy(self) -> bool:
        return not self.adaptive or (self.sampled_at is not None and time.time() - self.sampled_at < 10)

    async def sample(self, memory: int | None, cpus: float | None) -> None:
        async with self.pool._condition:
            valid = memory is not None and cpus is not None and memory >= 0 and math.isfinite(cpus) and cpus >= 0
            self.sampled_at = time.time() if valid else None
            if valid:
                assert memory is not None and cpus is not None
                self.last_memory = memory
                self.peak_memory = max(self.peak_memory, memory)
                updated = Request(
                    max(self.initial.cpus, cpus * 1.25),
                    max(self.initial.memory_bytes, math.ceil(self.peak_memory * 1.25)),
                )
                self.pool._cpus += updated.cpus - self.request.cpus
                self.pool._memory += updated.memory_bytes - self.request.memory_bytes
                self.request = updated
            if self.pool.shared:
                self.pool.shared.update(self)
            self.pool._condition.notify_all()

    async def phase(self, stage: str) -> None:
        self.stage = stage
        self.peak_memory = self.last_memory
        # The same container retains its resident pages during a phase transition.
        # Keep that reservation until fresh measurements establish its working set.
        if self.pool.shared:
            self.pool.shared.update(self)


class SharedResources:
    def __init__(self, directory: Path, scope: str | None) -> None:
        self.directory = directory
        self.scope = scope
        self.held: dict[str, int] = {}
        self.active = 0
        self.healthy = True

    def _rows(self) -> list[dict[str, Any]]:
        rows = []
        owners = 0
        for file in (self.directory / "leases").glob("*.json"):
            fd = os.open(file, os.O_RDWR | os.O_NOFOLLOW)
            try:
                row = read_json(file)
                if row.get("version") != 2:
                    raise ResourcePressureError("Unknown resource lease version; finish or clean its original run")
                try:
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    owners += 1
                    rows.append(row)
                    continue
                prefix = row.get("scope")
                project = row.get("project")
                remains = (
                    any(
                        command(
                            ["docker", *args, "--filter", f"label=com.docker.compose.project={project}"], timeout=15
                        )
                        for args in (["ps", "-aq"], ["network", "ls", "-q"], ["volume", "ls", "-q"])
                    )
                    if project
                    else prefix
                    and re.fullmatch(r"sb-[a-f0-9]{8}-", prefix)
                    and command(["docker", "ps", "-aq", "--filter", "name=^" + prefix], timeout=30)
                )
                if remains:
                    rows.append(row)
                else:
                    file.unlink()
            finally:
                os.close(fd)
        self.active = owners
        self.healthy = owners == len(rows) and all(
            not row.get("adaptive") or (row.get("sampled_at") is not None and time.time() - row["sampled_at"] < 10)
            for row in rows
        )
        return rows

    def update(self, lease: ResourceLease) -> None:
        with cache_lock(self.directory / "budget", timeout=5):
            fd = self.held[lease.key]
            value = {
                **asdict(lease.request),
                "version": 2,
                "project": lease.project,
                "scope": self.scope,
                "pid": os.getpid(),
                "adaptive": lease.adaptive,
                "sampled_at": lease.sampled_at,
                "phase": lease.stage,
            }
            os.lseek(fd, 0, os.SEEK_SET)
            os.ftruncate(fd, 0)
            os.write(fd, json.dumps(value).encode())
            os.fsync(fd)

    def available(self, capacity: Capacity, snapshot: DockerSnapshot | None = None) -> Capacity:
        with cache_lock(self.directory / "budget", timeout=5):
            rows = self._rows()
            return Capacity(
                capacity.cpus - sum(row["cpus"] for row in rows),
                capacity.memory_bytes
                - (snapshot.memory_with_reservations(rows) if snapshot else sum(row["memory_bytes"] for row in rows)),
            )

    def acquire(
        self,
        key: str,
        request: Request,
        capacity: Capacity,
        project: str | None,
        snapshot: DockerSnapshot | None = None,
    ) -> bool:
        with cache_lock(self.directory / "budget", timeout=5):
            rows = self._rows()
            if (
                not self.healthy
                or (snapshot is not None and not snapshot.healthy)
                or sum(row["cpus"] for row in rows) + request.cpus > capacity.cpus
                or (snapshot.memory_with_reservations(rows) if snapshot else sum(row["memory_bytes"] for row in rows))
                + request.memory_bytes
                > capacity.memory_bytes
            ):
                return False
            file = self.directory / "leases" / (key + ".json")
            atomic_json(
                file,
                {
                    **asdict(request),
                    "version": 2,
                    "project": project,
                    "scope": self.scope,
                    "pid": os.getpid(),
                    "started_at": time.time(),
                },
            )
            fd = os.open(file, os.O_RDWR | os.O_NOFOLLOW)
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.held[key] = fd
            return True

    def release(self, key: str) -> None:
        fd = self.held.pop(key, None)
        if fd is None:
            return
        try:
            with cache_lock(self.directory / "budget", timeout=5):
                (self.directory / "leases" / (key + ".json")).unlink(missing_ok=True)
        finally:
            os.close(fd)


def host_limits(
    cpus: float, memory: int, available: int, cgroup: Path = Path("/sys/fs/cgroup")
) -> tuple[float, int, int]:
    if hasattr(os, "sched_getaffinity"):
        cpus = min(cpus, len(os.sched_getaffinity(0)))
    quota = cgroup / "cpu.max"
    if quota.is_file():
        value, period = quota.read_text().split()
        if value != "max":
            cpus = min(cpus, int(value) / int(period))
    limit = cgroup / "memory.max"
    current = cgroup / "memory.current"
    if limit.is_file() and (value := limit.read_text().strip()) != "max":
        memory = min(memory, int(value))
        if current.is_file():
            available = min(available, max(0, int(value) - int(current.read_text())))
    return cpus, memory, min(memory, available)


def inspect_host(root: Path, settings: Resources) -> dict[str, Any]:
    docker = json.loads(command(["docker", "info", "--format", "{{json .}}"], timeout=30))
    cpus = float(docker["NCPU"])
    memory = int(docker["MemTotal"])
    host_memory = psutil.virtual_memory()
    host_cpus, host_total, available = host_limits(
        float(psutil.cpu_count() or 1), host_memory.total, host_memory.available
    )
    reserved = int(settings.reserve_memory_gib * 1024**3)
    capacity = usable_capacity(min(cpus, host_cpus), min(memory, available), settings.reserve_cpus, reserved)
    directory = root.resolve()
    while not directory.exists():
        directory = directory.parent
    disk = shutil.disk_usage(directory)
    return {
        "captured_at": time.time(),
        "docker": {
            "cpus": docker["NCPU"],
            "memory_bytes": docker["MemTotal"],
            "architecture": docker.get("Architecture"),
        },
        "limits": {"cpus": host_cpus, "memory_bytes": host_total, "available_memory_bytes": available},
        "capacity": asdict(capacity),
        "ceiling": asdict(usable_capacity(cpus, memory, settings.reserve_cpus, reserved)),
        "disk": {"free_bytes": disk.free, "total_bytes": disk.total},
        "host_load": list(os.getloadavg()) if hasattr(os, "getloadavg") else None,
        "host_memory": host_memory._asdict(),
        "disk_ready": disk.free >= settings.min_free_disk_gib * 1024**3,
    }


class ResourcePressureError(ValueError):
    pass


class ResourcePool:
    def __init__(
        self,
        capacity: Capacity,
        concurrency: int,
        *,
        admission: Callable[[Request], bool] | None = None,
        pressure_timeout_seconds: float = 600,
        shared_directory: Path | None = None,
        scope: str | None = None,
        sampler: DockerStats | None = None,
    ) -> None:
        if capacity.cpus <= 0 or capacity.memory_bytes <= 0 or concurrency < 1:
            raise ValueError("Insufficient scheduler capacity")
        self.admission = admission or (lambda request: True)
        self.sampler = sampler or getattr(self.admission, "sampler", None)
        self._snapshot: DockerSnapshot | None = None
        self.pressure_timeout_seconds = pressure_timeout_seconds
        self.shared = SharedResources(shared_directory, scope) if shared_directory is not None else None
        self._available = capacity
        self.capacity = capacity
        self.concurrency = concurrency
        self.active = 0
        self._cpus = 0.0
        self._memory = 0
        self._condition = asyncio.Condition()
        self._queue: list[Waiting] = []
        self._leases: dict[str, ResourceLease] = {}
        self.wait_reason = "queue_priority"

    def validate(self, request: Request) -> None:
        if request.cpus > self.capacity.cpus or request.memory_bytes > self.capacity.memory_bytes:
            raise ValueError(f"Task exceeds scheduler capacity: {asdict(request)} / {asdict(self.capacity)}")

    def fits(self, request: Request) -> bool:
        return (
            all(lease.healthy for lease in self._leases.values())
            and (self.shared is None or self.shared.healthy)
            and self.active < self.concurrency
            and self._cpus + request.cpus <= self.capacity.cpus
            and self._memory + request.memory_bytes <= self.capacity.memory_bytes
            and request.cpus <= self._available.cpus
            and request.memory_bytes <= self._available.memory_bytes
        )

    def eligible(self, token: Waiting) -> bool:
        ordered = sorted(self._queue, key=lambda row: -row.priority)
        head = ordered[0]
        if self.fits(head.request):
            return token is head
        if head.bypasses >= 2 * self.concurrency:
            return False
        return next((row for row in ordered if self.fits(row.request)), None) is token

    def admit(self, token: Waiting, shared_key: str, project: str | None) -> bool:
        if self.sampler and (self._snapshot is None or not self._snapshot.healthy):
            self.wait_reason = "docker_sample_unavailable"
            return False
        if self.shared:
            self._available = self.shared.available(self.capacity, self._snapshot)
        elif self._snapshot:
            self._available = Capacity(
                self.capacity.cpus - self._cpus,
                self.capacity.memory_bytes
                - self._snapshot.memory_with_reservations(
                    [{**asdict(lease.request), "project": lease.project} for lease in self._leases.values()]
                ),
            )
        if not self.eligible(token):
            self.wait_reason = (
                "resource_sample_unavailable"
                if not all(lease.healthy for lease in self._leases.values())
                or (self.shared and not self.shared.healthy)
                else "memory_budget"
                if self._memory + token.request.memory_bytes > self.capacity.memory_bytes
                or token.request.memory_bytes > self._available.memory_bytes
                else "cpu_budget"
                if self._cpus + token.request.cpus > self.capacity.cpus or token.request.cpus > self._available.cpus
                else "queue_priority_or_concurrency"
            )
            return False
        if not self.admission(token.request):
            self.wait_reason = getattr(self.admission, "reason", "host_pressure")
            return False
        if self.shared and not self.shared.acquire(shared_key, token.request, self.capacity, project, self._snapshot):
            self.wait_reason = "shared_resource_budget"
            return False
        return True

    @asynccontextmanager
    async def reserve(
        self,
        request: Request,
        *,
        adaptive: bool = False,
        priority: int = 0,
        on_wait: Callable[[str], None] | None = None,
        project: str | None = None,
    ) -> AsyncIterator[ResourceLease]:
        self.validate(request)
        token = Waiting(request, priority=priority)
        shared_key = uuid.uuid4().hex
        lease = ResourceLease(self, shared_key, request, adaptive, project)
        async with self._condition:
            self._queue.append(token)
        idle_pressure_since = time.monotonic()
        last_reason = None
        try:
            while True:
                if self.sampler:
                    try:
                        self._snapshot = await self.sampler.snapshot()
                    except (
                        OSError,
                        ValueError,
                        KeyError,
                        TypeError,
                        RuntimeError,
                        TimeoutError,
                        subprocess.SubprocessError,
                        aiohttp.ClientError,
                    ):
                        self._snapshot = None
                async with self._condition:
                    if self.admit(token, shared_key, project):
                        head = max(self._queue, key=lambda row: row.priority)
                        if head is not token:
                            head.bypasses += 1
                        self.active += 1
                        self._cpus += request.cpus
                        self._memory += request.memory_bytes
                        self._leases[shared_key] = lease
                        if self.shared:
                            try:
                                self.shared.update(lease)
                            except BaseException:
                                self.active -= 1
                                self._cpus -= request.cpus
                                self._memory -= request.memory_bytes
                                self._leases.pop(shared_key)
                                self.shared.release(shared_key)
                                raise
                        break
                    if on_wait and last_reason != self.wait_reason:
                        on_wait(self.wait_reason)
                        last_reason = self.wait_reason
                    if self.active or (self.shared and self.shared.active):
                        idle_pressure_since = time.monotonic()
                    elif time.monotonic() - idle_pressure_since >= self.pressure_timeout_seconds:
                        raise ResourcePressureError(
                            "Sustained host or disk pressure prevents admission; no running task was stopped"
                        )
                    try:
                        async with asyncio.timeout(min(1, self.pressure_timeout_seconds)):
                            await self._condition.wait()
                    except TimeoutError:
                        pass
        finally:
            async with self._condition:
                self._queue.remove(token)
                self._condition.notify_all()
        try:
            yield lease
        finally:
            try:
                if self.shared:
                    self.shared.release(shared_key)
            finally:
                async with self._condition:
                    self.active -= 1
                    self._cpus -= lease.request.cpus
                    self._memory -= lease.request.memory_bytes
                    self._leases.pop(shared_key)
                    self._condition.notify_all()


def usable_capacity(cpus: float, memory: int, reserve_cpus: float, reserve_memory: int) -> Capacity:
    if cpus <= reserve_cpus or memory <= reserve_memory:
        raise ValueError("Machine cannot satisfy benchmark resource reserves")
    return Capacity(cpus - reserve_cpus, memory - reserve_memory)


def parse_bytes(value: str) -> int | None:
    match = re.fullmatch(r"([0-9.]+)\s*([kKMGT]?i?B)", value.strip())
    if not match:
        return None
    units = {
        "B": 1,
        "kB": 1000,
        "KB": 1000,
        "MB": 1000**2,
        "GB": 1000**3,
        "TB": 1000**4,
        "KiB": 1024,
        "MiB": 1024**2,
        "GiB": 1024**3,
        "TiB": 1024**4,
    }
    return int(float(match[1]) * units[match[2]])


class HostPressure:
    def __init__(self, root: Path, settings: Resources) -> None:
        self.root = root
        self.settings = settings
        self.sampler = DockerStats()
        self.previous: tuple[float, float, float] | None = None
        self.saturated_since: float | None = None
        self.cpu_ready = False
        self.reason = "host_sample_unavailable"

    def __call__(self, request: Request) -> bool:
        try:
            now = time.monotonic()
            if self.previous is None or now - self.previous[0] >= 1:
                times = psutil.cpu_times()._asdict()
                total = sum(value for key, value in times.items() if key not in {"guest", "guest_nice"})
                idle = times["idle"] + times.get("iowait", 0)
                previous, self.previous = self.previous, (now, total, idle)
                self.cpu_ready = previous is not None and total > previous[1]
                if self.cpu_ready:
                    assert previous is not None
                    busy = 1 - (idle - previous[2]) / (total - previous[1])
                    self.saturated_since = (
                        (self.saturated_since if self.saturated_since is not None else now) if busy >= 0.95 else None
                    )
            memory = psutil.virtual_memory()
            available = host_limits(float(psutil.cpu_count() or 1), memory.total, memory.available)[2]
            if not self.cpu_ready:
                self.reason = "host_sample_unavailable"
            elif available < self.settings.reserve_memory_gib * 1024**3 + request.memory_bytes:
                self.reason = "host_memory_pressure"
            elif shutil.disk_usage(self.root).free < self.settings.min_free_disk_gib * 1024**3:
                self.reason = "disk_pressure"
            elif self.saturated_since is not None and now - self.saturated_since >= 3:
                self.reason = "cpu_saturated"
            else:
                self.reason = "ready"
                return True
        except (OSError, ValueError, KeyError, TypeError, psutil.Error):
            self.reason = "host_sample_unavailable"
        return False


def admission_for(root: Path, plan: dict[str, Any]) -> Callable[[Request], bool]:
    settings = plan.get("config", {}).get("resources")
    if not settings:
        return lambda request: True
    return HostPressure(
        root,
        Resources.model_validate(settings),
    )


def shared_pool_options(root: Path, plan: dict[str, Any]) -> dict[str, Any]:
    return (
        {"shared_directory": Path(plan["cache"]) / "resources", "scope": "sb-" + root.name[-8:] + "-"}
        if plan.get("cache")
        else {}
    )


class BuildSlots:
    def __init__(self, directory: Path, *, limit: int = 2) -> None:
        if limit < 1:
            raise ValueError("Build concurrency must be positive")
        self.directory = directory
        self.limit = limit
        self.fd: int | None = None

    def acquire(self) -> bool:
        self.directory.mkdir(parents=True, exist_ok=True)
        for index in range(self.limit):
            fd = os.open(self.directory / f"slot-{index}.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                os.close(fd)
                continue
            self.fd = fd
            return True
        return False

    def release(self) -> None:
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None


@asynccontextmanager
async def build_slot(cache: Path, *, wait_seconds: float | None, limit: int = 2) -> AsyncIterator[None]:
    slots = BuildSlots(cache / "build-slots", limit=limit)
    try:
        async with asyncio.timeout(wait_seconds):
            while True:
                if slots.acquire():
                    break
                await asyncio.sleep(0.1)
        yield
    finally:
        slots.release()


@contextmanager
def build_reservation(cache: Path, *, timeout: float, settings: Resources | None = None) -> Iterator[None]:
    settings = settings or Resources()
    host = inspect_host(cache, settings)
    capacity = Capacity(**host["ceiling"])
    request = Request(2, 4 * 1024**3)
    pool = ResourcePool(
        capacity,
        1,
        admission=HostPressure(cache, settings),
        pressure_timeout_seconds=timeout,
        shared_directory=cache / "resources",
        scope="build",
    )
    pool.validate(request)
    slots = BuildSlots(cache / "build-slots", limit=settings.build_concurrency)
    started = time.monotonic()
    try:
        while not slots.acquire():
            if time.monotonic() - started >= timeout:
                raise TimeoutError("Build slot admission timed out")
            time.sleep(0.1)
        pool.pressure_timeout_seconds = max(0.01, timeout - (time.monotonic() - started))
        with asyncio.Runner() as runner:
            manager = pool.reserve(request)
            runner.run(manager.__aenter__())
            try:
                yield
            finally:
                runner.run(manager.__aexit__(None, None, None))
    finally:
        slots.release()


def with_runtime_overhead(native: Request) -> Request:
    return Request(native.cpus + 0.2, native.memory_bytes + 128 * 1024**2)


def working_set_request(native: Request) -> Request:
    return with_runtime_overhead(Request(min(native.cpus, 0.25), min(native.memory_bytes, 1024**3)))
