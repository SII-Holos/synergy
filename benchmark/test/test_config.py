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


def test_new_yaml_inherits_research_deadline_and_freezes_it(tmp_path):
    import yaml

    from synergy_bench.config import load_config

    path = tmp_path / "new-experiment.yaml"
    path.write_text(yaml.safe_dump(config()))
    parsed = load_config(path)
    assert parsed.timeout_seconds == 10800
    assert parsed.model_dump()["timeout_seconds"] == 10800
    assert ExperimentConfig.model_validate(parsed.model_dump()).timeout_seconds == 10800
    assert parsed.request_idle_timeout_seconds is None


@pytest.mark.parametrize("deadline", ["native", 60, 21600])
def test_explicit_deadline_survives_freezing(deadline):
    parsed = ExperimentConfig.model_validate({**config(), "timeout_seconds": deadline})
    assert ExperimentConfig.model_validate(parsed.model_dump()).timeout_seconds == deadline


@pytest.mark.parametrize("deadline", [None, 0, -1, True, "10800", "naitve"])
def test_ambiguous_or_invalid_deadlines_are_rejected(deadline):
    with pytest.raises(ValidationError):
        ExperimentConfig.model_validate({**config(), "timeout_seconds": deadline})


@pytest.mark.parametrize("deadline", [None, 900])
def test_request_idle_deadline_is_explicit_and_frozen(deadline):
    parsed = ExperimentConfig.model_validate({**config(), "request_idle_timeout_seconds": deadline})
    assert parsed.model_dump()["request_idle_timeout_seconds"] == deadline


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
