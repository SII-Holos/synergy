import asyncio

import pytest

from synergy_bench.lifecycle import Lifecycle
from synergy_bench.storage import read_json


async def test_resource_queue_does_not_consume_nested_stage_deadlines(tmp_path):
    from synergy_bench.lifecycle import pause_deadlines

    lifecycle = Lifecycle(tmp_path)
    async with lifecycle.stage("preparation", deadline=0.03):
        async with lifecycle.stage("build", deadline=0.03):
            with pause_deadlines():
                await asyncio.sleep(0.06)
    stages = read_json(tmp_path / "stages.json")
    assert stages["preparation"][0]["queue_seconds"] >= 0.06
    assert stages["build"][0]["active_seconds"] < 0.03


async def test_deadline_and_cancel_preserve_separate_phase_results(tmp_path):
    lifecycle = Lifecycle(tmp_path)
    async with lifecycle.stage("preparation", deadline=1):
        pass
    with pytest.raises(TimeoutError):
        async with lifecycle.stage("agent", deadline=0.01):
            await asyncio.sleep(10)
    async with lifecycle.stage("verifier", deadline=1):
        pass
    stages = read_json(tmp_path / "stages.json")
    assert stages["preparation"][0]["status"] == "completed"
    assert stages["agent"][0]["status"] == "timed_out"
    assert stages["verifier"][0]["status"] == "completed"
    with pytest.raises(asyncio.CancelledError):
        async with lifecycle.stage("export", deadline=1):
            raise asyncio.CancelledError()
    assert read_json(tmp_path / "stages.json")["export"][0]["status"] == "interrupted"


async def test_repeated_stage_is_retained_instead_of_overwritten(tmp_path):
    lifecycle = Lifecycle(tmp_path)
    for _ in range(2):
        async with lifecycle.stage("prepare", deadline=1):
            pass
    assert len(read_json(tmp_path / "stages.json")["prepare"]) == 2


async def test_failure_retains_cause_locations_without_exception_values(tmp_path):
    lifecycle = Lifecycle(tmp_path)
    with pytest.raises(ValueError):
        async with lifecycle.stage("prepare", deadline=1):
            try:
                raise RuntimeError("do-not-retain-credential")
            except RuntimeError as cause:
                raise ValueError("do-not-retain-credential") from cause
    content = (tmp_path / "stages.json").read_text()
    assert "do-not-retain-credential" not in content
    trace = read_json(tmp_path / "stages.json")["prepare"][0]["error_trace"]
    assert [entry["type"] for entry in trace] == ["ValueError", "RuntimeError"]
    assert all(
        entry["frames"][-1]["function"] == test_failure_retains_cause_locations_without_exception_values.__name__
        for entry in trace
    )
