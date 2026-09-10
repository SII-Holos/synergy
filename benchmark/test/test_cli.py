from pathlib import Path

import pytest

from synergy_bench import cli
from synergy_bench.storage import atomic_json


@pytest.mark.parametrize("failure", ["missing_config", "malformed_yaml", "missing_suite", "config", "experiment"])
def test_invalid_input_files_exit_two_before_docker(tmp_path: Path, monkeypatch, failure: str) -> None:
    import yaml

    from synergy_bench import runner
    from synergy_bench.prepare import BENCHMARK

    path = tmp_path / "experiment.yaml"
    value = {
        "version": 1,
        "suite": str(BENCHMARK / "suites/local-24.json"),
        "variants": {"A": {"source": {"path": str(tmp_path)}, "model": "fixture/model"}},
    }
    if failure == "missing_suite":
        value["suite"] = "absent.json"
    if failure in {"config", "experiment"}:
        value["variants"]["A"][failure] = "absent.json"
    if failure != "missing_config":
        path.write_text("version: [" if failure == "malformed_yaml" else yaml.safe_dump(value))
    monkeypatch.setattr("sys.argv", ["synergy-bench", "run", str(path)])
    monkeypatch.setattr(runner, "command", lambda *args, **kwargs: pytest.fail("Docker must not run"))
    with pytest.raises(SystemExit) as exit:
        cli.main()
    assert exit.value.code == 2


def test_clean_uses_only_owned_attempt_records(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    run = tmp_path / "run"
    atomic_json(run / "owner.json", {"kind": "synergy-benchmark-run", "version": 1})
    records = [run / "trials/0000/attempt-001/environment.json", run / "debug/0000/attempt-debug/environment.json"]
    for record in records:
        atomic_json(record, {"project": "owned-project"})
        atomic_json(record.parent / "trial/agent/environment.json", {"images": []})
    removed = []
    monkeypatch.setattr(cli, "remove_environment", lambda root, record: removed.append(record))
    cli.clean(run)
    assert set(removed) == set(records)
    assert not run.exists()


def test_recovery_and_cleanup_cannot_cross_an_active_run_lock(tmp_path: Path) -> None:
    from synergy_bench.recovery import recover_export
    from synergy_bench.storage import locked

    atomic_json(tmp_path / "run/owner.json", {"kind": "synergy-benchmark-run", "version": 1})
    with locked(tmp_path / "run"):
        with pytest.raises(ValueError, match="already owned"):
            cli.clean(tmp_path / "run")
        with pytest.raises(ValueError, match="already owned"):
            recover_export(tmp_path / "run", "0", 1)
        assert (tmp_path / "run/owner.json").exists()
        assert not (tmp_path / "run/recoveries").exists()
