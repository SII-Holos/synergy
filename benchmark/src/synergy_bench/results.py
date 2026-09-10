from typing import Any, Literal

from pydantic import Field

from .config import StrictModel

RESULT_VERSION: Literal[2] = 2


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
    version: Literal[2] = RESULT_VERSION
    attempt_status: Literal["completed", "interrupted"] | None = None
    trial_directory: str | None = None
    execution: dict[str, Any] | None
    export: dict[str, Any] | None
    verifier: dict[str, Any] | None
    pier_exception: dict[str, Any] | None
    infrastructure_error: dict[str, Any] | None
    accounting: dict[str, Any] | None
    evidence: Coverage
    files: dict[str, FileEvidence]
