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
from dataclasses import asdict
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from pier.models.task.task import Task
from pier.models.task.verifier_mode import resolve_effective_verifier_env_config
from pier.models.trial.config import AgentConfig, EnvironmentConfig, TaskConfig, TrialConfig, VerifierConfig

from .background import background
from .cache import cache_activity, enforce_budget, reference_run, release_run
from .catalog import Suite, materialize, tree_digest
from .config import ExperimentConfig, ModelProfile, load_config, resolve_plan
from .engines import prepare_external
from .evidence import collect_evidence
from .gateway import Gateway, read_ledger
from .harnesses import harness_configuration
from .monitor import ResourceMonitor
from .native_usage import attach_synergy_requests, native_accounting, reconcile_requests, reconcile_usage
from .prepare import command, evaluator_identity, preflight, prepare_source, remove_owned_container, verify_prepared
from .resources import (
    Capacity,
    Request,
    ResourcePool,
    admission_for,
    inspect_host,
    shared_pool_options,
    with_runtime_overhead,
)
from .results import RESULT_VERSION, AttemptResult
from .storage import atomic_json, digest, locked, read_json
from .trial import BenchmarkTrial
from .usage import aggregate_usage


def inspect_config(path: Path) -> tuple[ExperimentConfig, Suite, dict[str, Any]]:
    config = load_config(path)
    suite = Suite.load((path.parent / config.suite).resolve())
    plan = {
        "version": 3,
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
            try:
                content = (base / file).read_text()
            except OSError as error:
                raise ValueError(f"Unable to read configuration reference: {file}") from error
            value = json.loads(content)
            validate_credentials(value)
            if "{file:" in content:
                raise ValueError("File references must be materialized into the experiment config")
            for reference in re.findall(r"\{env:([A-Za-z_][A-Za-z0-9_]*)\}", content):
                if reference not in variant.env:
                    raise ValueError(f"Config environment reference is not mapped: {reference}")
        source = variant.source.artifact or variant.source.path
        if variant.harness == "synergy" and not (base / source).is_dir():
            raise ValueError("Measured source or prepared artifact does not exist")


def initialize(path: Path) -> Path:
    config = load_config(path.resolve())
    cache = (path.resolve().parent / config.cache).resolve()
    reservation = cache / "reservations" / uuid.uuid4().hex
    reference_run(
        cache,
        reservation,
        artifacts=[
            Path(variant.source.artifact).name for variant in config.variants.values() if variant.source.artifact
        ],
    )
    budgets = {
        "budget_bytes": int(config.resources.cache_budget_gib * 1024**3),
        "min_free_bytes": int(config.resources.min_free_disk_gib * 1024**3),
    }
    root = None
    try:
        enforce_budget(cache, **budgets)
        with cache_activity(cache):
            root = _initialize(path)
        enforce_budget(cache, **budgets)
        atomic_json(root / "preparation.json", {"status": "completed", "ended_at": time.time()})
        return root
    except BaseException as error:
        if root is not None:
            atomic_json(
                root / "preparation.json",
                {"status": "failed", "stage": "cache_budget", "error": type(error).__name__, "ended_at": time.time()},
            )
        raise
    finally:
        release_run(cache, reservation)


def _initialize(path: Path) -> Path:
    path = path.resolve()
    config, suite, plan = inspect_config(path)
    base = path.parent
    validate_inputs(config, base)
    progress("preflight: validating Docker and experiment inputs")
    command(["docker", "info", "--format", "{{.ServerVersion}}"], timeout=30)
    cache = (base / config.cache).resolve()
    host = inspect_host(cache, config.resources)
    if not host["disk_ready"]:
        raise ValueError("Insufficient free disk for benchmark preparation; inspect owned cache before continuing")
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
        receipts = {}
        for name, variant in config.variants.items():
            stage = "inputs"
            progress(f"prepare: freezing source and inputs for {name}")
            inputs = root / "inputs" / name
            inputs.mkdir(parents=True)
            settings = read_json(base / variant.config) if variant.config else {}
            validate_credentials(settings)
            if variant.model_profile and variant.harness == "synergy":
                generated = harness_configuration(
                    "synergy", variant.model_profile, "http://benchmark.invalid/v1", "/logs/agent/home"
                )
                settings.update(generated["config"])
            settings = {"controlProfile": "full_access", **settings}
            for role in ["nano", "mini", "mid", "thinking", "long_context", "creative", "vision"]:
                settings.setdefault(f"{role}_model", variant.model)
            atomic_json(inputs / "config.json", settings)
            if variant.experiment:
                experiment = read_json(base / variant.experiment)
                validate_credentials(experiment)
                atomic_json(inputs / "experiment.json", experiment)
            source_key = digest(
                {"source": variant.source.model_dump(), "harness": variant.harness, "version": variant.package_version}
            )
            if source_key not in artifacts:
                stage = "source"
                artifacts[source_key] = (
                    prepare_source(
                        variant.source,
                        base,
                        cache,
                        config.platform,
                        timeout=config.preparation_timeout_seconds,
                        build_settings=config.resources,
                    )
                    if variant.harness == "synergy"
                    else (base / variant.source.artifact).resolve()
                    if variant.source.artifact
                    else prepare_external(
                        variant.harness,
                        variant.package_version,
                        cache,
                        config.platform,
                        timeout=config.preparation_timeout_seconds,
                        build_settings=config.resources,
                    )
                )
                receipts[source_key] = (
                    verify_prepared(artifacts[source_key])
                    if variant.harness != "synergy" and variant.source.artifact
                    else read_json(artifacts[source_key] / "receipt.json")
                )
            artifact = artifacts[source_key]
            reference_run(cache, root, artifacts=[artifact.name])
            receipt = receipts[source_key]
            if variant.harness != "synergy" and receipt.get("kind") != variant.harness:
                raise ValueError("Prepared artifact does not match requested native harness")
            if receipt["identity"]["platform"] != config.platform:
                raise ValueError("Prepared native artifact platform mismatch")
            if (
                variant.harness != "synergy"
                and variant.package_version
                and receipt["source"]["version"] != variant.package_version
            ):
                raise ValueError("Prepared native artifact package version mismatch")
            stage = "runtime-validation"
            progress(f"preflight: resolving {name} / {variant.runtime} / {variant.model} offline")
            capability = (
                preflight(
                    artifact,
                    {
                        **variant.model_dump(),
                        **({"env": {"BENCH_GATEWAY_KEY": "BENCH_GATEWAY_KEY"}} if variant.model_profile else {}),
                    },
                    inputs,
                    config.platform,
                    root / "preparation" / name,
                )
                if variant.harness == "synergy"
                else {"harness": variant.harness, "package": receipt["source"]}
            )
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
                reference_run(cache, root, artifacts=[digest(suite.sources[task.source].model_dump())])
                if Task(task_dir=task_path).has_steps:
                    raise ValueError("Multi-step tasks require a step-aware benchmark result contract")
                native = Task(task_dir=task_path).config
                environments = [native.environment]
                if (verifier_environment := resolve_effective_verifier_env_config(native, None)) is not None:
                    environments.append(verifier_environment)
                resources = {
                    "cpus": max(
                        float(environment.cpus) if environment.cpus is not None else host["capacity"]["cpus"]
                        for environment in environments
                    ),
                    "memory_bytes": max(
                        environment.memory_mb * 1024**2
                        if environment.memory_mb is not None
                        else host["capacity"]["memory_bytes"]
                        for environment in environments
                    ),
                }
                tasks[task.id] = {
                    **task.model_dump(),
                    "local_path": str(task_path),
                    "native_resources": resources,
                    "resources": asdict(
                        with_runtime_overhead(Request(float(resources["cpus"]), int(resources["memory_bytes"])))
                    ),
                }
        concurrency = config.resources.max_concurrency if config.concurrency == "auto" else config.concurrency
        pool = ResourcePool(Capacity(**host["capacity"]), concurrency)
        for task_metadata in tasks.values():
            pool.validate(Request(**task_metadata["resources"]))
        plan.update({"host": host, "concurrency": concurrency, "cache": str(cache)})
        plan.update({"variants": variants, "tasks": tasks})
        from .evaluator import freeze_evaluator

        freeze_evaluator(root, plan["evaluator"])
        plan["digest"] = digest(plan)
        reference_run(cache, root, artifacts=[Path(variant["artifact"]).name for variant in variants.values()])
        atomic_json(root / "plan.json", plan)
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


def startup_retryable(attempt: Path, result: dict[str, Any]) -> bool:
    execution = result.get("execution") or {}
    lifecycle = execution.get("lifecycle") or {}
    wire = attempt / "wire"
    return (
        execution.get("outcome") == "timeout"
        and lifecycle.get("timeout_stage") == "startup"
        and "model_started_at" in lifecycle
        and lifecycle["model_started_at"] is None
        and lifecycle.get("marker_error") is None
        and not result.get("infrastructure_error")
        and (result.get("wire_usage") or {}).get("attempts") == 0
        and (result.get("evidence") or {}).get("archive_valid") is True
        and not {"cleanup_failed", "credential-cleanup_failed", "environment-cleanup_failed"}.intersection(
            (result.get("evidence") or {}).get("issues", [])
        )
        and (not wire.exists() or not any(wire.iterdir()))
    )


async def execute_plan(
    root: Path,
    plan: dict[str, Any],
    execute: Callable[[dict[str, Any], Path], Awaitable[dict[str, Any]]],
) -> None:
    state_file = root / "state.json"
    state = read_json(state_file) if state_file.exists() else {"trials": {}}
    concurrency = plan["concurrency"]
    capacity = plan.get("host", {}).get("capacity", {"cpus": concurrency, "memory_bytes": concurrency * 1024**3})
    pool = ResourcePool(
        Capacity(**capacity), concurrency, admission=admission_for(root, plan), **shared_pool_options(root, plan)
    )
    pairs: dict[str, list[tuple[str, dict[str, Any]]]] = {}
    for index, item in enumerate(plan["schedule"]):
        pairs.setdefault(item["pair"], []).append((f"{index:04d}", item))

    async def pair(items: list[tuple[str, dict[str, Any]]]) -> None:
        for trial_id, item in items:
            request = Request(
                **plan.get("tasks", {}).get(item.get("task"), {}).get("resources", {"cpus": 1, "memory_bytes": 1024**3})
            )
            while True:
                queued = time.monotonic()
                async with pool.reserve(request):
                    previous = state["trials"].get(trial_id, {})
                    prior_result = (
                        root / "trials" / trial_id / f"attempt-{previous.get('attempt', 0):03d}" / "evidence.json"
                    )
                    if previous.get("status") in {"running", "interrupted"} and prior_result.exists():
                        if read_json(prior_result).get("attempt_status") == "completed":
                            previous["status"] = "completed"
                            atomic_json(state_file, state)
                    startup_retry = (
                        previous.get("status") == "completed"
                        and prior_result.exists()
                        and previous.get("startup_attempt", 1) < 3
                        and startup_retryable(prior_result.parent, read_json(prior_result))
                    )
                    if previous.get("status") == "completed" and not startup_retry:
                        break
                    if startup_retry:
                        verify_terminal(prior_result.parent, read_json(prior_result))
                    startup_attempt = (
                        previous.get("startup_attempt", 1) + 1 if startup_retry else previous.get("startup_attempt", 1)
                    )
                    backoff = 2 ** (startup_attempt - 2) if startup_retry else 0
                    number = previous.get("attempt", 0) + 1
                    attempt = root / "trials" / trial_id / f"attempt-{number:03d}"
                    attempt.mkdir(parents=True, exist_ok=False)
                    current = {
                        "status": "running",
                        "attempt": number,
                        "started": time.time(),
                        "queue_seconds": time.monotonic() - queued,
                        "reason": "retry_startup_timeout_before_model"
                        if startup_retry
                        else "resume_interrupted_attempt"
                        if previous
                        else "planned_first_attempt",
                        "startup_attempt": startup_attempt,
                        "backoff_seconds": backoff,
                        "previous_attempt": previous.get("attempt"),
                    }
                    state["trials"][trial_id] = current
                    atomic_json(state_file, state)
                    atomic_json(
                        attempt / "trial.json",
                        {
                            **item,
                            **{
                                key: current[key]
                                for key in [
                                    "queue_seconds",
                                    "reason",
                                    "previous_attempt",
                                    "startup_attempt",
                                    "backoff_seconds",
                                ]
                            },
                        },
                    )
                    progress(f"run: trial {trial_id} {item.get('task', '')} / {item['variant']} / {attempt.name}")
                    try:
                        if backoff:
                            await asyncio.sleep(backoff)
                        result = await execute(item, attempt)
                        result["attempt_status"] = "completed"
                        seal_attempt(attempt, result)
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
                        result = retain_failure(attempt, error)
                        result["attempt_status"] = "completed"
                        atomic_json(attempt / "evidence.json", result)
                        current["status"] = "completed"
                    finally:
                        current["finished"] = time.time()
                        atomic_json(state_file, state)
                        progress(f"run: trial {trial_id} {current['status']}")
                    if startup_attempt >= 3 or not startup_retryable(attempt, result):
                        break

    async with asyncio.TaskGroup() as group:
        for items in pairs.values():
            group.create_task(pair(items))


async def execute_trial(
    root: Path,
    plan: dict[str, Any],
    item: dict[str, Any],
    attempt: Path,
    *,
    debug: bool = False,
    probe_instruction: str | None = None,
) -> dict[str, Any]:
    variant = plan["variants"][item["variant"]]
    if not variant.get("model_profile"):
        return await _execute_trial(root, plan, item, attempt, debug=debug, probe_instruction=probe_instruction)
    profile = ModelProfile.model_validate(variant["model_profile"])
    gateway = Gateway(profile, attempt / "wire")
    reference = "BENCH_GATEWAY_TOKEN_" + uuid.uuid4().hex.upper()
    result = None
    try:
        async with gateway:
            os.environ[reference] = gateway.token
            result = await _execute_trial(
                root,
                plan,
                item,
                attempt,
                debug=debug,
                gateway=gateway,
                reference=reference,
                probe_instruction=probe_instruction,
            )
    except BaseException as error:
        retain_failure(attempt, error)
        raise
    finally:
        os.environ.pop(reference, None)
        file = attempt / "evidence.json"
        evidence = result or (read_json(file) if file.exists() else None)
        if evidence is not None:
            evidence["wire_usage"] = aggregate_usage(read_ledger(attempt / "wire"))
            evidence["reconciliation"] = reconcile_usage(evidence["wire_usage"], evidence.get("accounting"))
            evidence["reconciliation"]["requests"] = reconcile_requests(
                read_ledger(attempt / "wire"), evidence.get("accounting")
            )
            if evidence["reconciliation"]["requests"]["status"] == "mismatch":
                evidence["reconciliation"]["status"] = "mismatch"
            usage = evidence["wire_usage"]
            evidence["evidence"]["usage"] = (
                "unknown" if not usage["attempts"] else "partial" if usage["tokens"]["total"]["unknown"] else "complete"
            )
            seal_attempt(attempt, evidence)
            if result is None:
                atomic_json(file, evidence)
    assert result is not None
    return result


def retain_failure(attempt: Path, error: BaseException) -> dict[str, Any]:
    file = attempt / "evidence.json"
    if file.exists():
        evidence: dict[str, Any] = read_json(file)
    else:
        trials = [directory.parent for directory in attempt.glob("*/agent") if directory.is_dir()]
        trial = trials[0] if len(trials) == 1 else attempt / "unstarted"
        pier_file = trial / "result.json"
        evidence = collect_evidence(trial, read_json(pier_file) if pier_file.exists() else {})
        if trials:
            evidence["trial_directory"] = trial.name
    evidence["infrastructure_error"] = {"type": type(error).__name__, "message": str(error)}
    evidence["attempt_status"] = (
        "interrupted"
        if isinstance(error, (asyncio.CancelledError, KeyboardInterrupt)) and not evidence.get("execution")
        else "completed"
    )
    evidence["wire_usage"] = aggregate_usage(read_ledger(attempt / "wire"))
    evidence["reconciliation"] = reconcile_usage(evidence["wire_usage"], evidence.get("accounting"))
    for field in ["resources", "stages"]:
        if (attempt / (field + ".json")).exists():
            evidence[field] = read_json(attempt / (field + ".json"))
    seal_attempt(attempt, evidence)
    atomic_json(file, evidence)
    return evidence


def trial_configuration(
    root: Path,
    plan: dict[str, Any],
    item: dict[str, Any],
    attempt: Path,
    *,
    debug: bool = False,
    gateway: Gateway | None = None,
    reference: str | None = None,
    probe_instruction: str | None = None,
) -> tuple[TrialConfig, Path, str]:
    variant = plan["variants"][item["variant"]]
    task = plan["tasks"][item["task"]]
    inputs = attempt / "inputs"
    shutil.copytree(root / "inputs" / item["variant"], inputs)
    cleanup = plan["config"]["cleanup_seconds"]
    export_timeout = plan["config"]["export_timeout_seconds"]
    timeout = 120 if probe_instruction else plan["config"]["timeout_seconds"] or task["agent_seconds"]
    options = {
        **{key: variant[key] for key in ["runtime", "model", "agent", "variant"]},
        "config": "/benchmark-input/config.json",
        "bun_jit": variant.get("bun_jit"),
        "experiment": "/benchmark-input/experiment.json" if variant["experiment"] else None,
        "timeout_seconds": timeout,
        "startup_timeout_seconds": plan["config"].get("startup_timeout_seconds", 120),
        "execution_marker": "/logs/agent/model-started.json" if gateway else None,
        "cleanup_seconds": cleanup,
        "export_timeout_seconds": export_timeout,
    }
    if gateway:
        native = harness_configuration(
            variant["harness"],
            gateway.model,
            gateway.url,
            "/logs/agent/home",
            bun_jit=variant.get("bun_jit"),
        )
        if variant["harness"] == "synergy":
            settings = read_json(inputs / "config.json")
            settings.update(native["config"])
            atomic_json(inputs / "config.json", settings)
        else:
            options.update({"native": native, "harness": variant["harness"]})
    atomic_json(inputs / "options.json", options)
    trial_name = f"sb-{root.name[-8:]}-{attempt.parent.parent.name}-{attempt.parent.name}-{attempt.name}"
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
            override_timeout_sec=timeout + options["startup_timeout_seconds"] + cleanup + export_timeout + 15,
            kwargs={
                "settings": {
                    "artifact_id": variant["artifact_id"],
                    "harness": variant.get("harness", "synergy"),
                    "bun_jit": variant.get("bun_jit"),
                    "env": {"BENCH_GATEWAY_KEY": reference} if gateway else variant["env"],
                    "network_domains": [gateway.advertised] if gateway else variant["network_domains"],
                    "cleanup_seconds": cleanup,
                    "export_timeout_seconds": export_timeout,
                    "project": trial_name,
                    "probe_instruction": probe_instruction,
                    "connectivity_url": gateway.url
                    if gateway and reference != "BENCH_PREWARM_UNDISPATCHABLE"
                    else None,
                    "preparation_timeout_seconds": plan["config"]["preparation_timeout_seconds"],
                }
            },
        ),
        verifier=VerifierConfig(disable=bool(probe_instruction)),
        environment=EnvironmentConfig.model_validate(
            {
                "import_path": "synergy_bench.environment:CachedDockerEnvironment",
                "delete": not debug,
                "mounts": mounts,
                "kwargs": {
                    "keep_containers": debug,
                    "benchmark_cache": plan["cache"],
                    "benchmark_run": str(root),
                    "benchmark_platform": plan["config"]["platform"],
                    "inference_port": urlsplit(gateway.url).port if gateway else None,
                },
            }
        ),
    )
    return config, trial_dir, trial_name


