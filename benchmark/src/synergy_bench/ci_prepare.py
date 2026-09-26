from __future__ import annotations

import argparse
import shutil
import tempfile
from pathlib import Path

from .config import Source
from .prepare import prepare_source, verify_prepared
from .timing import phase


def prepare(output: Path, source: Path) -> Path:
    output = output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    target = output / "prepared"
    if target.exists():
        raise ValueError("CI preparation requires a fresh output directory")
    artifact = prepare_source(Source(path=str(source.resolve())), source, output / "cache", "linux/amd64")
    with tempfile.TemporaryDirectory(prefix=".publish-", dir=output) as temporary:
        stage = Path(temporary) / "prepared"
        with phase("publish"):
            shutil.copytree(artifact, stage, symlinks=True)
            verify_prepared(stage)
            stage.rename(target)
    return target


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--source", required=True, type=Path)
    arguments = parser.parse_args()
    prepare(arguments.output, arguments.source)
