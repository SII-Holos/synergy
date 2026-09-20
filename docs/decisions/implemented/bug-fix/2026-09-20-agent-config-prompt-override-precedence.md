# Decision Record: Config agent prompt overrides take precedence over native builders

Status: implemented

## Problem

`agent["synergy-flash"].prompt` — and the same field on every built-in primary agent — was silently discarded. `Agent.state()` merges config agents first (`item.prompt = value.prompt ?? item.prompt`), but the native prompt builders at the end of the resolution unconditionally overwrite `result[name].prompt` for the built-ins, so any config prompt for a built-in primary was dead configuration. Discovered when the benchmark's folded-tool-surface arm needed a prompt matching its reduced tool list: the override never reached the wire, leaving stale tool references in the live prompt.

## Decision

The config merge loop records every entry that sets `prompt` in a `configPromptOverrides` set ([agent.ts](../../../../packages/harness/src/agent/agent.ts)), and each native builder skips agents recorded there. Built-ins keep their generated prompts unless a config prompt explicitly replaces them — the same replacement semantics every other `agent.<name>` field already has. The [flash agent contract](../../../../packages/harness/test/agent/synergy-flash.test.ts) pins that a config override survives resolution and the built-in text is absent.

## Alternatives considered

**Append or template the override into the native prompt.** Rejected: a config prompt is a replacement under the merge loop's own `??` semantics, and appending would make "remove generated guidance" impossible — the benchmark use case requires exactly that.

**Fix in the benchmark via a copy agent under a new name.** Rejected: a config-defined copy would lose the native permission/deferredTools wiring and fragment the agent surface.

**Leave it and fork the agent in product code.** Rejected: prompt customization is a documented config field; making it inert for built-ins is a bug, not a contract.

## Consequences

Configs that set `prompt` on built-in primaries change behavior with this fix — such configs were inert before, so the affected population is configurations written but never effective. The benchmark core-surface presets ([qwen38-iter-r8](../../../../benchmark/configs/qwen38-iter-r8.yaml)) depend on this fix; synergy bundles built from this revision forward carry it, and the paired iteration preset measures the prompt's effect with the tool surface held constant.
