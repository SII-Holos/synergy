import errno
import os
import shutil
from contextlib import contextmanager
from pathlib import Path

import pytest
from fixtures.task_copy import copy_task_fixture

from synergy_bench.prepare import BENCHMARK


@pytest.fixture
def task_source(tmp_path):
    source = tmp_path / "source"
    shutil.copytree(BENCHMARK / "test/fixtures/task", source, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    (source / ".fixture-config").write_text("fixture=true\n")
    (source / "environment/.provider-config").write_text("provider=local\n")
    return source


def remove_after_enumeration(monkeypatch, file):
    scandir = os.scandir

    @contextmanager
    def enumerate_then_remove(path):
        with scandir(path) as entries:
            listed = list(entries)
            if Path(path) == file.parent:
                file.unlink()
            yield iter(listed)

    monkeypatch.setattr(os, "scandir", enumerate_then_remove)


@pytest.mark.parametrize(
    "bytecode",
    ["environment/__pycache__/provider.cpython-312.pyc.123456", "environment/provider.pyc"],
    ids=["temporary-cache-bytecode", "loose-bytecode"],
)
def test_task_fixture_copy_excludes_disappearing_bytecode_and_preserves_sources(
    task_source, tmp_path, monkeypatch, bytecode
):
    expected = {file.relative_to(task_source): file.read_bytes() for file in task_source.rglob("*") if file.is_file()}
    transient = task_source / bytecode
    transient.parent.mkdir(parents=True, exist_ok=True)
    transient.write_bytes(b"transient bytecode")
    destination = tmp_path / "dataset/tasks/fixture"

    with monkeypatch.context() as copy_patch:
        remove_after_enumeration(copy_patch, transient)
        copy_task_fixture(task_source, destination)

    copied = {file.relative_to(destination): file.read_bytes() for file in destination.rglob("*") if file.is_file()}
    assert copied == expected
    assert not (destination / "environment/__pycache__").exists()


def test_task_fixture_copy_reports_missing_source(tmp_path):
    source = tmp_path / "missing-task"
    with pytest.raises(FileNotFoundError) as error:
        copy_task_fixture(source, tmp_path / "dataset/tasks/fixture")
    assert error.value.errno == errno.ENOENT
    assert error.value.filename == str(source)


def test_task_fixture_copy_reports_disappearing_real_source(task_source, tmp_path, monkeypatch):
    provider = task_source / "environment/provider.py"
    with monkeypatch.context() as copy_patch:
        remove_after_enumeration(copy_patch, provider)
        with pytest.raises(shutil.Error) as error:
            copy_task_fixture(task_source, tmp_path / "dataset/tasks/fixture")
    assert any(source == str(provider) and "[Errno 2]" in message for source, _, message in error.value.args[0])
