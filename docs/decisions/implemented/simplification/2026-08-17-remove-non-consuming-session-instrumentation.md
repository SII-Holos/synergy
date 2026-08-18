# Decision Record: Remove non-consuming session instrumentation and test-only surface

Status: implemented

## Problem

The session domain shipped surface that either duplicates an existing API or produces data nothing consumes:

- `SessionSummary.diff` (`packages/synergy/src/session/summary.ts`) duplicated `Session.diff` (`src/session/index.ts`) line-for-line: same `StoragePath.sessionSummary` read, same `SnapshotSchema.normalizeArray`. It also parsed a `messageID` input it never used. The production route `GET /:sessionID/diff` uses `Session.diff` (`src/server/session.ts`); the only consumers of `SessionSummary.diff` were tests (`test/session/summary.test.ts`).
- `LoopJob.backgroundStats()` (`src/session/loop-job.ts`) had no production caller; only `test/session/loop-job.test.ts` read it. The runtime metrics it exposed (`session.loop_job.background.*`) remain catalogued and produced regardless.
- `LLM.collectText` (`src/session/llm.ts`) was used only by `test/session/llm-stream-lifecycle.test.ts`; production stream consumers use `takeFullStream`/`takeTextStream`.
- `RetentionProbe` (`src/session/retention-probe.ts`, 264 lines) tracked released LLM-owner memory via WeakRef/FinalizationRegistry with sweep timers, gated by `SYNERGY_RETENTION_PROBE_ENABLED` which defaulted to **enabled**. Producers were `llm-memory.ts` and `memory-pressure.ts`. Its only outputs were `llm.turn.retention.*` metrics registered in `performance/catalog.ts`; no code reads those series by name (the performance dashboard queries specific rows/keys, not these), and the only consumers of the API were `test/session/retention-probe.test.ts` and the marker assertion in `test/session/llm-memory.test.ts`.

All four were always-on or always-shipped code whose value had no reader.

## Decision

- Deleted `SessionSummary.diff`; the four summary tests now call `Session.diff` (identical observable behavior).
- Deleted `LoopJob.backgroundStats()`; `test/session/loop-job.test.ts` now waits on the job's own execution-completion signal instead of polling background state.
- Deleted `LLM.collectText`; the helper the stream test actually exercises lives in `test/session/llm-stream-util.ts` beside `llm-stream-lifecycle.test.ts`.
- Deleted `retention-probe.ts` and its test, removed the `begin`/`checkReleased`/`trackOwner` call sites from `llm-memory.ts`, `memory-pressure.ts`, `invoke.ts`, and `processor.ts`, and dropped the four `llm.turn.retention.*` catalog entries.

The SYNERGY_TEST_HOME fork in `agent-turn/index.ts` is removed by the separate record `2026-08-17-remove-agent-turn-test-fork.md` (own PR); this cleanup did not touch `agent-turn/index.ts`.

## Alternatives considered

- **Keep the probe but flip the default to disabled** — rejected: a disabled-by-default probe with no metric reader is dormant code; removal is strictly smaller and git history preserves it for future memory-leak investigations.
- **Keep `SessionSummary.diff` for the optional `messageID` input** — rejected: the input was parsed and ignored, so no caller could depend on it; `Session.diff` is the canonical route-backed API.
- **Move `backgroundStats` to a dev-only export** — rejected: an export with a single test consumer is still dead weight; the test asserts via the job's own completion instead.

## Consequences

- The `LLMTurnMemory.handle.trackOwner` surface is gone, so the WeakRef-based retention observability for released LLM-owner memory is gone with it; the GC instrumentation in `memory-pressure.ts` remains and is the production-facing signal. Reintroducing a probe later is cheap because the removed module is in history.
- The summary tests moved from a namespace-qualified API to the route-backed one; if the two implementations drift in the future there is no second copy to catch it, which is the point of the simplification.
- The `LoopJob` background tests now depend on the job lifecycle itself rather than an internal stats snapshot, so they stay honest about completion semantics and keep working if internal state shape changes.
