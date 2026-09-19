import pytest

from synergy_bench.config import ModelProfile
from synergy_bench.harnesses import PACKAGES, harness_configuration


@pytest.mark.parametrize("kind", ["synergy", "codex", "opencode", "pi", "deepseek"])
@pytest.mark.parametrize("protocol", ["chat-completions", "responses"])
def test_native_configuration_keeps_model_axis_and_environment_credentials(kind, protocol):
    model = ModelProfile(
        model="fixture-two",
        protocol=protocol,
        base_url="http://provider.invalid/v1",
        api_key_env="ACTUAL_PROVIDER_SECRET",
        context_window=64000,
        max_output_tokens=4096,
    )
    value = harness_configuration(kind, model, "http://host.docker.internal:1234/v1", "/logs/agent/home")
    assert "fixture-two" in str(value)
    assert "64000" in str(value)
    assert "ACTUAL_PROVIDER_SECRET" not in str(value)
    assert "BENCH_GATEWAY_KEY" in str(value)
    assert value["protocol"] == ("responses" if kind == "codex" else protocol)
    if kind != "synergy":
        assert PACKAGES[kind]["version"]
        assert value["argv"]


def test_unknown_harness_fails_before_launch():
    model = ModelProfile(
        model="m",
        protocol="responses",
        base_url="https://example.com/v1",
        api_key_env="KEY",
        context_window=1000,
        max_output_tokens=100,
    )
    with pytest.raises(ValueError, match="Unknown harness"):
        harness_configuration("imaginary", model, "http://localhost:1/v1", "/home/fixture")


@pytest.mark.parametrize("enabled", [None, False, True])
def test_opencode_jit_controls_the_native_process_without_changing_model_or_tools(enabled):
    model = ModelProfile(
        model="m",
        protocol="chat-completions",
        base_url="https://provider.test/v1",
        api_key_env="KEY",
        context_window=32000,
        max_output_tokens=2000,
    )
    baseline = harness_configuration("opencode", model, "http://localhost:1/v1", "/home/fixture")
    actual = harness_configuration("opencode", model, "http://localhost:1/v1", "/home/fixture", bun_jit=enabled)
    assert actual["files"] == baseline["files"]
    assert actual["argv"] == baseline["argv"]
    if enabled is None:
        assert "BUN_JSC_useJIT" not in actual["env"]
    else:
        assert actual["env"]["BUN_JSC_useJIT"] == str(int(enabled))


@pytest.mark.parametrize("enabled", [None, False, True])
def test_synergy_merge_system_messages_is_a_named_provider_condition(enabled):
    model = ModelProfile(
        model="m",
        protocol="chat-completions",
        base_url="https://provider.test/v1",
        api_key_env="KEY",
        context_window=32000,
        max_output_tokens=2000,
    )
    baseline = harness_configuration("synergy", model, "http://localhost:1/v1", "/home/fixture")
    actual = harness_configuration(
        "synergy", model, "http://localhost:1/v1", "/home/fixture", merge_system_messages=enabled
    )
    assert actual["protocol"] == baseline["protocol"]
    assert actual["env"] == baseline["env"]
    assert actual["argv"] == baseline["argv"]
    if enabled is None:
        assert actual["config"] == baseline["config"]
    else:
        assert actual["config"]["provider"]["benchmark"]["options"]["mergeSystemMessages"] is enabled


def test_merge_system_messages_is_rejected_for_verified_native_runtimes():
    model = ModelProfile(
        model="m",
        protocol="chat-completions",
        base_url="https://provider.test/v1",
        api_key_env="KEY",
        context_window=32000,
        max_output_tokens=2000,
    )
    with pytest.raises(ValueError, match="merge_system_messages.*synergy"):
        harness_configuration("opencode", model, "http://localhost:1/v1", "/home/fixture", merge_system_messages=True)


@pytest.mark.parametrize("enabled", [None, False, True])
def test_synergy_strip_reasoning_is_a_named_provider_condition(enabled):
    model = ModelProfile(
        model="m",
        protocol="chat-completions",
        base_url="https://provider.test/v1",
        api_key_env="KEY",
        context_window=32000,
        max_output_tokens=2000,
    )
    baseline = harness_configuration("synergy", model, "http://localhost:1/v1", "/home/fixture")
    actual = harness_configuration("synergy", model, "http://localhost:1/v1", "/home/fixture", strip_reasoning=enabled)
    assert actual["protocol"] == baseline["protocol"]
    assert actual["env"] == baseline["env"]
    assert actual["argv"] == baseline["argv"]
    if enabled is None:
        assert actual["config"] == baseline["config"]
    else:
        assert actual["config"]["provider"]["benchmark"]["options"]["stripReasoning"] is enabled


def test_strip_reasoning_is_rejected_for_verified_native_runtimes():
    model = ModelProfile(
        model="m",
        protocol="chat-completions",
        base_url="https://provider.test/v1",
        api_key_env="KEY",
        context_window=32000,
        max_output_tokens=2000,
    )
    with pytest.raises(ValueError, match="strip_reasoning.*synergy"):
        harness_configuration("opencode", model, "http://localhost:1/v1", "/home/fixture", strip_reasoning=True)


@pytest.mark.parametrize("kind", ["pi", "deepseek"])
def test_native_provider_can_explicitly_disable_developer_role(kind):
    model = ModelProfile(
        model="m",
        protocol="chat-completions",
        base_url="https://provider.test/v1",
        api_key_env="KEY",
        context_window=32000,
        max_output_tokens=2000,
        supports_developer_role=False,
    )
    config = harness_configuration(kind, model, "http://localhost:1/v1", "/home/fixture")
    assert "supportsDeveloperRole" in str(config["files"])
    assert "false" in str(config["files"])
