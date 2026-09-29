import asyncio
import time
from types import SimpleNamespace

import pytest

from synergy_bench import lifecycle as lifecycle_module
from synergy_bench.lifecycle import Lifecycle
from synergy_bench.storage import read_json


async def test_resource_queue_does_not_consume_nested_stage_deadlines(tmp_path, monkeypatch):
    from synergy_bench.lifecycle import pause_deadlines

    loop = asyncio.get_running_loop()
    now = loop.time()
    monkeypatch.setattr(loop, "time", lambda: now)
    monkeypatch.setattr(lifecycle_module, "time", SimpleNamespace(monotonic=lambda: now, time=time.time))
    lifecycle = Lifecycle(tmp_path)
    async with lifecycle.stage("preparation", deadline=10):
        async with lifecycle.stage("build", deadline=10):
            now += 1
            with pause_deadlines():
                now += 60
                await asyncio.sleep(0)
                await asyncio.sleep(0)
            now += 2
            await asyncio.sleep(0)
            await asyncio.sleep(0)
    stages = read_json(tmp_path / "stages.json")
    for name in ("preparation", "build"):
        stage = stages[name][0]
        assert stage["status"] == "completed"
        assert stage["queue_seconds"] == pytest.approx(60)
        assert stage["active_seconds"] == pytest.approx(3)
        assert stage["wall_seconds"] == pytest.approx(63)


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
