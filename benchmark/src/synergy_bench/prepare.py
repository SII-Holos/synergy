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
from .config import Resources, Source
from .inventory import Inventory
from .source import EXCLUDED, freeze_source, safe_path
from .storage import atomic_json, digest, read_json
from .timing import measured

BENCHMARK = Path(__file__).resolve().parents[2]


def evaluator_identity(root: Path | None = None) -> dict[str, str]:
    root = root or BENCHMARK
    return {
        "python": tree_digest(root / "src" / "synergy_bench"),
        "runtime": tree_digest(root / "runtime"),
        "lock": digest((root / "uv.lock").read_text()),
        "project": digest((root / "pyproject.toml").read_text()),
        "python_version": host_platform.python_version(),
        "recipe_dependencies": digest(read_json(root / "package.json")["dependencies"]),
    }


SESSION_RUNTIME = {
    "external.mjs",
    "capture.mjs",
    "native-outcome.mjs",
    "session-capture.mjs",
    "session-relay.mjs",
    "session-prepare.mjs",
    "session-entry.mjs",
}


def source_protocol(source: Path, commit: str | None) -> str:
    if (source / "packages/local-runtime/package.json").is_file():
        return "synergy-rollout-v1"
    # Provenance: https://github.com/SII-Holos/synergy/tree/v3.0.22/packages/synergy
    # This audited release predates compositions and native rollout exports.
    manifest = source / "packages/synergy/package.json"
    if commit == "024dd683e091d9fce3d1d26b79b2e188ce636b52" and manifest.is_file():
        if read_json(manifest).get("name") == "synergy":
            return "synergy-session-v1"
    raise ValueError("Unsupported historical Synergy source; audit its native execution and export protocol first")


def synergy_runtime_digest(root: Path, *, protocol: str = "synergy-rollout-v1") -> str:
    from .source import entry

    return digest(
        [
            entry(root, path.relative_to(root).as_posix())
            for path in sorted(root.rglob("*"))
            if path.is_file()
            and (
                path.suffix == ".ts"
                or path.name == "deadline.mjs"
                or (protocol == "synergy-session-v1" and path.name in SESSION_RUNTIME)
            )
        ]
    )


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


def source_recipe(source: Path, *, image_id: str, protocol: str, links: dict[str, str]) -> str:
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
    native = ""
    if protocol == "synergy-rollout-v1":
        native = (
            "FROM node:22.14.0-bullseye AS native\n"
            "COPY --from=source /opt/synergy /opt/synergy\n"
            "WORKDIR /opt/synergy/source\n"
            "RUN /opt/synergy/bin/bun packages/local-runtime/script/build-watcher.ts --local\n"
        )
        pty = (source / "packages/local-runtime/script/build-pty.ts").is_file()
        if pty:
            native += (
                "FROM rust:1.94.0-bookworm AS native_pty\n"
                "COPY --from=source /opt/synergy /opt/synergy\n"
                "WORKDIR /opt/synergy/source\n"
                "RUN /opt/synergy/bin/bun packages/local-runtime/script/build-pty.ts\n"
            )
        native += (
            "FROM source\n"
            "COPY --from=native /opt/synergy/source/packages/local-runtime/.artifacts/watcher "
            "/opt/synergy/source/packages/local-runtime/.artifacts/watcher\n"
        )
        if pty:
            native += (
                "COPY --from=native_pty /opt/synergy/source/packages/local-runtime/.artifacts/pty "
                "/opt/synergy/source/packages/local-runtime/.artifacts/pty\n"
            )
    prepare_entry = "session-prepare.mjs" if protocol == "synergy-session-v1" else "prepare.ts"
    return (
        f"FROM {image_id} AS source\nUSER root\nWORKDIR /opt/synergy/source\n"
        "COPY manifests/ ./\nENV HUSKY=0 ELECTRON_SKIP_BINARY_DOWNLOAD=1\n"
        "RUN --mount=type=cache,target=/root/.bun/install/cache,sharing=locked "
        "bun install --frozen-lockfile --network-concurrency 16\n"
        "COPY source/ ./\n"
        "COPY runtime/ /opt/synergy/runtime/\n"
        f"RUN {' && '.join(link_commands)}\n"
        "RUN mkdir -p /opt/synergy/bin && cp /usr/local/bin/bun /opt/synergy/bin/bun\n"
        f"RUN SYNERGY_HOME=/tmp/benchmark-prepare bun /opt/synergy/runtime/{prepare_entry}\n" + native
    )


