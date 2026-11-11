# Native deallocation crossed a maintenance hold

## Executive summary

An accepted Environment release needed a new Workspace claim for its final save or detach. Runtime maintenance held new claims, leaving the release incomplete; its `releasing` state then prevented maintenance from ending. Admission and physical ownership covered different parts of one native operation.

## Summary

The issue was reproduced with isolated native Environment and object Workspace fixtures. No original user Runtime, model or Home was modified. Existing mount transition drainage did not cover the Environment's resource-release callback.

## Timeline

1. A real native detach paused after its Environment had published `releasing`.
2. Runtime maintenance began, then the original detach resumed and failed new claim admission.
3. The retained release prevented maintenance release. A separate test showed new deallocation could also publish this incomplete intent after the hold.
4. The native provider reserved original mounted paths before publication, and new admission gained a transaction recheck. Real object Workspace final bytes then survived a later hold.
5. Callback review reproduced execution in another Runtime's actual Store. Context and lifetime checks, single-flight completion and early-wrapper drainage closed that newly introduced surface.
6. Independent review reproduced missing index coverage, unreserved reconciliation and a newly attached disjoint Workspace during preparation. Canonical coverage checks, the shared release owner and Environment use admission closed those gaps. An acknowledged detach with a lost response gained exact native receipt reconciliation.

## Root cause

Provider request ownership protected allocation state but did not reserve the physical claims used by later resource callbacks. A lower claim gate could not distinguish an original accepted release from a new writer. Merely allowing arbitrary cleanup callbacks would weaken physical ownership.

## Guardrails

`test/workspace/mount-maintenance.test.ts` uses the real native provider and coordinator to verify pre-admission refusal, an accepted detach, actual competing ownership, final object bytes and the reservation/publication race. Harness `test/environment/deallocation-owner.test.ts` checks original Runtime/Store/artifact ownership, escaped callbacks and drainage after early wrapper return or failure. See [the decision](../decisions/implemented/bug-fix/2026-11-12-retain-native-deallocation-claims-through-final-saving.md).

## Lessons

Reserve physical ownership before accepting a multi-stage native release and keep it until the last publication. A persisted release intent cannot substitute for that physical claim, and a callback's lexical origin does not preserve its Runtime or asynchronous lifetime.
