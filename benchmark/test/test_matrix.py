from collections import Counter

import pytest
from pydantic import ValidationError

from synergy_bench.config import ExperimentConfig, resolve_plan


def matrix_config():
    return {
        "version": 2,
        "suite": "fixture.json",
        "harnesses": {"full": {"kind": "synergy", "runtime": "full"}, "pi": {"kind": "pi"}},
        "models": {
            name: {
                "model": name,
                "base_url": "http://localhost:8087/v1",
                "protocol": "chat-completions",
                "api_key_env": "FIXTURE_KEY",
                "context_window": 128000,
                "max_output_tokens": 4096,
            }
            for name in ["one", "two"]
        },
        "repeat": 3,
    }


def test_independent_axes_and_same_model_pairing():
    config = ExperimentConfig.model_validate(matrix_config())
    tasks = [{"id": name, "tags": []} for name in ["a", "b"]]
    plan = resolve_plan(config, tasks)
    assert len(plan) == 24
    assert plan == resolve_plan(config, tasks)
    assert Counter((row["harness"], row["model"]) for row in plan) == {
        (harness, model): 6 for harness in ["full", "pi"] for model in ["one", "two"]
    }
    for pair in {row["pair"] for row in plan}:
        members = [row for row in plan if row["pair"] == pair]
        assert len(members) == 2
        assert len({(row["task"], row["model"], row["repeat"]) for row in members}) == 1
        assert {row["harness"] for row in members} == {"full", "pi"}
    assert config.concurrency == "auto"


def test_selected_combinations_and_exclusions():
    value = matrix_config()
    value["matrix"] = {
        "include": [{"harness": "pi", "model": "one"}, {"harness": "full", "model": "two"}],
        "exclude": [{"harness": "pi", "model": "one"}],
    }
    config = ExperimentConfig.model_validate(value)
    plan = resolve_plan(config, [{"id": "task", "tags": []}])
    assert len(plan) == 3
    assert {(row["harness"], row["model"]) for row in plan} == {("full", "two")}


@pytest.mark.parametrize("field", ["include", "exclude"])
def test_unknown_matrix_members_fail_early(field):
    value = matrix_config()
    value["matrix"] = {field: [{"harness": "missing", "model": "one"}]}
    with pytest.raises(ValidationError, match="Unknown harness"):
        ExperimentConfig.model_validate(value)


def test_output_budget_and_secret_url_are_rejected():
    value = matrix_config()
    value["models"]["one"]["max_output_tokens"] = 256000
    with pytest.raises(ValidationError, match="output"):
        ExperimentConfig.model_validate(value)
    value = matrix_config()
    value["models"]["one"]["base_url"] = "https://user:secret@example.test/v1"
    with pytest.raises(ValidationError, match="credentials"):
        ExperimentConfig.model_validate(value)


def test_serialization_round_trip_preserves_resolved_variants():
    config = ExperimentConfig.model_validate(matrix_config())
    restored = ExperimentConfig.model_validate(config.model_dump())
    assert restored == config


def test_opencode_jit_is_a_named_harness_condition_independent_of_model():
    value = matrix_config()
    value["harnesses"] = {
        "native": {"kind": "opencode"},
        "interpreted": {"kind": "opencode", "bun_jit": False},
    }
    config = ExperimentConfig.model_validate(value)
    for model in value["models"]:
        assert config.variants[f"native__{model}"].bun_jit is None
        assert config.variants[f"interpreted__{model}"].bun_jit is False
    assert ExperimentConfig.model_validate(config.model_dump()) == config


@pytest.mark.parametrize("kind", ["synergy", "codex", "pi", "deepseek"])
def test_jit_control_is_rejected_for_unverified_native_runtimes(kind):
    from synergy_bench.config import HarnessProfile

    with pytest.raises(ValueError, match="bun_jit.*opencode"):
        HarnessProfile(kind=kind, bun_jit=False)


@pytest.mark.parametrize("value", ["false", "0", 0, 1])
def test_jit_control_requires_an_explicit_boolean(value):
    from synergy_bench.config import HarnessProfile

    with pytest.raises(ValueError):
        HarnessProfile(kind="opencode", bun_jit=value)


def test_synergy_merge_system_messages_is_a_named_harness_condition():
    from synergy_bench.config import HarnessProfile

    value = matrix_config()
    value["harnesses"] = {
        "baseline": {"kind": "synergy"},
        "merged": {"kind": "synergy", "merge_system_messages": True},
        "explicit": {"kind": "synergy", "merge_system_messages": False},
    }
    config = ExperimentConfig.model_validate(value)
    for model in value["models"]:
        assert config.variants[f"baseline__{model}"].merge_system_messages is None
        assert config.variants[f"merged__{model}"].merge_system_messages is True
        assert config.variants[f"explicit__{model}"].merge_system_messages is False
    assert ExperimentConfig.model_validate(config.model_dump()) == config
    with pytest.raises(ValueError, match="merge_system_messages.*synergy"):
        HarnessProfile(kind="opencode", merge_system_messages=True)
    with pytest.raises(ValueError):
        HarnessProfile(kind="synergy", merge_system_messages="true")


