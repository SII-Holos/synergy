import json
import os
from pathlib import Path

import pytest

from synergy_bench import recovery
from synergy_bench.prepare import command
from synergy_bench.storage import atomic_json, read_json


@pytest.mark.skipif(os.environ.get("SYNERGY_BENCH_DOCKER") != "1", reason="Explicit recovery Docker contract")
@pytest.mark.parametrize("exit_code", [0, 7])
def test_recovery_hands_private_files_back_without_changing_original(
    tmp_path: Path, monkeypatch, exit_code: int
) -> None:
    artifact = tmp_path / "artifact"
    executable = artifact / "bundle/bin/bun"
    executable.parent.mkdir(parents=True)
    status = "completed" if exit_code == 0 else "failed"
    executable.write_text(
        "#!/bin/sh\npython3 - <<'PY'\n"
        "import json, os\n"
        "from pathlib import Path\n"
        "os.umask(0o077)\n"
        f"Path('/recovery/output/export.json').write_text(json.dumps({{'status': {status!r}}}))\n"
        "Path('/recovery/home/export-marker').write_text('copied home only')\n"
        f"PY\nexit {exit_code}\n"
    )
    executable.chmod(0o755)
    root = tmp_path / "run"
    original = root / "trials/0000/attempt-001"
    atomic_json(root / "owner.json", {"kind": "synergy-benchmark-run", "version": 1})
    atomic_json(original / "trial.json", {"variant": "A"})
    atomic_json(
        original / "evidence.json",
        {
            "version": 5,
            "execution": {"session_id": "fixture-session", "run_id": "fixture-run"},
            "trial_directory": "retained",
            "evidence": {"recording": "failed"},
            "verifier": {"rewards": {"reward": 0}},
        },
    )
    home = original / "retained/agent/home"
    home.mkdir(parents=True)
    (home / "retained-marker").write_text("original")
    before = (original / "evidence.json").read_bytes()
    atomic_json(
        root / "plan.json",
        {
            "version": 4,
            "result_version": 5,
            "variants": {"A": {"artifact": str(artifact), "runtime": "core"}},
            "config": {"platform": "linux/amd64"},
        },
    )
    monkeypatch.setattr(recovery, "verify_prepared", lambda _: {"base_image": "python:3.12-slim-bookworm"})
    monkeypatch.setattr(recovery, "recipe_links", lambda *_: {})
    result = recovery.recover_export(root, "0", 1, timeout=60)
    assert result["status"] == status, result
    assert result["model_calls"] == 0
    assert result["original_verifier"] == {"rewards": {"reward": 0}}
    target = Path(result["recovery"])
    observed = command(
        [
            "docker",
            "run",
            "--rm",
            "--platform",
            "linux/amd64",
            "--network",
            "none",
            "-v",
            f"{target}:/recovery:ro",
            "python:3.12-slim-bookworm",
            "python3",
            "-c",
            "import json; from pathlib import Path; "
            "print(json.dumps({name: [p.stat().st_uid, p.stat().st_gid, p.stat().st_mode & 0o777] "
            "for name in ['output/export.json', 'home/export-marker'] for p in [Path('/recovery') / name]}))",
        ],
    )
    assert all(value == [os.getuid(), os.getgid(), 0o600] for value in json.loads(observed).values())
    assert read_json(target / "output/export.json")["status"] == status
    assert (target / "home/retained-marker").read_text() == "original"
    assert (original / "evidence.json").read_bytes() == before
    assert sorted(file.name for file in home.iterdir()) == ["retained-marker"]


@pytest.mark.skipif(os.environ.get("SYNERGY_BENCH_DOCKER") != "1", reason="Container-owned private log handoff")
@pytest.mark.parametrize("stopped", [False, True])
def test_orphaned_logs_handoff_preserves_private_modes_and_bytes(tmp_path, stopped):
    import uuid

    from synergy_bench.runner import handoff_environment, remove_environment

    suffix = uuid.uuid4().hex[:8]
    root = tmp_path / ("run-" + suffix)
    attempt = root / "trials/0000/attempt-001"
    project = "sb-" + suffix + "-trials-0000-attempt-001"
    logs = attempt / project / "agent"
    logs.mkdir(parents=True)
    ownership = attempt / "environment.json"
    atomic_json(ownership, {"project": project})
    container = command(
        [
            "docker",
            "run",
            "-d",
            "--platform",
            "linux/amd64",
            "--network",
            "none",
            "--label",
            "com.docker.compose.project=" + project,
            "-v",
            f"{logs}:/logs/agent",
            "python:3.12-slim-bookworm",
            "sleep",
            "120",
        ]
    )
    try:
        command(
            [
                "docker",
                "exec",
                container,
                "python",
                "-c",
                "from pathlib import Path; import os; os.umask(0o077); "
                "Path('/logs/agent/home').mkdir(); Path('/logs/agent/home/secret').write_text('original private data')",
            ]
        )
        if stopped:
            command(["docker", "stop", "-t", "0", container])
        handoff_environment(root, ownership)
        observed = command(
            [
                "docker",
                "run",
                "--rm",
                "--network",
                "none",
                "--platform",
                "linux/amd64",
                "-v",
                f"{logs}:/logs/agent:ro",
                "python:3.12-slim-bookworm",
                "python",
                "-c",
                "from pathlib import Path; import json; "
                "print(json.dumps({name:[p.stat().st_uid,p.stat().st_gid,p.stat().st_mode & 0o777] "
                "for name in ['home','home/secret'] for p in [Path('/logs/agent') / name]}))",
            ]
        )
        assert json.loads(observed) == {
            "home": [os.getuid(), os.getgid(), 0o700],
            "home/secret": [os.getuid(), os.getgid(), 0o600],
        }
        assert (logs / "home/secret").read_text() == "original private data"
    finally:
        remove_environment(root, ownership)