async def _execute_trial(
    root: Path,
    plan: dict[str, Any],
    item: dict[str, Any],
    attempt: Path,
    *,
    debug: bool = False,
    gateway: Gateway | None = None,
    reference: str | None = None,
    probe_instruction: str | None = None,
) -> dict[str, Any]:
    config, trial_dir, trial_name = trial_configuration(
        root,
        plan,
        item,
        attempt,
        debug=debug,
        gateway=gateway,
        reference=reference,
        probe_instruction=probe_instruction,
    )
    variant = plan["variants"][item["variant"]]
    if gateway:
        gateway.execution_marker = trial_dir / "agent/model-started.json"
    trial = await BenchmarkTrial.create(config)
    try:
        try:
            async with ResourceMonitor(attempt, trial_name):
                result = await trial.run()
        finally:
            if not debug:
                await background(audit_environment, root, attempt / "environment.json", trial_dir / "agent")
    except asyncio.CancelledError:
        if variant.get("harness", "synergy") != "synergy":
            accounting = await background(native_accounting, trial_dir / "agent", variant["harness"])
            if accounting is not None:
                atomic_json(trial_dir / "agent/accounting.json", accounting)
        evidence = await background(collect_evidence, trial_dir, trial.result.model_dump(mode="json"))
        if variant.get("harness", "synergy") == "synergy":
            evidence["accounting"] = await background(
                attach_synergy_requests, trial_dir / "agent", evidence.get("accounting")
            )
        evidence["trial_directory"] = trial_name
        evidence["attempt_status"] = "completed" if evidence.get("execution") else "interrupted"
        atomic_json(attempt / "evidence.json", evidence)
        raise
    if variant.get("harness", "synergy") != "synergy":
        accounting = native_accounting(trial_dir / "agent", variant["harness"])
        if accounting is not None:
            atomic_json(trial_dir / "agent/accounting.json", accounting)
    evidence = await background(
        collect_evidence, trial_dir, result.model_dump(mode="json"), verification_required=not bool(probe_instruction)
    )
    if variant.get("harness", "synergy") == "synergy":
        evidence["accounting"] = await background(
            attach_synergy_requests, trial_dir / "agent", evidence.get("accounting")
        )
    evidence["trial_directory"] = trial_name
    for field in ["resources", "stages"]:
        if (attempt / (field + ".json")).exists():
            evidence[field] = read_json(attempt / (field + ".json"))
    return evidence


