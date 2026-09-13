from __future__ import annotations

import argparse
import json
import os
import shutil
from collections.abc import Sequence
from pathlib import Path

FAMILIES = ("integration", "parent-death", "compaction-integration", "oom-integration", "matrix-integration")
PRIVATE_DIRECTORIES = {"home", "wire", "evaluator", "inputs", "data", ".git", "node_modules"}
FILENAMES = {
    "evidence.json",
    "result.json",
    "rollout.zip",
    "execution.json",
    "accounting.json",
    "environment-cleanup.json",
    "cleanup.json",
    "export.json",
    "archive.json",
    "resources.json",
    "export.log",
    "validation.log",
    "parent.log",
    "recovered.log",
    "integration-cli.log",
    "container-events.log",
    "container-events-live.jsonl",
    "oom.log",
    "doctor.json",
    "prewarm.json",
}


def collect(root: Path, output: Path, families: Sequence[str]) -> dict[str, object]:
    if any(family not in FAMILIES for family in families):
        raise ValueError("Unknown evidence family")
    output.mkdir(parents=True, exist_ok=True)
    errors: list[dict[str, str]] = []
    copied = 0

    def failed(error: OSError, path: Path | None = None) -> None:
        path = path or (Path(error.filename) if error.filename else root)
        errors.append({"path": str(path.relative_to(root)), "error": type(error).__name__})

    for family in dict.fromkeys(families):
        source_root = root / family
        if source_root.is_symlink() or not source_root.exists():
            continue
        for directory, children, files in os.walk(source_root, onerror=failed):
            children[:] = [
                name
                for name in children
                if name not in PRIVATE_DIRECTORIES and not (Path(directory) / name).is_symlink()
            ]
            for name in files:
                source = Path(directory) / name
                if name not in FILENAMES or source.is_symlink():
                    continue
                target = output / source.relative_to(root)
                target.parent.mkdir(parents=True, exist_ok=True)
                try:
                    shutil.copyfile(source, target)
                    copied += 1
                except OSError as error:
                    failed(error, source)
    result = {"copied": copied, "errors": errors}
    (output / "collection.json").write_text(json.dumps(result))
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Collect explicitly selected deterministic benchmark CI evidence")
    parser.add_argument("families", nargs="+", choices=FAMILIES)
    parser.add_argument("--root", type=Path, default=Path(".artifacts/benchmark"))
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(collect(args.root, args.output, args.families)))
