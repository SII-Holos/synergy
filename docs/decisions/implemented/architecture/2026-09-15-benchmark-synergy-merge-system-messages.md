# Decision Record: Named system-message merge conditions for strict benchmark endpoints

Status: implemented

## Problem

Strict OpenAI-compatible deployments built on vLLM Qwen chat templates can reject multiple or non-leading system messages with "System message must be at the beginning". Two evaluator surfaces synthesize request shapes that trip this: Synergy's own provider loop, and the Responses bridge that converts Codex's top-level `instructions` plus developer messages into two leading system messages. Synergy providers already expose a `mergeSystemMessages` option, but the benchmark evaluator regenerates the Synergy provider block once at input freeze and again at dispatch, and both writes replace the whole `provider` value, so a harness `config` file cannot add provider options. Without declared conditions, cells against such endpoints fail during native startup or differ from other harnesses in request shape without an experimental record. The first live doctor on a vLLM Qwen3.8-27B endpoint reproduced exactly this split: all six Codex probes failed with two leading system messages while the six Synergy probes passed through the harness condition below and every other harness passed, and the retained run stays read-only evidence.

## Decision

Two named boolean conditions declare the endpoint constraint at the surface that owns each request shape. `harnesses.<name>.merge_system_messages` is Synergy-only in [config.py](../../../../benchmark/src/synergy_bench/config.py): when set, [harnesses.py](../../../../benchmark/src/synergy_bench/harnesses.py) injects the product's existing `mergeSystemMessages` provider option into the generated provider configuration, and [runner.py](../../../../benchmark/src/synergy_bench/runner.py) forwards the variant field at both generation sites. `models.<name>.merge_system_messages` is an endpoint capability in the model profile: when set, [gateway.py](../../../../benchmark/src/synergy_bench/gateway.py) merges leading system messages into one after protocol bridging and the developer-role rewrite, records the capability in every ledger entry, and preserves the native sequence when unset. Both values must be explicit, are rejected on the wrong axis, and mirror the `bun_jit` condition contract; the bridge and the recorded native request bytes remain unchanged.

The [Qwen acceptance preset](../../../../benchmark/configs/qwen38-acceptance.yaml) uses both conditions against a vLLM Qwen3.8-27B endpoint with a 262,144-token declared context and runs OpenCode with its native Bun; the JITless variant remains the Rosetta-specific condition of the GLM presets and is not part of this preset. The [preset launch contract](../../../../benchmark/test/test_experiment_presets.py) verifies that the merge flag reaches the frozen Synergy configuration for the Qwen preset and stays absent for the GLM presets, alongside the existing deadline propagation checks. The [gateway contracts](../../../../benchmark/test/test_gateway.py) cover the merged bridged shape and the preserved default sequence.

Provenance: the product behavior is documented in the [provider schema](../../../../packages/harness/src/config/schema.ts) and applied by [ProviderTransform.message](../../../../packages/harness/src/provider/transform.ts), which merges leading system messages and clamps the system cache breakpoint onto the merged block; the [configuration reference](../../../../packages/runtime-local/src/skill/builtin/synergy-config/references/providers.txt) records the targeted vLLM Qwen chat-template failure.

## Alternatives considered

**Accept a harness `config` overlay for provider options.** Rejected: the evaluator regenerates the provider block at freeze and dispatch, so an overlay would be silently discarded or would bypass the frozen-input verification that keeps measured conditions auditable.

**Change the product default to merge system messages.** Out of scope: this changes every rollout consumer and every provider, not only strict endpoints, and a benchmark change must not alter measured product behavior as a side effect.

**Rewrite system messages unconditionally in the gateway or bridge.** Rejected: an unnamed rewrite would change request semantics for every model, including endpoints that accept the native sequence, and would blur the recorded native request bytes. The gateway applies the declared model capability after bridging and records it in every ledger entry, so the condition stays per model and auditable.

## Consequences

The condition is frozen per experiment and reported as part of the harness axis; omitted cells keep the previous behavior, so historical runs remain read-only and comparable under unchanged conditions. The Qwen preset targets the native `linux/amd64` host with the pinned native CLI versions; model latency under enabled thinking is part of the observed condition, not an evaluator defect. Native failures on strict endpoints remain valid observations when execution and recording are intact.