def command(args: list[str], log: Path | None = None, *, timeout: float = 1800) -> str:
    if log:
        with log.open("a") as stream:
            process = subprocess.run(args, stdout=stream, stderr=subprocess.STDOUT, timeout=timeout)
        if process.returncode:
            raise RuntimeError(f"{args[0]} failed; see {log}")
        return ""
    return subprocess.check_output(args, stderr=subprocess.PIPE, timeout=timeout).decode().strip()


def transient_preparation_error(detail: str) -> bool:
    return bool(
        re.search(
            r"\b(?:429|500|502|503|504)\b|ECONNRESET|EAI_AGAIN|ETIMEDOUT|TLS handshake timeout|"
            r"connection reset|no such host|temporary failure|network is unreachable",
            detail,
            re.I,
        )
    )


def retry_command(args: list[str], log: Path, *, timeout: float = 1800, backoff: float = 2) -> str:
    history = log.with_suffix(log.suffix + ".attempts.json")
    records = read_json(history) if history.exists() else []
    deadline = time.monotonic() + timeout
    for attempt in range(3):
        offset = log.stat().st_size if log.exists() else 0
        row: dict[str, Any] = {"started_at": time.time(), "status": "running", "operation": args[:2]}
        records.append(row)
        atomic_json(history, records)
        try:
            result = command(args, log, timeout=max(0.01, deadline - time.monotonic()))
            row["status"] = "completed"
            return result
        except (RuntimeError, OSError, subprocess.SubprocessError) as error:
            with log.open("rb") if log.exists() else open(os.devnull, "rb") as stream:
                stream.seek(offset)
                detail = stream.read().decode(errors="replace")
            transient = transient_preparation_error(detail)
            delay = backoff * 2**attempt
            row.update(status="failed", error=type(error).__name__, retryable=transient)
            if not transient or attempt == 2 or time.monotonic() + delay >= deadline:
                raise
            row["backoff_seconds"] = delay
        finally:
            row["ended_at"] = time.time()
            atomic_json(history, records)
        time.sleep(delay)
    raise RuntimeError("Preparation retry budget exhausted")


@measured("cleanup")
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


@measured("verify")
def verify_prepared(path: Path) -> dict[str, Any]:
    if (path / "cache.json").exists():
        from .cache import verify_object

        verify_object(path)
        receipt: dict[str, Any] = read_json(path / "receipt.json")
        return receipt
    receipt = read_json(path / "receipt.json")
    if receipt["id"] != digest(receipt["identity"]):
        raise ValueError("Prepared artifact identity changed")
    inventory = Inventory(path / "bundle")
    verify_inventory_source(inventory, receipt["source"])
    if inventory.tree_digest("runtime", excluded={"node_modules", "__pycache__", ".git"}) != receipt["runtime_digest"]:
        raise ValueError("Prepared runtime changed")
    if inventory.tree_digest("bin", excluded={"node_modules", "__pycache__", ".git"}) != receipt["binary_digest"]:
        raise ValueError("Prepared executable changed")
    if inventory.tree_digest() != receipt["bundle_digest"]:
        raise ValueError("Prepared bundle or installed dependencies changed")
    return receipt


def verify_inventory_source(inventory: Inventory, receipt: dict[str, Any]) -> None:
    if digest(receipt["files"]) != receipt["digest"]:
        raise ValueError("Source manifest changed")
    if inventory.entries("source", excluded=EXCLUDED) != receipt["files"]:
        raise ValueError("Source content or inventory changed")


def bundle_digest(root: Path) -> str:
    return Inventory(root).tree_digest()


