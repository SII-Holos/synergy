# Decision Record: Declare the model reasoning tier as an explicit benchmark condition

Status: implemented

## Problem

A model profile can enable thinking without naming a reasoning tier. The GLM presets declared `thinking: {type: enabled, clear_thinking: false}` and omitted `reasoning_effort`, so the tier that produced a score came from the provider's current default rather than from the experiment.

[GLM-5.3](https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3) always reasons, accepts only `thinking.type: enabled`, and exposes three tiers through `reasoning_effort` — `low`, `high`, `max` — with `max` as the provider default. An omitted parameter therefore selects the deepest tier silently, and a reader of the retained evidence cannot distinguish that choice from an unconsidered one.

The defect is visible in the first full-suite run of `synergy-max-full`. Its frozen `plan.json` recorded `parameters` without `reasoning_effort`, so the run's own evidence did not state which tier produced its rewards. Reasoning consumed 1,545,020 of 1,880,753 output tokens (82.1%) and request latency reached p90 92s / p95 169s, which is consistent with the deepest tier but does not prove it. Paired comparison requires matching conditions; a parameter that no run records cannot be checked for equality, and the variant name that identifies a run carried no tier either.

## Decision

Model presets name the tier in the model key and set it explicitly. Every shipped preset declares `reasoning_effort: max` beside the `thinking` block, and the GLM model key is `glm53flash-max`, so a variant identifies its tier as `synergy-max-full__glm53flash-max`.

Defining the tier in the profile is what reaches every artifact: [config.py](../../../../benchmark/src/synergy_bench/config.py) validates `reasoning_effort` against its allowed set, [harnesses.py](../../../../benchmark/src/synergy_bench/harnesses.py) treats a declared reasoning parameter as the capability signal, the tier is frozen into `plan.json`, the [gateway](../../../../benchmark/src/synergy_bench/gateway.py) forwards the parameter verbatim, and the [protocol bridge](../../../../benchmark/src/synergy_bench/bridge.py) maps it to the wire control of the target protocol. The parameter is therefore recorded in the request ledger as an effective value with its native counterpart.

[Preset launch contracts](../../../../benchmark/test/test_experiment_presets.py) assert that a preset which enables thinking states its tier, so an omitted parameter cannot silently return. The tier joins harness kind, package version, frozen source, runtime composition and native task inputs as a named condition. A new tier is a new named condition that produces its own evidence; it never reinterprets a completed run.

Provenance: [GLM-5.3 tier parameters and default](https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3).

## Alternatives considered

**Keep relying on the provider default.** The cheapest option, and it produced a working run. It loses because the recorded evidence cannot state its own condition: the default is documented as `max` today and may change with the model, while `plan.json`, the variant name and the report would keep the same shape either way. A condition that no artifact records cannot be matched in a paired comparison, and a reader cannot tell a deliberate choice from an oversight.

**Record the tier only in a comment beside the parameter.** A comment documents intent for a human reading the YAML, but it is not parsed, does not reach `plan.json` or the variant name, and cannot be asserted by a test. The run's own evidence would still omit its tier, so it does not fix the defect it appears to describe.

**Add a tier field inside the `thinking` object.** The `thinking` schema accepts only `type` and `clear_thinking`, and those map to the provider's enable switch rather than to its reasoning depth. The provider exposes depth through `reasoning_effort`, so a parallel field would either duplicate that control or invent a vocabulary the endpoint does not read.

**Change only the local full-suite configuration.** The immediate run would be labelled while the shipped presets kept producing unlabelled evidence, which leaves the documented entry points as the least inspectable configurations in the repository. The fix belongs to the presets because they are what a new experiment copies.

## Consequences

The tier is now inspectable in three independent places — the model key and variant name, the frozen `plan.json`, and the effective request parameters in the ledger — so a later reader can state which condition produced a score without trusting prose.

Renaming the model key changes every variant name derived from it. Paths, assertions and reports keyed on the previous name refer to the historical condition and must be mapped explicitly rather than rewritten; the completed full-suite run keeps the key it was executed under, and its archived evidence records the tier it actually used.

Declaring the deepest tier makes the most expensive condition the default for these presets. That cost is now visible and separable: a cheaper tier is a distinct named condition with its own evidence, and matched comparisons can quantify what the tier buys instead of attributing its effect to the model or the harness.
