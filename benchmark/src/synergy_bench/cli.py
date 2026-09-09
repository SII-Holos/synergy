from __future__ import annotations

import argparse
import asyncio
import json
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

from .catalog import Suite
from .prepare import BENCHMARK
from .runner import initialize, inspect_config, remove_environment, resume
from .storage import locked, read_json


def emit(value: Any) -> None:
    print(json.dumps(value, indent=2, ensure_ascii=False))


def clean(root: Path) -> None:
    root = root.resolve()
    if read_json(root / "owner.json") != {"kind": "synergy-benchmark-run", "version": 1}:
        raise ValueError("Not a benchmark-owned run")
    with locked(root):
        for record in root.glob("**/environment.json"):
            remove_environment(root, record)
        shutil.rmtree(root)


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="synergy-bench", description="Local Synergy experiments and raw rollout evidence"
    )
    sub = parser.add_subparsers(dest="command", required=True)
    listing = sub.add_parser("list", help="List locked tasks without Docker or model calls")
    listing.add_argument("suite", nargs="?", type=Path, default=BENCHMARK / "suites/local-24.json")
    listing.add_argument("--tag", action="append", default=[])
    for name in ["plan", "prepare", "run"]:
        action = sub.add_parser(name)
        action.add_argument("config", type=Path)
    for name in ["resume", "inspect", "debug", "clean"]:
        action = sub.add_parser(name)
        action.add_argument("run", type=Path)
        if name in {"inspect", "debug"}:
            action.add_argument("--trial", required=name == "debug")
    args = parser.parse_args()
    try:
        if args.command == "list":
            suite = Suite.load(args.suite)
            emit([task.model_dump() for task in suite.tasks if set(args.tag) <= set(task.tags)])
        elif args.command == "plan":
            emit(inspect_config(args.config.resolve())[2])
        elif args.command in {"prepare", "run"}:
            root = initialize(args.config)
            emit({"run": str(root)})
            if args.command == "run":
                asyncio.run(resume(root))
        elif args.command in {"resume", "debug"}:
            asyncio.run(resume(args.run, debug_trial=args.trial if args.command == "debug" else None))
        elif args.command == "inspect":
            if args.trial is None:
                emit(
                    {
                        "plan": read_json(args.run / "plan.json"),
                        "state": read_json(args.run / "state.json") if (args.run / "state.json").exists() else None,
                    }
                )
            else:
                trial_id = f"{int(args.trial):04d}"
                emit(
                    [
                        {"attempt": file.parent.name, "result": read_json(file)}
                        for file in sorted((args.run / "trials" / trial_id).glob("*/evidence.json"))
                    ]
                )
        elif args.command == "clean":
            clean(args.run)
    except KeyboardInterrupt:
        print("Interrupted; resume the recorded run to continue pending trials.", file=sys.stderr)
        raise SystemExit(130) from None
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        print(f"synergy-bench: {error}", file=sys.stderr)
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
