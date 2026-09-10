from pathlib import Path

import pytest

from synergy_bench.runner import execute_plan
from synergy_bench.storage import atomic_json, read_json


@pytest.mark.asyncio
async def test_resume_preserves_completed_trials_and_restarts_interrupted_attempts(tmp_path: Path) -> None:
    plan = {"schedule": [{"task": "s/t", "variant": "A", "pair": "p", "repeat": 0}], "concurrency": 1}
    atomic_json(tmp_path / "state.json", {"trials": {"0000": {"status": "interrupted", "attempt": 1}}})
    called = []

    async def execute(item: dict, attempt: Path) -> dict:
        called.append(attempt)
        return {"execution": {"outcome": "failed"}}

    await execute_plan(tmp_path, plan, execute)
    await execute_plan(tmp_path, plan, execute)
    assert len(called) == 1
    assert called[0].name == "attempt-002"
    state = read_json(tmp_path / "state.json")
    assert state["trials"]["0000"]["status"] == "completed"


@pytest.mark.asyncio
async def test_trial_failure_does_not_drop_other_pairs(tmp_path: Path) -> None:
    plan = {"schedule": [{"pair": "p", "variant": "A"}, {"pair": "p", "variant": "B"}], "concurrency": 1}

    async def execute(item: dict, attempt: Path) -> dict:
        if item["variant"] == "A":
            raise ValueError("test infrastructure error")
        return {"execution": {"outcome": "completed"}}

    await execute_plan(tmp_path, plan, execute)
    state = read_json(tmp_path / "state.json")
    assert len(state["trials"]) == 2
    assert all(trial["status"] == "completed" for trial in state["trials"].values())
    assert read_json(tmp_path / "trials/0000/attempt-001/evidence.json")["infrastructure_error"]["type"] == "ValueError"


@pytest.mark.asyncio
async def test_cancellation_preserves_evidence_and_marks_attempt_interrupted(tmp_path: Path) -> None:
    import asyncio

    started = asyncio.Event()
    plan = {"schedule": [{"pair": "p", "variant": "A"}], "concurrency": 1}

    async def execute(item: dict, attempt: Path) -> dict:
        (attempt / "partial.log").write_text("retained")
        started.set()
        await asyncio.Future()
        return {}

    running = asyncio.create_task(execute_plan(tmp_path, plan, execute))
    await started.wait()
    running.cancel()
    with pytest.raises(asyncio.CancelledError):
        await running
    assert read_json(tmp_path / "state.json")["trials"]["0000"]["status"] == "interrupted"
    assert (tmp_path / "trials/0000/attempt-001/partial.log").read_text() == "retained"


@pytest.mark.asyncio
async def test_terminal_evidence_repairs_interrupted_state_without_paid_execution(tmp_path: Path) -> None:
    plan = {"schedule": [{"pair": "p", "variant": "A"}], "concurrency": 1}
    atomic_json(tmp_path / "state.json", {"trials": {"0000": {"status": "interrupted", "attempt": 1}}})
    atomic_json(
        tmp_path / "trials/0000/attempt-001/evidence.json",
        {"version": 2, "attempt_status": "completed", "execution": {"outcome": "failed"}},
    )

    async def execute(item: dict, attempt: Path) -> dict:
        pytest.fail("terminal attempts must not call the model again")

    await execute_plan(tmp_path, plan, execute)
    assert read_json(tmp_path / "state.json")["trials"]["0000"] == {"status": "completed", "attempt": 1}


def test_changed_terminal_bytes_are_not_rescheduled(tmp_path: Path) -> None:
    import hashlib

    from synergy_bench.runner import verify_terminal

    file = tmp_path / "owned/agent/events.jsonl"
    file.parent.mkdir(parents=True)
    file.write_bytes(b"original")
    evidence = {
        "version": 2,
        "trial_directory": "owned",
        "files": {"agent/events.jsonl": {"bytes": 8, "sha256": hashlib.sha256(b"original").hexdigest()}},
    }
    evidence.update(
        execution=None,
        export=None,
        verifier=None,
        pier_exception=None,
        infrastructure_error=None,
        accounting=None,
        evidence={"valid": True, "issues": [], "archive_valid": True, "recording": "complete", "usage": "complete"},
    )
    verify_terminal(tmp_path, evidence)
    file.write_bytes(b"modified")
    with pytest.raises(ValueError, match="hash changed"):
        verify_terminal(tmp_path, evidence)
