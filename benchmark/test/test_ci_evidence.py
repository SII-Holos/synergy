import json
import os

import pytest

from synergy_bench.ci_evidence import collect


def test_matrix_collection_excludes_private_homes_unknown_files_and_symlinks(tmp_path):
    root, output = tmp_path / "source", tmp_path / "output"
    family = root / "matrix-integration"
    agent = family / "run/trials/0000/attempt-001/agent"
    agent.mkdir(parents=True)
    (agent / "evidence.json").write_text('{"public":true}')
    (agent / "auth.json").write_text("private credentials")
    for name in ["home", "wire", "inputs", "evaluator", "data"]:
        private = agent / name
        private.mkdir()
        (private / "evidence.json").write_text("must not be copied")
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "evidence.json").write_text("outside source")
    (family / "linked").symlink_to(outside, target_is_directory=True)
    (agent / "execution.json").symlink_to(outside / "evidence.json")
    result = collect(root, output, ["matrix-integration"])
    assert result == {"copied": 1, "errors": []}
    assert sorted(str(p.relative_to(output)) for p in output.rglob("*") if p.is_file()) == [
        "collection.json",
        "matrix-integration/run/trials/0000/attempt-001/agent/evidence.json",
    ]
    assert json.loads((output / "collection.json").read_text()) == result


@pytest.mark.skipif(os.geteuid() == 0, reason="Requires actual unprivileged filesystem reads")
def test_unreadable_evidence_does_not_drop_other_files(tmp_path):
    root, output = tmp_path / "source", tmp_path / "output"
    directory = root / "integration/run/agent"
    directory.mkdir(parents=True)
    blocked = directory / "execution.json"
    blocked.write_text("private")
    blocked.chmod(0)
    (directory / "evidence.json").write_text("{}")
    try:
        result = collect(root, output, ["integration"])
        assert result["copied"] == 1
        assert result["errors"] == [{"path": "integration/run/agent/execution.json", "error": "PermissionError"}]
    finally:
        blocked.chmod(0o600)


def test_collection_rejects_unknown_families_and_does_not_traverse_linked_family(tmp_path):
    root, output = tmp_path / "source", tmp_path / "output"
    root.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "evidence.json").write_text("private")
    (root / "matrix-integration").symlink_to(outside, target_is_directory=True)
    with pytest.raises(ValueError, match="Unknown evidence family"):
        collect(root, output, ["../outside"])
    assert collect(root, output, ["matrix-integration"])["copied"] == 0


def test_native_home_archive_stays_private_while_validation_metadata_is_collected(tmp_path):
    import io
    import tarfile

    root, output = tmp_path / "source", tmp_path / "output"
    agent = root / "matrix-integration/run/trials/0000/attempt-001/agent"
    agent.mkdir(parents=True)
    with tarfile.open(agent / "rollout.tar.gz", "w:gz") as archive:
        secret = b'{"apiKey":"private-native-home"}'
        info = tarfile.TarInfo("home/auth.json")
        info.size = len(secret)
        archive.addfile(info, io.BytesIO(secret))
    metadata = {"format": "native-home-tar-v1", "valid": True}
    (agent / "archive.json").write_text(json.dumps(metadata))
    (agent / "evidence.json").write_text('{"version":3}')
    result = collect(root, output, ["matrix-integration"])
    retained = output / agent.relative_to(root)
    assert result == {"copied": 2, "errors": []}
    assert json.loads((retained / "archive.json").read_text()) == metadata
    assert not (retained / "rollout.tar.gz").exists()
    assert (agent / "rollout.tar.gz").is_file()
