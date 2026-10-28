from __future__ import annotations

import argparse
import shutil
import signal
import tempfile
import time
from collections.abc import Sequence
from pathlib import Path

from .config import Source
from .prepare import prepare_source, verify_prepared
from .storage import atomic_json
from .timing import phase


def prepare(output: Path, source: Path, *, timeout: int = 1800) -> Path:
    if timeout < 1:
        raise ValueError("CI preparation timeout must be positive")
    output = output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    receipt: dict[str, str | float] = {"status": "running", "stage": "source", "timeout_seconds": timeout}

    def record() -> None:
        receipt["elapsed_seconds"] = time.monotonic() - started
        atomic_json(output / "preparation.json", receipt)

    record()
    print(f"[benchmark preparation] source timeout={timeout}s", flush=True)
    try:
        target = output / "prepared"
        if target.exists():
            raise ValueError("CI preparation requires a fresh output directory")
        artifact = prepare_source(
            Source(path=str(source.resolve())), source, output / "cache", "linux/amd64", timeout=timeout
        )
        receipt["stage"] = "publish"
        record()
        print("[benchmark preparation] publish", flush=True)
        with tempfile.TemporaryDirectory(prefix=".publish-", dir=output) as temporary:
            stage = Path(temporary) / "prepared"
            with phase("publish"):
                shutil.copytree(artifact, stage, symlinks=True)
                verify_prepared(stage)
                stage.rename(target)
        receipt["status"] = "completed"
        return target
    except BaseException as error:
        receipt["status"] = "interrupted" if isinstance(error, KeyboardInterrupt) else "failed"
        receipt["error"] = type(error).__name__
        raise
    finally:
        record()
        print(f"[benchmark preparation] {receipt['status']} stage={receipt['stage']}", flush=True)


def main(argv: Sequence[str] | None = None) -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--timeout", type=int, default=1800)
    arguments = parser.parse_args(argv)
    if arguments.timeout < 1:
        parser.error("--timeout must be positive")

    def interrupted(number: int, _frame: object) -> None:
        signal.setitimer(signal.ITIMER_REAL, 0)
        if number == signal.SIGALRM:
            raise TimeoutError("CI preparation deadline exceeded")
        raise KeyboardInterrupt

    previous = {
        number: signal.signal(number, interrupted) for number in (signal.SIGALRM, signal.SIGTERM, signal.SIGINT)
    }
    try:
        signal.setitimer(signal.ITIMER_REAL, arguments.timeout)
        prepare(arguments.output, arguments.source, timeout=arguments.timeout)
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        for number, handler in previous.items():
            signal.signal(number, handler)


if __name__ == "__main__":
    main()
