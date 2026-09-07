# Transition cleanup retained disposed frontend pages

## Executive summary

A global command registry retained disposed Session owners after navigation, keeping their editor state and detached DOM reachable. A separate unreachable Scope cleanup compounded retention, while a Solid transition memo defect produced function-call errors during streaming. Tests covered visible results but did not exercise nested transitions, pending reads, and cleanup ownership together. Regression tests now exercise the real providers and component through those lifecycles.

## Summary

Users reported intermittent function-call errors in conversation error cards and increasing renderer memory during long sessions. Earlier tool rendering budgets reduced large-content costs, but heap inspection found old page ownership chains that those limits could not break. Deduplication by command ID hid the extra registrations from the visible command list.

## Timeline

- 2026-09-07: bounded tool rendering changes addressed eager highlighter and diff retention.
- 2026-09-07: a captured renderer heap showed 29 disposed Session command accessors retained alongside the current Session and Layout registrations.
- 2026-09-07: nested-transition reproductions accumulated 31 registrations after 30 page changes; unmounting the real SyncProvider neither released its Scope nor aborted its pending message request.
- 2026-09-07: the real CompactReasoningLine reproduced the Match accessor TypeError on Solid 1.9.10 and passed on 1.9.15; command retention remained reproducible until registration timing changed.

## Root cause

A page created during a Solid transition synchronously prepended its commands to a global signal. That transition's staged value still included the previous page. During commit, old-owner cleanup removed its accessor from the current signal value, but the subsequent staged-value commit restored the stale accessor. The accessor retained callbacks, owners, contexts, editor models, and detached DOM. Cleanup had run; its effect was overwritten.

SyncProvider's cleanup appeared after its return statement, so it was never registered. Moving it exposed another lifetime requirement: old and new providers can share a Scope during transitions, so one provider cannot unconditionally delete the shared state. Delayed snapshot and replay responses also need store-instance checks when a released Scope is reopened.

The function-call error had a separate upstream cause: a pure memo first created in a pending transition only received a staged value, leaving its current value undefined when streaming triggered a non-transition read of a Match child. Solid's [initial transition memo fix](https://github.com/solidjs/solid/pull/2617) initializes both values.

The previous tests exercised command results, message loading, and reasoning rendering separately. They did not verify public command membership after nested transition cleanup, request abort on provider disposal, or streaming during a suspended new Match. This allowed lifecycle defects to coexist with correct ordinary rendering.

## Guardrails added

- [Command lifecycle regression](../../packages/app/test/context/command-lifecycle.dom.test.ts): 100 page switches, reactive commands, duplicate-ID precedence, pending-transition visibility, and final disposal.
- [Sync lifecycle regression](../../packages/app/test/context/sync-lifecycle.dom.test.ts): unmount releases the lease and aborts the actual message loader's request.
- [Scope retention tests](../../packages/app/test/context/scope-retention.test.ts) and [GlobalSync lifecycle regression](../../packages/app/test/context/global-sync-lifecycle.dom.test.ts): overlapping leases, bounded background state, reopened instances, and delayed bootstrap/replay/list responses.
- [Reasoning transition regression](../../packages/ui/test/components/compact-reasoning-transition.dom.test.ts): real component and Solid control flow with streaming before commit.
- [Frontend workflow](../../.synergy/skill/develop-frontend/SKILL.md) and [decision record](../decisions/implemented/bug-fix/2026-09-07-transition-lifecycle-retention.md): committed registration, explicit leases, and stale-response rules.

## Lessons

A cleanup callback running is insufficient evidence that ownership ended: a later reactive commit can restore a reference. Test the surviving registry entries and state, not only cleanup call counts. Distinguish a visible exception from the retaining root; an upstream exception fix and an application memory fix may both be necessary. A single heap proves reachability at capture time, while post-deployment comparison is still needed to establish long-running memory behavior.
