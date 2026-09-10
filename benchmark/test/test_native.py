import json
import os
from pathlib import Path

import pytest

from synergy_bench.prepare import BENCHMARK, command

pytestmark = pytest.mark.skipif(os.environ.get("SYNERGY_BENCH_DOCKER") != "1", reason="Explicit Linux binding test")


def test_compiled_watcher_survives_a_real_interrupted_poll(tmp_path: Path) -> None:
    owner = BENCHMARK.parent / "packages/runtime-local"
    command(["bun", str(owner / "script/build-watcher.ts"), "--arch", "x64"], tmp_path / "build.log", timeout=900)
    binding = owner / ".artifacts/watcher/linux-x64-glibc"
    fixture = owner / "test/file/fixtures"
    observed = command(
        [
            "docker",
            "run",
            "--rm",
            "--platform",
            "linux/amd64",
            "-v",
            f"{fixture}:/fixture:ro",
            "-v",
            f"{binding}:/binding:ro",
            "-v",
            f"{tmp_path}:/test",
            "node:22.14.0-bullseye",
            "sh",
            "-c",
            "gcc -shared -fPIC /fixture/watcher-interrupt.c -ldl -lrt -o /test/interrupt.so && "
            "WATCHER_INTERRUPTED=/test/signal LD_PRELOAD=/test/interrupt.so "
            "node /fixture/watcher-interrupt.cjs /binding/watcher.node /test/files",
        ],
        timeout=90,
    )
    assert json.loads(observed) == {"poll": "EINTR", "event": "observed", "patch": "parcel-2.5.6-eintr-1"}
