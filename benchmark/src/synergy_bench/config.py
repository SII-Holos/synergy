from __future__ import annotations

import hashlib
import random
from pathlib import Path
from typing import Any, Literal

import yaml
from pydantic import BaseModel, ConfigDict, Field, model_validator


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Source(StrictModel):
    path: str = "."
    revision: str | None = None
    artifact: str | None = None

    @model_validator(mode="after")
    def validate_kind(self) -> Source:
        if self.artifact and self.revision:
            raise ValueError("artifact and revision are mutually exclusive")
        return self


class Variant(StrictModel):
    source: Source = Field(default_factory=Source)
    model: str = Field(min_length=3, pattern=r"^[^/\s]+/\S+$")
    runtime: str = "core"
    agent: str = "synergy"
    variant: str | None = None
    config: str | None = None
    experiment: str | None = None
    env: dict[str, str] = Field(default_factory=dict)
    network_domains: list[str] = Field(default_factory=list)


class Selection(StrictModel):
    tasks: list[str] = Field(default_factory=list)
    tags: list[str] = Field(default_factory=list)
    limit: int | None = Field(default=None, gt=0)


class ExperimentConfig(StrictModel):
    version: Literal[1]
    suite: str
    variants: dict[str, Variant] = Field(min_length=1)
    selection: Selection = Field(default_factory=Selection)
    repeat: int = Field(default=1, gt=0)
    concurrency: int = Field(default=1, gt=0, le=64)
    seed: int = 0
    platform: Literal["linux/amd64", "linux/arm64"] = "linux/amd64"
    output: str = ".artifacts/benchmark/runs"
    cache: str = ".artifacts/benchmark/cache"
    cleanup_seconds: int = Field(default=60, ge=10, le=600)
    export_timeout_seconds: int = Field(default=300, ge=1, le=3600)
    preparation_timeout_seconds: int = Field(default=1800, ge=1, le=7200)
    timeout_seconds: int | None = Field(default=None, gt=0)

    @model_validator(mode="after")
    def validate_names(self) -> ExperimentConfig:
        for name in self.variants:
            if not name or any(
                c not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-" for c in name
            ):
                raise ValueError("Variant names must contain only letters, digits, underscores or hyphens")
        return self


def load_config(path: Path) -> ExperimentConfig:
    return ExperimentConfig.model_validate(yaml.safe_load(path.read_text()))


def resolve_plan(config: ExperimentConfig, tasks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    ids = [task["id"] for task in tasks]
    if len(set(ids)) != len(ids):
        raise ValueError("Duplicate task IDs")
    missing = set(config.selection.tasks) - set(ids)
    if missing:
        raise ValueError(f"Unknown tasks: {sorted(missing)}")
    selected = sorted(
        (
            task
            for task in tasks
            if (not config.selection.tasks or task["id"] in config.selection.tasks)
            and (not config.selection.tags or set(config.selection.tags) <= set(task.get("tags", [])))
        ),
        key=lambda task: task["id"],
    )
    if config.selection.limit:
        selected = selected[: config.selection.limit]
    if not selected:
        raise ValueError("No tasks matched the selection")
    pairs = [(task, repeat) for repeat in range(config.repeat) for task in selected]
    rng = random.Random(config.seed)
    rng.shuffle(pairs)
    variants = list(config.variants)
    offsets = [index % len(variants) for index in range(len(pairs))]
    rng.shuffle(offsets)
    plan = []
    for (task, repeat), offset in zip(pairs, offsets, strict=True):
        pair = hashlib.sha256(f"{task['id']}:{repeat}".encode()).hexdigest()[:16]
        order = variants[offset:] + variants[:offset]
        for name in order:
            plan.append({"pair": pair, "task": task["id"], "repeat": repeat, "variant": name})
    return plan
