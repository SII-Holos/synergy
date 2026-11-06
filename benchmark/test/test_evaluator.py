import os
import subprocess
import sys

import pytest

from synergy_bench import prepare
from synergy_bench.evaluator import freeze_evaluator, recorded_environment


def test_frozen_evaluator_survives_checkout_edits_and_detects_tampering(tmp_path, monkeypatch):
    source = tmp_path / "source"
    (source / "src/synergy_bench").mkdir(parents=True)
    (source / "runtime").mkdir()
    (source / "src/synergy_bench/__init__.py").write_text('VALUE = "original"\n')
    (source / "runtime/runner.ts").write_text("original")
    (source / "uv.lock").write_text("locked")
    (source / "pyproject.toml").write_text("project")
    (source / "package.json").write_text('{"dependencies":{}}')
    monkeypatch.setattr(prepare, "BENCHMARK", source)
    expected = prepare.evaluator_identity()
    run = tmp_path / "run"
    snapshot = freeze_evaluator(run, expected)
    (source / "src/synergy_bench/__init__.py").write_text('VALUE = "changed"\n')
    env = recorded_environment(run, expected)
    result = subprocess.check_output(
        [sys.executable, "-c", "import synergy_bench;print(synergy_bench.VALUE)"], env=env, cwd=tmp_path
    )
    assert result == b"original\n"
    assert env["PATH"] == os.environ["PATH"]
    (snapshot / "runtime/runner.ts").write_text("corrupted")
    with pytest.raises(ValueError, match="snapshot changed"):
        recorded_environment(run, expected)


def test_interrupted_snapshot_publication_can_restart_safely(tmp_path, monkeypatch):
    from pathlib import Path

    run = tmp_path / "run"
    expected = prepare.evaluator_identity()
    original = Path.rename

    def interrupted(source, target):
        if source.name == "snapshot":
            assert (run / "evaluator.json").exists()
            raise OSError("publisher killed before rename")
        return original(source, target)

    with monkeypatch.context() as patch:
        patch.setattr(Path, "rename", interrupted)
        with pytest.raises(OSError, match="publisher killed"):
            freeze_evaluator(run, expected)
    assert not (run / "evaluator").exists()
    freeze_evaluator(run, expected)
    assert recorded_environment(run, expected)["PYTHONPATH"].endswith("evaluator/src")
