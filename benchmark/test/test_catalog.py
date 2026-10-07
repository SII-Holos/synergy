import json
from pathlib import Path

import pytest

from synergy_bench.cache import inspect_cache
from synergy_bench.catalog import Dataset, Suite, Task, materialize, tree_digest
from synergy_bench.source import git


def test_dataset_materialization_does_not_start_background_git_maintenance(tmp_path, monkeypatch):
    source = tmp_path / "source"
    task_path = source / "task"
    task_path.mkdir(parents=True)
    (task_path / "input.txt").write_text("immutable input")
    git(source, "init", "--quiet")
    git(source, "add", ".")
    git(
        source, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--quiet", "-m", "fixture"
    )
    task = Task(id="fixture/task", source="fixture", path="task", digest=tree_digest(task_path), tags=[])
    suite = Suite(
        version=1,
        name="fixture",
        selection="cache ownership",
        sources={
            "fixture": Dataset(
                url=str(source), commit=git(source, "rev-parse", "HEAD").decode().strip(), license="fixture"
            )
        },
        tasks=[task],
    )
    trace = tmp_path / "git-trace.jsonl"
    monkeypatch.setenv("GIT_TRACE2_EVENT", str(trace))
    cache = tmp_path / "cache"
    result = materialize(suite, task, cache)
    assert (result / "input.txt").read_text() == "immutable input"
    assert tree_digest(result) == task.digest
    events = [json.loads(line) for line in trace.read_text().splitlines()]
    writers = [
        event["argv"]
        for event in events
        if event.get("event") == "child_start" and {"maintenance", "gc"}.intersection(event.get("argv", []))
    ]
    assert writers == []
    entries = inspect_cache(cache)["entries"]
    assert len(entries) == 1
    assert entries[0]["valid"] is True


def test_official_subset_has_fixed_distinct_original_tasks() -> None:
    suite = Suite.load(Path(__file__).parents[1] / "suites" / "local-24.json")
    assert len(suite.tasks) == 24
    assert len({task.id for task in suite.tasks}) == 24
    assert sum(task.source == "deepswe-1.1" for task in suite.tasks) == 12
    assert sum(task.source == "terminal-bench-2.1" for task in suite.tasks) == 12
    assert all(len(source.commit) == 40 for source in suite.sources.values())
    assert all(len(task.digest) == 64 for task in suite.tasks)


@pytest.mark.parametrize("field", ["agent_seconds", "verifier_seconds"])
def test_task_catalog_rejects_per_task_deadline_overrides(field):
    suite = Suite.load(Path(__file__).parents[1] / "suites/local-24.json").model_dump()
    suite["tasks"][0][field] = 900
    with pytest.raises(ValueError, match="Extra inputs are not permitted"):
        Suite.model_validate(suite)


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
