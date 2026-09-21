from pathlib import Path
from types import SimpleNamespace

import pytest

from synergy_bench.config import load_config, resolve_plan
from synergy_bench.runner import trial_configuration
from synergy_bench.storage import atomic_json, read_json


@pytest.mark.parametrize("filename", ["glm53-acceptance.yaml", "glm53-long-session.yaml"])
def test_comparison_presets_keep_the_five_harness_sampling_population(filename):
    path = Path(__file__).parents[1] / "configs" / filename
    config = load_config(path)
    tasks = read_json(path.parent / config.suite)["tasks"]
    assert len(resolve_plan(config, tasks)) == 50
    assert {variant.harness for variant in config.variants.values()} == {
        "synergy",
        "codex",
        "opencode",
        "pi",
        "deepseek",
    }


@pytest.mark.parametrize(
    "path", sorted((Path(__file__).parents[1] / "configs").glob("*.yaml")), ids=lambda path: path.name
)
@pytest.mark.parametrize("native_seconds", [900, 10800])
def test_preset_deadlines_reach_every_native_launch_without_changing_verifier(tmp_path, path, native_seconds):
    config = load_config(path)
    tasks = read_json(path.parent / config.suite)["tasks"]
    schedule = resolve_plan(config, tasks)
    assert schedule
    expected = native_seconds if config.timeout_seconds == "native" else config.timeout_seconds
    root = tmp_path / "run-12345678"
    for name, variant in config.variants.items():
        atomic_json(root / "inputs" / name / "config.json", {})
        task = {"local_path": str(tmp_path / "task"), "agent_seconds": native_seconds}
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
        assert options["bun_jit"] == variant.bun_jit
        assert trial.agent.kwargs["settings"]["bun_jit"] == variant.bun_jit
        assert (
            trial.agent.override_timeout_sec
            == expected + config.startup_timeout_seconds + config.cleanup_seconds + config.export_timeout_seconds + 15
        )
        assert trial.verifier.override_timeout_sec is None
        assert not trial.verifier.disable
        assert task["agent_seconds"] == native_seconds
        if variant.harness == "opencode":
            env = options["native"]["env"]
            if variant.bun_jit is None:
                assert "BUN_JSC_useJIT" not in env
            else:
                assert env["BUN_JSC_useJIT"] == str(int(variant.bun_jit))


@pytest.mark.parametrize(
    "path", sorted((Path(__file__).parents[1] / "configs").glob("*.yaml")), ids=lambda path: path.name
)
def test_thinking_presets_declare_their_reasoning_tier(path):
    config = load_config(path)
    for key, model in config.models.items():
        if not (
            model.parameters.get("thinking", {}).get("type") == "enabled"
            or model.parameters.get("enable_thinking") is True
        ):
            continue
        assert model.parameters.get("reasoning_effort"), (
            f"{path.name}:{key} enables thinking without declaring reasoning_effort; "
            "the reasoning tier would come from the provider default instead of the experiment"
        )


@pytest.mark.parametrize("enabled", [None, False, True])
def test_synergy_jit_condition_reaches_launcher_without_becoming_a_credential_reference(tmp_path, enabled):
    from synergy_bench.config import ExperimentConfig, Variant

    variant = Variant(model="fixture/model", bun_jit=enabled)
    root = tmp_path / "run-12345678"
    atomic_json(root / "inputs/synergy/config.json", {})
    plan = {
        "config": ExperimentConfig(version=1, suite="fixture.json", variants={"synergy": variant}).model_dump(),
        "cache": str(tmp_path / "cache"),
        "variants": {"synergy": {**variant.model_dump(), "artifact": str(tmp_path), "artifact_id": "fixture"}},
        "tasks": {"task": {"local_path": str(tmp_path / "task"), "agent_seconds": 90}},
    }
    attempt = root / "trials/0000/attempt-001"
    trial, _, _ = trial_configuration(root, plan, {"variant": "synergy", "task": "task"}, attempt)
    assert trial.agent.kwargs["settings"]["bun_jit"] is enabled
    assert trial.agent.kwargs["settings"]["env"] == {}
    assert read_json(attempt / "inputs/options.json")["bun_jit"] is enabled
