from __future__ import annotations

import asyncio
import os
import signal
import time
from pathlib import Path
from typing import Any


async def run_process(args: list[str], *, log: Path, deadline: float, env: dict[str, str] | None = None) -> int:
    log.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(log, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    with os.fdopen(fd, "ab", buffering=0) as output:
        process = await asyncio.create_subprocess_exec(
            *args, env=env, start_new_session=True, stdin=asyncio.subprocess.DEVNULL, stdout=output, stderr=output
        )
        try:
            async with asyncio.timeout(deadline):
                return await process.wait()
        finally:
            if process.returncode is None:
                try:
                    os.killpg(process.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
                try:
                    async with asyncio.timeout(5):
                        await process.wait()
                except TimeoutError:
                    pass
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            await process.wait()
            os.fsync(output.fileno())


async def run_preparation_process(
    args: list[str],
    *,
    log: Path,
    deadline: float,
    env: dict[str, str] | None = None,
    backoff: float = 2,
) -> int:
    from .prepare import transient_preparation_error
    from .storage import atomic_json

    expires = time.monotonic() + deadline
    records: list[dict[str, Any]] = []
    for attempt in range(3):
        output = log.with_suffix(log.suffix + f".attempt-{attempt + 1}")
        row: dict[str, Any] = {"started_at": time.time(), "status": "running", "log": output.name}
        records.append(row)
        atomic_json(log.with_suffix(log.suffix + ".attempts.json"), records)
        try:
            code = await run_process(args, env=env, log=output, deadline=max(0.01, expires - time.monotonic()))
            detail = output.read_text(errors="replace")
            await asyncio.to_thread(log.write_text, detail)
            transient = code != 0 and transient_preparation_error(detail)
            row.update(status="completed" if code == 0 else "failed", exit_code=code, retryable=transient)
            delay = backoff * 2**attempt
            if not transient or attempt == 2 or time.monotonic() + delay >= expires:
                return code
            row["backoff_seconds"] = delay
        except BaseException as error:
            row.update(
                status="interrupted" if isinstance(error, asyncio.CancelledError) else "failed",
                error=type(error).__name__,
            )
            raise
        finally:
            row["ended_at"] = time.time()
            atomic_json(log.with_suffix(log.suffix + ".attempts.json"), records)
        await asyncio.sleep(delay)
    raise RuntimeError("Preparation retry budget exhausted")
