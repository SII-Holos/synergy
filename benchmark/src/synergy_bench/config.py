from __future__ import annotations

import hashlib
import math
import random
import re
from pathlib import Path
from typing import Annotated, Any, Literal
from urllib.parse import urlsplit

import yaml
from pydantic import BaseModel, ConfigDict, Field, StrictBool, model_validator


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


HarnessKind = Literal["synergy", "codex", "opencode", "pi", "deepseek"]
MODEL_PARAMETERS = {
    "temperature",
    "top_p",
    "seed",
    "stop",
    "frequency_penalty",
    "presence_penalty",
    "reasoning_effort",
    "thinking",
    "tool_stream",
    "reasoning",
}


class ModelProfile(StrictModel):
    model: str = Field(min_length=1, pattern=r"^\S+$")
    protocol: Literal["chat-completions", "responses"]
    base_url: str
    api_key_env: str = Field(pattern=r"^[A-Za-z_][A-Za-z0-9_]*$")
    context_window: int = Field(gt=0)
    max_output_tokens: int = Field(gt=0)
    supports_developer_role: bool = True
    merge_system_messages: bool = False
    parameters: dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode="after")
    def validate_model(self) -> ModelProfile:
        url = urlsplit(self.base_url)
        if url.scheme not in {"http", "https"} or not url.hostname:
            raise ValueError("Model base_url must be an HTTP(S) endpoint")
        if url.username or url.password or url.query or url.fragment:
            raise ValueError("Model endpoint must not contain credentials, query or fragment")
        if self.max_output_tokens >= self.context_window:
            raise ValueError("Model output budget must be smaller than its context window")
        reserved = {"model", "messages", "input", "tools", "stream", "stream_options", "api_key", "headers"}
        if reserved & self.parameters.keys():
            raise ValueError("Model parameters cannot override transport, messages or credentials")
        common = {"temperature", "top_p"}
        allowed = common | (
            {
                "seed",
                "stop",
                "frequency_penalty",
                "presence_penalty",
                "reasoning_effort",
                "thinking",
                "tool_stream",
                "chat_template_kwargs",
            }
            if self.protocol == "chat-completions"
            else {"reasoning"}
        )
        if self.parameters.keys() - allowed:
            raise ValueError(f"Unsupported model parameters: {sorted(self.parameters.keys() - allowed)}")
        for key, bounds in {
            "temperature": (0, 2),
            "top_p": (0, 1),
            "frequency_penalty": (-2, 2),
            "presence_penalty": (-2, 2),
        }.items():
            if key in self.parameters:
                value = self.parameters[key]
                if type(value) not in {int, float} or not math.isfinite(value) or not bounds[0] <= value <= bounds[1]:
                    raise ValueError(f"Invalid {key} parameter")
        if "seed" in self.parameters and type(self.parameters["seed"]) is not int:
            raise ValueError("Model seed must be an integer")
        if "tool_stream" in self.parameters and type(self.parameters["tool_stream"]) is not bool:
            raise ValueError("tool_stream must be a boolean")
        if "stop" in self.parameters:
            stop = self.parameters["stop"]
            if not isinstance(stop, str) and not (
                isinstance(stop, list) and 1 <= len(stop) <= 4 and all(isinstance(value, str) for value in stop)
            ):
                raise ValueError("stop must be a string or one to four strings")
        if "reasoning_effort" in self.parameters and self.parameters["reasoning_effort"] not in (
            "none",
            "minimal",
            "low",
            "medium",
            "high",
            "xhigh",
            "max",
        ):
            raise ValueError("Unsupported reasoning_effort")
        for key, keys in {"thinking": {"type", "clear_thinking"}, "reasoning": {"effort", "summary"}}.items():
            if key not in self.parameters:
                continue
            value = self.parameters[key]
            if not isinstance(value, dict) or value.keys() - keys:
                raise ValueError(f"Unsupported {key} parameters")
            if key == "thinking" and (
                value.get("type") not in ("enabled", "disabled")
                or ("clear_thinking" in value and type(value["clear_thinking"]) is not bool)
            ):
                raise ValueError("Invalid thinking parameters")
            if key == "reasoning" and (
                value.get("effort", "medium") not in ("none", "minimal", "low", "medium", "high", "xhigh", "max")
                or value.get("summary", "auto") not in ("auto", "concise", "detailed")
            ):
                raise ValueError("Invalid reasoning parameters")
        if "chat_template_kwargs" in self.parameters:
            value = self.parameters["chat_template_kwargs"]
            if not isinstance(value, dict) or value.keys() - {"enable_thinking", "thinking_budget"}:
                raise ValueError("Invalid chat_template_kwargs parameters")
            if "enable_thinking" in value and type(value["enable_thinking"]) is not bool:
                raise ValueError("Invalid chat_template_kwargs enable_thinking")
            if "thinking_budget" in value and (
                type(value["thinking_budget"]) is not int or value["thinking_budget"] < 0
            ):
                raise ValueError("Invalid chat_template_kwargs thinking_budget")
        return self


