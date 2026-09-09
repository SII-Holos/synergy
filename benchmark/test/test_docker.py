import os
import shutil
from pathlib import Path

import pytest
import yaml

from synergy_bench.catalog import tree_digest
from synergy_bench.prepare import BENCHMARK
from synergy_bench.runner import initialize, resume
from synergy_bench.source import git
from synergy_bench.storage import atomic_json, read_json

pytestmark = pytest.mark.skipif(
    os.environ.get("SYNERGY_BENCH_DOCKER") != "1", reason="Explicit Docker integration suite"
)


def test_real_synergy_paired_rollout(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import asyncio

    dataset = tmp_path / "dataset"
    shutil.copytree(BENCHMARK / "test/fixtures/task", dataset / "tasks/fixture")
    git(dataset, "init", "--quiet")
    git(dataset, "add", ".")
    git(
        dataset,
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.test",
        "commit",
        "--quiet",
        "-m",
        "fixture",
    )
    commit = git(dataset, "rev-parse", "HEAD").decode().strip()
    atomic_json(
        tmp_path / "suite.json",
        {
            "version": 1,
            "name": "fixture",
            "selection": "deterministic transport test",
            "sources": {"fixture": {"url": str(dataset), "commit": commit, "license": "test fixture"}},
            "tasks": [
                {
                    "id": "fixture/marker",
                    "source": "fixture",
                    "path": "tasks/fixture",
                    "digest": tree_digest(dataset / "tasks/fixture"),
                    "tags": [],
                    "agent_seconds": 90,
                    "verifier_seconds": 30,
                }
            ],
        },
    )
    atomic_json(
        tmp_path / "provider.json",
        {
            "execution": {"agentWorkers": 1, "agentWorkerMinIdle": 0},
            "provider": {
                "fixture": {
                    "name": "Fixture",
                    "npm": "@ai-sdk/openai-compatible",
                    "env": [],
                    "models": {
                        "fixture": {"name": "Fixture", "tool_call": True, "limit": {"context": 128000, "output": 4096}}
                    },
                    "options": {"apiKey": "{env:BENCH_FIXTURE_KEY}", "baseURL": "http://127.0.0.1:8087/v1"},
                }
            },
        },
    )
    variant = {
        "source": {"artifact": os.environ["SYNERGY_BENCH_TEST_ARTIFACT"]}
        if os.environ.get("SYNERGY_BENCH_TEST_ARTIFACT")
        else {"path": str(BENCHMARK.parent)},
        "runtime": "core",
        "model": "fixture/fixture",
        "config": "provider.json",
        "env": {"BENCH_FIXTURE_KEY": "BENCH_FIXTURE_KEY"},
    }
    config = {
        "version": 1,
        "suite": "suite.json",
        "cache": str(BENCHMARK.parent / ".artifacts/benchmark/cache"),
        "output": str(BENCHMARK.parent / ".artifacts/benchmark/integration"),
        "variants": {"A": variant, "B": variant},
    }
    path = tmp_path / "experiment.yaml"
    path.write_text(yaml.safe_dump(config))
    monkeypatch.setenv("BENCH_FIXTURE_KEY", "deterministic-local-fixture")
    root = initialize(path)
    print(f"Integration evidence: {root}", flush=True)
    asyncio.run(resume(root))
    evidence = [read_json(file) for file in root.glob("trials/*/attempt-*/evidence.json")]
    assert len(evidence) == 2
    assert all(result["execution"] and result["execution"]["exit_code"] == 0 for result in evidence), evidence
    assert all(result["verifier"]["rewards"] == {"reward": 1.0} for result in evidence), evidence
    assert all(result["evidence"]["complete"] for result in evidence), evidence
    assert all(result["accounting"]["tokens"]["cacheRead"]["total"] > 0 for result in evidence), evidence
    asyncio.run(resume(root))
    assert len(list(root.glob("trials/*/attempt-*/evidence.json"))) == 2
