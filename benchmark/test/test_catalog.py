from pathlib import Path

import pytest

from synergy_bench.catalog import Suite, tree_digest


def test_official_subset_has_fixed_distinct_original_tasks() -> None:
    suite = Suite.load(Path(__file__).parents[1] / "suites" / "local-24.json")
    assert len(suite.tasks) == 24
    assert len({task.id for task in suite.tasks}) == 24
    assert sum(task.source == "deepswe-1.1" for task in suite.tasks) == 12
    assert sum(task.source == "terminal-bench-2.1" for task in suite.tasks) == 12
    assert all(len(source.commit) == 40 for source in suite.sources.values())
    assert all(len(task.digest) == 64 for task in suite.tasks)


def test_tree_digest_detects_verifier_and_mode_changes(tmp_path: Path) -> None:
    file = tmp_path / "test.sh"
    file.write_text("exit 0")
    first = tree_digest(tmp_path)
    file.chmod(0o755)
    assert tree_digest(tmp_path) != first
    file.write_text("exit 1")
    assert tree_digest(tmp_path) != first
    (tmp_path / "escape").symlink_to("/tmp")
    with pytest.raises(ValueError, match="escapes"):
        tree_digest(tmp_path)
