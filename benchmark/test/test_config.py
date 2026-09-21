from pathlib import Path

import pytest
from pydantic import ValidationError

from synergy_bench.config import ExperimentConfig, ModelProfile, resolve_plan


@pytest.mark.parametrize("enabled", [False, True])
def test_boolean_thinking_switch_survives_freezing(enabled):
    profile = ModelProfile(
        model="bailian/deepseek-v4.1-flash",
        protocol="chat-completions",
        base_url="http://provider.invalid/v1",
        api_key_env="BOYUE_API_KEY",
        context_window=1000000,
        max_output_tokens=8192,
        parameters={"enable_thinking": enabled},
    )
    assert ModelProfile.model_validate(profile.model_dump()).parameters["enable_thinking"] is enabled


@pytest.mark.parametrize("enabled", [None, 0, 1, "false", "true"])
def test_boolean_thinking_switch_rejects_coercion(enabled):
    with pytest.raises(ValidationError):
        ModelProfile(
            model="fixture",
            protocol="chat-completions",
            base_url="http://provider.invalid/v1",
            api_key_env="KEY",
            context_window=1000,
            max_output_tokens=100,
            parameters={"enable_thinking": enabled},
        )


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


def test_preflight_deadline_default_survives_freezing():
    parsed = ExperimentConfig.model_validate(config())
    assert parsed.preflight_timeout_seconds == 120
    assert ExperimentConfig.model_validate(parsed.model_dump()).preflight_timeout_seconds == 120


@pytest.mark.parametrize("deadline", [1, 600, 3600])
def test_explicit_preflight_deadline_is_independent_of_task_deadline(deadline):
    parsed = ExperimentConfig.model_validate(
        {**config(), "timeout_seconds": "native", "preflight_timeout_seconds": deadline}
    )
    frozen = ExperimentConfig.model_validate(parsed.model_dump())
    assert frozen.preflight_timeout_seconds == deadline
    assert frozen.timeout_seconds == "native"


@pytest.mark.parametrize("deadline", [None, 0, -1, True, "600", 600.0, 3601])
def test_invalid_preflight_deadlines_are_rejected(deadline):
    with pytest.raises(ValidationError):
        ExperimentConfig.model_validate({**config(), "preflight_timeout_seconds": deadline})


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
