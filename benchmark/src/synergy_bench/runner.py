from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import shutil
import sys
import time
import uuid
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

from pier.models.task.task import Task
from pier.models.trial.config import AgentConfig, EnvironmentConfig, TaskConfig, TrialConfig

from .background import background
from .catalog import Suite, materialize, tree_digest
from .config import ExperimentConfig, load_config, resolve_plan
from .evidence import collect_evidence
from .prepare import command, evaluator_identity, preflight, prepare_source, verify_prepared
from .results import RESULT_VERSION, AttemptResult
from .storage import atomic_json, digest, locked, read_json
from .trial import BenchmarkTrial


def inspect_config(path: Path) -> tuple[ExperimentConfig, Suite, dict[str, Any]]:
    config = load_config(path)
    suite = Suite.load((path.parent / config.suite).resolve())
    plan = {
        "version": 2,
        "result_version": RESULT_VERSION,
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


def progress(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def validate_inputs(config: ExperimentConfig, base: Path) -> None:
    for variant in config.variants.values():
        for key, reference in variant.env.items():
            if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key) or not re.fullmatch(
                r"[A-Za-z_][A-Za-z0-9_]*", reference
            ):
                raise ValueError("Credentials must map environment variable names")
            if key.startswith("SYNERGY_") or key in {
                "HOME",
                "PATH",
                "NODE_OPTIONS",
                "BUN_OPTIONS",
                "LD_PRELOAD",
                "MODELS_DEV_API_JSON",
            }:
                raise ValueError(f"Reserved benchmark environment variable: {key}")
            if not os.environ.get(reference):
                raise ValueError(f"Missing credential environment variable: {reference}")
        for file in [variant.config, variant.experiment]:
            if not file:
                continue
            value = read_json(base / file)
            validate_credentials(value)
            content = (base / file).read_text()
            if "{file:" in content:
                raise ValueError("File references must be materialized into the experiment config")
            for reference in re.findall(r"\{env:([A-Za-z_][A-Za-z0-9_]*)\}", content):
                if reference not in variant.env:
                    raise ValueError(f"Config environment reference is not mapped: {reference}")
        source = variant.source.artifact or variant.source.path
        if not (base / source).is_dir():
            raise ValueError("Measured source or prepared artifact does not exist")


def initialize(path: Path) -> Path:
    path = path.resolve()
    config, suite, plan = inspect_config(path)
    base = path.parent
    validate_inputs(config, base)
    progress("preflight: validating Docker and experiment inputs")
    command(["docker", "info", "--format", "{{.ServerVersion}}"], timeout=30)
    cache = (base / config.cache).resolve()
    root = (base / config.output).resolve() / f"{time.strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:8]}"
    root.mkdir(parents=True, mode=0o700)
    atomic_json(root / "owner.json", {"kind": "synergy-benchmark-run", "version": 1})
    atomic_json(root / "preparation.json", {"status": "running", "started_at": time.time()})
    progress(f"prepare: {root}")
    stage = "inputs"
    try:
        stage = "inputs"
        variants = {}
        artifacts: dict[str, Path] = {}
        for name, variant in config.variants.items():
            stage = "inputs"
            progress(f"prepare: freezing source and inputs for {name}")
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
                stage = "source"
                artifacts[source_key] = prepare_source(
                    variant.source, base, cache, config.platform, timeout=config.preparation_timeout_seconds
                )
            artifact = artifacts[source_key]
            receipt = read_json(artifact / "receipt.json")
            stage = "runtime-validation"
            progress(f"preflight: resolving {name} / {variant.runtime} / {variant.model} offline")
            capability = preflight(artifact, variant.model_dump(), inputs, config.platform, root / "preparation" / name)
            variants[name] = {
                **variant.model_dump(),
                "artifact": str(artifact),
                "artifact_id": receipt["id"],
                "source_receipt": receipt["source"],
                "composition": capability,
                "inputs_digest": tree_digest(inputs),
            }
        stage = "tasks"
        selected = {item["task"] for item in plan["schedule"]}
        tasks = {}
        for task in suite.tasks:
            if task.id in selected:
                progress(f"prepare: verifying task {task.id}")
                task_path = materialize(suite, task, cache)
                if Task(task_dir=task_path).has_steps:
                    raise ValueError("Multi-step tasks require a step-aware benchmark result contract")
                tasks[task.id] = {**task.model_dump(), "local_path": str(task_path)}
        plan.update({"variants": variants, "tasks": tasks})
        plan["digest"] = digest(plan)
        atomic_json(root / "plan.json", plan)
        atomic_json(root / "preparation.json", {"status": "completed", "ended_at": time.time()})
    except BaseException as error:
        atomic_json(
            root / "preparation.json",
            {
                "status": "interrupted" if isinstance(error, (KeyboardInterrupt, asyncio.CancelledError)) else "failed",
                "stage": stage,
                "ended_at": time.time(),
                "error": type(error).__name__,
            },
        )
        raise
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
                if previous.get("status") in {"running", "interrupted"} and prior_result.exists():
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
                progress(f"run: trial {trial_id} {item.get('task', '')} / {item['variant']} / {attempt.name}")
                try:
                    result = await execute(item, attempt)
                    result["attempt_status"] = "completed"
                    atomic_json(attempt / "evidence.json", result)
                    current["status"] = "completed"
                except asyncio.CancelledError:
                    evidence = attempt / "evidence.json"
                    current["status"] = (
                        "completed"
                        if evidence.exists() and read_json(evidence).get("attempt_status") == "completed"
                        else "interrupted"
                    )
                    raise
                except Exception as error:
                    atomic_json(
                        attempt / "evidence.json",
                        {
                            "version": RESULT_VERSION,
                            "attempt_status": "completed",
                            "execution": None,
                            "verifier": None,
                            "accounting": None,
                            "infrastructure_error": {"type": type(error).__name__, "message": str(error)},
                            "export": None,
                            "pier_exception": None,
                            "files": {},
                            "evidence": {
                                "valid": False,
                                "issues": ["trial_failed"],
                                "archive_valid": False,
                                "recording": "unknown",
                                "usage": "unknown",
                            },
                        },
                    )
                    current["status"] = "completed"
                finally:
                    current["finished"] = time.time()
                    atomic_json(state_file, state)
                    progress(f"run: trial {trial_id} {current['status']}")

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
    export_timeout = plan["config"]["export_timeout_seconds"]
    timeout = plan["config"]["timeout_seconds"] or task["agent_seconds"]
    options = {
        **{key: variant[key] for key in ["runtime", "model", "agent", "variant"]},
        "config": "/benchmark-input/config.json",
        "experiment": "/benchmark-input/experiment.json" if variant["experiment"] else None,
        "timeout_seconds": timeout,
        "cleanup_seconds": cleanup,
        "export_timeout_seconds": export_timeout,
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
            override_timeout_sec=timeout + cleanup + export_timeout + 15,
            kwargs={
                "settings": {
                    "artifact_id": variant["artifact_id"],
                    "env": variant["env"],
                    "network_domains": variant["network_domains"],
                    "cleanup_seconds": cleanup,
                    "export_timeout_seconds": export_timeout,
                    "project": trial_name,
                }
            },
        ),
        environment=EnvironmentConfig.model_validate(
            {"type": "docker", "delete": not debug, "mounts": mounts, "kwargs": {"keep_containers": debug}}
        ),
    )
    trial = await BenchmarkTrial.create(config)
    try:
        try:
            result = await trial.run()
        finally:
            if not debug:
                await background(audit_environment, root, attempt / "environment.json", trial_dir / "agent")
    except asyncio.CancelledError:
        evidence = await background(collect_evidence, trial_dir, trial.result.model_dump(mode="json"))
        evidence["trial_directory"] = trial_name
        evidence["attempt_status"] = "completed" if evidence.get("execution") else "interrupted"
        atomic_json(attempt / "evidence.json", evidence)
        raise
    evidence = await background(collect_evidence, trial_dir, result.model_dump(mode="json"))
    evidence["trial_directory"] = trial_name
    return evidence


