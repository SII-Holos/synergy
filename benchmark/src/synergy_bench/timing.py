from __future__ import annotations

import json
import os
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from functools import wraps
from pathlib import Path
from typing import ParamSpec, TypeVar

P = ParamSpec("P")
T = TypeVar("T")


@contextmanager
def phase(name: str) -> Iterator[None]:
    started = time.perf_counter()
    status = "failure"
    try:
        yield
        status = "success"
    finally:
        target = os.environ.get("SYNERGY_BENCH_TIMINGS")
        if target:
            path = Path(target)
            path.parent.mkdir(parents=True, exist_ok=True)
            row = json.dumps({"phase": name, "seconds": time.perf_counter() - started, "status": status}) + "\n"
            with path.open("a") as stream:
                stream.write(row)


def measured(name: str) -> Callable[[Callable[P, T]], Callable[P, T]]:
    def decorate(function: Callable[P, T]) -> Callable[P, T]:
        @wraps(function)
        def call(*args: P.args, **kwargs: P.kwargs) -> T:
            with phase(name):
                return function(*args, **kwargs)

        return call

    return decorate
