from __future__ import annotations

import json
from typing import Any

import yaml

from .config import ModelProfile

# Native interfaces (version pins below are experimental conditions):
# https://learn.chatgpt.com/docs/config-file/config-reference
# https://github.com/anomalyco/opencode/tree/v1.15.13/packages/opencode
# https://github.com/earendil-works/pi/tree/v0.85.1/packages/coding-agent/docs
# https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/bundle/headless
# The default OpenCode pin passes Git-workspace process/usage acceptance; 1.17.20 and
# 1.18.29/30 hung after completed turns in the same fixture. Related upstream report:
# https://github.com/anomalyco/opencode/issues/35870 (same root cause is not established).
PACKAGES = {
    "codex": {"name": "@openai/codex", "version": "0.154.0", "binary": "node_modules/.bin/codex"},
    "opencode": {"name": "opencode-ai", "version": "1.15.13", "binary": "node_modules/.bin/opencode"},
    "pi": {"name": "@earendil-works/pi-coding-agent", "version": "0.85.1", "binary": "node_modules/.bin/pi"},
    "deepseek": {"name": "@deepseek-ai/dsh", "version": "0.1.5-rc.1", "binary": "node_modules/.bin/dsh"},
}


def session_configuration(settings: dict[str, Any], options: dict[str, Any]) -> dict[str, Any]:
    if options["runtime"] != "full" or options.get("experiment"):
        raise ValueError("Session-export releases require full runtime without experiment overlays")
    provider = options["model"].split("/", 1)[0]
    endpoint = settings["provider"][provider]["options"]["baseURL"]
    env = {
        "SYNERGY_HOME": "/logs/agent/home",
        "SYNERGY_CONFIG": options["config"],
        "SYNERGY_CONFIG_CONTENT": "{}",
        "SYNERGY_DISABLE_AUTOUPDATE": "1",
        "SYNERGY_DISABLE_DEFAULT_PLUGINS": "1",
        "SYNERGY_DISABLE_MODELS_FETCH": "1",
        "MODELS_DEV_API_JSON": "/opt/synergy/source/packages/synergy/test/tool/fixtures/models-api.json",
        "BENCH_GATEWAY_BASE": endpoint,
        "BENCH_CAPTURE_DIR": "/logs/agent/home/native-wire",
        # v3.0.22 process-host.ts inherits this in the native agent-turn workers.
        "BUN_OPTIONS": "--preload=/opt/synergy/runtime/session-capture.mjs",
    }
    if options.get("bun_jit") is not None:
        env["BUN_JSC_useJIT"] = str(int(options["bun_jit"]))
    argv = [
        "/opt/synergy/bin/bun",
        "/opt/synergy/source/packages/synergy/src/index.ts",
        "send",
        "--format",
        "json",
        "--model",
        options["model"],
        "--agent",
        options["agent"],
    ]
    if options.get("variant"):
        argv += ["--variant", options["variant"]]
    return {"argv": argv, "env": env, "files": {}}


