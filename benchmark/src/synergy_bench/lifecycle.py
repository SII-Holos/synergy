from __future__ import annotations

import asyncio
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from .storage import atomic_json, read_json


class Lifecycle:
    def __init__(self, directory: Path) -> None:
        self.file = directory / "stages.json"
        self.records: dict[str, list[dict[str, Any]]] = read_json(self.file) if self.file.exists() else {}

    @asynccontextmanager
    async def stage(self, name: str, *, deadline: float | None) -> AsyncIterator[None]:
        if deadline is not None and deadline <= 0:
            raise ValueError("Stage deadline must be positive")
        started = time.monotonic()
        row: dict[str, Any] = {"status": "running", "started_at": time.time(), "deadline_seconds": deadline}
        self.records.setdefault(name, []).append(row)
        atomic_json(self.file, self.records)
        try:
            async with asyncio.timeout(deadline):
                yield
            row["status"] = "completed"
        except BaseException as error:
            row["status"] = (
                "timed_out"
                if isinstance(error, TimeoutError)
                or type(error).__name__
                in {
                    "AgentTimeoutError",
                    "VerifierTimeoutError",
                    "EnvironmentStartTimeoutError",
                    "AgentSetupTimeoutError",
                }
                else "interrupted"
                if isinstance(error, asyncio.CancelledError)
                else "failed"
            )
            row["error"] = type(error).__name__
            raise
        finally:
            row["ended_at"] = time.time()
            row["wall_seconds"] = time.monotonic() - started
            atomic_json(self.file, self.records)
