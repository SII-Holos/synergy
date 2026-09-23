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
        "version": 2,
        "suite": "suite.json",
        "harnesses": {
            "a": {"kind": "synergy", "source": {"path": "."}},
            "b": {"kind": "synergy", "source": {"path": "."}},
        },
        "models": {
            "m": {
                "model": "model",
                "protocol": "chat-completions",
                "base_url": "http://fixture.invalid/v1",
                "api_key_env": "BENCH_FIXTURE_KEY",
                "context_window": 32000,
                "max_output_tokens": 2048,
            }
        },
    }


def test_new_yaml_has_no_task_deadline_override(tmp_path):
    import yaml

    from synergy_bench.config import load_config

    path = tmp_path / "new-experiment.yaml"
    path.write_text(yaml.safe_dump(config()))
    parsed = load_config(path)
    assert "timeout_seconds" not in parsed.model_dump()
    assert "verifier_timeout_seconds" not in parsed.model_dump()
    assert ExperimentConfig.model_validate(parsed.model_dump()) == parsed
    assert parsed.request_idle_timeout_seconds is None


@pytest.mark.parametrize("field", ["timeout_seconds", "verifier_timeout_seconds", "task_timeout_seconds"])
@pytest.mark.parametrize("deadline", ["native", 60, 10800, 21600, None, 0, -1, True, "10800"])
def test_task_deadline_overrides_are_rejected(field, deadline):
    with pytest.raises(ValidationError, match="Extra inputs are not permitted"):
        ExperimentConfig.model_validate({**config(), field: deadline})


@pytest.mark.parametrize("deadline", [None, 900])
def test_request_idle_deadline_is_explicit_and_frozen(deadline):
    parsed = ExperimentConfig.model_validate({**config(), "request_idle_timeout_seconds": deadline})
    assert parsed.model_dump()["request_idle_timeout_seconds"] == deadline


def test_rejects_unknown_fields_and_missing_model():
    with pytest.raises(ValidationError):
        ExperimentConfig.model_validate({**config(), "concurency": 4})
    value = config()
    del value["models"]["m"]["model"]
    with pytest.raises(ValidationError):
        ExperimentConfig.model_validate(value)


def test_plan_is_balanced_reproducible_and_pairs_variants(tmp_path: Path):
    parsed = ExperimentConfig.model_validate(config())
    tasks = [{"id": f"task-{i}", "tags": ["coding"]} for i in range(8)]
    plan = resolve_plan(parsed, tasks)
    assert plan == resolve_plan(parsed, tasks)
    assert len(plan) == 16
    assert sum(plan[i]["variant"] == "a__m" for i in range(0, 16, 2)) == 4
    for i in range(0, 16, 2):
        assert plan[i]["pair"] == plan[i + 1]["pair"]
        assert plan[i]["task"] == plan[i + 1]["task"]
        assert {plan[i]["variant"], plan[i + 1]["variant"]} == {"a__m", "b__m"}


def test_selection_precedes_pair_expansion():
    parsed = ExperimentConfig.model_validate({**config(), "selection": {"tags": ["fast"], "limit": 1}})
    plan = resolve_plan(parsed, [{"id": "slow", "tags": []}, {"id": "fast", "tags": ["fast"]}])
    assert [row["task"] for row in plan] == ["fast", "fast"]
    with pytest.raises(ValueError, match="No tasks"):
        resolve_plan(parsed, [{"id": "slow", "tags": []}])


def test_dependency_proxy_freezes_only_an_explicit_environment_reference():
    parsed = ExperimentConfig.model_validate({**config(), "dependency_proxy_env": "BENCH_DEPENDENCY_PROXY"})
    assert parsed.model_dump()["dependency_proxy_env"] == "BENCH_DEPENDENCY_PROXY"
    assert ExperimentConfig.model_validate(config()).dependency_proxy_env is None
    with pytest.raises(ValidationError):
        ExperimentConfig.model_validate({**config(), "dependency_proxy_env": "http://private.invalid:7890"})


def test_exact_cells_preserve_frozen_priority_and_do_not_expand_other_sides():
    value = {**config(), "seed": 20260921}
    tasks = [{"id": f"task-{i:02d}"} for i in range(24)]
    full = resolve_plan(ExperimentConfig.model_validate(value), tasks)
    missing = [2, 6, 7, 8, 9, 10, 12, 13, 18, 19, 33, 36, 37, 40, 41, 42, 43, 44, 45, 46, 47]
    selected = [full[index] for index in missing]
    cells = [{key: row[key] for key in ["task", "harness", "model", "repeat"]} for row in reversed(selected)]
    parsed = ExperimentConfig.model_validate({**value, "selection": {"cells": cells}})
    assert resolve_plan(parsed, tasks) == selected
    assert resolve_plan(ExperimentConfig.model_validate(parsed.model_dump()), tasks) == selected


@pytest.mark.parametrize(
    "cell",
    [
        {"task": "missing", "harness": "a", "model": "m", "repeat": 0},
        {"task": "task", "harness": "missing", "model": "m", "repeat": 0},
        {"task": "task", "harness": "a", "model": "missing", "repeat": 0},
        {"task": "task", "harness": "a", "model": "m", "repeat": 1},
    ],
)
def test_exact_cells_reject_unavailable_matrix_members(cell):
    parsed = ExperimentConfig.model_validate({**config(), "selection": {"cells": [cell]}})
    with pytest.raises(ValueError, match="Requested cells are outside the selected matrix"):
        resolve_plan(parsed, [{"id": "task"}])


def test_exact_cells_reject_duplicates_and_conflicting_filters():
    cell = {"task": "task", "harness": "a", "model": "m", "repeat": 0}
    parsed = ExperimentConfig.model_validate({**config(), "selection": {"cells": [cell, cell]}})
    with pytest.raises(ValueError, match="Duplicate selected cells"):
        resolve_plan(parsed, [{"id": "task"}])
    parsed = ExperimentConfig.model_validate({**config(), "selection": {"cells": [cell], "tasks": ["other"]}})
    with pytest.raises(ValueError, match="Requested cells are outside the selected matrix"):
        resolve_plan(parsed, [{"id": "task"}, {"id": "other"}])


def test_exact_cells_keep_requested_repeat_without_adding_repeats():
    cell = {"task": "task", "harness": "b", "model": "m", "repeat": 1}
    parsed = ExperimentConfig.model_validate({**config(), "repeat": 2, "selection": {"cells": [cell]}})
    plan = resolve_plan(parsed, [{"id": "task"}])
    assert len(plan) == 1
    assert {key: plan[0][key] for key in cell} == cell


def test_empty_exact_selection_cannot_accidentally_dispatch_the_full_matrix():
    with pytest.raises(ValidationError):
        ExperimentConfig.model_validate({**config(), "selection": {"cells": []}})


def test_missing_credentials_fail_before_preparation(tmp_path, monkeypatch):
    from synergy_bench.config import ExperimentConfig
    from synergy_bench.runner import validate_inputs

    monkeypatch.delenv("BENCH_MISSING_CREDENTIAL", raising=False)
    value = globals()["config"]()
    value["models"]["m"]["api_key_env"] = "BENCH_MISSING_CREDENTIAL"
    parsed = ExperimentConfig.model_validate(value)
    with pytest.raises(ValueError, match="Missing credential environment"):
        validate_inputs(parsed, tmp_path)