def environment_projects(root: Path, record: Path) -> set[str]:
    project = read_json(record)["project"]
    if not re.fullmatch(rf"sb-{re.escape(root.name[-8:])}-[a-z0-9-]+", project):
        raise ValueError("Unexpected Docker project ownership")
    label = '{{.Label "com.docker.compose.project"}}'
    names = set(command(["docker", "ps", "-a", "--format", label], timeout=15).splitlines())
    names.update(command(["docker", "network", "ls", "--format", label], timeout=15).splitlines())
    names.update(command(["docker", "volume", "ls", "--format", label], timeout=15).splitlines())
    return {name for name in names if name == project or name.startswith(project + "__verifier__")}


def handoff_environment(root: Path, record: Path) -> None:
    project = read_json(record)["project"]
    trial = record.parent / project
    if trial.is_symlink() or not trial.resolve().is_relative_to(root.resolve()):
        raise ValueError("Retained logs escape their run")
    transferred = set()
    for name in sorted(environment_projects(root, record)):
        for container in command(
            ["docker", "ps", "-aq", "--filter", f"label=com.docker.compose.project={name}"], timeout=15
        ).splitlines():
            metadata = json.loads(command(["docker", "inspect", container], timeout=15))[0]
            for mount in metadata["Mounts"]:
                path = Path(mount.get("Source", ""))
                if mount["Type"] != "bind" or path in transferred or not path.is_relative_to(trial):
                    continue
                if path.is_symlink() or not path.resolve().is_relative_to(trial.resolve()):
                    raise ValueError("Retained log mount escapes its trial")
                identifier = record.parent / ("handoff-" + uuid.uuid4().hex + ".cid")
                try:
                    command(
                        [
                            "docker",
                            "run",
                            "--rm",
                            "--pull",
                            "never",
                            "--cidfile",
                            str(identifier),
                            "--network",
                            "none",
                            "--read-only",
                            "--user",
                            "0",
                            "--cap-drop",
                            "ALL",
                            "--cap-add",
                            "CHOWN",
                            "--cap-add",
                            "DAC_OVERRIDE",
                            "--mount",
                            f"type=bind,source={path},target=/retained",
                            "--entrypoint",
                            "chown",
                            metadata["Image"],
                            "-R",
                            "-h",
                            f"{os.getuid()}:{os.getgid()}",
                            "/retained",
                        ],
                        timeout=30,
                    )
                    transferred.add(path)
                finally:
                    remove_owned_container(identifier)
                    identifier.unlink(missing_ok=True)


