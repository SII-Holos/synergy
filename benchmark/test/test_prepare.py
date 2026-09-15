from pathlib import Path

import pytest

from synergy_bench.prepare import recipe_links
from synergy_bench.storage import atomic_json


def test_recipe_resolves_public_names_without_a_benchmark_workspace(tmp_path: Path) -> None:
    atomic_json(tmp_path / "package.json", {"workspaces": {"packages": ["components/*"]}})
    atomic_json(tmp_path / "components/renamed/package.json", {"name": "@example/runtime"})
    assert recipe_links(tmp_path, {"@example/runtime": "workspace:*"}) == {"@example/runtime": "components/renamed"}
    with pytest.raises(ValueError, match="not provided"):
        recipe_links(tmp_path, {"@example/missing": "workspace:*"})


@pytest.mark.parametrize("failure", [RuntimeError("injected build failure"), KeyboardInterrupt()])
def test_preparation_failure_never_exposes_a_resumable_plan(tmp_path: Path, monkeypatch, failure) -> None:
    import yaml

    from synergy_bench import runner
    from synergy_bench.prepare import BENCHMARK
    from synergy_bench.storage import read_json

    path = tmp_path / "experiment.yaml"
    path.write_text(
        yaml.safe_dump(
            {
                "version": 1,
                "suite": str(BENCHMARK / "suites/local-24.json"),
                "output": "runs",
                "variants": {"A": {"source": {"path": str(tmp_path)}, "model": "fixture/model"}},
            }
        )
    )
    monkeypatch.setattr(runner, "command", lambda *args, **kwargs: "fixture Docker")
    monkeypatch.setattr(
        runner,
        "inspect_host",
        lambda *args: {"disk_ready": True, "capacity": {"cpus": 8, "memory_bytes": 16 * 1024**3}},
    )

    def prepare(*args, **kwargs):
        raise failure

    monkeypatch.setattr(runner, "prepare_source", prepare)
    with pytest.raises(type(failure)):
        runner.initialize(path)
    root = next((tmp_path / "runs").iterdir())
    assert read_json(root / "preparation.json")["status"] == (
        "interrupted" if isinstance(failure, KeyboardInterrupt) else "failed"
    )
    assert read_json(root / "preparation.json")["stage"] == "source"
    assert not (root / "plan.json").exists()


def test_cleanup_rejects_an_unverified_container_identifier(tmp_path: Path, monkeypatch) -> None:
    from synergy_bench import prepare

    file = tmp_path / "container.id"
    file.write_text("another-project")
    monkeypatch.setattr(prepare, "command", lambda *args, **kwargs: pytest.fail("Unverified Docker mutation"))
    with pytest.raises(ValueError, match="Invalid owned container"):
        prepare.remove_owned_container(file)


@pytest.mark.parametrize(
    "external", ["external.mjs", "capture.mjs", "capture-plugin.mjs", "capture-pi.mjs", "native-outcome.mjs"]
)
@pytest.mark.parametrize("synergy", ["entry.ts", "deadline.mjs"])
def test_external_observer_changes_do_not_invalidate_synergy_runtime(tmp_path, external, synergy):
    from synergy_bench.prepare import synergy_runtime_digest

    (tmp_path / synergy).write_text("native Synergy entry")
    (tmp_path / external).write_text("external observer one")
    first = synergy_runtime_digest(tmp_path)
    (tmp_path / external).write_text("external observer two")
    assert synergy_runtime_digest(tmp_path) == first
    (tmp_path / synergy).write_text("changed Synergy entry")
    assert synergy_runtime_digest(tmp_path) != first
