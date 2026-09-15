from __future__ import annotations

import asyncio
import hashlib
import time
import uuid
from pathlib import Path
from typing import Any

from pier.models.task.task import Task
from pier.models.task.verifier_mode import resolve_effective_verifier_env_config
from pier.models.trial.config import AgentConfig, EnvironmentConfig, TaskConfig, TrialConfig

from .cache import cache_activity, enforce_budget, reference_run
from .catalog import Suite, materialize, tree_digest
from .config import Resources
from .evaluator import freeze_evaluator
from .evidence import grading_evidence
from .monitor import ResourceMonitor
from .prepare import evaluator_identity
from .resources import Capacity, Request, ResourcePool, admission_for, inspect_host, shared_pool_options
from .results import native_reward
from .storage import atomic_json, digest, locked, read_json
from .trial import BenchmarkTrial


def oracle_configuration(root: Path, task: dict[str, Any], attempt: Path, *, cache: Path, platform: str) -> TrialConfig:
    name = f"sb-{root.name[-8:]}-oracle-{attempt.parent.name}-{attempt.name}"
    mounts = []
    for category in ["agent", "verifier", "artifacts"]:
        directory = attempt / name / category
        directory.mkdir(parents=True, exist_ok=True)
        mounts.append({"type": "bind", "source": str(directory), "target": f"/logs/{category}"})
    atomic_json(attempt / "environment.json", {"project": name, "debug": False})
    return TrialConfig(
        trial_name=name,
        trials_dir=attempt,
        task=TaskConfig(path=Path(task["local_path"])),
        agent=AgentConfig(
            name="oracle", kwargs={"settings": {"cleanup_seconds": 60, "preparation_timeout_seconds": 1800}}
        ),
        environment=EnvironmentConfig.model_validate(
            {
                "import_path": "synergy_bench.environment:CachedDockerEnvironment",
                "delete": True,
                "mounts": mounts,
                "kwargs": {"benchmark_cache": str(cache), "benchmark_platform": platform, "inference_port": None},
            }
        ),
    )


def oracle_result(trial: Path, native: dict[str, Any]) -> dict[str, Any]:
    rewards = (native.get("verifier_result") or {}).get("rewards")
    reward = native_reward(rewards)
    exit_file = trial / "agent/exit-code.txt"
    files = {}
    for file in sorted(trial.rglob("*")):
        if file.is_file() and not file.is_symlink():
            with file.open("rb") as stream:
                files[file.relative_to(trial).as_posix()] = {
                    "sha256": hashlib.file_digest(stream, "sha256").hexdigest(),
                    "bytes": file.stat().st_size,
                }
    return {
        "version": 1,
        "purpose": "native_oracle_audit",
        "status": "passed" if reward is not None and reward >= 1 and not native.get("exception_info") else "failed",
        "reward": reward,
        "native_rewards": rewards,
        "solution_exit_code": int(exit_file.read_text().strip()) if exit_file.exists() else None,
        "solution_timing": native.get("agent_execution"),
        "grading": grading_evidence(trial, native),
        "native_exception": native.get("exception_info"),
        "files": files,
        "trial_directory": trial.name,
        "ended_at": time.time(),
    }


