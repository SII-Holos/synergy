from __future__ import annotations

import hashlib
import os
import shutil
import time
import uuid
from pathlib import Path
from typing import Any

from .prepare import BENCHMARK, command, recipe_links, remove_owned_container, verify_prepared
from .results import RESULT_VERSION, require_current_plan
from .storage import atomic_json, locked, read_json


def recover_export(root: Path, trial: str, attempt: int, *, timeout: int = 300) -> dict[str, Any]:
    root = root.resolve()
    if attempt < 1 or int(trial) < 0:
        raise ValueError("Invalid trial or attempt")
    with locked(root, create=False):
        if read_json(root / "owner.json") != {"kind": "synergy-benchmark-run", "version": 1}:
            raise ValueError("Not a benchmark-owned run")
        require_current_plan(read_json(root / "plan.json"))
        original = root / "trials" / f"{int(trial):04d}" / f"attempt-{attempt:03d}"
        evidence_file = original / "evidence.json"
        evidence = read_json(evidence_file)
        if evidence.get("version") != RESULT_VERSION:
            raise ValueError("Unsupported benchmark result version")
        execution = evidence.get("execution") or {}
        if not execution.get("session_id") or not execution.get("run_id"):
            raise ValueError("Original evidence has no exportable session/run identity")
        directory = evidence.get("trial_directory")
        if not isinstance(directory, str) or Path(directory).name != directory:
            raise ValueError("Invalid retained trial directory")
        home = original / directory / "agent/home"
        if not home.is_dir() or home.is_symlink():
            raise ValueError("Retained Home is unavailable")
        plan = read_json(root / "plan.json")
        variant = plan["variants"][read_json(original / "trial.json")["variant"]]
        artifact = Path(variant["artifact"])
        receipt = verify_prepared(artifact)
        target = root / "recoveries" / f"{int(trial):04d}-{attempt:03d}-{uuid.uuid4().hex[:8]}"
        target.mkdir(parents=True, mode=0o700)
        metadata = {
            "version": 1,
            "status": "running",
            "started_at": time.time(),
            "original_evidence_sha256": hashlib.sha256(evidence_file.read_bytes()).hexdigest(),
            "original_recording": evidence.get("evidence"),
            "original_verifier": evidence.get("verifier"),
            "model_calls": 0,
        }
        atomic_json(target / "recovery.json", metadata)
        try:
            shutil.copytree(home, target / "home", symlinks=True)
            shutil.copytree(BENCHMARK / "runtime", target / "runtime", ignore=shutil.ignore_patterns("node_modules"))
            for name, relative in recipe_links(
                artifact / "bundle/source", read_json(BENCHMARK / "package.json")["dependencies"]
            ).items():
                link = target / "runtime/node_modules" / name
                link.parent.mkdir(parents=True, exist_ok=True)
                os.symlink(f"/opt/synergy/source/{relative}", link)
            (target / "output").mkdir()
            atomic_json(target / "config.json", {})
            atomic_json(
                target / "request.json",
                {
                    "runtime": variant["runtime"],
                    "identity": {"sessionID": execution["session_id"], "runID": execution["run_id"]},
                    "timeout_seconds": timeout,
                },
            )
            command(
                [
                    "docker",
                    "run",
                    "--rm",
                    "--cidfile",
                    str(target / "container.id"),
                    "--network",
                    "none",
                    "--platform",
                    plan["config"]["platform"],
                    "-e",
                    "SYNERGY_HOME=/recovery/home",
                    "-v",
                    f"{artifact / 'bundle'}:/opt/synergy:ro",
                    "-v",
                    f"{target}:/recovery",
                    receipt["base_image"],
                    "sh",
                    "-c",
                    "/opt/synergy/bin/bun /recovery/runtime/recover.ts /recovery/request.json; "
                    'result=$?; chown -R "$1:$2" /recovery || exit 1; exit "$result"',
                    "recovery",
                    str(os.getuid()),
                    str(os.getgid()),
                ],
                target / "recovery.log",
                timeout=timeout + 15,
            )
            exported = read_json(target / "output/export.json")
            metadata.update(status=exported["status"], export=exported)
        except Exception as error:
            metadata.update(status="failed", error={"type": type(error).__name__, "message": str(error)})
        finally:
            try:
                remove_owned_container(target / "container.id")
                metadata["cleanup"] = {"status": "completed"}
            except Exception as error:
                metadata.update(status="failed", cleanup={"status": "failed", "error": type(error).__name__})
            metadata["ended_at"] = time.time()
            atomic_json(target / "recovery.json", metadata)
        return {"recovery": str(target), **metadata}