def environment_projects(root: Path, record: Path) -> set[str]:
    project = read_json(record)["project"]
    if not re.fullmatch(rf"sb-{re.escape(root.name[-8:])}-[a-z0-9-]+", project):
        raise ValueError("Unexpected Docker project ownership")
    label = '{{.Label "com.docker.compose.project"}}'
    names = set(command(["docker", "ps", "-a", "--format", label], timeout=15).splitlines())
    names.update(command(["docker", "network", "ls", "--format", label], timeout=15).splitlines())
    return {name for name in names if name == project or name.startswith(project + "__verifier__")}


def remove_environment(root: Path, record: Path) -> None:
    for name in sorted(environment_projects(root, record)):
        selector = f"label=com.docker.compose.project={name}"
        for container in command(["docker", "ps", "-aq", "--filter", selector], timeout=15).splitlines():
            command(["docker", "rm", "-f", container], timeout=30)
        for network in command(["docker", "network", "ls", "-q", "--filter", selector], timeout=15).splitlines():
            command(["docker", "network", "rm", network], timeout=30)


def audit_environment(root: Path, ownership: Path, agent: Path) -> None:
    errors = []
    try:
        if environment_projects(root, ownership):
            errors.append("residual_resources")
            remove_environment(root, ownership)
    except Exception as error:
        errors.append(type(error).__name__)
    if errors:
        file = agent / "environment-cleanup.json"
        record: dict[str, Any] = read_json(file) if file.exists() else {"status": "failed", "errors": []}
        record["errors"].extend(errors)
        atomic_json(file, record)