@measured("prepare")
def prepare_source(
    source: Source,
    base: Path,
    cache: Path,
    platform: str,
    *,
    timeout: int = 1800,
    build_settings: Resources | None = None,
) -> Path:
    deadline = time.monotonic() + timeout
    if source.artifact:
        path = (base / source.artifact).resolve()
        receipt = verify_prepared(path)
        if receipt["identity"]["platform"] != platform:
            raise ValueError("Prepared artifact platform mismatch")
        if receipt["identity"]["runtime"] != synergy_runtime_digest(
            BENCHMARK / "runtime", protocol=receipt["identity"].get("runtime_protocol", "synergy-rollout-v1")
        ):
            raise ValueError("Prepared runtime recipe differs from this evaluator; prepare a new artifact")
        dependencies = (
            {"synergy": "workspace:*"}
            if receipt["identity"].get("runtime_protocol") == "synergy-session-v1"
            else read_json(BENCHMARK / "package.json")["dependencies"]
        )
        if receipt["identity"]["recipe_dependencies"] != dependencies:
            raise ValueError("Prepared recipe dependencies changed")
        return path
    work = cache / "preparing"
    work.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="source-", dir=work) as temporary:
        stage = Path(temporary)
        receipt = freeze_source((base / source.path).resolve(), stage / "source", source.revision)
        protocol = source_protocol(stage / "source", receipt.get("commit"))
        if protocol == "synergy-session-v1" and not source.revision:
            raise ValueError("Session-export releases require an explicit immutable source revision")
        manager = read_json(stage / "source" / "package.json").get("packageManager", "")
        if not re.fullmatch(r"bun@\d+\.\d+\.\d+", manager):
            raise ValueError("Source must pin its Bun packageManager version")
        version = manager.removeprefix("bun@")
        identity = {
            "source": receipt["digest"],
            "runtime": synergy_runtime_digest(BENCHMARK / "runtime", protocol=protocol),
            "runtime_protocol": protocol,
            "recipe_dependencies": {"synergy": "workspace:*"}
            if protocol == "synergy-session-v1"
            else read_json(BENCHMARK / "package.json")["dependencies"],
            "bun": version,
            "platform": platform,
            "build": digest(Path(__file__).read_text()),
        }
        artifact_id = digest(identity)
        target = cache / "prepared" / artifact_id
        from .cache import cache_lock, register_directory

        with cache_lock(cache / "locks" / artifact_id, timeout=max(1, deadline - time.monotonic())):
            if target.exists():
                verify_prepared(target)
                return target
            from .resources import build_reservation

            with build_reservation(cache, timeout=max(1, deadline - time.monotonic()), settings=build_settings):
                shutil.copytree(BENCHMARK / "runtime", stage / "runtime")
                base_image = f"oven/bun:{version}"
                log = work / f"{artifact_id}.log"
                retry_command(
                    ["docker", "pull", "--platform", platform, base_image],
                    log,
                    timeout=max(1, deadline - time.monotonic()),
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
                (stage / "Dockerfile").write_text(
                    source_recipe(stage / "source", image_id=image_id, protocol=protocol, links=links)
                )
                image = f"synergy-bench:{artifact_id}"
                container = f"synergy-bench-prepare-{uuid.uuid4().hex[:16]}"
                retry_command(
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
                inventory = Inventory(stage / "bundle")
                verify_inventory_source(inventory, receipt)
                runtime_digest = inventory.tree_digest("runtime", excluded={"node_modules", "__pycache__", ".git"})
                result = {
                    "version": 1,
                    "id": artifact_id,
                    "identity": identity,
                    "source": receipt,
                    "base_image": image_id,
                    "image": image,
                    "image_id": command(["docker", "image", "inspect", image, "--format", "{{.Id}}"]),
                    "runtime_digest": runtime_digest,
                    "binary_digest": inventory.tree_digest("bin", excluded={"node_modules", "__pycache__", ".git"}),
                    "bundle_digest": inventory.tree_digest(),
                }
                atomic_json(stage / "receipt.json", result)
                shutil.copyfile(log, stage / "prepare.log")
                shutil.rmtree(stage / "source")
                shutil.rmtree(stage / "runtime")
                target.parent.mkdir(parents=True, exist_ok=True)
                register_directory(cache, target, identity=identity, contents=stage, prepared_inventory=inventory)
                stage.rename(target)
                parent = os.open(target.parent, os.O_RDONLY | os.O_DIRECTORY)
                try:
                    os.fsync(parent)
                finally:
                    os.close(parent)
                return target
