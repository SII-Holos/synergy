from __future__ import annotations

import asyncio
import fcntl
import json
import math
import os
import re
import shutil
import time
import uuid
from collections.abc import AsyncIterator, Callable, Iterator
from contextlib import asynccontextmanager, contextmanager
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

import psutil

from .cache import cache_lock
from .config import Resources
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


class SharedResources:
    def __init__(self, directory: Path, scope: str | None) -> None:
        self.directory = directory
        self.scope = scope
        self.held: dict[str, int] = {}
        self.active = 0

    def _rows(self) -> list[dict[str, Any]]:
        rows = []
        for file in (self.directory / "leases").glob("*.json"):
            fd = os.open(file, os.O_RDWR | os.O_NOFOLLOW)
            try:
                row = read_json(file)
                try:
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    rows.append(row)
                    continue
                prefix = row.get("scope")
                if (
                    prefix
                    and re.fullmatch(r"sb-[a-f0-9]{8}-", prefix)
                    and command(["docker", "ps", "-q", "--filter", "name=^" + prefix], timeout=30)
                ):
                    rows.append(row)
                else:
                    file.unlink()
            finally:
                os.close(fd)
        self.active = len(rows)
        return rows

    def available(self, capacity: Capacity) -> Capacity:
        with cache_lock(self.directory / "budget", timeout=5):
            rows = self._rows()
            return Capacity(
                capacity.cpus - sum(row["cpus"] for row in rows),
                capacity.memory_bytes - sum(row["memory_bytes"] for row in rows),
            )

    def acquire(self, key: str, request: Request, capacity: Capacity) -> bool:
        with cache_lock(self.directory / "budget", timeout=5):
            rows = self._rows()
            if (
                sum(row["cpus"] for row in rows) + request.cpus > capacity.cpus
                or sum(row["memory_bytes"] for row in rows) + request.memory_bytes > capacity.memory_bytes
            ):
                return False
            file = self.directory / "leases" / (key + ".json")
            atomic_json(file, {**asdict(request), "scope": self.scope, "pid": os.getpid(), "started_at": time.time()})
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


def inspect_host(root: Path, settings: Resources) -> dict[str, Any]:
    docker = json.loads(command(["docker", "info", "--format", "{{json .}}"], timeout=30))
    cpus = float(docker["NCPU"])
    memory = int(docker["MemTotal"])
    reserved = max(int(settings.reserve_memory_gib * 1024**3), int(memory * settings.reserve_memory_fraction))
    capacity = usable_capacity(cpus, memory, settings.reserve_cpus, reserved)
    directory = root.resolve()
    while not directory.exists():
        directory = directory.parent
    disk = shutil.disk_usage(directory)
    return {
        "captured_at": time.time(),
        "docker": {"cpus": cpus, "memory_bytes": memory, "architecture": docker.get("Architecture")},
        "capacity": asdict(capacity),
        "disk": {"free_bytes": disk.free, "total_bytes": disk.total},
        "host_load": list(os.getloadavg()) if hasattr(os, "getloadavg") else None,
        "host_memory": psutil.virtual_memory()._asdict(),
        "disk_ready": disk.free >= settings.min_free_disk_gib * 1024**3,
    }


