import sys

import pytest

from synergy_bench import cli
from synergy_bench.config import ExperimentConfig, Resources
from synergy_bench.report import report_data
from synergy_bench.storage import atomic_json


def test_old_benchmark_configuration_is_rejected():
    with pytest.raises(ValueError):
        ExperimentConfig.model_validate({"version": 1, "suite": "suite.json", "variants": {"a": {"model": "p/m"}}})
    with pytest.raises(ValueError):
        Resources(reserve_memory_fraction=0.15)


@pytest.mark.parametrize("version", [None, 1, 2, 3])
def test_reports_do_not_import_retired_plans(tmp_path, version):
    atomic_json(tmp_path / "plan.json", {"version": version, "result_version": 4, "schedule": []})
    with pytest.raises(ValueError, match="Unsupported benchmark"):
        report_data(tmp_path)


@pytest.mark.parametrize("version", [None, 1, 2, 3, 4])
def test_reports_require_current_version_on_every_persisted_result(tmp_path, version):
    atomic_json(tmp_path / "plan.json", {"version": 4, "result_version": 5, "schedule": []})
    atomic_json(
        tmp_path / "trials/0000/attempt-001/evidence.json",
        {"version": version, "verifier": {"rewards": {"reward": 1.0}}},
    )
    with pytest.raises(ValueError, match="Unsupported benchmark result"):
        report_data(tmp_path)


@pytest.mark.parametrize("argv", [["normalize", "x"], ["resume", "x", "--recorded-evaluator"]])
def test_retired_cli_entrypoints_are_rejected(monkeypatch, argv):
    monkeypatch.setattr(sys, "argv", ["synergy-bench", *argv])
    with pytest.raises(SystemExit) as error:
        cli.main()
    assert error.value.code == 2