def verify_terminal(attempt: Path, result: dict[str, Any]) -> None:
    if result.get("version") != RESULT_VERSION:
        raise ValueError("Historical attempt is read-only with this evaluator")
    AttemptResult.model_validate(result)
    directory = result.get("trial_directory")
    if not directory:
        if result.get("files"):
            raise ValueError("Evidence files have no trial directory")
        return
    if Path(directory).name != directory:
        raise ValueError("Invalid evidence trial directory")
    trial = attempt / directory
    for name, expected in result.get("files", {}).items():
        file = trial / name
        if (
            Path(name).is_absolute()
            or ".." in Path(name).parts
            or file.is_symlink()
            or not file.resolve().is_relative_to(trial.resolve())
        ):
            raise ValueError("Evidence path escapes its trial")
        if not file.is_file() or file.stat().st_size != expected["bytes"]:
            raise ValueError("Terminal evidence file is missing or changed")
        with file.open("rb") as stream:
            checksum = hashlib.file_digest(stream, "sha256").hexdigest()
        if checksum != expected["sha256"]:
            raise ValueError("Terminal evidence hash changed; refusing to reschedule")


def retained_terminal(trial: Path) -> dict[str, Any] | None:
    file = trial / "agent/events.jsonl"
    if not file.exists():
        return None
    terminal = None
    with file.open() as stream:
        for line in stream:
            try:
                event = json.loads(line)
            except ValueError:
                continue
            if isinstance(event, dict) and event.get("type") in {"result", "failed"}:
                terminal = event
    return terminal


async def reconcile_terminal(root: Path, attempt: Path, plan: dict[str, Any]) -> bool:
    ownership = attempt / "environment.json"
    if not ownership.exists():
        return False
    project = read_json(ownership)["project"]
    if not re.fullmatch(rf"sb-{re.escape(root.name[-8:])}-[a-z0-9-]+", project):
        raise ValueError("Unexpected retained trial ownership")
    trial = attempt / project
    agent = trial / "agent"
    resolved_agent = await background(agent.resolve)
    if trial.is_symlink() or agent.is_symlink() or not resolved_agent.is_relative_to(root):
        raise ValueError("Retained terminal path escapes its run")
    terminal = await background(retained_terminal, trial)
    if not (agent / "execution.json").exists() and not (agent / "finished").exists() and not terminal:
        return False
    progress(f"resume: reconciling retained terminal for {attempt.parent.name} without model execution")
    budget = plan["config"]["export_timeout_seconds"] + 15
    execution = {}
    if (agent / "execution.json").exists():
        try:
            observed = read_json(agent / "execution.json")
            if isinstance(observed, dict):
                execution = observed
        except ValueError:
            pass
    stamp = execution.get("ended_at", (terminal or {}).get("timestamp", 0))
    remaining = max(0, min(budget, stamp / 1000 + budget - time.time())) if isinstance(stamp, (int, float)) else 0
    deadline = time.monotonic() + remaining
    while not (agent / "finished").exists() and time.monotonic() < deadline:
        exported = agent / "export.json"
        if exported.exists():
            try:
                observed = read_json(exported)
                if not isinstance(observed, dict) or observed.get("status") in {"completed", "failed"}:
                    break
            except ValueError:
                break
        running = await background(
            command, ["docker", "ps", "-q", "--filter", f"label=com.docker.compose.project={project}"], timeout=15
        )
        if not running:
            break
        await asyncio.sleep(0.2)
    try:
        await background(remove_environment, root, ownership)
    except Exception as error:
        atomic_json(agent / "environment-cleanup.json", {"status": "failed", "errors": [type(error).__name__]})
    pier = {
        "exception_info": {"exception_type": "OrchestratorInterrupted", "exception_message": "No retained Pier result"}
    }
    if (trial / "result.json").exists():
        try:
            observed = read_json(trial / "result.json")
            if isinstance(observed, dict):
                pier = observed
        except ValueError:
            pass
    evidence = await background(collect_evidence, trial, pier)
    if evidence["execution"] is None and terminal:
        evidence["execution"] = {
            "version": 2,
            "recovered_from": "events.jsonl",
            "terminal": terminal,
            "outcome": terminal.get("outcome", "interrupted"),
            "exit_code": terminal.get("exitCode"),
            "session_id": terminal.get("sessionID"),
            "run_id": terminal.get("runID"),
            "wall_ms": None,
        }
        if evidence["accounting"] is None:
            evidence["accounting"] = (terminal.get("result") or {}).get("accounting")
    evidence.update(attempt_status="completed", trial_directory=project)
    atomic_json(
        attempt / "reconciliation.json",
        {"version": 1, "source": "retained-terminal", "model_calls": 0, "created_at": time.time()},
    )
    atomic_json(attempt / "evidence.json", evidence)
    return True


