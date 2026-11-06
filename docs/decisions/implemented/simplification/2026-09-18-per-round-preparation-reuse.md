# Decision Record: Reuse per-round preparation by input identity

Status: implemented

## Problem

The Agent turn loop rebuilds the same derived state on every model round of a session, even when nothing it depends on has changed. Three separate paths re-derive per round:

- **Instruction files.** `InstructionFiles.load()` reads and formats every `AGENTS.md`, override file, configured fallback filename, and explicit `instructions` entry on each assembly of the system prompt. The turn loop assembles the prompt once per round, so a ten-round turn re-read the same unchanged files ten times. Every read is a `stat` plus a full file read plus string formatting, on the critical path before the provider request.
- **Tool availability.** `invoke.ts` called `ToolResolver.definitions()` to build the tool definitions for the prompt and then `ToolResolver.resolveWithAvailability()`, which internally called `availability()` again. Both calls collect the same registry, MCP, and ephemeral sources, so each round performed the collection twice and discarded the first result.
- **Configuration composition.** `Experiment.apply()` composes the live config with runtime overrides and the active snapshot, then runs a full `ConfigSchema.parse` over the merged object. The turn path resolves configuration per round, so an unchanged configuration was re-parsed on every round.

None of the three is a correctness defect on its own, and each is individually small. Together they put repeated file I/O, registry collection, and full schema validation between the user's turn and its first token on every round.

## Decision

Each path memoizes on the identity of its real inputs, so unchanged input reuses work and changed input re-derives. No TTL, no polling, no manual invalidation call.

- **Instruction files** memoize in a `WeakMap` keyed by the `Config.state()` value and the workspace directory. `Config.state()` is a `ScopedState`, so its value is the configuration revision for that scope: a reload replaces it and the memo is discarded with it, which makes staleness structurally impossible rather than time-bounded. Within a revision, each file is additionally revalidated against a `dev:ino:size:mtimeMs:ctimeMs` fingerprint before reuse, because instruction files are workspace content: editing one does not reload the configuration, so serving the memoized text for the rest of a turn would be wrong. Remote instruction URLs are excluded from the memo because they expose no equivalent cheap revalidation.
- **Tool availability** is collected once per round by the caller. `resolveWithAvailability(input, prepared?)` takes an already-collected `Availability` and only calls `availability()` when it is absent, so the turn loop collects definitions once and hands the same result to resolution. The existing `log.time("availability")` and `log.time("resolveWithAvailability")` spans stay where they were, so the caller still measures collection and the callee still measures resolution. Callers that hold no prior availability keep calling it with one argument and self-collect.
- **Configuration composition** memoizes in a three-level `WeakMap` keyed by the live config, the runtime overrides, and the active snapshot. All three are re-created rather than mutated when they change, so object identity is an exact invalidation signal, and weak keys keep the memo proportional to inputs still in use. The `if (!overrides && !snapshot) return live` fast path is preserved.

## Alternatives considered

**A time-based cache for instruction files.** Rejected: a TTL trades a stale-read window against re-read frequency and cannot be set correctly. Too short and rounds still re-read; too long and an edited `AGENTS.md` is ignored for an unbounded number of rounds. Keying on the configuration revision plus a stat fingerprint has no window at all: a reload always invalidates and an edit is always observed.

**A manual invalidation hook on config reload.** Rejected: it requires every reload path to remember to clear the cache, and the paths that replace configuration are not enumerable in one place. Keying on the `Config.state()` value gets the same invalidation from the existing replacement, with nothing to remember.

**Caching instruction files for the lifetime of the runtime.** Rejected outright: instruction files are user-editable workspace content and would be served stale until restart.

**Passing the availability through a module-level variable or an instance field.** Rejected: it would make the round's tool set depend on call order across the module rather than on what the caller holds, and concurrent turns would race on it. An explicit optional parameter keeps the data flow visible at the call site.

**Memoizing the whole resolved tool set rather than the availability.** Rejected: resolution folds in the active tool IDs and per-request runtime input, so its result is not a function of the availability alone. Only the collection is deduplicated.

**Making `Experiment.apply()` a pure function of a serialized key.** Rejected: hashing the composed configuration would cost comparable work to the parse it avoids, and would still need identity semantics for the snapshot. Identity keying is both cheaper and exact.

## Consequences

A round that changes nothing reuses all three derivations, so the repeated work now scales with the number of distinct inputs in a turn rather than the number of rounds. A round that changes any input re-derives normally, which is the common case for a deliberate configuration change and therefore must not be optimized away.

The invalidation signals are all pre-existing replacement points rather than new mechanisms: `Config.state` for the live configuration, `Config.state.reset()`/`resetAll()` for instruction files, `configureRuntime`/`updateRuntime` for overrides, and `Experiment.provide` for snapshots. Nothing new has to remember to invalidate.

`Experiment.apply()` now returns the same object for identical inputs where it previously returned a fresh parse each call. Its one production consumer (`Config.current()`) and its test were audited for identity-sensitive behavior: no consumer mutates the returned object, compares config results by reference, or keys a map by one. The only `delete` on a config object mutates its own argument. The returned shape is unchanged, so only identity differs, and it differs in a way that makes repeated reads cheaper.

`InstructionFiles` gains `stats()` and `resetStatsForTest()` so the reuse and invalidation invariants are assertable rather than inferred. Local file I/O is still paid once per revision per scope per workspace, and a file's fingerprint is checked on every load, so the steady-state cost per round is one `stat` per candidate file rather than a read.

Coverage: `test/session/instruction-files.test.ts` asserts reuse within a turn and refresh after a configuration reload, including that an edit which does not reload config is still observed via fingerprint; `test/session/tool-resolver-availability.test.ts` spies the registry and asserts exactly one collection both when the caller passes the availability and when the resolver self-collects; `test/config/experiment.test.ts` asserts that an unchanged input reuses one parsed object while a changed live config or a different snapshot re-parses.
