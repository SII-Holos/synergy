# Continue returned before its scheduled owner completed

## Executive summary

An in-process Continue could return handled while the same admitted task was still running. Native admission had already scheduled the task, and the convenience operation treated an early wake return as completed execution. It must also await that Session’s current completion and lease release.

## Summary

The independent-root integration failed after reinstall and materialization: Continue returned true while only the interrupted model request had been prepared. That observation suggested a waiting defect but did not identify the owner that won scheduling. A controlled reproduction then held the original provider after the real scheduled wake acquired the Session and observed the explicit convenience wake return.

## Timeline

- Exact-head CI reached the independent-root Continue assertions and observed one model preparation where completed continuation required another. Its complementary materialize-before-reinstall case passed.
- The first controlled fixture waited for a namespace export spy that could not observe the internal lexical wake. It timed out before the semantic oracle and was not a product RED.
- The corrected control reached its semantic assertions, but its cleanup awaited the already-returned convenience promise instead of the genuine background owner. Runtime disposal then hid the assertion behind a framework timeout; that run was not accepted as a product RED.
- Releasing and draining the original owner inside the live Runtime exposed the intended failure in thirteen assertions: the owner remained running while Continue was already settled.
- The same controlled case passed all forty-seven assertions after the post-wake join. Whole-file and adjacent-owner validation are separate from this focused result.
- The held-owner control also verifies that a duplicate in-process Continue returns handled while the original newly accepted call remains pending. The complete independent-root and command files, native recovery and in-process client neighbors, and owning type checks passed in separate runs.

## Root cause

`SessionResume` commits its native continuation receipt and schedules a wake after commit. Before the in-process wrapper reaches its explicit wake, that scheduled operation may own the Session. `SessionManager.wake()` is a work-discovery operation: it may return for an already-running Session or after runnable input has been consumed. Only a path that reaches `SessionInvoke.loop()` necessarily starts or joins a loop result. The convenience wrapper incorrectly equated every wake return with execution completion.

## Guardrails

- [x] Machine check: `packages/presets/test/composition/independent-root.test.ts` — the original Resume and wake execute, the real scheduled provider is held, the explicit wake returns, and Continue must remain pending until release. The test releases and drains that owner before Runtime disposal so cleanup cannot conceal the oracle.
- The [Continue decision](../decisions/implemented/bug-fix/2026-10-23-durable-session-continue.md) preserves HTTP admission, native receipt identity, owner authorization and non-admitting outcomes. No timer, retry, new execution or cross-Session wait is added.

## Lessons

Admission, discovery and execution completion are separate observations. Force the actual owner interleaving when testing a convenience operation that promises to wait. Cleanup must drain the genuine retained operation, including when the API under test returns too early.