class HarnessProfile(StrictModel):
    kind: HarnessKind
    source: Source = Field(default_factory=Source)
    package_version: str | None = Field(default=None, pattern=r"^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$")
    runtime: str = "core"
    agent: str = "synergy"
    config: str | None = None
    experiment: str | None = None
    bun_jit: StrictBool | None = None
    merge_system_messages: StrictBool | None = None
    strip_reasoning: StrictBool | None = None

    @model_validator(mode="after")
    def validate_native_options(self) -> HarnessProfile:
        if self.bun_jit is not None and self.kind != "opencode":
            raise ValueError("bun_jit is supported only for opencode")
        if self.merge_system_messages is not None and self.kind != "synergy":
            raise ValueError("merge_system_messages is supported only for synergy")
        if self.strip_reasoning is not None and self.kind != "synergy":
            raise ValueError("strip_reasoning is supported only for synergy")
        if self.kind != "synergy":
            if self.config or self.experiment or self.runtime != "core" or self.agent != "synergy":
                raise ValueError("Native harness config, experiment, runtime or agent override is unsupported")
            if self.source.revision or (not self.source.artifact and self.source.path != "."):
                raise ValueError("Native harness source requires a pinned package version or prepared artifact")
        return self


class Combination(StrictModel):
    harness: str
    model: str


class Matrix(StrictModel):
    include: list[Combination] = Field(default_factory=list)
    exclude: list[Combination] = Field(default_factory=list)


class Resources(StrictModel):
    max_concurrency: int = Field(default=8, ge=1, le=64)
    build_concurrency: int = Field(default=2, ge=1, le=16)
    reserve_cpus: float = Field(default=2, ge=0)
    reserve_memory_gib: float = Field(default=2, ge=0)
    reserve_memory_fraction: float = Field(default=0.15, ge=0, lt=1)
    min_free_disk_gib: float = Field(default=20, ge=0)
    cache_budget_gib: float = Field(default=32, gt=0)


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
    harness: HarnessKind = "synergy"
    harness_key: str | None = None
    model_key: str | None = None
    model_profile: ModelProfile | None = None
    package_version: str | None = None
    bun_jit: StrictBool | None = None
    merge_system_messages: StrictBool | None = None
    strip_reasoning: StrictBool | None = None


class Selection(StrictModel):
    tasks: list[str] = Field(default_factory=list)
    tags: list[str] = Field(default_factory=list)
    limit: int | None = Field(default=None, gt=0)


class ExperimentConfig(StrictModel):
    version: Literal[1, 2]
    suite: str
    variants: dict[str, Variant] = Field(default_factory=dict)
    harnesses: dict[str, HarnessProfile] = Field(default_factory=dict)
    models: dict[str, ModelProfile] = Field(default_factory=dict)
    matrix: Matrix = Field(default_factory=Matrix)
    resources: Resources = Field(default_factory=Resources)
    selection: Selection = Field(default_factory=Selection)
    repeat: int = Field(default=1, gt=0)
    task_repeats: dict[str, Annotated[int, Field(gt=0)]] = Field(default_factory=dict)
    concurrency: Literal["auto"] | int = "auto"
    seed: int = 0
    platform: Literal["linux/amd64", "linux/arm64"] = "linux/amd64"
    output: str = ".artifacts/benchmark/runs"
    cache: str = ".artifacts/benchmark/cache"
    cleanup_seconds: int = Field(default=60, ge=10, le=600)
    export_timeout_seconds: int = Field(default=300, ge=1, le=3600)
    preparation_timeout_seconds: int = Field(default=1800, ge=1, le=7200)
    startup_timeout_seconds: int = Field(default=120, ge=1, le=1800)
    timeout_seconds: int | None = Field(default=None, gt=0)

    @model_validator(mode="after")
    def validate_names(self) -> ExperimentConfig:
        if self.concurrency != "auto" and not 1 <= self.concurrency <= 64:
            raise ValueError("Concurrency must be auto or an integer from 1 to 64")
        for name in self.variants.keys() | self.harnesses.keys() | self.models.keys():
            if not re.fullmatch(r"[A-Za-z0-9_-]+", name):
                raise ValueError("Names must contain only letters, digits, underscores or hyphens")
        if self.version == 1:
            if not self.variants or self.harnesses or self.models or self.matrix != Matrix():
                raise ValueError("Version 1 requires variants; use version 2 for an independent matrix")
            return self
        if not self.harnesses or not self.models:
            raise ValueError("Version 2 requires harnesses and models")
        for cell in self.matrix.include + self.matrix.exclude:
            if cell.harness not in self.harnesses:
                raise ValueError(f"Unknown harness: {cell.harness}")
            if cell.model not in self.models:
                raise ValueError(f"Unknown model: {cell.model}")
        selected = self.matrix.include or [
            Combination(harness=harness, model=model) for harness in self.harnesses for model in self.models
        ]
        excluded = {(cell.harness, cell.model) for cell in self.matrix.exclude}
        resolved = {}
        for cell in selected:
            if (cell.harness, cell.model) in excluded:
                continue
            harness = self.harnesses[cell.harness]
            model = self.models[cell.model]
            key = f"{cell.harness}__{cell.model}"
            if key in resolved:
                raise ValueError("Duplicate matrix combination")
            resolved[key] = Variant(
                source=harness.source,
                model=f"benchmark/{model.model}",
                runtime=harness.runtime,
                agent=harness.agent,
                config=harness.config,
                experiment=harness.experiment,
                env={model.api_key_env: model.api_key_env},
                network_domains=[str(urlsplit(model.base_url).hostname)],
                harness=harness.kind,
                harness_key=cell.harness,
                model_key=cell.model,
                model_profile=model,
                package_version=harness.package_version,
                bun_jit=harness.bun_jit,
                merge_system_messages=harness.merge_system_messages,
                strip_reasoning=harness.strip_reasoning,
            )
        if not resolved:
            raise ValueError("No matrix combinations selected")
        if self.variants and self.variants != resolved:
            raise ValueError("Resolved variants disagree with the matrix")
        self.variants = resolved
        return self