class ResourcePool:
    def __init__(
        self,
        capacity: Capacity,
        concurrency: int,
        *,
        admission: Callable[[], bool] | None = None,
        pressure_timeout_seconds: float = 600,
        shared_directory: Path | None = None,
        scope: str | None = None,
    ) -> None:
        if capacity.cpus <= 0 or capacity.memory_bytes <= 0 or concurrency < 1:
            raise ValueError("Insufficient scheduler capacity")
        self.admission = admission or (lambda: True)
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

    def validate(self, request: Request) -> None:
        if request.cpus > self.capacity.cpus or request.memory_bytes > self.capacity.memory_bytes:
            raise ValueError(f"Task exceeds scheduler capacity: {asdict(request)} / {asdict(self.capacity)}")

    def fits(self, request: Request) -> bool:
        return (
            self.active < self.concurrency
            and self._cpus + request.cpus <= self.capacity.cpus
            and self._memory + request.memory_bytes <= self.capacity.memory_bytes
            and request.cpus <= self._available.cpus
            and request.memory_bytes <= self._available.memory_bytes
        )

    def eligible(self, token: Waiting) -> bool:
        head = self._queue[0]
        if self.fits(head.request):
            return token is head
        if head.bypasses >= 2 * self.concurrency:
            return False
        return next((row for row in self._queue if self.fits(row.request)), None) is token

    def admit(self, token: Waiting, shared_key: str) -> bool:
        if self.shared:
            self._available = self.shared.available(self.capacity)
        return (
            self.eligible(token)
            and self.admission()
            and (self.shared is None or self.shared.acquire(shared_key, token.request, self.capacity))
        )

    @asynccontextmanager
    async def reserve(self, request: Request) -> AsyncIterator[None]:
        self.validate(request)
        token = Waiting(request)
        shared_key = uuid.uuid4().hex
        async with self._condition:
            self._queue.append(token)
            idle_pressure_since = time.monotonic()
            try:
                while not self.admit(token, shared_key):
                    if self.active or (self.shared and self.shared.active):
                        idle_pressure_since = time.monotonic()
                    elif time.monotonic() - idle_pressure_since >= self.pressure_timeout_seconds:
                        raise ValueError(
                            "Sustained host or disk pressure prevents admission; no running task was stopped"
                        )
                    try:
                        async with asyncio.timeout(min(1, self.pressure_timeout_seconds)):
                            await self._condition.wait()
                    except TimeoutError:
                        pass
                if self._queue[0] is not token:
                    self._queue[0].bypasses += 1
                self.active += 1
                self._cpus += request.cpus
                self._memory += request.memory_bytes
            finally:
                self._queue.remove(token)
                self._condition.notify_all()
        try:
            yield
        finally:
            try:
                if self.shared:
                    self.shared.release(shared_key)
            finally:
                async with self._condition:
                    self.active -= 1
                    self._cpus -= request.cpus
                    self._memory -= request.memory_bytes
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


def pressure_ready(root: Path, *, min_free_bytes: int, reserve_memory_bytes: int) -> bool:
    memory = psutil.virtual_memory()
    return (
        shutil.disk_usage(root).free >= min_free_bytes
        and memory.available >= reserve_memory_bytes
        and psutil.cpu_percent() < 95
    )


def admission_for(root: Path, plan: dict[str, Any]) -> Callable[[], bool]:
    settings = plan.get("config", {}).get("resources")
    if not settings:
        return lambda: True
    return lambda: pressure_ready(
        root,
        min_free_bytes=int(settings["min_free_disk_gib"] * 1024**3),
        reserve_memory_bytes=max(
            int(settings["reserve_memory_gib"] * 1024**3),
            int(psutil.virtual_memory().total * settings["reserve_memory_fraction"]),
        ),
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
async def build_slot(cache: Path, *, wait_seconds: float, limit: int = 2) -> AsyncIterator[None]:
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
    capacity = Capacity(**host["capacity"])
    request = Request(2, 4 * 1024**3)
    ResourcePool(capacity, 1).validate(request)
    shared = SharedResources(cache / "resources", "build")
    slots = BuildSlots(cache / "build-slots", limit=settings.build_concurrency)
    key = uuid.uuid4().hex
    started = time.monotonic()
    acquired = False
    try:
        while not (acquired := shared.acquire(key, request, capacity)):
            if time.monotonic() - started >= timeout:
                raise TimeoutError("Build resource admission timed out")
            time.sleep(0.2)
        while not slots.acquire():
            if time.monotonic() - started >= timeout:
                raise TimeoutError("Build slot admission timed out")
            time.sleep(0.1)
        yield
    finally:
        try:
            if acquired:
                shared.release(key)
        finally:
            slots.release()


def with_runtime_overhead(native: Request) -> Request:
    return Request(native.cpus + 0.2, native.memory_bytes + 128 * 1024**2)