def harness_configuration(
    kind: str, model: ModelProfile, endpoint: str, home: str, *, bun_jit: bool | None = None
) -> dict[str, Any]:
    files: dict[str, str] = {}
    env: dict[str, str] = {
        "BENCH_GATEWAY_BASE": endpoint,
        "BENCH_CAPTURE_DIR": home + "/native-wire",
        "NODE_USE_ENV_PROXY": "1",
    }
    if bun_jit is not None:
        if kind not in {"synergy", "opencode"} or type(bun_jit) is not bool:
            raise ValueError("bun_jit requires an explicit boolean for synergy or opencode")
        # Provenance: https://github.com/oven-sh/bun/issues/22901
        # Local adaptation: expose Bun's supported override as an explicit experiment
        # condition; do not use the distinct JSC_useJIT variable or auto-detect a fallback.
        env["BUN_JSC_useJIT"] = str(int(bun_jit))
    protocol = "responses" if kind == "codex" else model.protocol
    api = "openai-completions" if protocol == "chat-completions" else "openai-responses"
    name = model.model
    effort = model.parameters.get("reasoning_effort")
    if "reasoning" in model.parameters:
        effort = model.parameters["reasoning"].get("effort", "medium")
    reasoning = effort is not None and effort != "none"
    if "thinking" in model.parameters:
        reasoning = model.parameters["thinking"]["type"] == "enabled"
    if "enable_thinking" in model.parameters:
        reasoning = model.parameters["enable_thinking"]
    model_spec = {
        "id": name,
        "name": name,
        "contextWindow": model.context_window,
        "maxTokens": model.max_output_tokens,
        "reasoning": reasoning,
        "input": ["text"],
        "compat": {"supportsDeveloperRole": model.supports_developer_role},
    }

    def put(path: str, value: Any) -> None:
        files[path] = json.dumps(value, ensure_ascii=False, indent=2)

    if kind in {"synergy", "opencode"}:
        provider = {
            "name": "Benchmark model",
            "npm": "@ai-sdk/openai-compatible" if protocol == "chat-completions" else "@ai-sdk/openai",
            "models": {
                name: {
                    "name": name,
                    "reasoning": reasoning,
                    "tool_call": True,
                    "limit": {"context": model.context_window, "output": model.max_output_tokens},
                }
            },
            "options": {"apiKey": "{env:BENCH_GATEWAY_KEY}", "baseURL": endpoint},
        }
        config: dict[str, Any] = {"provider": {"benchmark": provider}, "model": f"benchmark/{name}"}
        if kind == "synergy":
            config["controlProfile"] = "full_access"
            for role in ["nano", "mini", "mid", "thinking", "long_context", "creative", "vision"]:
                config[f"{role}_model"] = f"benchmark/{name}"
            put("synergy-config.json", config)
            return {"protocol": protocol, "config": config, "files": files, "env": env, "argv": []}
        config.update(
            {
                "small_model": f"benchmark/{name}",
                "permission": "allow",
                "autoupdate": False,
                "enabled_providers": ["benchmark"],
                "plugin": ["file:///opt/synergy/runtime/capture-plugin.mjs"],
            }
        )
        put("opencode.json", config)
        env.update(
            {
                "OPENCODE_CONFIG": home + "/opencode.json",
                "OPENCODE_DISABLE_AUTOUPDATE": "true",
                "OPENCODE_DISABLE_MODELS_FETCH": "true",
                "OPENCODE_PERMISSION": '{"*":"allow"}',
            }
        )
        argv = ["run", "--format", "json", "--model", f"benchmark/{name}"]
    elif kind == "codex":
        quote = json.dumps
        files["codex/config.toml"] = (
            "\n".join(
                [
                    "model = " + quote(name),
                    'model_provider = "benchmark"',
                    'approval_policy = "never"',
                    'sandbox_mode = "danger-full-access"',
                    f"model_context_window = {model.context_window}",
                    "check_for_update_on_startup = false",
                    'web_search = "disabled"',
                    'cli_auth_credentials_store = "file"',
                    "[model_providers.benchmark]",
                    'name = "Benchmark model"',
                    "base_url = " + quote(endpoint),
                    'wire_api = "responses"',
                    'env_key = "BENCH_GATEWAY_KEY"',
                    "requires_openai_auth = false",
                ]
            )
            + "\n"
        )
        env["CODEX_HOME"] = home + "/codex"
        argv = [
            "exec",
            "--json",
            "--skip-git-repo-check",
            "--dangerously-bypass-approvals-and-sandbox",
            "--model",
            name,
        ]
    elif kind == "pi":
        put(
            "pi/models.json",
            {
                "providers": {
                    "benchmark": {
                        "baseUrl": endpoint,
                        "api": api,
                        "apiKey": "$BENCH_GATEWAY_KEY",
                        "models": [model_spec],
                    }
                }
            },
        )
        env["PI_CODING_AGENT_DIR"] = home + "/pi"
        argv = [
            "--mode",
            "json",
            "--print",
            "--extension",
            "/opt/synergy/runtime/capture-pi.mjs",
            "--provider",
            "benchmark",
            "--model",
            name,
        ]
    elif kind == "deepseek":
        env["NODE_OPTIONS"] = "--import /opt/synergy/runtime/capture.mjs"
        profile = {
            "apiKeyEnv": "BENCH_GATEWAY_KEY",
            "api": api,
            "baseURL": endpoint,
            "defaultContextWindow": model.context_window,
            "defaultMaxTokens": model.max_output_tokens,
            "compat": {"supportsDeveloperRole": model.supports_developer_role},
            "models": [
                {
                    "id": name,
                    "name": name,
                    "contextWindow": model.context_window,
                    "maxTokens": model.max_output_tokens,
                    "reasoningEfforts": {"high": "high"} if reasoning else False,
                }
            ],
        }
        files["dsh/settings.yaml"] = yaml.safe_dump(
            {
                "llm-pi-ai": {"providers": {"benchmark": profile}},
                "agent-default-model": {"provider": "benchmark", "model": name},
                "permission": {"defaultPreset": "danger-full-access"},
            },
            sort_keys=False,
        )
        env["DSH_HOME"] = home + "/dsh"
        argv = ["--profile", "headless"]
    else:
        raise ValueError(f"Unknown harness: {kind}")
    return {
        "protocol": protocol,
        "files": files,
        "env": env,
        "argv": ["/opt/synergy/engine/" + PACKAGES[kind]["binary"], *argv],
    }
