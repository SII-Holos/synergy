from pathlib import Path
from types import SimpleNamespace

import pytest

from synergy_bench.config import load_config, resolve_plan
from synergy_bench.runner import trial_configuration
from synergy_bench.storage import atomic_json, read_json


@pytest.mark.parametrize("filename", ["glm53-acceptance.yaml", "glm53-long-session.yaml", "glm53-full-local24.yaml"])
@pytest.mark.parametrize("native_seconds", [900, 10800])
@pytest.mark.parametrize("probe", [False, True])
def test_preset_deadlines_reach_every_native_launch_without_changing_verifier(
    tmp_path, filename, native_seconds, probe
):
    path = Path(__file__).parents[1] / "configs" / filename
    config = load_config(path)
    tasks = read_json(path.parent / config.suite)["tasks"]
    schedule = resolve_plan(config, tasks)
    full = filename == "glm53-full-local24.yaml"
    assert len(schedule) == (120 if full else 50)
    if full:
        assert len({item["task"] for item in schedule}) == 24
        assert config.harnesses["synergy-max-full"].runtime == "full"
        assert config.harnesses["synergy-max-full"].agent == "synergy-max"
    assert {variant.harness for variant in config.variants.values()} == {
        "synergy",
        "codex",
        "opencode",
        "pi",
        "deepseek",
    }
    expected = native_seconds if filename == "glm53-acceptance.yaml" else 10800
    if probe:
        expected = 900 if full else 120
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
            probe_instruction="Run the tool probe" if probe else None,
        )
        options = read_json(attempt / "inputs/options.json")
        assert options["timeout_seconds"] == expected
        assert (
            trial.agent.override_timeout_sec
            == expected + config.startup_timeout_seconds + config.cleanup_seconds + config.export_timeout_seconds + 15
        )
        assert trial.verifier.override_timeout_sec is None
        assert trial.verifier.disable == probe
        assert task["agent_seconds"] == native_seconds
        if variant.harness == "opencode":
            env = options["native"]["env"]
            if filename != "glm53-acceptance.yaml":
                assert name == "opencode-jitless__glm53flash"
                assert env["BUN_JSC_useJIT"] == "0"
            else:
                assert "BUN_JSC_useJIT" not in env
