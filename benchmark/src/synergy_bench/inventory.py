from __future__ import annotations

import hashlib
import os
import stat
from pathlib import Path
from typing import Any

from .storage import digest


class Inventory:
    """One operation's complete byte inventory; never retained across verification calls."""

    def __init__(self, root: Path, *, reuse: Inventory | None = None):
        self.root = root.resolve()
        self.files: dict[str, dict[str, Any]] = {}
        for directory, dirs, names in os.walk(root):
            for name in names + [name for name in dirs if (Path(directory) / name).is_symlink()]:
                file = Path(directory) / name
                relative = file.relative_to(root).as_posix()
                if reuse is not None and file.is_relative_to(reuse.root):
                    item = reuse.files.get(file.relative_to(reuse.root).as_posix())
                    if item is not None:
                        self.files[relative] = item
                        continue
                info = file.lstat()
                if stat.S_ISLNK(info.st_mode):
                    self.files[relative] = {"link": os.readlink(file)}
                elif stat.S_ISREG(info.st_mode):
                    with file.open("rb") as stream:
                        sha = hashlib.file_digest(stream, "sha256").hexdigest()
                    self.files[relative] = {"bytes": info.st_size, "sha256": sha, "mode": info.st_mode & 0o777}
                else:
                    raise ValueError(f"Unsupported inventory entry: {relative}")
        self.files = dict(sorted(self.files.items()))

    def entries(self, prefix: str = "", *, excluded: set[str] | None = None) -> list[dict[str, Any]]:
        root = self.root / prefix
        rows = []
        for name, item in self.files.items():
            if prefix and not name.startswith(prefix + "/"):
                continue
            relative = name[len(prefix) + 1 :] if prefix else name
            if excluded and (
                set(Path(relative).parts[:-1]) & excluded
                or (Path(relative).name in excluded and (root / relative).is_dir())
            ):
                continue
            if "link" in item:
                target = item["link"]
                if Path(target).is_absolute() or not (root / relative).resolve().is_relative_to(root):
                    raise ValueError(f"Source symlink escapes snapshot: {relative}")
                rows.append({"path": relative, "kind": "link", "target": target})
            else:
                rows.append(
                    {
                        "path": relative,
                        "kind": "file",
                        "sha256": item["sha256"],
                        "executable": bool(item["mode"] & 0o111),
                    }
                )
        return rows

    def tree_digest(self, prefix: str = "", *, excluded: set[str] | None = None) -> str:
        return digest(self.entries(prefix, excluded=excluded))

    def cache_receipt(self) -> dict[str, Any]:
        entries = [{"path": name, **item} for name, item in self.files.items() if name != "cache.json"]
        return {"digest": digest(entries), "bytes": sum(item.get("bytes", 0) for item in entries)}
