from __future__ import annotations

import os
import platform as host_platform
import re
import shlex
import shutil
import subprocess
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any

from .catalog import tree_digest
from .config import Source
from .source import entry, freeze_source, safe_path, verify_source
from .storage import atomic_json, digest, locked, read_json

BENCHMARK = Path(__file__).resolve().parents[2]


def evaluator_identity() -> dict[str, str]:
    return {
        "python": tree_digest(BENCHMARK / "src" / "synergy_bench"),
        "runtime": tree_digest(BENCHMARK / "runtime"),
        "lock": digest((BENCHMARK / "uv.lock").read_text()),
        "python_version": host_platform.python_version(),
        "recipe_dependencies": digest(read_json(BENCHMARK / "package.json")["dependencies"]),
    }


def recipe_links(source: Path, dependencies: dict[str, str]) -> dict[str, str]:
    packages = {}
    for workspace in read_json(source / "package.json")["workspaces"]["packages"]:
        safe_path(workspace)
        for manifest in source.glob(f"{workspace}/package.json"):
            packages[read_json(manifest)["name"]] = manifest.parent.relative_to(source).as_posix()
    for name, version in dependencies.items():
        safe_path(name)
        if version != "workspace:*" or name not in packages:
            raise ValueError(f"Recipe dependency is not provided by the measured workspace: {name}")
    return {name: packages[name] for name in sorted(dependencies)}


def command(args: list[str], log: Path | None = None, *, timeout: float = 1800) -> str:
    if log:
        with log.open("a") as stream:
            process = subprocess.run(args, stdout=stream, stderr=subprocess.STDOUT, timeout=timeout)
        if process.returncode:
            raise RuntimeError(f"{args[0]} failed; see {log}")
        return ""
    return subprocess.check_output(args, stderr=subprocess.PIPE, timeout=timeout).decode().strip()


def remove_owned_container(file: Path) -> None:
    if not file.exists():
        return
    container = file.read_text().strip()
    if not re.fullmatch(r"[a-f0-9]{64}", container):
        raise ValueError("Invalid owned container ID")
    remaining = command(["docker", "ps", "-aq", "--no-trunc", "--filter", f"id={container}"], timeout=15)
    if remaining:
        if remaining != container:
            raise ValueError("Container ownership changed")
        command(["docker", "rm", "-f", container], timeout=30)


def verify_prepared(path: Path) -> dict[str, Any]:
    receipt: dict[str, Any] = read_json(path / "receipt.json")
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


