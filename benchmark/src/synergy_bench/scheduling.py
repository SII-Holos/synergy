from __future__ import annotations

import time
from collections.abc import AsyncIterator
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from contextvars import ContextVar
from pathlib import Path
from typing import Any

from .lifecycle import pause_deadlines
from .resources import Request, ResourceLease, ResourcePool, working_set_request
from .storage import atomic_json

current_resources: ContextVar[PhaseResources | None] = ContextVar("benchmark_resources", default=None)


@asynccontextmanager
async def queued[T](manager: AbstractAsyncContextManager[T], project: str, reason: str) -> AsyncIterator[T]:
    scheduler = current_resources.get()
    started = time.monotonic()
    if scheduler:
        scheduler.record("queued", project, phase="preparation", reason=reason)
    with pause_deadlines():
        value = await manager.__aenter__()
    try:
        if scheduler:
            scheduler.record(
                "admitted", project, phase="preparation", reason=reason, queue_seconds=time.monotonic() - started
            )
        yield value
    except BaseException as error:
        if not await manager.__aexit__(type(error), error, error.__traceback__):
            raise
    else:
        await manager.__aexit__(None, None, None)


class PhaseResources:
    def __init__(self, pool: ResourcePool, directory: Path) -> None:
        self.pool = pool
        self.directory = directory
        self.leases: dict[str, tuple[AbstractAsyncContextManager[ResourceLease], ResourceLease]] = {}
        self.events: list[dict[str, Any]] = []

    def record(self, event: str, project: str, **fields: Any) -> None:
        self.events.append({"event": event, "project": project, "at": time.time(), **fields})
        atomic_json(self.directory / "scheduling.json", {"version": 1, "events": self.events})

    async def acquire(self, project: str, native: Request) -> None:
        if project in self.leases:
            return
        verifier = "__verifier__" in project
        stage = "verifier" if verifier else "agent"
        request = working_set_request(native)
        queued = time.monotonic()
        self.record("queued", project, phase=stage, memory_bytes=request.memory_bytes, cpus=request.cpus)
        manager = self.pool.reserve(
            request,
            adaptive=True,
            priority=int(verifier),
            on_wait=lambda reason: self.record("pressure", project, phase=stage, reason=reason),
        )
        with pause_deadlines():
            lease = await manager.__aenter__()
        self.leases[project] = (manager, lease)
        try:
            await lease.phase(stage)
            self.record("started", project, phase=stage, queue_seconds=time.monotonic() - queued)
        except BaseException:
            await self.release(project)
            raise

    async def phase(self, stage: str) -> None:
        for project, (_, lease) in self.leases.items():
            await lease.phase(stage)
            self.record("phase", project, phase=stage)

    async def sample(self, samples: dict[str, tuple[int | None, float | None]] | None) -> None:
        for project, (_, lease) in tuple(self.leases.items()):
            memory, cpus = (samples or {}).get(project, (None, None))
            await lease.sample(memory, cpus)

    async def release(self, project: str) -> None:
        entry = self.leases.pop(project, None)
        if entry:
            await entry[0].__aexit__(None, None, None)
            self.record("released", project)

    async def finish(self, *, resources_removed: bool) -> None:
        if self.leases and not resources_removed:
            await self.sample(None)
            raise RuntimeError("Owned resources remain; retaining scheduler reservations")
        for project in tuple(self.leases):
            await self.release(project)
