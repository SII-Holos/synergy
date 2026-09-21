from pathlib import Path
from types import SimpleNamespace

import pytest

from synergy_bench.config import load_config, resolve_plan
from synergy_bench.runner import trial_configuration
from synergy_bench.storage import atomic_json, read_json

PRESETS = {
    "glm53-acceptance.yaml": {"timeout": None, "model": "glm53flash", "jitless": False, "merge": False},
    "glm53-long-session.yaml": {"timeout": 10800, "model": "glm53flash", "jitless": True, "merge": False},
    "qwen38-acceptance.yaml": {"timeout": None, "model": "qwen38", "jitless": False, "merge": True},
}


@pytest.mark.parametrize("filename", sorted(PRESETS))
@pytest.mark.parametrize("native_seconds", [900, 10800])
def test_preset_deadlines_and_suite_verifier_budgets_reach_every_native_launch(tmp_path, filename, native_seconds):
    preset = PRESETS[filename]
    path = Path(__file__).parents[1] / "configs" / filename
    config = load_config(path)
    tasks = read_json(path.parent / config.suite)["tasks"]
    schedule = resolve_plan(config, tasks)
    assert len(schedule) == 50
    assert {variant.harness for variant in config.variants.values()} == {
        "synergy",
        "codex",
        "opencode",
        "pi",
        "deepseek",
    }
    expected = preset["timeout"] or native_seconds
    root = tmp_path / "run-12345678"
    for name, variant in config.variants.items():
        atomic_json(root / "inputs" / name / "config.json", {})
        task = {"local_path": str(tmp_path / "task"), "agent_seconds": native_seconds, "verifier_seconds": 2400}
        plan = {
            "config": config.model_dump(),
            "cache": str(tmp_path / "cache"),
            "variants": {
                name: {**variant.model_dump(), "artifact": str(tmp_path / "artifact"), "artifact_id": "fixture"}
            },
            "tasks": {"task": task},
        }
        attempt = root / "trials" / name / "attempt-001"
        trial, _, _ = trial_configuration(
            root,
            plan,
            {"variant": name, "task": "task"},
            attempt,
            gateway=SimpleNamespace(
                model=variant.model_profile, url="http://gateway.invalid:8080/v1", advertised="gateway.invalid"
            ),
            reference="FIXTURE_GATEWAY_KEY",
        )
        options = read_json(attempt / "inputs/options.json")
        assert options["timeout_seconds"] == expected
        assert (
            trial.agent.override_timeout_sec
            == expected + config.startup_timeout_seconds + config.cleanup_seconds + config.export_timeout_seconds + 15
        )
        assert trial.verifier.override_timeout_sec == 2400
        assert not trial.verifier.disable
        assert task["agent_seconds"] == native_seconds
        if variant.harness == "opencode":
            env = options["native"]["env"]
            if preset["jitless"]:
                assert name == f"opencode-jitless__{preset['model']}"
                assert env["BUN_JSC_useJIT"] == "0"
            else:
                assert "BUN_JSC_useJIT" not in env
        if variant.harness == "synergy":
            settings = read_json(attempt / "inputs/config.json")
            merged = settings["provider"]["benchmark"]["options"].get("mergeSystemMessages")
            assert (merged is True) == preset["merge"]


def test_probe_trials_get_an_independent_diagnostic_budget_without_touching_scoring(tmp_path):
    path = Path(__file__).parents[1] / "configs" / "qwen38-acceptance.yaml"
    config = load_config(path)
    root = tmp_path / "run-12345678"
    name, variant = next(iter(config.variants.items()))
    atomic_json(root / "inputs" / name / "config.json", {})
    task = {"local_path": str(tmp_path / "task"), "agent_seconds": 900}
    plan = {
        "config": config.model_dump(),
        "cache": str(tmp_path / "cache"),
        "variants": {name: {**variant.model_dump(), "artifact": str(tmp_path / "artifact"), "artifact_id": "fixture"}},
        "tasks": {"task": task},
    }
    gateway = SimpleNamespace(
        model=variant.model_profile, url="http://gateway.invalid:8080/v1", advertised="gateway.invalid"
    )
    probe_trial, _, _ = trial_configuration(
        root,
        plan,
        {"variant": name, "task": "task"},
        root / "trials" / name / "attempt-001",
        gateway=gateway,
        reference="FIXTURE_GATEWAY_KEY",
        probe_instruction="printf PROBE_MARKER",
    )
    probe_options = read_json(root / "trials" / name / "attempt-001" / "inputs" / "options.json")
    assert probe_options["timeout_seconds"] == 300
    assert probe_trial.verifier.disable
    scoring_trial, _, _ = trial_configuration(
        root,
        plan,
        {"variant": name, "task": "task"},
        root / "trials" / name / "attempt-002",
        gateway=gateway,
        reference="FIXTURE_GATEWAY_KEY",
    )
    scoring_options = read_json(root / "trials" / name / "attempt-002" / "inputs" / "options.json")
    assert scoring_options["timeout_seconds"] == 900
    assert not scoring_trial.verifier.disable
    assert (
        scoring_trial.agent.override_timeout_sec
        == 900 + config.startup_timeout_seconds + config.cleanup_seconds + config.export_timeout_seconds + 15
    )


