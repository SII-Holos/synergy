from __future__ import annotations

import asyncio
import os
import re
import shutil
import time
import uuid
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

from pier.models.trial.config import AgentConfig, EnvironmentConfig, TaskConfig, TrialConfig
from pier.trial.trial import Trial

from .catalog import Suite, materialize, tree_digest
from .config import ExperimentConfig, load_config, resolve_plan
from .evidence import collect_evidence
from .prepare import command, evaluator_identity, preflight, prepare_source, verify_prepared
from .storage import atomic_json, digest, locked, read_json


def inspect_config(path: Path) -> tuple[ExperimentConfig, Suite, dict[str, Any]]:
    config = load_config(path)
    suite = Suite.load((path.parent / config.suite).resolve())
    plan = {
        "version": 1,
        "config": config.model_dump(),
        "suite": suite.model_dump(),
        "schedule": resolve_plan(config, [task.model_dump() for task in suite.tasks]),
        "concurrency": config.concurrency,
        "evaluator": evaluator_identity(),
    }
    return config, suite, plan


def validate_credentials(value: Any) -> None:
    if isinstance(value, dict):
        for key, item in value.items():
            if re.search(r"api.?key|secret|password|authorization|access.?token|refresh.?token", key, re.I):
                if isinstance(item, str) and item and not re.fullmatch(r"\{env:[A-Za-z_][A-Za-z0-9_]*\}", item):
                    raise ValueError(f"Use an environment reference for credential field {key}")
            validate_credentials(item)
    elif isinstance(value, list):
        for item in value:
            validate_credentials(item)


def initialize(path: Path) -> Path:
    path = path.resolve()
    config, suite, plan = inspect_config(path)
    base = path.parent
    cache = (base / config.cache).resolve()
    root = (base / config.output).resolve() / f"{time.strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:8]}"
    root.mkdir(parents=True, mode=0o700)
    atomic_json(root / "owner.json", {"kind": "synergy-benchmark-run", "version": 1})
    variants = {}
    artifacts: dict[str, Path] = {}
    for name, variant in config.variants.items():
        inputs = root / "inputs" / name
        inputs.mkdir(parents=True)
        settings = read_json(base / variant.config) if variant.config else {}
        validate_credentials(settings)
        settings = {"controlProfile": "full_access", **settings}
        for role in ["nano", "mini", "mid", "thinking", "long_context", "creative", "vision"]:
            settings.setdefault(f"{role}_model", variant.model)
        atomic_json(inputs / "config.json", settings)
        if variant.experiment:
            experiment = read_json(base / variant.experiment)
            validate_credentials(experiment)
            atomic_json(inputs / "experiment.json", experiment)
        for key, reference in variant.env.items():
            if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key) or not re.fullmatch(
                r"[A-Za-z_][A-Za-z0-9_]*", reference
            ):
                raise ValueError("Credentials must map environment variable names to environment variable names")
            if key.startswith("SYNERGY_") or key in {"HOME", "PATH", "NODE_OPTIONS", "BUN_OPTIONS", "LD_PRELOAD"}:
                raise ValueError(f"Reserved benchmark environment variable: {key}")
        source_key = digest(variant.source.model_dump())
        if source_key not in artifacts:
            artifacts[source_key] = prepare_source(variant.source, base, cache, config.platform)
        artifact = artifacts[source_key]
        receipt = read_json(artifact / "receipt.json")
        capability = preflight(artifact, variant.model_dump(), inputs, config.platform)
        variants[name] = {
            **variant.model_dump(),
            "artifact": str(artifact),
            "artifact_id": receipt["id"],
            "source_receipt": receipt["source"],
            "composition": capability,
            "inputs_digest": tree_digest(inputs),
        }
    selected = {item["task"] for item in plan["schedule"]}
    tasks = {}
    for task in suite.tasks:
        if task.id in selected:
            task_path = materialize(suite, task, cache)
            tasks[task.id] = {**task.model_dump(), "local_path": str(task_path)}
    plan.update({"variants": variants, "tasks": tasks})
    plan["digest"] = digest(plan)
    atomic_json(root / "plan.json", plan)
    return root


