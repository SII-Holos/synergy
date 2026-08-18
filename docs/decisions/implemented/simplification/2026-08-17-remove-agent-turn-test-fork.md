# Decision Record: Remove the SYNERGY_TEST_HOME fork from AgentTurn.stream

Status: implemented

## Problem

`packages/synergy/src/session/agent-turn/index.ts` shipped a second stream implementation selected by the `SYNERGY_TEST_HOME` env var: it called `LLM.stream` in-process, projected text into synthetic `"test-text"` deltas, and bypassed the worker pool entirely. Consequences:

- Tests (`test/preload.ts` sets `SYNERGY_TEST_HOME` for every test file) never exercised the production stream path (pool + `prepared.system` + `FrameStream`), while production never exercised the fork.
- The fork embedded test-only semantics in production code (synthetic `"test-text"` ids, a noop `dispose` in one sub-case).
- The same file also carried `AgentTurn.collectText` with zero callers in src or tests.

`SYNERGY_TEST_HOME` itself must stay: `src/global/index.ts` (Path.root), `src/provider/models-macro.ts` (build-time), and `src/plugin/marketplace-registry.ts` depend on it.

## Decision

The env fork was removed from the production stream path and replaced with a narrow, explicit test-only hook:

- `index.ts` deletes the `SYNERGY_TEST_HOME` branch; `stream()` performs the admission check, delegates to the registered in-process hook when present, and otherwise runs the pool path (existing code unchanged). `AgentTurn.setInProcessStream(hook | undefined)` registers the hook.
- New module `agent-turn/in-process.ts` carries the old fork body verbatim (`LLM.stream` in-process, the three projection sub-cases, usage catch, dispose handling) exported as `runInProcessStream`. Production `index.ts` does not import it.
- `startContextUsageDraft` moved into the shared module `agent-turn/context-usage-draft.ts`, used by both the pool path (with `prepared.system`) and the hook (with raw `input.system`); behavior is unchanged.
- `test/preload.ts` registers the hook after setting the test home (`AgentTurn.setInProcessStream(runInProcessStream)`). Behavior of every existing fork-using test (`test/agent/call.test.ts` mocks `LLM.stream`/`LLM.takeTextStream`) is unchanged.
- `test/session/agent-turn.test.ts` replaces its `delete process.env.SYNERGY_TEST_HOME` with `AgentTurn.setInProcessStream(undefined)` to reach the pool path, restoring the hook in `finally`.
- `AgentTurn.collectText` was deleted (zero callers).

Worker processes inherit `SYNERGY_TEST_HOME` but never consulted the fork (`runner.ts` runs the full product path); no worker-side change was needed.

## Alternatives considered

- **Run all tests against the real worker pool** — rejected: workers need a working provider inside the spawned process plus `ScopeContext` wiring for every call-style test; it would rewrite test infrastructure far beyond this cleanup.
- **Keep the fork but select it by env inside a test-only module** — rejected: that still keeps an env-sensitive branch reachable from production; the explicit hook makes the seam visible and defaults to undefined in production.
- **Delete the fork outright and re-mock at the `AgentTurn.stream` boundary in tests** — rejected: churns mocks across tests for no behavioral gain; the hook keeps the same seam the mocks already target (`LLM.stream`/`LLM.takeTextStream`).

## Consequences

- The `packages/synergy` suites stay green: `test/agent/call.test.ts`, `test/session/agent-turn.test.ts`, `agent-turn-protocol`, `llm-stream-lifecycle`, `agent-worker-pool`, `agent-worker-process`, `agent-worker-runtime-boundary`, `restart-while-queued`, `test/server/shutdown-admission.test.ts`.
- No `SYNERGY_TEST_HOME` reference remains in `src/session/agent-turn/**`; `"test-text"` appears only inside the in-process module.
- The production stream path contains no env check; the pool path is unchanged; the moved fork body keeps coverage via the preload-registered hook.
- Cost: the hook is a test-only seam registered in preload; a future test that forgets to unregister it (as `agent-turn.test.ts` must) would silently keep the in-process path. Mitigated by the explicit `setInProcessStream(undefined)` pattern and the comment in `preload.ts`.
- Cost: `startContextUsageDraft` now lives in a shared module; the pool path uses `prepared.system` and the hook uses raw `input.system`, verified by existing tests.
