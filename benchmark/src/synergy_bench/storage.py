from __future__ import annotations

import hashlib
import json
import os
import tempfile
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any


def digest(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def atomic_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as output:
            json.dump(value, output, indent=2, ensure_ascii=False)
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        Path(temporary).unlink(missing_ok=True)


def read_json(path: Path) -> Any:
    return json.loads(path.read_text())


@contextmanager
def locked(directory: Path, *, create: bool = True) -> Iterator[None]:
    import fcntl

    directory = directory.resolve()
    directory.parent.mkdir(parents=True, exist_ok=True)
    lock = directory.parent / f".{directory.name}.lock"
    fd = os.open(lock, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "a") as handle:
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise ValueError("Experiment is already owned by another process") from error
        try:
            if create:
                directory.mkdir(parents=True, exist_ok=True)
            elif not directory.is_dir():
                raise ValueError("Experiment directory does not exist")
            yield
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
