from pathlib import Path

import pytest
from pydantic import ValidationError

from synergy_bench.config import ExperimentConfig, resolve_plan


def config():
    return {
        "version": 1,
        "suite": "suite.json",
        "variants": {
            "a": {"source": {"path": "."}, "model": "test/model"},
            "b": {"source": {"path": "."}, "model": "test/model", "variant": "high"},
        },
    }


def test_rejects_unknown_fields_and_missing_model():
    with pytest.raises(ValidationError):
        ExperimentConfig.model_validate({**config(), "concurency": 4})
    value = config()
    del value["variants"]["a"]["model"]
    with pytest.raises(ValidationError):
        ExperimentConfig.model_validate(value)


def test_plan_is_balanced_reproducible_and_pairs_variants(tmp_path: Path):
    parsed = ExperimentConfig.model_validate(config())
    tasks = [{"id": f"task-{i}", "tags": ["coding"]} for i in range(8)]
    plan = resolve_plan(parsed, tasks)
    assert plan == resolve_plan(parsed, tasks)
    assert len(plan) == 16
    assert sum(plan[i]["variant"] == "a" for i in range(0, 16, 2)) == 4
    for i in range(0, 16, 2):
        assert plan[i]["pair"] == plan[i + 1]["pair"]
        assert plan[i]["task"] == plan[i + 1]["task"]
        assert {plan[i]["variant"], plan[i + 1]["variant"]} == {"a", "b"}


def test_selection_precedes_pair_expansion():
    parsed = ExperimentConfig.model_validate({**config(), "selection": {"tags": ["fast"], "limit": 1}})
    plan = resolve_plan(parsed, [{"id": "slow", "tags": []}, {"id": "fast", "tags": ["fast"]}])
    assert [row["task"] for row in plan] == ["fast", "fast"]
    with pytest.raises(ValueError, match="No tasks"):
        resolve_plan(parsed, [{"id": "slow", "tags": []}])


def test_missing_credentials_fail_before_preparation(tmp_path, monkeypatch):
    from synergy_bench.config import ExperimentConfig
    from synergy_bench.runner import validate_inputs

    monkeypatch.delenv("BENCH_MISSING_CREDENTIAL", raising=False)
    config = ExperimentConfig.model_validate(
        {
            "version": 1,
            "suite": "unused",
            "variants": {"A": {"model": "provider/model", "env": {"KEY": "BENCH_MISSING_CREDENTIAL"}}},
        }
    )
    with pytest.raises(ValueError, match="Missing credential environment"):
        validate_inputs(config, tmp_path)