def load_config(path: Path) -> ExperimentConfig:
    try:
        content = path.read_text()
    except OSError as error:
        raise ValueError(f"Unable to read experiment configuration: {path}") from error
    try:
        value = yaml.safe_load(content)
    except yaml.YAMLError as error:
        raise ValueError("Invalid experiment YAML") from error
    return ExperimentConfig.model_validate(value)


def resolve_plan(config: ExperimentConfig, tasks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    ids = [task["id"] for task in tasks]
    if len(set(ids)) != len(ids):
        raise ValueError("Duplicate task IDs")
    if set(config.task_repeats) - set(ids):
        raise ValueError("Unknown task in task repeat overrides")
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
    groups: dict[str, list[str]] = {}
    for name, variant in config.variants.items():
        groups.setdefault(variant.model_key or variant.model, []).append(name)
    pairs = [
        (task, repeat, model)
        for repeat in range(max([config.repeat, *config.task_repeats.values()]))
        for task in selected
        if repeat < config.task_repeats.get(task["id"], config.repeat)
        for model in groups
    ]
    rng = random.Random(config.seed)
    rng.shuffle(pairs)
    plan = []
    offsets = {model: 0 for model in groups}
    for task, repeat, model in pairs:
        variants = groups[model]
        offset = offsets[model] % len(variants)
        offsets[model] += 1
        pair = hashlib.sha256(f"{task['id']}:{repeat}:{model}".encode()).hexdigest()[:16]
        order = variants[offset:] + variants[:offset]
        for name in order:
            variant = config.variants[name]
            plan.append(
                {
                    "pair": pair,
                    "task": task["id"],
                    "repeat": repeat,
                    "variant": name,
                    "harness": variant.harness_key or name,
                    "model": variant.model_key or variant.model,
                }
            )
    return plan


def normalize_legacy(
    value: dict[str, Any], models: dict[str, Any], bindings: dict[str, str], base: Path
) -> dict[str, Any]:
    legacy = ExperimentConfig.model_validate(value)
    if legacy.version != 1:
        raise ValueError("Only version 1 configurations require normalization")
    harnesses = {}
    combinations = []
    for name, variant in legacy.variants.items():
        if variant.model not in bindings or bindings[variant.model] not in models:
            raise ValueError(f"Explicit model binding required for {variant.model}")
        if variant.variant is not None:
            raise ValueError("Move legacy sampling variants into explicit model profiles before normalization")
        source = variant.source.model_dump()
        for field in ["path", "artifact"]:
            if source.get(field):
                source[field] = str((base / source[field]).resolve())
        harnesses[name] = {
            "kind": variant.harness,
            "source": source,
            "runtime": variant.runtime,
            "agent": variant.agent,
            "package_version": variant.package_version,
            **{
                field: str((base / file).resolve())
                for field in ["config", "experiment"]
                if (file := getattr(variant, field))
            },
        }
        combinations.append({"harness": name, "model": bindings[variant.model]})
    result = {
        key: item
        for key, item in legacy.model_dump().items()
        if key not in {"variants", "harnesses", "models", "matrix"}
    }
    for field in ["suite", "cache", "output"]:
        result[field] = str((base / result[field]).resolve())
    result.update(version=2, harnesses=harnesses, models=models, matrix={"include": combinations})
    normalized = ExperimentConfig.model_validate(result).model_dump()
    normalized.pop("variants")
    return normalized
