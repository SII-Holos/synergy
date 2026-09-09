from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
import uuid
from pathlib import Path
from typing import Any

from .catalog import tree_digest
from .config import Source
from .source import entry, freeze_source, verify_source
from .storage import atomic_json, digest, locked, read_json

BENCHMARK = Path(__file__).resolve().parents[2]


def evaluator_identity() -> dict[str, str]:
    return {
        "python": tree_digest(BENCHMARK / "src" / "synergy_bench"),
        "runtime": tree_digest(BENCHMARK / "runtime"),
        "lock": digest((BENCHMARK / "uv.lock").read_text()),
    }


def command(args: list[str], log: Path | None = None) -> str:
    if log:
        with log.open("a") as stream:
            process = subprocess.run(args, stdout=stream, stderr=subprocess.STDOUT)
        if process.returncode:
            raise ValueError(f"{args[0]} failed; see {log}")
        return ""
    return subprocess.check_output(args, stderr=subprocess.PIPE).decode().strip()


def verify_prepared(path: Path) -> dict[str, Any]:
    receipt = read_json(path / "receipt.json")
    if receipt["id"] != digest(receipt["identity"]):
        raise ValueError("Prepared artifact identity changed")
    verify_source(path / "bundle" / "source", receipt["source"])
    if tree_digest(path / "bundle" / "runtime") != receipt["runtime_digest"]:
        raise ValueError("Prepared runtime changed")
    if tree_digest(path / "bundle" / "bin") != receipt["binary_digest"]:
        raise ValueError("Prepared executable changed")
    if bundle_digest(path / "bundle") != receipt["bundle_digest"]:
        raise ValueError("Prepared bundle or installed dependencies changed")
    return receipt


def bundle_digest(root: Path) -> str:
    files = []
    for directory, dirs, names in os.walk(root):
        for name in names + [name for name in dirs if (Path(directory) / name).is_symlink()]:
            files.append(entry(root, (Path(directory) / name).relative_to(root).as_posix()))
    files.sort(key=lambda item: item["path"] if item else "")
    return digest(files)


def prepare_source(source: Source, base: Path, cache: Path, platform: str) -> Path:
    if source.artifact:
        path = (base / source.artifact).resolve()
        receipt = verify_prepared(path)
        if receipt["identity"]["platform"] != platform:
            raise ValueError("Prepared artifact platform mismatch")
        if receipt["identity"]["runtime"] != tree_digest(BENCHMARK / "runtime"):
            raise ValueError("Prepared runtime recipe differs from this evaluator; prepare a new artifact")
        return path
    work = cache / "preparing"
    work.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="source-", dir=work) as temporary:
        stage = Path(temporary)
        receipt = freeze_source((base / source.path).resolve(), stage / "source", source.revision)
        manager = read_json(stage / "source" / "package.json").get("packageManager", "")
        if not re.fullmatch(r"bun@\d+\.\d+\.\d+", manager):
            raise ValueError("Source must pin its Bun packageManager version")
        version = manager.removeprefix("bun@")
        identity = {
            "source": receipt["digest"],
            "runtime": tree_digest(BENCHMARK / "runtime"),
            "bun": version,
            "platform": platform,
            "build": 2,
        }
        artifact_id = digest(identity)
        target = cache / "prepared" / artifact_id
        with locked(cache / "locks" / artifact_id):
            if target.exists():
                verify_prepared(target)
                return target
            shutil.copytree(BENCHMARK / "runtime", stage / "runtime")
            base_image = f"oven/bun:{version}"
            log = work / f"{artifact_id}.log"
            command(["docker", "pull", "--platform", platform, base_image], log)
            image_id = command(["docker", "image", "inspect", base_image, "--format", "{{index .RepoDigests 0}}"])
            manifests = stage / "manifests"
            manifests.mkdir()
            for name in ["package.json", "bun.lock"]:
                shutil.copyfile(stage / "source" / name, manifests / name)
            package = read_json(stage / "source" / "package.json")
            for workspace in package["workspaces"]["packages"]:
                for manifest in (stage / "source").glob(f"{workspace}/package.json"):
                    destination = manifests / manifest.relative_to(stage / "source")
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(manifest, destination)
            shutil.copytree(stage / "source" / "patches", manifests / "patches")
            (stage / "Dockerfile").write_text(
                f"FROM {image_id}\nUSER root\nWORKDIR /opt/synergy/source\n"
                "COPY manifests/ ./\nENV HUSKY=0 ELECTRON_SKIP_BINARY_DOWNLOAD=1\n"
                "RUN bun install --frozen-lockfile\n"
                "COPY source/ ./\n"
                "COPY runtime/ /opt/synergy/runtime/\n"
                "RUN ln -s ../source/node_modules /opt/synergy/runtime/node_modules "
                "&& mkdir -p /opt/synergy/bin && cp /usr/local/bin/bun /opt/synergy/bin/bun\n"
            )
            image = f"synergy-bench:{artifact_id}"
            container = f"synergy-bench-prepare-{uuid.uuid4().hex[:16]}"
            command(
                [
                    "docker",
                    "build",
                    "--platform",
                    platform,
                    "--label",
                    "org.synergy.benchmark=prepared",
                    "-t",
                    image,
                    str(stage),
                ],
                log,
            )
            try:
                command(["docker", "create", "--platform", platform, "--name", container, image])
                command(["docker", "cp", f"{container}:/opt/synergy", str(stage / "bundle")], log)
            finally:
                command(["docker", "rm", "-f", container], log)
            runtime_digest = tree_digest(stage / "bundle" / "runtime")
            result = {
                "version": 1,
                "id": artifact_id,
                "identity": identity,
                "source": receipt,
                "base_image": image_id,
                "image": image,
                "runtime_digest": runtime_digest,
                "binary_digest": tree_digest(stage / "bundle" / "bin"),
                "bundle_digest": bundle_digest(stage / "bundle"),
            }
            atomic_json(stage / "receipt.json", result)
            shutil.copyfile(log, stage / "prepare.log")
            verify_source(stage / "bundle" / "source", receipt)
            shutil.rmtree(stage / "source")
            shutil.rmtree(stage / "runtime")
            target.parent.mkdir(parents=True, exist_ok=True)
            stage.rename(target)
            return target


def preflight(artifact: Path, variant: dict[str, Any], directory: Path, platform: str) -> dict[str, Any]:
    args = [
        "docker",
        "run",
        "--rm",
        "--platform",
        platform,
        "--network",
        "none",
        "-e",
        "SYNERGY_HOME=/tmp/synergy-benchmark",
        "-e",
        "SYNERGY_CONFIG_CONTENT={}",
        "-v",
        f"{artifact / 'bundle'}:/opt/synergy:ro",
        "-v",
        f"{directory}:/inputs:ro",
        read_json(artifact / "receipt.json")["base_image"],
        "/opt/synergy/bin/bun",
        "/opt/synergy/runtime/inspect.ts",
        variant["runtime"],
        "/inputs/config.json",
    ]
    if variant.get("experiment"):
        args.append("/inputs/experiment.json")
    return json.loads(command(args))
