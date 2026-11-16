# Native publication lost input priority

## Executive summary

A new real source-to-target organization fixture failed during paused activation because the organization owner published before canonical Core. The dependency sorter had discarded the incoming owner priority. A second real test showed that a FIFO ready queue could still violate that priority after a dependency was resolved. Publication now selects the earliest incoming owner among all currently eligible owners.

## Summary

All reproductions used temporary Runtime Homes. No user Runtime, original Home or real model data was touched. The failure rejected target activation rather than granting execution.

## Timeline

1. Native target activation published the organization binding before the Session existed and failed its canonical Session read.
2. Staging retained its full manifest graph validation but began ordering from the captured incoming contexts.
3. A Workspace-to-Core dependency plus a real downstream Session reader still failed: the FIFO queue ran the observer before newly unlocked Core.
4. Choosing the earliest incoming ready owner on each step made both native failures pass while retaining parent/child ordering, cycle and missing-owner checks.

## Root cause

Compatibility manifest keys were treated as publication priority. The first correction preserved input order only when initially constructing the ready queue. Topological validity alone does not preserve established priority among nodes that become eligible at different steps.

## Guardrails

`test/session/transfer-publication-order.test.ts` exercises canonical Core, actual Workspace catalogs and a downstream publisher that reads the published Session. `test/execution-handoff.test.ts` verifies native source cancellation and target activation. The enrolled HTTPS controller suite retains its original root and actor assertions. The [decision](../decisions/implemented/bug-fix/2026-11-12-preserve-native-publication-input-priority.md) defines the stable rank rule.

## Lessons

Dependency graphs determine legal order; an existing captured plan determines priority wherever the graph permits a choice. Verify that priority with an owner that consumes the real published state.
