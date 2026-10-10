# Historical replay blocked startup

## Executive summary

The execution-time migration added in PR #1599 declared Session scope and an owner callback but omitted execution policy. The central runner therefore ran its global traversal for resident SQL data. Each owner reconstructed its complete journal before checking whether correction was needed. Existing empty-home and correctness tests did not establish startup cost on populated stores. Migration scope and execution policy must be separate, explicit choices.

## Summary

A user with thousands of conversations and tens of gigabytes of retained evidence could wait for unrelated historical work before entering the application. Missing rollout recovery coverage and automatically resumed import/usage work could produce similar historical reads even after fixing one migration.

## Timeline

The earlier staged-import and bounded-history changes separated metadata admission from historical preparation. The October 8 execution-time correction reintroduced a global pass for resident owners. The October 10 audit traced that pass, page preparation and recovery admission, then reproduced the regression with populated SQL fixtures.

## Root cause

`scope: session` described data ownership, while absent `execution` retained startup behavior. `upSession` supported deferred legacy import but did not defer resident SQL owners. A completion receipt represented a global pass, and recovery treated unknown coverage as an instruction to enumerate every owner. Tests verified final corrected values without asserting which cold records admission touched.

## Guardrails added

The [history admission decision](../decisions/implemented/bug-fix/2026-10-10-history-work-outside-startup.md) records owner receipts, pure record upgrades, deferred recovery epochs and explicit full rebuilds. The [startup regression](../../packages/harness/test/lifecycle/history-startup.test.ts) asserts cold-history reads remain zero for 10,000 Sessions and 10,000 operations, including interrupted migration state. The [persistence workflow](../../.synergy/skill/change-persistence/SKILL.md) requires execution classification and populated-store evidence for future migrations.

## Lessons

Deferring work until idle still performs a full historical pass. On-demand preparation must be explicit at its owning boundary, and unknown recovery coverage must remain unknown until each owner is verified. Core admission time, first-page work, complete history export and physical artifact throughput require separate measurements.
