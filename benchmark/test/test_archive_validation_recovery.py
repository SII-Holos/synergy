import hashlib
from pathlib import Path

from synergy_bench import recovery
from synergy_bench.storage import atomic_json


def test_validation_recovery_uses_exact_retained_archive_without_export_or_evidence_changes(tmp_path, monkeypatch):
    artifact = tmp_path / "artifact"
    (artifact / "bundle").mkdir(parents=True)
    root = tmp_path / "run"
    original = root / "trials/0000/attempt-001"
    agent = original / "retained/agent"
    agent.mkdir(parents=True)
    archive = agent / "rollout.zip"
    archive.write_bytes(b"frozen archive")
    checksum = hashlib.sha256(archive.read_bytes()).hexdigest()
    atomic_json(root / "owner.json", {"kind": "synergy-benchmark-run", "version": 1})
    atomic_json(
        root / "plan.json",
        {
            "version": 4,
            "result_version": 5,
            "variants": {"A": {"artifact": str(artifact), "runtime": "core"}},
            "config": {"platform": "linux/amd64"},
        },
    )
    atomic_json(original / "trial.json", {"variant": "A"})
    atomic_json(
        original / "evidence.json",
        {
            "version": 5,
            "trial_directory": "retained",
            "export": {"process": {"exit_code": 0, "timed_out": False}, "validation": {"timed_out": True}},
            "files": {"agent/rollout.zip": {"sha256": checksum, "bytes": archive.stat().st_size}},
            "evidence": {"archive_valid": False},
        },
    )
    before = (original / "evidence.json").read_bytes()
    monkeypatch.setattr(recovery, "verify_prepared", lambda _: {"base_image": "fixture-image"})
    monkeypatch.setattr(recovery, "recipe_links", lambda *_: {})

    def verify(command, log=None, timeout=None):
        assert command.count("-v") >= 2
        assert f"{archive}:/recovery-input/rollout.zip:ro" in command
        assert "verify.ts" in " ".join(command)
        assert "entry.ts" not in " ".join(command)
        output = Path(log).parent / "output/archive.json"
        atomic_json(output, {"valid": True, "sha256": checksum, "bytes": archive.stat().st_size})
        return ""

    monkeypatch.setattr(recovery, "command", verify)
    monkeypatch.setattr(recovery, "remove_owned_container", lambda _: None)
    result = recovery.recover_archive_validation(root, "0", 1, timeout=60)
    assert result["status"] == "completed"
    assert result["model_calls"] == 0
    assert result["validation_evaluator"]
    assert (original / "evidence.json").read_bytes() == before
    assert archive.read_bytes() == b"frozen archive"


def test_validation_recovery_rejects_changed_archive(tmp_path):
    root = tmp_path / "run"
    original = root / "trials/0000/attempt-001"
    agent = original / "retained/agent"
    agent.mkdir(parents=True)
    (agent / "rollout.zip").write_bytes(b"changed")
    atomic_json(root / "owner.json", {"kind": "synergy-benchmark-run", "version": 1})
    atomic_json(root / "plan.json", {"version": 4, "result_version": 5})
    atomic_json(
        original / "evidence.json",
        {
            "version": 5,
            "trial_directory": "retained",
            "export": {"process": {"exit_code": 0, "timed_out": False}, "validation": {"timed_out": True}},
            "files": {"agent/rollout.zip": {"sha256": "0" * 64, "bytes": 7}},
        },
    )
    import pytest

    with pytest.raises(ValueError, match="archive hash"):
        recovery.recover_archive_validation(root, "0", 1)