def recover_archive_validation(root: Path, trial: str, attempt: int, *, timeout: int = 300) -> dict[str, Any]:
    root = root.resolve()
    if attempt < 1 or int(trial) < 0 or not 1 <= timeout <= 3600:
        raise ValueError("Invalid validation recovery selection or timeout")
    with locked(root, create=False):
        if read_json(root / "owner.json") != {"kind": "synergy-benchmark-run", "version": 1}:
            raise ValueError("Not a benchmark-owned run")
        plan = read_json(root / "plan.json")
        require_current_plan(plan)
        original = root / "trials" / f"{int(trial):04d}" / f"attempt-{attempt:03d}"
        evidence_file = original / "evidence.json"
        evidence = read_json(evidence_file)
        if evidence.get("version") != RESULT_VERSION:
            raise ValueError("Unsupported benchmark result version")
        exported = evidence.get("export") or {}
        process = exported.get("process") or {}
        validation = exported.get("validation") or {}
        if process.get("exit_code") != 0 or process.get("timed_out") or validation.get("timed_out") is not True:
            raise ValueError("Only a successfully exported archive with timed-out validation may be resumed")
        directory = evidence.get("trial_directory")
        if not isinstance(directory, str) or Path(directory).name != directory:
            raise ValueError("Invalid retained trial directory")
        archive = original / directory / "agent/rollout.zip"
        if archive.is_symlink() or not archive.is_file() or not archive.resolve().is_relative_to(root):
            raise ValueError("Retained archive is unavailable")
        sealed = (evidence.get("files") or {}).get("agent/rollout.zip") or {}
        with archive.open("rb") as stream:
            checksum = hashlib.file_digest(stream, "sha256").hexdigest()
        if checksum != sealed.get("sha256") or archive.stat().st_size != sealed.get("bytes"):
            raise ValueError("Retained archive hash or size differs from original evidence")
        variant = plan["variants"][read_json(original / "trial.json")["variant"]]
        artifact = Path(variant["artifact"])
        receipt = verify_prepared(artifact)
        target = root / "recoveries" / f"validation-{int(trial):04d}-{attempt:03d}-{uuid.uuid4().hex[:8]}"
        target.mkdir(parents=True, mode=0o700)
        metadata = {
            "version": 1,
            "kind": "archive_validation",
            "status": "running",
            "started_at": time.time(),
            "original_evidence_sha256": hashlib.sha256(evidence_file.read_bytes()).hexdigest(),
            "archive_sha256": checksum,
            "model_calls": 0,
        }
        atomic_json(target / "recovery.json", metadata)
        try:
            shutil.copytree(BENCHMARK / "runtime", target / "runtime", ignore=shutil.ignore_patterns("node_modules"))
            for name, relative in recipe_links(
                artifact / "bundle/source", read_json(BENCHMARK / "package.json")["dependencies"]
            ).items():
                link = target / "runtime/node_modules" / name
                link.parent.mkdir(parents=True, exist_ok=True)
                os.symlink(f"/opt/synergy/source/{relative}", link)
            (target / "output").mkdir()
            (target / "home").mkdir()
            atomic_json(target / "config.json", {})
            command(
                [
                    "docker",
                    "run",
                    "--rm",
                    "--cidfile",
                    str(target / "container.id"),
                    "--network",
                    "none",
                    "--platform",
                    plan["config"]["platform"],
                    "-e",
                    "SYNERGY_HOME=/recovery/home",
                    "-e",
                    "SYNERGY_CONFIG=/recovery/config.json",
                    "-e",
                    "SYNERGY_CONFIG_CONTENT={}",
                    "-e",
                    "SYNERGY_BENCH_COMPOSITION=" + variant["runtime"],
                    "-e",
                    "SYNERGY_DISABLE_MODELS_FETCH=1",
                    "-e",
                    "SYNERGY_DISABLE_DEFAULT_PLUGINS=1",
                    "-e",
                    "SYNERGY_DISABLE_AUTOUPDATE=1",
                    "-e",
                    "MODELS_DEV_API_JSON=/opt/synergy/source/packages/testing/fixtures/models-api.json",
                    "-v",
                    f"{artifact / 'bundle'}:/opt/synergy:ro",
                    "-v",
                    f"{archive}:/recovery-input/rollout.zip:ro",
                    "-v",
                    f"{target}:/recovery",
                    receipt["base_image"],
                    "sh",
                    "-c",
                    "/opt/synergy/bin/bun /recovery/runtime/verify.ts "
                    '/recovery-input/rollout.zip "$1" /recovery/output/archive.json; '
                    'result=$?; chown -R "$2:$3" /recovery || exit 1; exit "$result"',
                    "recovery",
                    variant["runtime"],
                    str(os.getuid()),
                    str(os.getgid()),
                ],
                target / "validation.log",
                timeout=timeout + 15,
            )
            validated = read_json(target / "output/archive.json")
            if (
                validated.get("valid") is not True
                or validated.get("sha256") != checksum
                or validated.get("bytes") != sealed["bytes"]
            ):
                raise ValueError("Validation receipt does not match the retained archive")
            with archive.open("rb") as stream:
                if hashlib.file_digest(stream, "sha256").hexdigest() != checksum:
                    raise ValueError("Retained archive changed during validation")
            metadata.update(status="completed", validation=validated)
        except Exception as error:
            metadata.update(status="failed", error={"type": type(error).__name__, "message": str(error)})
        finally:
            try:
                remove_owned_container(target / "container.id")
                metadata["cleanup"] = {"status": "completed"}
            except Exception as error:
                metadata.update(status="failed", cleanup={"status": "failed", "error": type(error).__name__})
            metadata["ended_at"] = time.time()
            atomic_json(target / "recovery.json", metadata)
        return {"recovery": str(target), **metadata}