async def execute_plan(
    root: Path,
    plan: dict[str, Any],
    execute: Callable[[dict[str, Any], Path], Awaitable[dict[str, Any]]],
) -> None:
    state_file = root / "state.json"
    state = read_json(state_file) if state_file.exists() else {"trials": {}}
    semaphore = asyncio.Semaphore(plan["concurrency"])
    pairs: dict[str, list[tuple[str, dict[str, Any]]]] = {}
    for index, item in enumerate(plan["schedule"]):
        pairs.setdefault(item["pair"], []).append((f"{index:04d}", item))

    async def pair(items: list[tuple[str, dict[str, Any]]]) -> None:
        async with semaphore:
            for trial_id, item in items:
                previous = state["trials"].get(trial_id, {})
                prior_result = (
                    root / "trials" / trial_id / f"attempt-{previous.get('attempt', 0):03d}" / "evidence.json"
                )
                if previous.get("status") == "running" and prior_result.exists():
                    if read_json(prior_result).get("attempt_status") == "completed":
                        previous["status"] = "completed"
                        atomic_json(state_file, state)
                if previous.get("status") == "completed":
                    continue
                number = previous.get("attempt", 0) + 1
                attempt = root / "trials" / trial_id / f"attempt-{number:03d}"
                attempt.mkdir(parents=True, exist_ok=False)
                current = {"status": "running", "attempt": number, "started": time.time()}
                state["trials"][trial_id] = current
                atomic_json(state_file, state)
                atomic_json(attempt / "trial.json", item)
                try:
                    result = await execute(item, attempt)
                    result["attempt_status"] = "completed"
                    atomic_json(attempt / "evidence.json", result)
                    current["status"] = "completed"
                except asyncio.CancelledError:
                    current["status"] = "interrupted"
                    raise
                except Exception as error:
                    atomic_json(
                        attempt / "evidence.json",
                        {
                            "version": 1,
                            "attempt_status": "completed",
                            "execution": None,
                            "verifier": None,
                            "accounting": None,
                            "infrastructure_error": {"type": type(error).__name__, "message": str(error)},
                            "evidence": {"complete": False, "missing": ["trial_failed"]},
                        },
                    )
                    current["status"] = "completed"
                finally:
                    current["finished"] = time.time()
                    atomic_json(state_file, state)

    async with asyncio.TaskGroup() as group:
        for items in pairs.values():
            group.create_task(pair(items))


async def execute_trial(
    root: Path, plan: dict[str, Any], item: dict[str, Any], attempt: Path, *, debug: bool = False
) -> dict[str, Any]:
    variant = plan["variants"][item["variant"]]
    task = plan["tasks"][item["task"]]
    inputs = attempt / "inputs"
    shutil.copytree(root / "inputs" / item["variant"], inputs)
    cleanup = plan["config"]["cleanup_seconds"]
    timeout = plan["config"]["timeout_seconds"] or task["agent_seconds"]
    options = {
        **{key: variant[key] for key in ["runtime", "model", "agent", "variant"]},
        "config": "/benchmark-input/config.json",
        "experiment": "/benchmark-input/experiment.json" if variant["experiment"] else None,
        "timeout_seconds": timeout,
        "cleanup_seconds": cleanup,
    }
    atomic_json(inputs / "options.json", options)
    trial_name = f"sb-{root.name[-8:]}-{attempt.parent.name}-{attempt.name}"
    trial_dir = attempt / trial_name
    mounts: list[dict[str, Any]] = [
        {
            "type": "bind",
            "source": str(Path(variant["artifact"]) / "bundle"),
            "target": "/opt/synergy",
            "read_only": True,
        },
        {"type": "bind", "source": str(inputs), "target": "/benchmark-input", "read_only": True},
    ]
    for name in ["agent", "verifier", "artifacts"]:
        directory = trial_dir / name
        directory.mkdir(parents=True)
        mounts.append({"type": "bind", "source": str(directory), "target": f"/logs/{name}"})
    atomic_json(attempt / "environment.json", {"project": trial_name, "debug": debug})
    config = TrialConfig(
        task=TaskConfig(path=Path(task["local_path"])),
        trial_name=trial_name,
        trials_dir=attempt,
        agent=AgentConfig(
            import_path="synergy_bench.agent:SynergyAgent",
            model_name=variant["model"],
            override_timeout_sec=timeout + cleanup,
            kwargs={
                "settings": {
                    "artifact_id": variant["artifact_id"],
                    "env": variant["env"],
                    "network_domains": variant["network_domains"],
                    "cleanup_seconds": cleanup,
                    "project": trial_name,
                }
            },
        ),
        environment=EnvironmentConfig.model_validate(
            {"type": "docker", "delete": not debug, "mounts": mounts, "kwargs": {"keep_containers": debug}}
        ),
    )
    trial = await Trial.create(config)
    result = await trial.run()
    evidence = collect_evidence(trial_dir, result.model_dump(mode="json"))
    evidence["trial_directory"] = trial_name
    return evidence


