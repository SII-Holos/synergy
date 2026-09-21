from pathlib import Path
from types import SimpleNamespace

import pytest

from synergy_bench.config import load_config, resolve_plan
from synergy_bench.gateway import Gateway
from synergy_bench.harnesses import harness_configuration
from synergy_bench.runner import trial_configuration
from synergy_bench.storage import atomic_json, read_json


def test_boyue_comparison_uses_release_baseline_and_native_output_limit(tmp_path):
    config = load_config(Path(__file__).parents[1] / "configs/coding-observations-boyue.yaml")
    assert config.harnesses["baseline"].source.revision == "024dd683e091d9fce3d1d26b79b2e188ce636b52"
    assert config.preflight_timeout_seconds == 600
    model = config.models["boyue-deepseek41flash-no-thinking"]
    settings = harness_configuration("synergy", model, "http://gateway.invalid/v1", "/home/fixture")["config"]
    spec = settings["provider"]["benchmark"]["models"][model.model]
    assert spec["limit"] == {"context": 1000000, "output": 393216}
    assert spec["reasoning"] is False
    for role in ["nano", "mini", "mid", "thinking", "long_context", "creative", "vision"]:
        assert settings[f"{role}_model"] == settings["model"]
    payload, _ = Gateway(model, tmp_path).effective(
        {"model": model.model, "messages": [], "max_tokens": 8192, "reasoning_effort": "high"},
        "chat-completions",
    )
    assert payload["max_tokens"] == 393216
    assert payload["enable_thinking"] is False
    assert "reasoning_effort" not in payload


@pytest.mark.parametrize("protocol", ["synergy-session-v1", "synergy-rollout-v1"])
@pytest.mark.parametrize("task_deadline", ["native", 900])
def test_preflight_deadline_reaches_both_launchers_without_changing_formal_trials(tmp_path, protocol, task_deadline):
    from synergy_bench.config import ExperimentConfig, Variant

    variant = Variant(model="benchmark/fixture", runtime="full", agent="synergy-max", bun_jit=True)
    root = tmp_path / "run-12345678"
    atomic_json(
        root / "inputs/native/config.json",
        {"provider": {"benchmark": {"options": {"baseURL": "http://fixture.invalid/v1"}}}},
    )
    config = ExperimentConfig(version=1, suite="fixture.json", variants={"native": variant})
    task = {"local_path": str(tmp_path / "task"), "agent_seconds": 90}
    plan = {
        "config": {**config.model_dump(), "timeout_seconds": task_deadline, "preflight_timeout_seconds": 600},
        "cache": str(tmp_path / "cache"),
        "variants": {
            "native": {
                **variant.model_dump(),
                "artifact": str(tmp_path),
                "artifact_id": "fixture",
                "runtime_protocol": protocol,
            }
        },
        "tasks": {"task": task},
    }
    for probe in [True, False]:
        attempt = root / ("probes" if probe else "trials") / "0000/attempt-001"
        trial, _, _ = trial_configuration(
            root,
            plan,
            {"variant": "native", "task": "task"},
            attempt,
            probe_instruction="Run the connectivity marker" if probe else None,
        )
        expected = 600 if probe else 90 if task_deadline == "native" else task_deadline
        assert read_json(attempt / "inputs/options.json")["timeout_seconds"] == expected
        assert trial.agent.override_timeout_sec == (
            expected + config.startup_timeout_seconds + config.cleanup_seconds + config.export_timeout_seconds + 15
        )
        assert trial.verifier.disable is probe
        assert trial.verifier.override_timeout_sec is None
        assert task["agent_seconds"] == 90


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


def test_session_release_uses_its_native_cli_and_inherited_capture(tmp_path):
    from synergy_bench.config import ExperimentConfig, Variant

    variant = Variant(model="benchmark/fixture", runtime="full", agent="synergy-max", bun_jit=True)
    root = tmp_path / "run-12345678"
    atomic_json(
        root / "inputs/release/config.json",
        {"provider": {"benchmark": {"options": {"baseURL": "http://fixture.invalid/v1"}}}},
    )
    plan = {
        "config": ExperimentConfig(version=1, suite="fixture.json", variants={"release": variant}).model_dump(),
        "cache": str(tmp_path / "cache"),
        "variants": {
            "release": {
                **variant.model_dump(),
                "artifact": str(tmp_path),
                "artifact_id": "fixture",
                "runtime_protocol": "synergy-session-v1",
            }
        },
        "tasks": {"task": {"local_path": str(tmp_path / "task"), "agent_seconds": 90}},
    }
    attempt = root / "trials/0000/attempt-001"
    trial, _, _ = trial_configuration(root, plan, {"variant": "release", "task": "task"}, attempt)
    options = read_json(attempt / "inputs/options.json")
    native = options["native"]
    assert native["argv"] == [
        "/opt/synergy/bin/bun",
        "/opt/synergy/source/packages/synergy/src/index.ts",
        "send",
        "--format",
        "json",
        "--model",
        "benchmark/fixture",
        "--agent",
        "synergy-max",
    ]
    assert native["env"]["SYNERGY_HOME"] == "/logs/agent/home"
    assert native["env"]["BUN_OPTIONS"] == "--preload=/opt/synergy/runtime/session-capture.mjs"
    assert native["env"]["BENCH_GATEWAY_BASE"] == "http://fixture.invalid/v1"
    assert native["env"]["BUN_JSC_useJIT"] == "1"
    assert trial.agent.kwargs["settings"]["runtime_protocol"] == "synergy-session-v1"
