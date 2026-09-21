# Decision Record: Expose Synergy Bun JIT as a frozen benchmark condition

Status: implemented

## Problem

Native Synergy sessions can stop progressing under Linux amd64 emulation on an ARM Docker host after successful short preflights. An explicit JIT control exists for OpenCode, but Synergy cannot declare the equivalent condition. Changing the host environment or restarting an existing attempt with a different runtime would make the experiment identity inaccurate. Similar thread waits are documented in the [native runtime investigation](../../../postmortem/0013-short-native-probes-missed-opencode-rosetta-stalls.md).

## Decision

Allow the strict optional `bun_jit` boolean for Synergy and OpenCode. Preserve native defaults when absent. Freeze the value in the named harness variant and per-attempt launch options. Synergy applies `BUN_JSC_useJIT` before launching its Bun wrapper, so the native CLI, workers and export processes inherit it. Preserve the environment's inference proxy and keep credential references separate from this literal runtime value. OpenCode retains its existing native environment path; other harnesses reject the option.

Changing the option creates a separate experimental condition. Retain original failures and costs, never switch an active attempt, and compare product revisions only with matching runtime settings. A passing interpreted run establishes a usable execution condition, not the internal cause or repair of the upstream runtime stall.

## Alternatives considered

**Disable JIT globally or automatically after a stall.** This silently changes measured runtime and latency conditions and obscures the original failure.

**Change the prepared product bundle.** The evaluator can set the environment before Bun starts, preserving immutable product artifacts and their provenance. Modifying product source solely for evaluation is unnecessary.

**Accept short preflight success.** Short tool roundtrips do not exercise the native execution length where stalls appeared. Deterministic native controls must retain at least 120 tool roundtrips, effective tool subprocess settings, terminal execution, native grading and complete usage for two models over both supported protocols.

## Consequences

The control enables an explicit paired evaluation on affected hosts without changing prompts, tools, model controls or task deadlines. Interpreted execution can change performance; results cannot be pooled with default-JIT runs. Native long-session acceptance remains bounded evidence, so later real-task failures must still be retained and investigated.