def prepare_oracle(suite_path: Path, output: Path, cache: Path, *, concurrency: int, platform: str) -> Path:
    suite = Suite.load(suite_path)
    settings = Resources()
    enforce_budget(
        cache,
        budget_bytes=int(settings.cache_budget_gib * 1024**3),
        min_free_bytes=int(settings.min_free_disk_gib * 1024**3),
    )
    host = inspect_host(cache, settings)
    if not host["disk_ready"]:
        raise ValueError("Insufficient disk for the native oracle audit")
    root = output.resolve() / (time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:8])
    root.mkdir(parents=True, mode=0o700)
    atomic_json(root / "owner.json", {"kind": "synergy-benchmark-oracle", "version": 1})
    tasks = []
    pool = ResourcePool(Capacity(**host["capacity"]), concurrency)
    with cache_activity(cache):
        for item in suite.tasks:
            path = materialize(suite, item, cache)
            reference_run(cache, root, artifacts=[digest(suite.sources[item.source].model_dump())])
            task = Task(task_dir=path)
            if task.has_steps:
                raise ValueError("Oracle audit currently requires single-step tasks")
            environments = [task.config.environment]
            verifier = resolve_effective_verifier_env_config(task.config, None)
            if verifier is not None:
                environments.append(verifier)
            request = Request(
                max(float(env.cpus) if env.cpus is not None else host["capacity"]["cpus"] for env in environments),
                max(
                    env.memory_mb * 1024**2 if env.memory_mb is not None else host["capacity"]["memory_bytes"]
                    for env in environments
                ),
            )
            pool.validate(request)
            tasks.append(
                {
                    **item.model_dump(),
                    "local_path": str(path),
                    "resources": {"cpus": request.cpus, "memory_bytes": request.memory_bytes},
                }
            )
    plan: dict[str, Any] = {
        "version": 3,
        "kind": "native_oracle_audit",
        "tasks": tasks,
        "host": host,
        "concurrency": concurrency,
        "cache": str(cache.resolve()),
        "platform": platform,
        "evaluator": evaluator_identity(),
        "config": {"resources": settings.model_dump()},
    }
    freeze_evaluator(root, plan["evaluator"])
    plan["digest"] = digest(plan)
    atomic_json(root / "plan.json", plan)
    return root


async def run_oracle(root: Path) -> dict[str, Any]:
    from .runner import audit_environment, progress, remove_environment

    root = await asyncio.to_thread(root.resolve)
    with locked(root, create=False):
        if read_json(root / "owner.json") != {"kind": "synergy-benchmark-oracle", "version": 1}:
            raise ValueError("Not a benchmark-owned oracle audit")
        plan = read_json(root / "plan.json")
        if plan["evaluator"] != evaluator_identity() or plan["digest"] != digest(
            {key: value for key, value in plan.items() if key != "digest"}
        ):
            raise ValueError("Oracle plan or evaluator changed")
        pool = ResourcePool(
            Capacity(**plan["host"]["capacity"]),
            plan["concurrency"],
            admission=admission_for(root, plan),
            **shared_pool_options(root, plan),
        )
        rows: dict[str, Any] = {}

        async def execute(index: int, task: dict[str, Any]) -> None:
            attempt = root / "oracles" / f"{index:04d}" / "attempt-001"
            file = attempt / "oracle.json"
            if file.exists():
                result = read_json(file)
                trial = attempt / result["trial_directory"]
                for name, expected in result["files"].items():
                    path = trial / name
                    if path.is_symlink() or not path.resolve().is_relative_to(trial.resolve()):
                        raise ValueError("Oracle evidence path changed")
                    with path.open("rb") as stream:
                        if hashlib.file_digest(stream, "sha256").hexdigest() != expected["sha256"]:
                            raise ValueError("Oracle evidence changed")
                rows[task["id"]] = result
                return
            async with pool.reserve(Request(**task["resources"])):
                if tree_digest(Path(task["local_path"])) != task["digest"]:
                    raise ValueError("Oracle task input changed")
                attempt.mkdir(parents=True, exist_ok=True)
                prior = (attempt / "environment.json").exists()
                config = oracle_configuration(root, task, attempt, cache=Path(plan["cache"]), platform=plan["platform"])
                trial_dir = attempt / config.trial_name
                progress(f"oracle: {task['id']}")
                native: dict[str, Any] = {}
                try:
                    if prior:
                        await asyncio.to_thread(remove_environment, root, attempt / "environment.json")
                        native_file = trial_dir / "result.json"
                        native = (
                            read_json(native_file)
                            if native_file.exists()
                            else {"exception_info": {"exception_type": "OrchestratorInterrupted"}}
                        )
                    else:
                        with cache_activity(Path(plan["cache"])):
                            async with ResourceMonitor(attempt, config.trial_name):
                                trial = await BenchmarkTrial.create(config)
                                native = (await trial.run()).model_dump(mode="json")
                except BaseException as error:
                    native = {
                        "exception_info": {"exception_type": type(error).__name__, "exception_message": str(error)}
                    }
                    if isinstance(error, asyncio.CancelledError):
                        raise
                finally:
                    cleanup_error = None
                    try:
                        await asyncio.to_thread(
                            audit_environment, root, attempt / "environment.json", trial_dir / "agent"
                        )
                    except Exception as error:
                        cleanup_error = {"type": type(error).__name__, "message": str(error)}
                    result = {
                        **await asyncio.to_thread(oracle_result, trial_dir, native),
                        "task": task["id"],
                        "task_digest": task["digest"],
                        "cleanup_error": cleanup_error,
                    }
                    if (attempt / "resources.json").exists():
                        result["resources"] = read_json(attempt / "resources.json")
                    atomic_json(file, result)
                    rows[task["id"]] = result
                    progress(f"oracle: {task['id']} {result['status']} reward={result['reward']}")

        try:
            width = plan["concurrency"]
            for offset in range(0, len(plan["tasks"]), width):
                await asyncio.to_thread(
                    enforce_budget,
                    Path(plan["cache"]),
                    budget_bytes=int(plan["config"]["resources"]["cache_budget_gib"] * 1024**3),
                    min_free_bytes=int(plan["config"]["resources"]["min_free_disk_gib"] * 1024**3),
                )
                async with asyncio.TaskGroup() as group:
                    for index in range(offset, min(offset + width, len(plan["tasks"]))):
                        group.create_task(execute(index, plan["tasks"][index]))
        finally:
            report = {
                "version": 1,
                "planned": len(plan["tasks"]),
                "completed": len(rows),
                "rows": list(rows.values()),
                "missing": [task["id"] for task in plan["tasks"] if task["id"] not in rows],
            }
            atomic_json(root / "oracle-report.json", report)
        return report


