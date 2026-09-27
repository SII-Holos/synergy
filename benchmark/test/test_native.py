import json
import os
import xml.etree.ElementTree as ET
from pathlib import Path

import pytest

from synergy_bench.prepare import BENCHMARK, command, verify_prepared

pytestmark = pytest.mark.skipif(os.environ.get("SYNERGY_BENCH_DOCKER") != "1", reason="Explicit Linux binding test")


def test_prepared_source_runs_owned_processes_without_a_runtime_compiler(tmp_path: Path) -> None:
    from synergy_bench.config import Source
    from synergy_bench.prepare import prepare_source, remove_owned_container

    prepared = os.environ.get("SYNERGY_BENCH_TEST_ARTIFACT")
    if prepared:
        artifact = Path(prepared)
    else:
        info = json.loads(command(["docker", "info", "--format", "{{json .}}"], timeout=30))
        platform = "linux/arm64" if info["Architecture"] in {"aarch64", "arm64"} else "linux/amd64"
        artifact = prepare_source(Source(path=str(BENCHMARK.parent)), BENCHMARK, tmp_path / "cache", platform)
    receipt = verify_prepared(artifact)
    container = tmp_path / "native-process.cid"
    try:
        command(
            [
                "docker",
                "run",
                "--rm",
                "--cidfile",
                str(container),
                "--network",
                "none",
                "--platform",
                receipt["identity"]["platform"],
                "-v",
                f"{artifact / 'bundle'}:/opt/synergy:ro",
                "-v",
                f"{tmp_path}:/test",
                "-w",
                "/opt/synergy/source/packages/local-runtime",
                "ubuntu:24.04",
                "sh",
                "-c",
                "! command -v cargo && ! command -v cc && "
                "/opt/synergy/bin/bun test --timeout 30000 --reporter=junit "
                "--reporter-outfile=/test/native-process.xml "
                "--test-name-pattern 'activation records ownership before any command runs' "
                "test/process/owned-process.test.ts",
            ],
            timeout=90,
        )
        cases = ET.parse(tmp_path / "native-process.xml").findall(".//testcase")
        checked = [case for case in cases if case.get("name", "").startswith("activation records ownership")]
        assert len(checked) == 1
        assert not any(checked[0].find(tag) is not None for tag in ["failure", "error", "skipped"])
    finally:
        remove_owned_container(container)


def test_compiled_watcher_survives_a_real_interrupted_poll(tmp_path: Path) -> None:
    prepared = os.environ.get("SYNERGY_BENCH_TEST_ARTIFACT")
    if prepared:
        artifact = Path(prepared)
        verify_prepared(artifact)
        owner = artifact / "bundle/source/packages/local-runtime"
    else:
        owner = BENCHMARK.parent / "packages/local-runtime"
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
