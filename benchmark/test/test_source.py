import os
import subprocess
from pathlib import Path

import pytest

from synergy_bench.source import freeze_source, verify_source


def git(root, *args):
    return subprocess.check_output(["git", "-C", str(root), *args])


@pytest.fixture
def repo(tmp_path):
    root = tmp_path / "repo"
    root.mkdir()
    git(root, "init", "-q")
    git(root, "config", "user.email", "fixture@example.invalid")
    git(root, "config", "user.name", "Fixture")
    (root / "tracked").write_text("original")
    (root / "deleted").write_text("remove")
    (root / ".gitignore").write_text("ignored\n")
    git(root, "add", ".")
    git(root, "commit", "-qm", "fixture")
    return root


def test_freezes_dirty_contents_modes_links_and_deletions(repo: Path, tmp_path: Path):
    (repo / "tracked").write_text("changed")
    (repo / "deleted").unlink()
    (repo / "new").write_text("new")
    (repo / "new").chmod(0o755)
    (repo / "ignored").write_text("private")
    (repo / "link").symlink_to("tracked")
    before = git(repo, "status", "--porcelain")
    target = tmp_path / "snapshot"
    receipt = freeze_source(repo, target)
    assert git(repo, "status", "--porcelain") == before
    assert (target / "tracked").read_text() == "changed"
    assert not (target / "deleted").exists()
    assert not (target / "ignored").exists()
    assert not (target / ".git").exists()
    assert os.readlink(target / "link") == "tracked"
    assert (target / "new").stat().st_mode & 0o111
    (repo / "tracked").write_text("later")
    verify_source(target, receipt)
    assert (target / "tracked").read_text() == "changed"
    (target / "new").write_text("tampered")
    with pytest.raises(ValueError, match="changed"):
        verify_source(target, receipt)


def test_revision_ignores_working_changes(repo: Path, tmp_path: Path):
    (repo / "tracked").write_text("dirty")
    target = tmp_path / "snapshot"
    receipt = freeze_source(repo, target, revision="HEAD")
    assert (target / "tracked").read_text() == "original"
    verify_source(target, receipt)


def test_rejects_escape_link(repo: Path, tmp_path: Path):
    (repo / "escape").symlink_to("../../outside")
    with pytest.raises(ValueError, match="escapes"):
        freeze_source(repo, tmp_path / "snapshot")
