import asyncio
import os
import sys

import pytest

from synergy_bench.process import run_process


async def test_cancellation_reaps_process_tree_and_retains_output(tmp_path):
    pid = tmp_path / "child.pid"
    script = (
        "import subprocess,time,pathlib; child=subprocess.Popen(['sleep','100']);pathlib.Path('"
        + str(pid)
        + "').write_text(str(child.pid));print('retained',flush=True);time.sleep(100)"
    )
    running = asyncio.create_task(
        run_process([sys.executable, "-c", script], log=tmp_path / "process.log", deadline=30)
    )
    async with asyncio.timeout(5):
        for _ in range(500):
            if pid.exists():
                break
            await asyncio.sleep(0.01)
        assert pid.exists()
    running.cancel()
    with pytest.raises(asyncio.CancelledError):
        await running
    assert (tmp_path / "process.log").read_text() == "retained\n"
    with pytest.raises(ProcessLookupError):
        os.kill(int(pid.read_text()), 0)


async def test_timeout_is_bounded_and_nonzero_exit_is_preserved(tmp_path):
    with pytest.raises(TimeoutError):
        await run_process(
            [sys.executable, "-c", "import time;time.sleep(10)"], log=tmp_path / "timeout.log", deadline=0.05
        )
    assert (
        await run_process([sys.executable, "-c", "raise SystemExit(7)"], log=tmp_path / "failed.log", deadline=1) == 7
    )


async def test_normal_exit_reaps_detached_children_in_owned_group(tmp_path):
    pid = tmp_path / "child.pid"
    script = (
        "import subprocess,pathlib;child=subprocess.Popen(['sleep','100']);pathlib.Path('"
        + str(pid)
        + "').write_text(str(child.pid))"
    )
    assert await run_process([sys.executable, "-c", script], log=tmp_path / "log", deadline=5) == 0
    await asyncio.sleep(0.05)
    with pytest.raises(ProcessLookupError):
        os.kill(int(pid.read_text()), 0)
