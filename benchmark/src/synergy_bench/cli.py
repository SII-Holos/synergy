from __future__ import annotations

import argparse
import asyncio
import json
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

import yaml

from .cache import collect_cache, inspect_cache, release_run
from .catalog import Suite
from .config import load_config, normalize_legacy
from .evaluator import recorded_environment
from .evidence import summarize
from .prepare import BENCHMARK, remove_owned_container
from .recovery import recover_export
from .report import paired_compare, report_data, write_report
from .runner import initialize, inspect_config, remove_environment, resume
from .storage import atomic_json, locked, read_json


def emit(value: Any) -> None:
    print(json.dumps(value, indent=2, ensure_ascii=False))


def recorded_command(root: Path, arguments: list[str]) -> int:
    plan = read_json(root / "plan.json")
    if plan.get("version") != 3:
        raise ValueError("Historical experiments cannot execute with this evaluator")
    env = recorded_environment(root, plan["evaluator"])
    return subprocess.call([sys.executable, "-m", "synergy_bench.cli", *arguments], env=env)


def clean(root: Path) -> None:
    root = root.resolve()
    with locked(root, create=False):
        if read_json(root / "owner.json") != {"kind": "synergy-benchmark-run", "version": 1}:
            raise ValueError("Not a benchmark-owned run")
        for category in ["trials", "debug", "probes", "prewarming"]:
            for record in (root / category).glob("*/attempt-*/environment.json"):
                remove_environment(root, record)
        for category in ["recoveries", "preparation"]:
            for record in (root / category).glob("*/container.id"):
                remove_owned_container(record)
        cache = read_json(root / "plan.json").get("cache") if (root / "plan.json").exists() else None
        shutil.rmtree(root)
        if cache:
            release_run(Path(cache), root)


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
    for name in ["resume", "inspect", "debug", "clean", "doctor", "prewarm"]:
        action = sub.add_parser(name)
        action.add_argument("run", type=Path)
        if name in {"resume", "debug", "doctor", "prewarm"}:
            action.add_argument(
                "--recorded-evaluator", action="store_true", help="Execute the verified frozen evaluator"
            )
        if name in {"inspect", "debug"}:
            action.add_argument("--trial", required=name == "debug")
    oracle = sub.add_parser(
        "oracle", help="Audit isolated reference solutions and verifiers with the fixed three-hour execution budget"
    )
    oracle.add_argument("suite", type=Path)
    oracle.add_argument("--output", type=Path, required=True)
    oracle.add_argument("--cache", type=Path, required=True)
    oracle.add_argument("--concurrency", type=int, choices=range(1, 9), default=2)
    oracle.add_argument("--platform", choices=["linux/amd64", "linux/arm64"], default="linux/amd64")
    oracle_resume = sub.add_parser(
        "oracle-resume", help="Reconcile or continue an oracle audit without repeating completed grading"
    )
    oracle_resume.add_argument("run", type=Path)
    oracle_resume.add_argument("--recorded-evaluator", action="store_true")
    oracle_report = sub.add_parser("oracle-report", help="Read-only import of raw oracle scores and evidence")
    oracle_report.add_argument("run", type=Path)
    oracle_report.add_argument("--output", type=Path)
    recovery = sub.add_parser(
        "recover-export", help="Export a retained Home copy without model calls or altering original evidence"
    )
    recovery.add_argument("run", type=Path)
    recovery.add_argument("--trial", required=True)
    recovery.add_argument("--attempt", type=int, default=1)
    recovery.add_argument("--timeout", type=int, default=300)
    normalize = sub.add_parser("normalize", help="Explicitly migrate a v1 config; supply model profiles and bindings")
    normalize.add_argument("config", type=Path)
    normalize.add_argument("--models", type=Path, required=True)
    normalize.add_argument("--output", type=Path, required=True)
    report = sub.add_parser("report", help="Read current or historical evidence without executing it")
    report.add_argument("run", type=Path)
    report.add_argument("--output", type=Path)
    report.add_argument(
        "--include-run",
        action="append",
        type=Path,
        default=[],
        help="Include every attempt cost from related runs without changing the selected scoring run",
    )
    compare = sub.add_parser("compare", help="Paired comparison of selected harness variants")
    compare.add_argument("left", type=Path)
    compare.add_argument("right", type=Path)
    compare.add_argument("--left-harness", required=True)
    compare.add_argument("--right-harness", required=True)
    compare.add_argument("--model")
    compare.add_argument("--left-model")
    compare.add_argument("--right-model")
    compare.add_argument("--seed", type=int, default=0)
    compare.add_argument("--output", type=Path)
    cache = sub.add_parser("cache", help="Inspect or collect exclusively benchmark-owned, unreferenced cache")
    cache.add_argument("path", type=Path)
    cache.add_argument("--collect", action="store_true")
    cache.add_argument("--budget-gib", type=float, default=32)
    cache.add_argument("--min-free-gib", type=float, default=20)
    args = parser.parse_args()
    root = getattr(args, "run", None)
    try:
        if getattr(args, "recorded_evaluator", False):
            arguments = [args.command, str(args.run.resolve())]
            if args.command == "debug":
                arguments.extend(["--trial", args.trial])
            raise SystemExit(recorded_command(args.run, arguments))
        if args.command == "oracle":
            from .oracle import prepare_oracle

            root = prepare_oracle(
                args.suite, args.output, args.cache, concurrency=args.concurrency, platform=args.platform
            )
            emit({"run": str(root), "purpose": "native_oracle_audit"})
            raise SystemExit(recorded_command(root, ["oracle-resume", str(root)]))
        elif args.command == "oracle-report":
            from .oracle import report_oracle

            result = report_oracle(args.run)
            if args.output:
                atomic_json(args.output, result)
            emit(result)
        elif args.command == "oracle-resume":
            from .oracle import run_oracle

            emit(asyncio.run(run_oracle(args.run)))
        elif args.command == "normalize":
            if args.output.exists():
                raise ValueError("Normalization destination already exists")
            profiles = yaml.safe_load(args.models.read_text())
            result = normalize_legacy(
                yaml.safe_load(args.config.read_text()),
                profiles["models"],
                profiles["bindings"],
                args.config.resolve().parent,
            )
            args.output.parent.mkdir(parents=True, exist_ok=True)
            with args.output.open("x") as file:
                file.write(yaml.safe_dump(result, sort_keys=False, allow_unicode=True))
            emit({"config": str(args.output), "version": 2})
        elif args.command == "report":
            emit(write_report(args.run, args.output or args.run / "reports" / "current", related=args.include_run))
        elif args.command == "compare":

            def selected(path: Path, harness: str) -> list[dict[str, Any]]:
                return [
                    row
                    for row in report_data(path)["scored"]
                    if row["harness"] == harness and row["model"] == args.model
                ]

            if args.model:
                if args.left_model or args.right_model:
                    raise ValueError("Use --model for paired harness comparison or two explicit model names")
                result = paired_compare(
                    selected(args.left, args.left_harness), selected(args.right, args.right_harness), seed=args.seed
                )
            else:
                if not args.left_model or not args.right_model or args.left_harness != args.right_harness:
                    raise ValueError("Cross-model comparison requires both model names and the same harness")

                def group(path: Path, model: str) -> dict[str, Any]:
                    rows: list[dict[str, Any]] = [
                        row
                        for row in report_data(path)["groups"]
                        if row["harness"] == args.left_harness and row["model"] == model
                    ]
                    if len(rows) != 1:
                        raise ValueError("Requested harness/model group is absent")
                    return rows[0]

                result = {
                    "version": 1,
                    "mode": "descriptive_cross_model",
                    "left": group(args.left, args.left_model),
                    "right": group(args.right, args.right_model),
                    "paired_difference": None,
                    "reason": "Paired bootstrap is restricted to the same model and frozen conditions",
                }
            if args.output:
                atomic_json(args.output, result)
            emit(result)
        elif args.command == "cache":
            emit(
                collect_cache(
                    args.path,
                    budget_bytes=int(args.budget_gib * 1024**3),
                    min_free_bytes=int(args.min_free_gib * 1024**3),
                )
                if args.collect
                else inspect_cache(args.path)
            )
        elif args.command in {"doctor", "prewarm"}:
            asyncio.run(resume(args.run, maintenance=args.command))
            emit(read_json(args.run / (args.command + ".json")))
        elif args.command == "list":
            suite = Suite.load(args.suite)
            emit([task.model_dump() for task in suite.tasks if set(args.tag) <= set(task.tags)])
        elif args.command == "plan":
            emit(inspect_config(args.config.resolve())[2])
        elif args.command in {"prepare", "run"}:
            if load_config(args.config).version != 2:
                raise ValueError("Version 1 is migration input only; run normalize with explicit model profiles first")
            root = initialize(args.config)
            if args.command == "run":
                raise SystemExit(recorded_command(root, ["resume", str(root)]))
            emit({"run": str(root), "status": "prepared"})
        elif args.command in {"resume", "debug"}:
            asyncio.run(resume(args.run, debug_trial=args.trial if args.command == "debug" else None))
            result = summarize(args.run, category="debug" if args.command == "debug" else "trials")
            emit(result)
            raise SystemExit(result["exit_code"])
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
        elif args.command == "recover-export":
            if args.timeout < 1 or args.timeout > 3600:
                raise ValueError("Export timeout must be between 1 and 3600 seconds")
            result = recover_export(args.run, args.trial, args.attempt, timeout=args.timeout)
            emit(result)
            raise SystemExit(0 if result["status"] == "completed" else 1)
        elif args.command == "clean":
            clean(args.run)
    except KeyboardInterrupt:
        if root and root.exists():
            result = summarize(root)
            emit({**result, "exit_code": 130, "interrupted": True})
        print("Interrupted; retained attempts are preserved. Resume continues unfinished trials.", file=sys.stderr)
        raise SystemExit(130) from None
    except ValueError as error:
        print(f"synergy-bench: {error}", file=sys.stderr)
        raise SystemExit(2) from None
    except (RuntimeError, OSError, subprocess.SubprocessError) as error:
        print(f"synergy-bench: {error}", file=sys.stderr)
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
