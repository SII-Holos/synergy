import math
from typing import Any, Literal

from pydantic import Field

from .config import StrictModel

PLAN_VERSION = 4
RESULT_VERSION: Literal[5] = 5


class FileEvidence(StrictModel):
    sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    bytes: int = Field(ge=0)


class Coverage(StrictModel):
    valid: bool
    issues: list[str]
    archive_valid: bool
    recording: Literal["complete", "partial", "failed", "unknown"]
    usage: Literal["complete", "partial", "unknown"]


class Cleanup(StrictModel):
    status: Literal["completed", "warning", "failed", "unknown"] = "unknown"
    resources_removed: bool | None = None
    issues: list[str] = Field(default_factory=list)


class AttemptResult(StrictModel):
    version: Literal[5] = RESULT_VERSION
    attempt_status: Literal["completed", "interrupted"] | None = None
    trial_directory: str | None = None
    execution: dict[str, Any] | None
    export: dict[str, Any] | None
    verifier: dict[str, Any] | None
    pier_exception: dict[str, Any] | None
    infrastructure_error: dict[str, Any] | None
    accounting: dict[str, Any] | None
    wire_usage: dict[str, Any] | None = None
    reconciliation: dict[str, Any] | None = None
    grading: dict[str, Any] = Field(default_factory=lambda: {"execution": "unknown", "functional_tests": "unknown"})
    stages: dict[str, Any] = Field(default_factory=dict)
    resources: dict[str, Any] = Field(default_factory=dict)
    cleanup: Cleanup = Field(default_factory=Cleanup)
    evidence: Coverage
    sidecar_files: dict[str, FileEvidence] = Field(default_factory=dict)
    files: dict[str, FileEvidence]


def native_reward(rewards: Any) -> float | None:
    if not isinstance(rewards, dict) or not rewards:
        return None
    reward = (
        rewards.get("reward") if "reward" in rewards else next(iter(rewards.values())) if len(rewards) == 1 else None
    )
    return (
        float(reward)
        if isinstance(reward, (int, float)) and not isinstance(reward, bool) and math.isfinite(reward)
        else None
    )


def require_current_plan(value: dict[str, Any]) -> None:
    if value.get("version") != PLAN_VERSION or value.get("result_version") != RESULT_VERSION:
        raise ValueError("Unsupported benchmark format; only the current plan and result versions are accepted")
