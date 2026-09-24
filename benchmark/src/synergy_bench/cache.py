from __future__ import annotations

import asyncio
import fcntl
import json
import os
import re
import shutil
import subprocess
import time
from collections.abc import AsyncIterator, Iterator
from contextlib import asynccontextmanager, contextmanager
from pathlib import Path
from typing import Any

from .inventory import Inventory
from .storage import atomic_json, digest, read_json

OWNER = "synergy-benchmark-cache-v1"


@contextmanager
def cache_lock(path: Path, *, timeout: float = 1800) -> Iterator[None]:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path.parent / ("." + path.name + ".lock"), os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    deadline = time.monotonic() + timeout
    with os.fdopen(fd, "a") as file:
        while True:
            try:
                fcntl.flock(file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise TimeoutError("Timed out waiting for the cache builder") from None
                time.sleep(min(0.1, max(0, deadline - time.monotonic())))
        try:
            yield
        finally:
            fcntl.flock(file.fileno(), fcntl.LOCK_UN)


def inventory(path: Path, *, prepared_inventory: Inventory | None = None) -> dict[str, Any]:
    return Inventory(path, reuse=prepared_inventory).cache_receipt()


def publish(stage: Path, cache: Path, identity: dict[str, Any]) -> Path:
    observed = inventory(stage)
    key = digest({"identity": identity, "digest": observed["digest"]})
    target = cache / "objects" / key
    with cache_lock(cache / "locks" / key):
        if target.exists():
            verify_object(target)
            return target
        atomic_json(
            stage / "cache.json",
            {"owner": OWNER, "identity": identity, **observed, "id": key, "created_at": time.time()},
        )
        target.parent.mkdir(parents=True, exist_ok=True)
        stage.rename(target)
        fd = os.open(target.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    return target


def verify_object(path: Path) -> dict[str, Any]:
    receipt: dict[str, Any] = read_json(path / "cache.json")
    if receipt.get("owner") != OWNER or receipt.get("id") != path.name:
        raise ValueError("Not a benchmark-owned cache object")
    observed = inventory(path)
    if observed["digest"] != receipt["digest"] or observed["bytes"] != receipt["bytes"]:
        raise ValueError("Corrupt benchmark cache object")
    if digest({"identity": receipt["identity"], "digest": receipt["digest"]}) != path.name:
        raise ValueError("Cache identity changed")
    return receipt


def protected(cache: Path, category: str = "artifacts") -> set[str]:
    result = set()
    for file in (cache / "references").glob("*.json"):
        result.update(read_json(file).get(category, []))
    return result


def image_metadata(tag: str) -> dict[str, Any] | None:
    from .prepare import command

    try:
        result: dict[str, Any] = json.loads(
            command(["docker", "image", "inspect", tag, "--format", "{{json .}}"], timeout=30)
        )
        return result
    except subprocess.CalledProcessError as error:
        if b"No such image" in (error.stderr or b""):
            return None
        raise


def image_entries(cache: Path, valid_objects: set[str], directories: list[dict[str, Any]]) -> list[dict[str, Any]]:
    entries = []
    references = protected(cache, "images")
    for file in sorted((cache / "images").glob("*.json")):
        if file.is_symlink() or file.name.endswith(".pending.json"):
            continue
        receipt = read_json(file)
        if receipt.get("owner") != "synergy-benchmark-image-v1":
            continue
        if (
            file.stem != digest(receipt["identity"])
            or not re.fullmatch(r"synergy-bench-(?:task|egress):[a-f0-9]{64}", receipt["tag"])
            or receipt["tag"].split(":")[-1] != file.stem
        ):
            raise ValueError("Image cache ownership receipt changed")
        observed = image_metadata(receipt["tag"])
        entries.append(
            {
                "id": file.stem,
                "kind": "image",
                "tag": receipt["tag"],
                "image_id": receipt["id"],
                "valid": observed is not None and observed["Id"] == receipt["id"],
                "bytes": observed["Size"] if observed is not None and observed["Id"] == receipt["id"] else 0,
                "protected": file.stem in references,
                "created_at": receipt.get("created_at", 0),
                "receipt": str(file),
                "remove_receipt": True,
            }
        )
    artifacts = []
    for file in sorted((cache / "objects").glob("*/receipt.json")):
        if file.parent.name not in valid_objects:
            continue
        owner = file.parent / "cache.json"
        if file.is_symlink() or file.parent.is_symlink() or not owner.is_file():
            continue
        if read_json(owner).get("owner") != OWNER:
            continue
        artifacts.append((file, read_json(owner)["created_at"], "synergy-bench-engine"))
    for row in directories:
        if row["valid"] and Path(row["path"]).parts[0] == "prepared":
            file = cache / row["path"] / "receipt.json"
            if file.is_file() and not file.is_symlink():
                artifacts.append((file, row["created_at"], "synergy-bench"))
    for file, created_at, prefix in artifacts:
        receipt = read_json(file)
        tag = receipt.get("image", "")
        if not re.fullmatch(prefix + r":[a-f0-9]{64}", tag) or not receipt.get("image_id"):
            continue
        observed = image_metadata(tag)
        if observed is None:
            continue
        entries.append(
            {
                "id": digest(tag),
                "kind": "image",
                "tag": tag,
                "image_id": receipt["image_id"],
                "valid": observed["Id"] == receipt["image_id"],
                "bytes": observed["Size"] if observed["Id"] == receipt["image_id"] else 0,
                "protected": False,
                "created_at": created_at,
                "receipt": str(file),
                "remove_receipt": False,
            }
        )
    return entries


def remove_cached_image(row: dict[str, Any]) -> bool:
    from .prepare import command

    observed = image_metadata(row["tag"])
    if observed is not None and observed["Id"] != row["image_id"]:
        raise ValueError("Cached image was retagged; refusing to remove it")
    if command(["docker", "ps", "-aq", "--filter", "ancestor=" + row["tag"]], timeout=30):
        return False
    if observed is not None:
        command(["docker", "image", "rm", row["tag"]], timeout=60)
    if row["remove_receipt"]:
        Path(row["receipt"]).unlink()
    return True


def inspect_cache(cache: Path, *, verify: bool = True) -> dict[str, Any]:
    references = protected(cache)
    entries = []
    for path in sorted((cache / "objects").glob("*")):
        if path.is_symlink() or not (path / "cache.json").is_file():
            continue
        receipt = read_json(path / "cache.json")
        if receipt.get("owner") != OWNER:
            continue
        try:
            if verify:
                verify_object(path)
            valid = True
        except (ValueError, OSError):
            valid = False
        entries.append(
            {
                "id": path.name,
                "kind": "object",
                "valid": valid,
                "bytes": receipt["bytes"],
                "protected": path.name in references,
                "created_at": receipt["created_at"],
            }
        )
    directories = directory_entries(cache, verify=verify)
    entries.extend(image_entries(cache, {row["id"] for row in entries if row["valid"]}, directories))
    entries.extend(directories)
    directory = cache.resolve()
    while not directory.exists():
        directory = directory.parent
    return {
        "owner": OWNER,
        "integrity_checked": verify,
        "entries": entries,
        "owned_bytes": sum(entry["bytes"] for entry in entries),
        "byte_accounting": "files_plus_logical_image_sizes_shared_layers_may_be_counted_more_than_once",
        "disk_free_bytes": shutil.disk_usage(directory).free,
    }


def collect_cache(cache: Path, *, budget_bytes: int, min_free_bytes: int = 20 * 1024**3) -> dict[str, Any]:
    if budget_bytes < 0 or min_free_bytes < 0:
        raise ValueError("Cache budgets cannot be negative")
    removed = []
    with cache_activity(cache, collection=True), cache_lock(cache / "gc"):
        report = inspect_cache(cache)
        remaining = report["owned_bytes"]
        for entry in sorted(report["entries"], key=lambda item: (item["created_at"], item["kind"] != "image")):
            if remaining <= budget_bytes and shutil.disk_usage(cache).free >= min_free_bytes:
                break
            with cache_lock(cache / "locks" / entry["id"]):
                if entry["id"] in protected(cache, "images" if entry["kind"] == "image" else "artifacts"):
                    continue
                if entry["kind"] == "image":
                    if not entry["valid"] or not remove_cached_image(entry):
                        continue
                    remaining -= entry["bytes"]
                    removed.append(entry["id"])
                    continue
                if entry["kind"] == "directory":
                    target = cache / entry["path"]
                    if target.is_symlink() or not target.resolve().is_relative_to(cache.resolve()):
                        raise ValueError("Managed directory ownership changed")
                    if not entry["valid"]:
                        continue
                    shutil.rmtree(target)
                    Path(entry["receipt"]).unlink()
                    remaining -= entry["bytes"]
                    removed.append(entry["id"])
                    continue
                target = cache / "objects" / entry["id"]
                if target.is_symlink() or read_json(target / "cache.json").get("owner") != OWNER:
                    raise ValueError("Cache ownership changed")
                shutil.rmtree(target)
                remaining -= entry["bytes"]
                removed.append(entry["id"])
    return {"removed": removed, "remaining_bytes": remaining}


@asynccontextmanager
async def async_cache_lock(path: Path, *, wait_seconds: float = 1800) -> AsyncIterator[None]:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path.parent / ("." + path.name + ".lock"), os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    deadline = time.monotonic() + wait_seconds
    try:
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise TimeoutError("Timed out waiting for cache publication") from None
                await asyncio.sleep(0.1)
        try:
            yield
        finally:
            fcntl.flock(fd, fcntl.LOCK_UN)
    finally:
        os.close(fd)


@contextmanager
def cache_activity(cache: Path, *, collection: bool = False) -> Iterator[None]:
    cache.mkdir(parents=True, exist_ok=True)
    fd = os.open(cache / ".activity.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        try:
            fcntl.flock(fd, (fcntl.LOCK_EX if collection else fcntl.LOCK_SH) | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise ValueError("Cache has active readers/builders or collection; try again after it finishes") from error
        yield
    finally:
        os.close(fd)


def reference_run(
    cache: Path, run: Path, *, artifacts: list[str] | None = None, images: list[str] | None = None
) -> None:
    key = digest(str(run.resolve()))
    with cache_activity(cache), cache_lock(cache / "locks" / ("reference-" + key)):
        file = cache / "references" / (key + ".json")
        value = read_json(file) if file.exists() else {"run": str(run.resolve()), "artifacts": [], "images": []}
        value["artifacts"] = sorted(set(value["artifacts"]) | set(artifacts or []))
        value["images"] = sorted(set(value.get("images", [])) | set(images or []))
        atomic_json(file, value)


def release_run(cache: Path, run: Path) -> None:
    with cache_activity(cache):
        (cache / "references" / (digest(str(run.resolve())) + ".json")).unlink(missing_ok=True)


def register_directory(
    cache: Path,
    path: Path,
    *,
    identity: dict[str, Any],
    contents: Path | None = None,
    prepared_inventory: Inventory | None = None,
) -> None:
    relative = path.relative_to(cache)
    if len(relative.parts) != 2 or relative.parts[0] not in {"prepared", "datasets", "downloads"}:
        raise ValueError("Unsupported managed cache directory")
    if path.is_symlink() or not path.resolve().is_relative_to(cache.resolve()):
        raise ValueError("Managed cache path escapes its owner")
    atomic_json(
        cache / "directories" / (digest(relative.as_posix()) + ".json"),
        {
            "owner": OWNER,
            "id": path.name,
            "path": relative.as_posix(),
            "identity": identity,
            **inventory(contents if contents is not None else path, prepared_inventory=prepared_inventory),
            "created_at": time.time(),
        },
    )


def directory_entries(cache: Path, *, verify: bool) -> list[dict[str, Any]]:
    result = []
    references = protected(cache)
    for file in sorted((cache / "directories").glob("*.json")):
        if file.is_symlink():
            continue
        receipt = read_json(file)
        relative = Path(receipt["path"])
        if (
            receipt.get("owner") != OWNER
            or len(relative.parts) != 2
            or relative.parts[0] not in {"prepared", "datasets", "downloads"}
        ):
            raise ValueError("Managed directory ownership receipt changed")
        if file.stem != digest(relative.as_posix()) or relative.name != receipt["id"]:
            raise ValueError("Managed directory identity changed")
        path = cache / relative
        valid = path.is_dir() and not path.is_symlink() and path.resolve().is_relative_to(cache.resolve())
        if valid and verify:
            observed = inventory(path)
            valid = all(observed[key] == receipt[key] for key in ["digest", "bytes"])
        result.append(
            {
                "kind": "directory",
                "id": receipt["id"],
                "path": receipt["path"],
                "receipt": str(file),
                "bytes": receipt["bytes"] if path.exists() else 0,
                "valid": valid,
                "protected": receipt["id"] in references,
                "created_at": receipt["created_at"],
            }
        )
    return result


def enforce_budget(cache: Path, *, budget_bytes: int, min_free_bytes: int) -> dict[str, Any]:
    if budget_bytes < 0 or min_free_bytes < 0:
        raise ValueError("Cache budgets cannot be negative")
    report = inspect_cache(cache, verify=False)
    result = {"removed": [], "remaining_bytes": report["owned_bytes"]}
    if report["owned_bytes"] > budget_bytes or report["disk_free_bytes"] < min_free_bytes:
        try:
            result = collect_cache(cache, budget_bytes=budget_bytes, min_free_bytes=min_free_bytes)
        except ValueError as error:
            raise ValueError("Cache budget cannot be reclaimed while readers or builds are active") from error
        if result["remaining_bytes"] > budget_bytes or shutil.disk_usage(cache).free < min_free_bytes:
            raise ValueError(
                "Cache budget is exhausted by protected inputs; prepare a smaller batch or increase the explicit budget"
            )
    return result
