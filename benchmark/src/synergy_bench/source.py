from __future__ import annotations

import hashlib
import os
import shutil
import stat
import subprocess
import tempfile
from pathlib import Path
from typing import Any

from .storage import digest

EXCLUDED = {".git", "node_modules", ".venv", "__pycache__", ".artifacts", ".turbo"}


def git(root: Path, *args: str) -> bytes:
    return subprocess.check_output(["git", "--no-optional-locks", "-C", str(root), *args], stderr=subprocess.PIPE)


def safe_path(name: str) -> Path:
    path = Path(name)
    if path.is_absolute() or ".." in path.parts or not path.parts:
        raise ValueError(f"Unsafe source path: {name}")
    return path


def entry(root: Path, name: str) -> dict[str, Any] | None:
    relative = safe_path(name)
    file = root / relative
    try:
        info = file.lstat()
    except FileNotFoundError:
        return None
    if stat.S_ISLNK(info.st_mode):
        target = os.readlink(file)
        if Path(target).is_absolute() or not (file.parent / target).resolve().is_relative_to(root.resolve()):
            raise ValueError(f"Source symlink escapes snapshot: {name}")
        return {"path": name, "kind": "link", "target": target}
    if not stat.S_ISREG(info.st_mode):
        raise ValueError(f"Unsupported source entry (including submodules): {name}")
    if not file.resolve().is_relative_to(root.resolve()):
        raise ValueError(f"Source path escapes snapshot: {name}")
    return {
        "path": name,
        "kind": "file",
        "sha256": hashlib.sha256(file.read_bytes()).hexdigest(),
        "executable": bool(info.st_mode & 0o111),
    }


def working_entries(root: Path) -> list[dict[str, Any]]:
    names = git(root, "ls-files", "--cached", "--others", "--exclude-standard", "-z").decode().split("\0")
    result = []
    for name in sorted(set(names) - {""}):
        if set(Path(name).parts) & EXCLUDED:
            continue
        item = entry(root, name)
        if item:
            result.append(item)
    return result


def verify_source(root: Path, receipt: dict[str, Any]) -> None:
    if digest(receipt["files"]) != receipt["digest"]:
        raise ValueError("Source manifest changed")
    for item in receipt["files"]:
        if entry(root, item["path"]) != item:
            raise ValueError(f"Source content changed: {item['path']}")
    names = set()
    for directory, dirs, files in os.walk(root):
        dirs[:] = [name for name in dirs if name not in EXCLUDED]
        for name in files + [name for name in dirs if (Path(directory) / name).is_symlink()]:
            names.add((Path(directory) / name).relative_to(root).as_posix())
    if names != {item["path"] for item in receipt["files"]}:
        raise ValueError("Source inventory changed")


def freeze_source(root: Path, destination: Path, revision: str | None = None) -> dict[str, Any]:
    root = root.resolve()
    commit = git(root, "rev-parse", "--verify", f"{revision or 'HEAD'}^{{commit}}").decode().strip()
    if destination.exists():
        raise ValueError("Snapshot destination already exists")
    destination.parent.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix=".source-", dir=destination.parent))
    try:
        if revision:
            records = git(root, "ls-tree", "-rz", "--full-tree", commit).split(b"\0")
            for record in records:
                if not record:
                    continue
                metadata, raw_name = record.split(b"\t", 1)
                mode, kind, object_id = metadata.decode().split()
                name = raw_name.decode()
                relative = safe_path(name)
                if set(relative.parts) & EXCLUDED:
                    continue
                if kind != "blob":
                    raise ValueError(f"Unsupported source entry: {name}")
                content = git(root, "cat-file", "blob", object_id)
                output = stage / relative
                output.parent.mkdir(parents=True, exist_ok=True)
                if mode == "120000":
                    output.symlink_to(content.decode())
                    entry(stage, name)
                else:
                    output.write_bytes(content)
                    output.chmod(0o755 if mode == "100755" else 0o644)
            files: list[dict[str, Any]] = []
            for file in sorted(stage.rglob("*")):
                if file.is_symlink() or file.is_file():
                    item = entry(stage, file.relative_to(stage).as_posix())
                    if item is not None:
                        files.append(item)
        else:
            files = working_entries(root)
            for item in files:
                output = stage / item["path"]
                output.parent.mkdir(parents=True, exist_ok=True)
                if item["kind"] == "link":
                    output.symlink_to(item["target"])
                else:
                    shutil.copyfile(root / item["path"], output)
                    output.chmod(0o755 if item["executable"] else 0o644)
            if working_entries(root) != files or git(root, "rev-parse", "HEAD").decode().strip() != commit:
                raise ValueError("Source changed while freezing; retry preparation")
        receipt = {
            "version": 1,
            "commit": commit,
            "mode": "revision" if revision else "working-tree",
            "digest": digest(files),
            "files": files,
        }
        verify_source(stage, receipt)
        stage.rename(destination)
        return receipt
    finally:
        if stage.exists():
            shutil.rmtree(stage)
