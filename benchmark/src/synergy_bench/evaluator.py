from __future__ import annotations

import os
import shutil
import tempfile
from pathlib import Path

from . import prepare
from .catalog import tree_digest
from .storage import atomic_json, read_json


def freeze_evaluator(run: Path, expected: dict[str, str]) -> Path:
    run.mkdir(parents=True, exist_ok=True)
    target = run / "evaluator"
    if target.exists():
        recorded_environment(run, expected)
        return target
    with tempfile.TemporaryDirectory(prefix=".evaluator-", dir=run) as temporary:
        stage = Path(temporary) / "snapshot"
        stage.mkdir()
        for name in ["src", "runtime"]:
            shutil.copytree(prepare.BENCHMARK / name, stage / name, ignore=shutil.ignore_patterns("__pycache__"))
        for name in ["uv.lock", "pyproject.toml", "package.json"]:
            shutil.copyfile(prepare.BENCHMARK / name, stage / name)
        if prepare.evaluator_identity(stage) != expected or prepare.evaluator_identity() != expected:
            raise ValueError("Evaluator changed during preparation; create a new experiment")
        receipt = {"identity": expected, "snapshot_digest": tree_digest(stage)}
        atomic_json(run / "evaluator.json", receipt)
        stage.rename(target)
        fd = os.open(run, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    return target


def recorded_environment(run: Path, expected: dict[str, str]) -> dict[str, str]:
    snapshot = (run / "evaluator").resolve()
    receipt = read_json(run / "evaluator.json")
    if receipt["identity"] != expected or tree_digest(snapshot) != receipt["snapshot_digest"]:
        raise ValueError("Recorded evaluator snapshot changed")
    if prepare.evaluator_identity(snapshot) != expected:
        raise ValueError("Recorded evaluator interpreter or dependencies changed")
    return {**os.environ, "PYTHONPATH": str(snapshot / "src"), "PYTHONDONTWRITEBYTECODE": "1"}