@pytest.mark.parametrize("suite_agent_seconds,suite_verifier_seconds", [(900, 2400), (1200, 1200), (3600, 1800)])
def test_r9_pairs_native_flash_sources_with_declared_suite_budgets(
    tmp_path, suite_agent_seconds, suite_verifier_seconds
):
    path = Path(__file__).parents[1] / "configs" / "qwen38-iter-r9.yaml"
    config = load_config(path)
    tasks = read_json(path.parent / config.suite)["tasks"]
    schedule = resolve_plan(config, tasks)
    assert len(schedule) == 10
    assert config.seed == 20260922
    assert config.concurrency == 2
    assert config.repeat == 1
    assert not config.task_repeats
    assert config.timeout_seconds is None
    baseline = config.harnesses["flash-baseline"]
    candidate = config.harnesses["flash-routing"]
    assert baseline.source.revision == "3d00b6b1840b454fd446cde670d8a929d50c938c"
    assert candidate.source.revision is None
    assert baseline.model_dump(exclude={"source"}) == candidate.model_dump(exclude={"source"})
    assert baseline.runtime == "core"
    assert baseline.agent == "synergy-flash"
    assert baseline.config is None and baseline.experiment is None
    model = config.models["qwen38"]
    assert model.parameters == {
        "temperature": 0.6,
        "top_p": 0.95,
        "reasoning_effort": "high",
        "thinking": {"type": "enabled", "clear_thinking": False},
    }
    assert model.base_url == "https://inference.example.invalid/v1"
    assert model.context_window == 262144 and model.max_output_tokens == 65536
    for offset in range(0, len(schedule), 2):
        left, right = schedule[offset : offset + 2]
        assert (left["pair"], left["task"], left["repeat"]) == (right["pair"], right["task"], right["repeat"])
        assert {left["harness"], right["harness"]} == {"flash-baseline", "flash-routing"}
    root = tmp_path / "run-12345678"
    for name, variant in config.variants.items():
        atomic_json(root / "inputs" / name / "config.json", {})
        plan = {
            "config": config.model_dump(),
            "cache": str(tmp_path / "cache"),
            "variants": {
                name: {**variant.model_dump(), "artifact": str(tmp_path / "artifact"), "artifact_id": "fixture"}
            },
            "tasks": {
                "task": {
                    "local_path": str(tmp_path / "task"),
                    "agent_seconds": suite_agent_seconds,
                    "verifier_seconds": suite_verifier_seconds,
                }
            },
        }
        attempt = root / "trials" / name / "attempt-001"
        trial, _, _ = trial_configuration(
            root,
            plan,
            {"variant": name, "task": "task"},
            attempt,
            gateway=SimpleNamespace(model=model, url="http://gateway.invalid:8080/v1", advertised="gateway.invalid"),
            reference="FIXTURE_GATEWAY_KEY",
        )
        options = read_json(attempt / "inputs/options.json")
        settings = read_json(attempt / "inputs/config.json")
        assert options["agent"] == "synergy-flash"
        assert options["timeout_seconds"] == suite_agent_seconds
        assert trial.verifier.override_timeout_sec == suite_verifier_seconds
        assert not trial.verifier.disable
        assert settings["provider"]["benchmark"]["options"]["mergeSystemMessages"] is True
        assert "agent" not in settings