def prepare_source(source: Source, base: Path, cache: Path, platform: str, *, timeout: int = 1800) -> Path:
    deadline = time.monotonic() + timeout
    if source.artifact:
        path = (base / source.artifact).resolve()
        receipt = verify_prepared(path)
        if receipt["identity"]["platform"] != platform:
            raise ValueError("Prepared artifact platform mismatch")
        if receipt["identity"]["runtime"] != tree_digest(BENCHMARK / "runtime"):
            raise ValueError("Prepared runtime recipe differs from this evaluator; prepare a new artifact")
        if receipt["identity"]["recipe_dependencies"] != read_json(BENCHMARK / "package.json")["dependencies"]:
            raise ValueError("Prepared recipe dependencies changed")
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
            "recipe_dependencies": read_json(BENCHMARK / "package.json")["dependencies"],
            "bun": version,
            "platform": platform,
            "build": digest(Path(__file__).read_text()),
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
            command(
                ["docker", "pull", "--platform", platform, base_image], log, timeout=max(1, deadline - time.monotonic())
            )
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
            links = recipe_links(stage / "source", identity["recipe_dependencies"])
            link_commands = []
            for name, relative in links.items():
                link_path = Path("/opt/synergy/runtime/node_modules") / name
                linked = Path("/opt/synergy/source") / relative
                link_commands.extend(
                    [
                        shlex.join(["mkdir", "-p", str(link_path.parent)]),
                        shlex.join(["ln", "-s", os.path.relpath(linked, link_path.parent), str(link_path)]),
                    ]
                )
            (stage / "Dockerfile").write_text(
                f"FROM {image_id} AS source\nUSER root\nWORKDIR /opt/synergy/source\n"
                "COPY manifests/ ./\nENV HUSKY=0 ELECTRON_SKIP_BINARY_DOWNLOAD=1\n"
                "RUN --mount=type=cache,target=/root/.bun/install/cache,sharing=locked "
                "bun install --frozen-lockfile --network-concurrency 16\n"
                "COPY source/ ./\n"
                "COPY runtime/ /opt/synergy/runtime/\n"
                f"RUN {' && '.join(link_commands)}\n"
                "RUN mkdir -p /opt/synergy/bin && cp /usr/local/bin/bun /opt/synergy/bin/bun\n"
                "RUN SYNERGY_HOME=/tmp/benchmark-prepare bun /opt/synergy/runtime/prepare.ts\n"
                "FROM node:22.14.0-bullseye AS native\n"
                "COPY --from=source /opt/synergy /opt/synergy\n"
                "WORKDIR /opt/synergy/source\n"
                "RUN /opt/synergy/bin/bun packages/runtime-local/script/build-watcher.ts --local\n"
                "FROM source\n"
                "COPY --from=native /opt/synergy/source/packages/runtime-local/.artifacts/watcher "
                "/opt/synergy/source/packages/runtime-local/.artifacts/watcher\n"
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
                timeout=max(1, deadline - time.monotonic()),
            )
            container_file = work / f"{artifact_id}.container.id"
            remove_owned_container(container_file)
            container_file.unlink(missing_ok=True)
            try:
                command(
                    [
                        "docker",
                        "create",
                        "--cidfile",
                        str(container_file),
                        "--platform",
                        platform,
                        "--name",
                        container,
                        image,
                    ]
                )
                command(["docker", "cp", f"{container}:/opt/synergy", str(stage / "bundle")], log)
            finally:
                remove_owned_container(container_file)
                container_file.unlink(missing_ok=True)
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


def preflight(artifact: Path, variant: dict[str, Any], directory: Path, platform: str, logs: Path) -> dict[str, Any]:
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
    args += [
        "/inputs/experiment.json" if variant.get("experiment") else "",
        variant["model"],
        variant["agent"],
        variant.get("variant") or "",
    ]
    for key in variant.get("env", {}):
        args[2:2] = ["-e", f"{key}=benchmark-preflight"]
    for key, value in {
        "SYNERGY_CONFIG": "/inputs/config.json",
        "SYNERGY_DISABLE_MODELS_FETCH": "1",
        "SYNERGY_DISABLE_DEFAULT_PLUGINS": "1",
        "SYNERGY_DISABLE_AUTOUPDATE": "1",
        "MODELS_DEV_API_JSON": "/opt/synergy/source/packages/testing/fixtures/models-api.json",
    }.items():
        args[2:2] = ["-e", f"{key}={value}"]
    logs.mkdir(parents=True, exist_ok=True)
    args[2:2] = ["--cidfile", str(logs / "container.id")]
    started = time.time()
    timed_out = False
    result = None
    try:
        with (logs / "stdout.log").open("w") as stdout, (logs / "stderr.log").open("w") as stderr:
            result = subprocess.run(args, stdout=stdout, stderr=stderr, timeout=120)
    except subprocess.TimeoutExpired:
        timed_out = True
        raise
    finally:
        atomic_json(
            logs / "process.json",
            {
                "started_at": started,
                "ended_at": time.time(),
                "timed_out": timed_out,
                "exit_code": result.returncode if result is not None else None,
            },
        )
        remove_owned_container(logs / "container.id")
    if result.returncode == 2:
        raise ValueError(f"Frozen runtime rejected the experiment; see {logs / 'stderr.log'}")
    if result.returncode:
        raise RuntimeError(f"Frozen runtime validation failed; see {logs / 'stderr.log'}")
    capability: dict[str, Any] = read_json(logs / "stdout.log")
    return capability
