import asyncio

import pytest

from synergy_bench.lifecycle import Lifecycle
from synergy_bench.storage import read_json


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
