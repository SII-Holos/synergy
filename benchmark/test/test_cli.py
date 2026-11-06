import sys
from pathlib import Path

import pytest

from synergy_bench import cli
from synergy_bench.storage import atomic_json


@pytest.mark.parametrize("failure", ["missing_config", "malformed_yaml", "missing_suite", "config", "experiment"])
def test_invalid_input_files_exit_two_before_docker(tmp_path: Path, monkeypatch, failure: str) -> None:
    import yaml

    from synergy_bench import runner
    from synergy_bench.prepare import BENCHMARK

    monkeypatch.setenv("FIXTURE_KEY", "deterministic-fixture")
    path = tmp_path / "experiment.yaml"
    value = {
        "version": 2,
        "suite": str(BENCHMARK / "suites/local-24.json"),
        "harnesses": {"A": {"kind": "synergy", "source": {"path": str(tmp_path)}}},
        "models": {
            "fixture": {
                "model": "model",
                "protocol": "chat-completions",
                "base_url": "http://127.0.0.1:1/v1",
                "api_key_env": "FIXTURE_KEY",
                "context_window": 32000,
                "max_output_tokens": 2048,
            }
        },
    }
    if failure == "missing_suite":
        value["suite"] = "absent.json"
    if failure in {"config", "experiment"}:
        value["harnesses"]["A"][failure] = "absent.json"
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


def test_cli_declares_direct_execution_and_reporting_commands(capsys, monkeypatch):
    monkeypatch.setattr(sys, "argv", ["synergy-bench", "--help"])
    with pytest.raises(SystemExit) as exit:
        cli.main()
    assert exit.value.code == 0
    output = capsys.readouterr().out
    for command in ["run", "resume", "report", "compare", "cache"]:
        assert command in output


def test_compare_models_keeps_same_harness_and_uses_descriptive_groups(tmp_path, monkeypatch, capsys):
    from test_report import fixture

    from synergy_bench.storage import read_json

    fixture(tmp_path / "left", [(1, 30)])
    fixture(tmp_path / "right", [(0, 40)])
    plan = read_json(tmp_path / "right/plan.json")
    plan["schedule"][0]["model"] = "other"
    atomic_json(tmp_path / "right/plan.json", plan)
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "synergy-bench",
            "compare",
            str(tmp_path / "left"),
            str(tmp_path / "right"),
            "--left-harness",
            "a",
            "--right-harness",
            "a",
            "--left-model",
            "m",
            "--right-model",
            "other",
        ],
    )
    cli.main()
    import json

    result = json.loads(capsys.readouterr().out)
    assert result["mode"] == "descriptive_cross_model"
    assert result["left"]["successes"] == 1
    assert result["right"]["successes"] == 0
    assert result["paired_difference"] is None