def remove_environment(root: Path, record: Path) -> None:
    project = read_json(record)["project"]
    if not re.fullmatch(rf"sb-{re.escape(root.name[-8:])}-[a-z0-9-]+", project):
        raise ValueError("Unexpected Docker project ownership")
    label = '{{.Label "com.docker.compose.project"}}'
    names = set(command(["docker", "ps", "-a", "--format", label]).splitlines())
    names.update(command(["docker", "network", "ls", "--format", label]).splitlines())
    projects = {name for name in names if name == project or name.startswith(project + "__verifier__")}
    for name in sorted(projects):
        selector = f"label=com.docker.compose.project={name}"
        for container in command(["docker", "ps", "-aq", "--filter", selector]).splitlines():
            command(["docker", "rm", "-f", container])
        for network in command(["docker", "network", "ls", "-q", "--filter", selector]).splitlines():
            command(["docker", "network", "rm", network])


async def resume(root: Path, *, debug_trial: str | None = None) -> None:
    root = await asyncio.to_thread(root.resolve)
    with locked(root):
        plan = read_json(root / "plan.json")
        if plan["digest"] != digest({key: value for key, value in plan.items() if key != "digest"}):
            raise ValueError("Experiment plan changed")
        if plan["evaluator"] != evaluator_identity():
            raise ValueError("Evaluator changed; use the recorded evaluator revision to resume")
        for artifact in {variant["artifact"] for variant in plan["variants"].values()}:
            await asyncio.to_thread(verify_prepared, Path(artifact))
        for name, variant in plan["variants"].items():
            if tree_digest(root / "inputs" / name) != variant["inputs_digest"]:
                raise ValueError("Experiment inputs changed")
            for reference in variant["env"].values():
                if not os.environ.get(reference):
                    raise ValueError(f"Missing credential environment variable: {reference}")
        for task in plan["tasks"].values():
            if tree_digest(Path(task["local_path"])) != task["digest"]:
                raise ValueError(f"Task content changed: {task['id']}")
        os.environ["DOCKER_DEFAULT_PLATFORM"] = plan["config"]["platform"]
        if (root / "state.json").exists():
            for trial_id, state in read_json(root / "state.json")["trials"].items():
                if state["status"] in {"running", "interrupted"}:
                    record = root / "trials" / trial_id / f"attempt-{state['attempt']:03d}" / "environment.json"
                    if record.exists():
                        await asyncio.to_thread(remove_environment, root, record)
        if debug_trial is not None:
            index = int(debug_trial)
            item = plan["schedule"][index]
            attempt = root / "debug" / f"{index:04d}" / f"attempt-{uuid.uuid4().hex[:8]}"
            attempt.mkdir(parents=True)
            atomic_json(attempt / "evidence.json", await execute_trial(root, plan, item, attempt, debug=True))
            return
        await execute_plan(root, plan, lambda item, attempt: execute_trial(root, plan, item, attempt))
