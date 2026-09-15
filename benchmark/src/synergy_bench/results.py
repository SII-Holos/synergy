import math
from typing import Any, Literal

from pydantic import Field

from .config import StrictModel

RESULT_VERSION: Literal[3] = 3


class FileEvidence(StrictModel):
    sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    bytes: int = Field(ge=0)


class Coverage(StrictModel):
    valid: bool
    issues: list[str]
    archive_valid: bool
    recording: Literal["complete", "partial", "failed", "unknown"]
    usage: Literal["complete", "partial", "unknown"]


class AttemptResult(StrictModel):
    version: Literal[3] = RESULT_VERSION
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
