from __future__ import annotations

import hashlib
import os
import re
import shutil
import time
import uuid
from pathlib import Path
from typing import Any

from .prepare import BENCHMARK, command, recipe_links, verify_prepared
from .storage import atomic_json, locked, read_json


def recover_export(root: Path, trial: str, attempt: int, *, timeout: int = 300) -> dict[str, Any]:
    root = root.resolve()
    if attempt < 1 or int(trial) < 0:
        raise ValueError("Invalid trial or attempt")
    with locked(root, create=False):
        if read_json(root / "owner.json") != {"kind": "synergy-benchmark-run", "version": 1}:
            raise ValueError("Not a benchmark-owned run")
        original = root / "trials" / f"{int(trial):04d}" / f"attempt-{attempt:03d}"
        evidence_file = original / "evidence.json"
        evidence = read_json(evidence_file)
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
                    "/opt/synergy/bin/bun",
                    "/recovery/runtime/recover.ts",
                    "/recovery/request.json",
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
                cid = target / "container.id"
                if cid.exists():
                    container = cid.read_text().strip()
                    if not re.fullmatch(r"[a-f0-9]{64}", container):
                        raise ValueError("Invalid owned recovery container ID")
                    remaining = command(
                        ["docker", "ps", "-aq", "--no-trunc", "--filter", f"id={container}"], timeout=30
                    )
                    if remaining:
                        if remaining != container:
                            raise ValueError("Recovery container ownership changed")
                        command(["docker", "rm", "-f", container], timeout=30)
                metadata["cleanup"] = {"status": "completed"}
            except Exception as error:
                metadata.update(status="failed", cleanup={"status": "failed", "error": type(error).__name__})
            metadata["ended_at"] = time.time()
            atomic_json(target / "recovery.json", metadata)
        return {"recovery": str(target), **metadata}