async def resume(root: Path, *, debug_trial: str | None = None) -> None:
    root = await asyncio.to_thread(root.resolve)
    with locked(root, create=False):
        if read_json(root / "owner.json") != {"kind": "synergy-benchmark-run", "version": 1}:
            raise ValueError("Not a benchmark-owned run")
        if not (root / "plan.json").exists():
            raise ValueError("Preparation did not complete; inspect preparation records and create a new run")
        plan = read_json(root / "plan.json")
        if plan.get("version") != 2 or plan.get("result_version") != RESULT_VERSION:
            raise ValueError("Historical experiment is read-only with this evaluator")
        if plan["digest"] != digest({key: value for key, value in plan.items() if key != "digest"}):
            raise ValueError("Experiment plan changed")
        if plan["evaluator"] != evaluator_identity():
            raise ValueError("Evaluator changed; use the recorded evaluator revision to resume")
        progress("resume: verifying frozen artifacts, inputs and terminal evidence")
        for artifact in {variant["artifact"] for variant in plan["variants"].values()}:
            await background(verify_prepared, Path(artifact))
        for name, variant in plan["variants"].items():
            if await background(tree_digest, root / "inputs" / name) != variant["inputs_digest"]:
                raise ValueError("Experiment inputs changed")
            for reference in variant["env"].values():
                if not os.environ.get(reference):
                    raise ValueError(f"Missing credential environment variable: {reference}")
        for task in plan["tasks"].values():
            if await background(tree_digest, Path(task["local_path"])) != task["digest"]:
                raise ValueError(f"Task content changed: {task['id']}")
        os.environ["DOCKER_DEFAULT_PLATFORM"] = plan["config"]["platform"]
        if (root / "state.json").exists():
            for trial_id, state in read_json(root / "state.json")["trials"].items():
                evidence_file = root / "trials" / trial_id / f"attempt-{state['attempt']:03d}" / "evidence.json"
                if not evidence_file.exists():
                    await reconcile_terminal(root, evidence_file.parent, plan)
                    if state["status"] == "completed" and not evidence_file.exists():
                        raise ValueError("Completed attempt has no retained terminal evidence")
                if evidence_file.exists():
                    await background(verify_terminal, evidence_file.parent, read_json(evidence_file))
                if state["status"] in {"running", "interrupted"}:
                    attempt = root / "trials" / trial_id / f"attempt-{state['attempt']:03d}"
                    terminal = attempt / "evidence.json"
                    if terminal.exists() and read_json(terminal).get("attempt_status") == "completed":
                        continue
                    record = attempt / "environment.json"
                    if record.exists():
                        await asyncio.to_thread(remove_environment, root, record)
        if debug_trial is not None:
            index = int(debug_trial)
            if index < 0 or index >= len(plan["schedule"]):
                raise ValueError("Unknown trial index")
            item = plan["schedule"][index]
            attempt = root / "debug" / f"{index:04d}" / f"attempt-{uuid.uuid4().hex[:8]}"
            attempt.mkdir(parents=True)
            atomic_json(attempt / "evidence.json", await execute_trial(root, plan, item, attempt, debug=True))
            return
        await execute_plan(root, plan, lambda item, attempt: execute_trial(root, plan, item, attempt))