def remove_environment(root: Path, record: Path) -> None:
    for name in sorted(environment_projects(root, record)):
        selector = f"label=com.docker.compose.project={name}"
        for container in command(["docker", "ps", "-aq", "--filter", selector], timeout=15).splitlines():
            command(["docker", "rm", "-f", container], timeout=30)
        for network in command(["docker", "network", "ls", "-q", "--filter", selector], timeout=15).splitlines():
            command(["docker", "network", "rm", network], timeout=30)
        for volume in command(["docker", "volume", "ls", "-q", "--filter", selector], timeout=15).splitlines():
            command(["docker", "volume", "rm", volume], timeout=30)


def audit_environment(root: Path, ownership: Path, agent: Path) -> None:
    errors = []
    try:
        remove_environment(root, ownership)
        if environment_projects(root, ownership):
            errors.append("residual_resources")
    except Exception as error:
        errors.append(type(error).__name__)
    if errors:
        file = agent / "environment-cleanup.json"
        record: dict[str, Any] = read_json(file) if file.exists() else {"status": "failed", "errors": []}
        record["errors"].extend(errors)
        atomic_json(file, record)


def seal_attempt(attempt: Path, result: dict[str, Any]) -> None:
    files = [
        attempt / name
        for name in [
            "stages.json",
            "resources.json",
            "trial.json",
            "probe.json",
            "probe-intent.json",
            "environment.json",
        ]
    ]
    files.extend((attempt / "wire").rglob("*"))
    hashes = {}
    for file in files:
        if not file.is_file() or file.is_symlink():
            continue
        with file.open("rb") as stream:
            hashes[file.relative_to(attempt).as_posix()] = {
                "bytes": file.stat().st_size,
                "sha256": hashlib.file_digest(stream, "sha256").hexdigest(),
            }
    result["sidecar_files"] = hashes


