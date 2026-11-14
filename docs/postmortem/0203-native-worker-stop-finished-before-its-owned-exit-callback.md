# Native worker stop finished before its owned exit callback

## Executive summary

Agent and Policy worker stop could finish while the original parent exit callback remained pending. Retain that callback through the original process host before allowing Runtime disposal.

## Summary

A Presets CI failure reported a closed Runtime between successful attachment scenarios, but its single-frame stack did not identify the owner. Source tracing found a concrete lifecycle gap in both worker process hosts. A controlled regression using real native children demonstrated the gap; this does not establish that it caused that particular natural CI failure.

## Timeline

The two original hosts failed after real native exit because stop returned while their original exit callbacks were explicitly held. After retaining callback completion, both roles passed ordinary and callback-failure cases. Their original environment, Policy process and worker-pool neighbors also passed: 75 tests and 426 assertions. A final four-case check passed after limiting the failure observer to stopping.

## Root cause

Both hosts returned immediately when `Subprocess.exitCode` was available and otherwise awaited only native process exit. Runtime shutdown awaited those stop methods before disposing the context. The callback still called the captured Runtime, so the completion prerequisite was weaker than the owner's lifetime requirement.

## Guardrails

- [x] Machine check: `packages/harness/test/lifecycle/worker-exit-owned-callback.test.ts` uses original native workers and controls only delivery of their actual exit callbacks. Stop remains pending, original Runtime identity is retained, each callback executes once and its exact error survives repeated stop.
- [x] Machine check: original worker environment, Policy process and both worker-pool suites pass.
- [ ] Machine check: the original ordered Presets acceptance cohort must pass on Linux before its natural closed-Runtime failure is considered resolved.

The [decision](../decisions/implemented/bug-fix/2026-11-14-drain-native-worker-exit-callbacks-before-runtime-disposal.md) keeps the disposed-context guard intact.

## Lessons

Native process exit and completion of its parent callback are separate facts. Drain both through the original owner.
