import asyncio
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


@pytest.fixture(scope="module")
def prepared_fixture(tmp_path_factory: pytest.TempPathFactory):
    tmp_path = tmp_path_factory.mktemp("docker-benchmark")
    dataset = tmp_path / "dataset"
    shutil.copytree(BENCHMARK / "test/fixtures/task", dataset / "tasks/fixture")
    separate = dataset / "tasks/separate"
    shutil.copytree(BENCHMARK / "test/fixtures/task", separate)
    definition = (separate / "task.toml").read_text()
    definition = 'artifacts = ["/logs/artifacts/marker"]\n' + definition
    definition = definition.replace('name = "synergy/fixture"', 'name = "synergy/separate"')
    definition = definition.replace("[verifier]\n", '[verifier]\nenvironment_mode = "separate"\n')
    definition += (
        "\n[[verifier.collect]]\n"
        'command = "mkdir -p /logs/artifacts && cp /app/marker /logs/artifacts/marker"\ntimeout_sec = 10\n'
    )
    (separate / "task.toml").write_text(definition)
    (separate / "tests/test.sh").write_text(
        "#!/bin/sh\nmkdir -p /logs/verifier\n"
        'if test ! -f /app/marker && test "$(cat /logs/artifacts/marker)" = verified; then\n'
        "echo 1 > /logs/verifier/reward.txt\nelse\necho 0 > /logs/verifier/reward.txt\nfi\n"
    )
    (separate / "tests/Dockerfile").write_text(
        "FROM python:3.12-slim-bookworm\nWORKDIR /app\nCOPY test.sh /tests/test.sh\n"
    )
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
            ]
            + [
                {
                    "id": "fixture/separate",
                    "source": "fixture",
                    "path": "tasks/separate",
                    "digest": tree_digest(separate),
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
                        name: {"name": name, "tool_call": True, "limit": {"context": 128000, "output": 4096}}
                        for name in ["fixture", "hang", "disconnect", "long"]
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
    library_config = read_json(tmp_path / "provider.json")
    library_config["embedding"] = {
        "apiKey": "{env:BENCH_FIXTURE_KEY}",
        "baseURL": "http://127.0.0.1:8087/v1",
        "model": "fixture-embedding",
    }
    atomic_json(tmp_path / "library.json", library_config)
    config = {
        "version": 1,
        "suite": "suite.json",
        "cache": str(BENCHMARK.parent / ".artifacts/benchmark/cache"),
        "output": str(BENCHMARK.parent / ".artifacts/benchmark/integration"),
        "variants": {
            "A": variant,
            "B": variant,
            "library": {**variant, "runtime": "core-library", "config": "library.json"},
            "full": {**variant, "runtime": "full", "config": "library.json"},
        },
    }
    path = tmp_path / "experiment.yaml"
    path.write_text(yaml.safe_dump(config))
    with pytest.MonkeyPatch.context() as monkeypatch:
        monkeypatch.setenv("BENCH_FIXTURE_KEY", "deterministic-local-fixture")
        root = initialize(path)
        print(f"Integration evidence: {root}", flush=True)
        yield root, path


def test_real_synergy_paired_rollout(prepared_fixture) -> None:
    root, _ = prepared_fixture
    asyncio.run(resume(root))
    evidence = [read_json(file) for file in root.glob("trials/*/attempt-*/evidence.json")]
    assert len(evidence) == 8
    assert all(result["execution"] and result["execution"]["exit_code"] == 0 for result in evidence), evidence
    assert all(result["verifier"]["rewards"] == {"reward": 1.0} for result in evidence), evidence
    assert all(result["evidence"]["valid"] for result in evidence), evidence
    assert all(result["accounting"]["tokens"]["cacheRead"]["total"] > 0 for result in evidence), evidence
    assert_retained_credentials_absent(root)
    asyncio.run(resume(root))
    assert len(list(root.glob("trials/*/attempt-*/evidence.json"))) == 8


def assert_retained_credentials_absent(root: Path) -> None:
    import zipfile

    sentinel = b"deterministic-local-fixture"
    for evidence_file in root.glob("trials/*/attempt-*/evidence.json"):
        evidence = read_json(evidence_file)
        trial = evidence_file.parent / evidence["trial_directory"]
        for name in evidence["files"]:
            file = trial / name
            assert sentinel not in file.read_bytes(), name
            if file.suffix == ".zip":
                with zipfile.ZipFile(file) as archive:
                    for item in archive.infolist():
                        assert sentinel not in archive.read(item), item.filename


def primary_attempts(root: Path):
    for call in root.glob("trials/*/attempt-*/*/agent/home/.synergy/data/sessions/*/*/rollout/runs/*/calls/*.json"):
        if read_json(call)["purpose"] == "synergy":
            for attempt in (call.parent.parent / "attempts" / call.stem).glob("*.json"):
                yield read_json(attempt)


@pytest.mark.parametrize("mode", ["long", "disconnect", "timeout", "cancel", "docker-stop"])
def test_faults_preserve_terminal_evidence_and_cleanup(prepared_fixture, mode: str) -> None:
    from synergy_bench.prepare import command

    original, path = prepared_fixture
    config = yaml.safe_load(path.read_text())
    artifact = read_json(original / "plan.json")["variants"]["A"]["artifact"]
    variant = config["variants"]["A"]
    variant["source"] = {"artifact": artifact}
    variant["model"] = "fixture/" + ("hang" if mode in {"timeout", "cancel", "docker-stop"} else mode)
    config["variants"] = {mode: variant}
    config["selection"] = {"tasks": ["fixture/marker"]}
    if mode == "timeout":
        config["timeout_seconds"] = 15
    fault = path.with_name(f"{mode}.yaml")
    fault.write_text(yaml.safe_dump(config))
    root = initialize(fault)
    print(f"Fault injection ({mode}): {root}", flush=True)

    async def run() -> None:
        execution = asyncio.create_task(resume(root))
        if mode not in {"disconnect", "cancel", "docker-stop"}:
            await execution
            return
        try:
            async with asyncio.timeout(180):
                while not any(
                    (attempt.get("response") or {}).get("bytes", 0) > 0 for attempt in primary_attempts(root)
                ):
                    if execution.done():
                        await execution
                        pytest.fail("Primary provider response was never recorded")
                    await asyncio.sleep(0.05)
            if mode == "disconnect":
                marker = next(root.glob("trials/*/attempt-*/*/artifacts/provider-started"))
                marker.with_name("disconnect-release").touch()
                await execution
                return
            if mode == "cancel":
                execution.cancel()
                with pytest.raises(asyncio.CancelledError):
                    await execution
                return
            environment = next(root.glob("trials/*/attempt-*/environment.json"))
            project = read_json(environment)["project"]
            containers = await asyncio.to_thread(
                command, ["docker", "ps", "-q", "--filter", f"label=com.docker.compose.project={project}"]
            )
            assert len(containers.splitlines()) == 1
            await asyncio.to_thread(command, ["docker", "kill", containers.strip()])
            await execution
        finally:
            if not execution.done():
                execution.cancel()
                await asyncio.gather(execution, return_exceptions=True)

    asyncio.run(run())
    file = next(root.glob("trials/*/attempt-*/evidence.json"))
    result = read_json(file)
    if mode == "docker-stop":
        assert result["evidence"]["valid"] is False
        assert result["evidence"]["issues"]
    else:
        assert result["evidence"]["valid"], result
        assert result["export"]["status"] == "completed", result
        assert result["evidence"]["archive_valid"]
        if mode == "long":
            assert result["execution"]["outcome"] == "completed", result
            assert result["verifier"]["rewards"] == {"reward": 1.0}
            assert result["evidence"]["recording"] == "complete"
        else:
            assert result["execution"]["outcome"] in {"failed", "timeout", "cancelled"}, result
            assert result["evidence"]["recording"] == "partial", result
            assert result["accounting"]["tokens"]["input"]["unknown"] > 0, result
            attempts = list(primary_attempts(root))
            assert any((attempt.get("response") or {}).get("bytes", 0) > 0 for attempt in attempts), attempts
    assert_retained_credentials_absent(root)
    for resource in [["ps", "-a"], ["network", "ls"]]:
        projects = command(["docker", *resource, "--format", '{{.Label "com.docker.compose.project"}}'])
        assert not any(name.startswith(f"sb-{root.name[-8:]}-") for name in projects.splitlines())
    asyncio.run(resume(root))
    assert len(list(root.glob("trials/*/attempt-*/evidence.json"))) == 1