def verify_terminal(attempt: Path, result: dict[str, Any]) -> None:
    if result.get("version") != RESULT_VERSION:
        raise ValueError("Historical attempt is read-only with this evaluator")
    AttemptResult.model_validate(result)
    for name, expected in result.get("sidecar_files", {}).items():
        file = attempt / name
        if (
            Path(name).is_absolute()
            or ".." in Path(name).parts
            or not file.resolve().is_relative_to(attempt.resolve())
            or file.is_symlink()
        ):
            raise ValueError("Evidence path escapes its attempt")
        if not file.is_file():
            raise ValueError("Terminal evidence file is missing")
        with file.open("rb") as stream:
            checksum = hashlib.file_digest(stream, "sha256").hexdigest()
        if file.stat().st_size != expected["bytes"] or checksum != expected["sha256"]:
            raise ValueError("Terminal evidence hash changed; refusing to reschedule")
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
    await background(handoff_environment, root, ownership)
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
        await background(handoff_environment, root, ownership)
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
    item = read_json(attempt / "trial.json") if (attempt / "trial.json").exists() else {}
    evidence = await background(collect_evidence, trial, pier, verification_required=item.get("purpose") != "preflight")
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
    if execution.get("harness") not in {None, "synergy"}:
        evidence["accounting"] = await background(native_accounting, agent, execution["harness"])
    else:
        evidence["accounting"] = await background(attach_synergy_requests, agent, evidence.get("accounting"))
    evidence["wire_usage"] = aggregate_usage(read_ledger(attempt / "wire"))
    evidence["reconciliation"] = reconcile_usage(evidence["wire_usage"], evidence.get("accounting"))
    evidence["reconciliation"]["requests"] = reconcile_requests(
        read_ledger(attempt / "wire"), evidence.get("accounting")
    )
    if evidence["reconciliation"]["requests"]["status"] == "mismatch":
        evidence["reconciliation"]["status"] = "mismatch"
    for field in ["resources", "stages"]:
        if (attempt / (field + ".json")).exists():
            evidence[field] = read_json(attempt / (field + ".json"))
    evidence.update(attempt_status="completed", trial_directory=project)
    atomic_json(
        attempt / "reconciliation.json",
        {"version": 1, "source": "retained-terminal", "model_calls": 0, "created_at": time.time()},
    )
    seal_attempt(attempt, evidence)
    atomic_json(attempt / "evidence.json", evidence)
    return True