def test_synergy_strip_reasoning_is_a_named_harness_condition():
    from synergy_bench.config import HarnessProfile

    value = matrix_config()
    value["harnesses"] = {
        "baseline": {"kind": "synergy"},
        "stripped": {"kind": "synergy", "strip_reasoning": True},
    }
    config = ExperimentConfig.model_validate(value)
    for model in value["models"]:
        assert config.variants[f"baseline__{model}"].strip_reasoning is None
        assert config.variants[f"stripped__{model}"].strip_reasoning is True
    assert ExperimentConfig.model_validate(config.model_dump()) == config
    with pytest.raises(ValueError, match="strip_reasoning.*synergy"):
        HarnessProfile(kind="pi", strip_reasoning=True)
    with pytest.raises(ValueError):
        HarnessProfile(kind="synergy", strip_reasoning="true")


def test_profile_rejects_unmapped_or_transport_overriding_parameters():
    import pytest

    from synergy_bench.config import HarnessProfile, ModelProfile

    base = dict(
        model="m",
        protocol="chat-completions",
        base_url="https://provider.test/v1",
        api_key_env="KEY",
        context_window=32000,
        max_output_tokens=2048,
    )
    for key in ["max_tokens", "max_output_tokens", "authorization", "n", "typo_temperature"]:
        with pytest.raises(ValueError):
            ModelProfile(**base, parameters={key: 1})
    with pytest.raises(ValueError, match="config"):
        HarnessProfile(kind="pi", config="silently-ignored.json")


def test_task_repeat_counts_are_independent_of_harness_and_model():
    from synergy_bench.config import ExperimentConfig, resolve_plan

    base = {
        "version": 2,
        "suite": "suite.json",
        "harnesses": {"a": {"kind": "pi"}, "b": {"kind": "codex"}},
        "models": {
            "m": {
                "model": "m",
                "protocol": "chat-completions",
                "base_url": "https://provider.test/v1",
                "api_key_env": "KEY",
                "context_window": 32000,
                "max_output_tokens": 2048,
            }
        },
        "repeat": 1,
        "task_repeats": {"s/cert": 3},
    }
    config = ExperimentConfig.model_validate(base)
    schedule = resolve_plan(config, [{"id": "s/cert"}, {"id": "s/other"}])
    assert len(schedule) == 8
    assert len([row for row in schedule if row["task"] == "s/cert"]) == 6
    with pytest.raises(ValueError, match="repeat"):
        resolve_plan(config, [{"id": "s/other"}])


@pytest.mark.parametrize("parameters", [{"reasoning_effort": []}, {"thinking": {"type": {}}}])
def test_invalid_reasoning_parameters_raise_validation_errors(parameters):
    from synergy_bench.config import ModelProfile

    with pytest.raises(ValueError):
        ModelProfile(
            model="m",
            protocol="chat-completions",
            base_url="https://provider.test/v1",
            api_key_env="KEY",
            context_window=100,
            max_output_tokens=10,
            parameters=parameters,
        )


@pytest.mark.parametrize(
    "parameters",
    [
        {"chat_template_kwargs": {"enable_thinking": True, "thinking_budget": 1024}},
        {"chat_template_kwargs": {"enable_thinking": False}},
    ],
)
def test_chat_template_kwargs_accept_valid_shapes(parameters):
    from synergy_bench.config import ModelProfile

    profile = ModelProfile(
        model="m",
        protocol="chat-completions",
        base_url="https://provider.test/v1",
        api_key_env="KEY",
        context_window=100,
        max_output_tokens=10,
        parameters=parameters,
    )
    assert profile.parameters == parameters


@pytest.mark.parametrize(
    "parameters",
    [
        {"chat_template_kwargs": "enabled"},
        {"chat_template_kwargs": {"enable_thinking": "yes"}},
        {"chat_template_kwargs": {"thinking_budget": 1.5}},
        {"chat_template_kwargs": {"thinking_budget": -1}},
        {"chat_template_kwargs": {"unknown_key": True}},
    ],
)
def test_chat_template_kwargs_reject_invalid_shapes(parameters):
    from synergy_bench.config import ModelProfile

    with pytest.raises(ValueError):
        ModelProfile(
            model="m",
            protocol="chat-completions",
            base_url="https://provider.test/v1",
            api_key_env="KEY",
            context_window=100,
            max_output_tokens=10,
            parameters=parameters,
        )