def report_oracle(root: Path) -> dict[str, Any]:
    if read_json(root / "owner.json") != {"kind": "synergy-benchmark-oracle", "version": 1}:
        raise ValueError("Not a benchmark-owned oracle audit")
    plan = read_json(root / "plan.json")
    rows = []
    for index, _task in enumerate(plan["tasks"]):
        file = root / "oracles" / f"{index:04d}" / "attempt-001" / "oracle.json"
        if not file.exists():
            continue
        recorded = read_json(file)
        trial = file.parent / recorded["trial_directory"]
        for name, expected in recorded["files"].items():
            path = trial / name
            if path.is_symlink() or not path.resolve().is_relative_to(trial.resolve()):
                raise ValueError("Oracle evidence path changed")
            with path.open("rb") as stream:
                if hashlib.file_digest(stream, "sha256").hexdigest() != expected["sha256"]:
                    raise ValueError("Oracle evidence changed")
        reward = native_reward(recorded.get("native_rewards"))
        native_file = trial / "result.json"
        grading = grading_evidence(trial, read_json(native_file)) if native_file.exists() else recorded.get("grading")
        rows.append(
            {
                **recorded,
                "recorded_status": recorded["status"],
                "recorded_grading": recorded.get("grading"),
                "grading": grading,
                "reward": reward,
                "status": "passed"
                if reward is not None and reward >= 1 and not recorded.get("native_exception")
                else "failed",
                "source_record_sha256": hashlib.sha256(file.read_bytes()).hexdigest(),
            }
        )
    return {
        "version": 2,
        "purpose": "native_oracle_audit_report",
        "read_only_import": True,
        "planned": len(plan["tasks"]),
        "completed": len(rows),
        "rows": rows,
        "missing": [task["id"] for task in plan["tasks"] if task["id"] not in {row["task"] for row in rows}],
    }