async def resume(root: Path, *, debug_trial: str | None = None, maintenance: str | None = None) -> None:
    await _resume(root, debug_trial=debug_trial, maintenance=maintenance)


async def _resume(root: Path, *, debug_trial: str | None = None, maintenance: str | None = None) -> None:
    root = await asyncio.to_thread(root.resolve)
    with locked(root, create=False):
        if read_json(root / "owner.json") != {"kind": "synergy-benchmark-run", "version": 1}:
            raise ValueError("Not a benchmark-owned run")
        if not (root / "plan.json").exists():
            raise ValueError("Preparation did not complete; inspect preparation records and create a new run")
        plan = read_json(root / "plan.json")
        if plan.get("version") != 3 or plan.get("result_version") != RESULT_VERSION:
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
                    ownership = evidence_file.parent / "environment.json"
                    if ownership.exists():
                        await background(remove_environment, root, ownership)
                if state["status"] in {"running", "interrupted"}:
                    attempt = root / "trials" / trial_id / f"attempt-{state['attempt']:03d}"
                    terminal = attempt / "evidence.json"
                    if terminal.exists() and read_json(terminal).get("attempt_status") == "completed":
                        continue
                    record = attempt / "environment.json"
                    if record.exists():
                        await asyncio.to_thread(remove_environment, root, record)
        if maintenance is not None:
            from .maintenance import doctor_plan, prewarm_plan

            if maintenance == "prewarm":
                await prewarm_plan(root, plan)
            elif maintenance == "doctor":
                await doctor_plan(root, plan)
            else:
                raise ValueError("Unknown maintenance operation")
            return
        if debug_trial is not None:
            index = int(debug_trial)
            if index < 0 or index >= len(plan["schedule"]):
                raise ValueError("Unknown trial index")
            item = plan["schedule"][index]
            attempt = root / "debug" / f"{index:04d}" / f"attempt-{uuid.uuid4().hex[:8]}"
            attempt.mkdir(parents=True)
            atomic_json(attempt / "evidence.json", await execute_trial(root, plan, item, attempt, debug=True))
            return
        if plan["config"].get("version") == 2:
            from .maintenance import doctor_plan, prewarm_plan

            if not (root / "prewarm.json").exists() or read_json(root / "prewarm.json")["status"] != "completed":
                await prewarm_plan(root, plan)
            await doctor_plan(root, plan)
        await execute_plan(root, plan, lambda item, attempt: execute_trial(root, plan, item, attempt))
