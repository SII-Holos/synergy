from __future__ import annotations

import shutil
import tempfile
from pathlib import Path
from typing import Any

from .cache import cache_activity, cache_lock, publish, verify_object
from .config import Resources
from .harnesses import PACKAGES
from .prepare import BENCHMARK, command, remove_owned_container, retry_command
from .storage import atomic_json, digest, read_json

NODE_IMAGE = "node:24.8.0-bullseye"
NATIVE_RUNTIME = [
    "external.mjs",
    "capture.mjs",
    "capture-plugin.mjs",
    "capture-pi.mjs",
    "native-outcome.mjs",
    "deadline.mjs",
]


def prepare_external(
    kind: str,
    version: str | None,
    cache: Path,
    platform: str,
    *,
    timeout: int = 1800,
    build_settings: Resources | None = None,
) -> Path:
    with cache_activity(cache):
        return _prepare_external(kind, version, cache, platform, timeout=timeout, build_settings=build_settings)


def _prepare_external(
    kind: str, version: str | None, cache: Path, platform: str, *, timeout: int, build_settings: Resources | None
) -> Path:
    package = PACKAGES[kind]
    version = version or package["version"]
    # Provenance: https://docs.npmjs.com/cli/v11/configuring-npm/package-json#overrides
    # rc.3's web bundle requires an unpublished document-preview release.
    # Keep this exception scoped to the verified rc.1 harness until its next upgrade.
    package_overrides = {"@deepseek-ai/dsh-web-app": version} if kind == "deepseek" and version == "0.1.5-rc.1" else {}
    identity = {
        "kind": kind,
        "package": package["name"],
        "version": version,
        "overrides": package_overrides,
        "platform": platform,
        "recipe": digest(Path(__file__).read_text()),
        "runtime": digest({name: (BENCHMARK / "runtime" / name).read_text() for name in NATIVE_RUNTIME}),
    }
    recipe_id = digest(identity)
    index = cache / "indexes" / (recipe_id + ".json")
    with cache_lock(cache / "locks" / ("engine-" + recipe_id), timeout=timeout):
        if index.exists():
            target: Path = cache / "objects" / read_json(index)["artifact"]
            if target.exists():
                verify_object(target)
                return target
        from .resources import build_reservation

        with build_reservation(cache, timeout=timeout, settings=build_settings):
            work = cache / "preparing"
            work.mkdir(parents=True, exist_ok=True)
            with tempfile.TemporaryDirectory(prefix="engine-", dir=work) as temporary:
                stage = Path(temporary)
                log = work / (recipe_id + ".log")
                try:
                    base_image = command(
                        ["docker", "image", "inspect", NODE_IMAGE, "--format", "{{index .RepoDigests 0}}"]
                    )
                except Exception:
                    retry_command(["docker", "pull", "--platform", platform, NODE_IMAGE], log, timeout=timeout)
                    base_image = command(
                        ["docker", "image", "inspect", NODE_IMAGE, "--format", "{{index .RepoDigests 0}}"]
                    )
                atomic_json(
                    stage / "package.json",
                    {
                        "name": "benchmark-native-harness",
                        "private": True,
                        "version": "1.0.0",
                        "dependencies": {
                            package["name"]: version,
                            **({"@opencode-ai/plugin": version} if kind == "opencode" else {}),
                        },
                        "overrides": package_overrides,
                    },
                )
                retry_command(
                    [
                        "docker",
                        "run",
                        "--rm",
                        "--platform",
                        platform,
                        "-v",
                        f"{stage}:/work",
                        "-w",
                        "/work",
                        base_image,
                        "npm",
                        "install",
                        "--package-lock-only",
                        "--ignore-scripts",
                        "--no-audit",
                        "--no-fund",
                    ],
                    log,
                    timeout=timeout,
                )
                identity["base_image"] = base_image
                identity["lock"] = digest(read_json(stage / "package-lock.json"))
                for name in NATIVE_RUNTIME:
                    shutil.copyfile(BENCHMARK / "runtime" / name, stage / name)
                (stage / "Dockerfile").write_text(
                    f"FROM {base_image}\nUSER root\nWORKDIR /opt/synergy/engine\n"
                    "COPY package.json package-lock.json ./\n"
                    "RUN --mount=type=cache,target=/root/.npm,sharing=locked npm ci --no-audit --no-fund\n"
                    "RUN mkdir -p /opt/synergy/node /opt/synergy/runtime && cp -a /usr/local/. /opt/synergy/node/\n"
                    "COPY " + " ".join(NATIVE_RUNTIME) + " /opt/synergy/runtime/\n"
                )
                image = "synergy-bench-engine:" + digest(identity)
                retry_command(
                    [
                        "docker",
                        "build",
                        "--platform",
                        platform,
                        "--label",
                        "org.synergy.benchmark=engine",
                        "-t",
                        image,
                        str(stage),
                    ],
                    log,
                    timeout=timeout,
                )
                container_file = stage / "container.id"
                try:
                    container = command(
                        ["docker", "create", "--platform", platform, "--cidfile", str(container_file), image]
                    )
                    command(["docker", "cp", container + ":/opt/synergy", str(stage / "bundle")], log, timeout=timeout)
                finally:
                    remove_owned_container(container_file)
                    container_file.unlink(missing_ok=True)
                shutil.copyfile(log, stage / "prepare.log")
                image_id = command(["docker", "image", "inspect", image, "--format", "{{.Id}}"])
                receipt: dict[str, Any] = {
                    "version": 1,
                    "id": digest(identity),
                    "identity": identity,
                    "source": {"package": package["name"], "version": version, "lock": identity["lock"]},
                    "base_image": base_image,
                    "image": image,
                    "image_id": image_id,
                    "kind": kind,
                }
                atomic_json(stage / "receipt.json", receipt)
                target = publish(stage, cache, identity)
                atomic_json(index, {"artifact": target.name})
                return target
