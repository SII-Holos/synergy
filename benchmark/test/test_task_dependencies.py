import hashlib
import importlib.util
import io
import json
import tomllib
import zipfile
from pathlib import Path

import pytest

from synergy_bench.catalog import tree_digest


def prepare_module():
    path = Path(__file__).parents[1] / "tasks/local24-repro-v6/build-cython-ext/environment/prepare-wheels.py"
    spec = importlib.util.spec_from_file_location("task_wheel_preparation", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_derived_tasks_preserve_declared_inputs_and_native_configuration():
    root = Path(__file__).parents[1] / "tasks/local24-repro-v6"
    provenance = json.loads((root / "provenance.json").read_text())
    for row in provenance["tasks"]:
        task = root / row["task"]
        assert tree_digest(task) == row["derived_digest"]
        for name, checksum in row["unchanged_files_sha256"].items():
            assert hashlib.sha256((task / name).read_bytes()).hexdigest() == checksum
        config = tomllib.loads((task / "task.toml").read_text())
        assert config == row["retained_task_config"]
        assert "docker_image" not in config["environment"]
        assert "instruction.md" in row["unchanged_files_sha256"]
        assert "tests/test_outputs.py" in row["unchanged_files_sha256"]


def test_dependency_cache_uses_root_distribution_metadata_not_vendored_packages(tmp_path):
    wheel = tmp_path / "setuptools.whl"
    with zipfile.ZipFile(wheel, "w") as archive:
        archive.writestr("setuptools-80.9.0.dist-info/METADATA", "Name: setuptools\nVersion: 80.9.0\n")
        archive.writestr("setuptools/_vendor/packaging-24.2.dist-info/METADATA", "Name: packaging\nVersion: 24.2\n")
    prepare_module().freeze_wheels(tmp_path)
    assert (tmp_path / "constraints.txt").read_text() == "setuptools==80.9.0\n"
    assert json.loads((tmp_path / "manifest.json").read_text()) == {
        "packages": {"setuptools": "80.9.0"},
        "wheels": [{"file": wheel.name, "sha256": hashlib.sha256(wheel.read_bytes()).hexdigest()}],
    }


def test_dependency_cache_rejects_conflicting_distributions(tmp_path):
    for version in ["1.0", "2.0"]:
        with zipfile.ZipFile(tmp_path / f"fixture-{version}.whl", "w") as archive:
            archive.writestr(f"fixture-{version}.dist-info/METADATA", f"Name: fixture\nVersion: {version}\n")
    with pytest.raises(ValueError, match="multiple wheels"):
        prepare_module().freeze_wheels(tmp_path)


def test_locked_download_rejects_wrong_bytes_without_publishing(tmp_path, monkeypatch):
    module = prepare_module()
    monkeypatch.setattr("urllib.request.urlopen", lambda *args, **kwargs: io.BytesIO(b"incorrect"))
    artifact = {"file": "fixture.whl", "url": "https://files.pythonhosted.org/fixture.whl", "sha256": "0" * 64}
    with pytest.raises(ValueError, match="checksum"):
        module.download_artifact(artifact, tmp_path)
    assert not (tmp_path / "fixture.whl").exists()


def test_locked_download_uses_the_frozen_artifact_and_validates_cache(tmp_path, monkeypatch):
    module = prepare_module()
    calls = []
    content = b"immutable distribution"

    def open_url(url, **kwargs):
        calls.append(url)
        return io.BytesIO(content)

    monkeypatch.setattr("urllib.request.urlopen", open_url)
    artifact = {
        "file": "fixture.whl",
        "url": "https://files.pythonhosted.org/fixture.whl",
        "sha256": hashlib.sha256(content).hexdigest(),
    }
    module.download_artifact(artifact, tmp_path)
    module.download_artifact(artifact, tmp_path)
    assert calls == [artifact["url"]]
    (tmp_path / "fixture.whl").write_bytes(b"changed")
    with pytest.raises(ValueError, match="checksum"):
        module.download_artifact(artifact, tmp_path)
