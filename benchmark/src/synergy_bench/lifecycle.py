from __future__ import annotations

import asyncio
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from .storage import atomic_json, read_json


def error_trace(error: BaseException) -> list[dict[str, Any]]:
    chain = []
    seen: set[int] = set()
    while id(error) not in seen:
        seen.add(id(error))
        frames = []
        frame = error.__traceback__
        while frame is not None:
            frames.append(
                {
                    "module": frame.tb_frame.f_globals.get("__name__"),
                    "function": frame.tb_frame.f_code.co_name,
                    "line": frame.tb_lineno,
                }
            )
            frame = frame.tb_next
        chain.append({"type": type(error).__name__, "frames": frames})
        cause = error.__cause__ or (None if error.__suppress_context__ else error.__context__)
        if cause is None:
            break
        error = cause
    return chain


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
            row["error_trace"] = error_trace(error)
            raise
        finally:
            row["ended_at"] = time.time()
            row["wall_seconds"] = time.monotonic() - started
            atomic_json(self.file, self.records)
