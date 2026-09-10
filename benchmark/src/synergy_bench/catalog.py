from __future__ import annotations

import os
import shutil
import tempfile
from pathlib import Path
from typing import Literal

from pydantic import Field, model_validator

from .config import StrictModel
from .source import entry, git, safe_path
from .storage import digest, locked


class Dataset(StrictModel):
    url: str
    commit: str = Field(pattern=r"^[0-9a-f]{40}$")
    license: str


class Task(StrictModel):
    id: str = Field(pattern=r"^[a-zA-Z0-9_.-]+/[a-zA-Z0-9_-]+$")
    source: str
    path: str
    digest: str = Field(pattern=r"^[0-9a-f]{64}$")
    tags: list[str]
    agent_seconds: float = Field(gt=0)
    verifier_seconds: float = Field(gt=0)


class Suite(StrictModel):
    version: Literal[1]
    name: str
    selection: str
    sources: dict[str, Dataset]
    tasks: list[Task] = Field(min_length=1)

    @model_validator(mode="after")
    def valid_tasks(self) -> Suite:
        if len({task.id for task in self.tasks}) != len(self.tasks):
            raise ValueError("Duplicate task IDs")
        for task in self.tasks:
            safe_path(task.path)
            if task.source not in self.sources:
                raise ValueError(f"Unknown source: {task.source}")
        return self

    @classmethod
    def load(cls, path: Path) -> Suite:
        try:
            content = path.read_text()
        except OSError as error:
            raise ValueError(f"Unable to read task suite: {path}") from error
        return cls.model_validate_json(content)


def tree_digest(root: Path) -> str:
    files = []
    for directory, dirs, names in os.walk(root):
        dirs[:] = sorted(name for name in dirs if name not in {"node_modules", "__pycache__", ".git"})
        for name in sorted(names + [name for name in dirs if (Path(directory) / name).is_symlink()]):
            file = Path(directory) / name
            files.append(entry(root, file.relative_to(root).as_posix()))
    files.sort(key=lambda item: item["path"] if item else "")
    return digest(files)


def materialize(suite: Suite, task: Task, cache: Path) -> Path:
    source = suite.sources[task.source]
    identity = digest(source.model_dump())
    target = cache / "datasets" / identity / "source"
    with locked(target.parent):
        if not target.exists():
            stage = Path(tempfile.mkdtemp(prefix=".dataset-", dir=target.parent))
            try:
                git(stage, "init", "--quiet")
                git(stage, "fetch", "--depth=1", source.url, source.commit)
                git(stage, "checkout", "--detach", "--quiet", "FETCH_HEAD")
                if git(stage, "rev-parse", "HEAD").decode().strip() != source.commit:
                    raise ValueError("Dataset revision mismatch")
                stage.rename(target)
            finally:
                if stage.exists():
                    shutil.rmtree(stage)
        path = target / safe_path(task.path)
        if not path.resolve().is_relative_to(target.resolve()) or tree_digest(path) != task.digest:
            raise ValueError(f"Task content changed: {task.id}")
        return path
