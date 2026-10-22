# Performance evidence and failure retention

## Executive summary

A performance investigation found recoverable execution payloads outside their owners' accounting and several misleading resource and issue projections. Failure-path retention, window selection and attribution needed behavioral tests independent of ordinary successful execution. The fixes preserve full recovery data and existing policy limits; they do not establish the cause of all observed process memory growth.

## Summary

Failed streaming writes retained snapshots after releasing their buffer charge. Cortex could publish a terminal task and then fail before registering eventual cleanup. At the same time, Performance could combine latest issue evidence with old trace attribution, merge unrelated Scopes, use the wrong slow thresholds and select stale server samples from a limited mixed-role history. CPU clipping and ambiguous counts made those projections harder to interpret.

## Timeline

On 2026-10-20, runtime observations prompted source tracing and isolated reproductions. These separated real model latency from misleading cumulative issues and resource projections. On 2026-10-21, package-level behavioral regressions reproduced the confirmed defects before implementation; subsequent fixes and focused tests covered failed writes, terminal recording faults, issue upgrades and resource windows exceeding the detail limit.

Independent review then identified premature cleanup while a concurrent finalizer still owned capacity. Extending the existing real-Runtime test to hold finalization beyond five minutes reproduced removal of the live task before capacity release. Cleanup defers destructive removal until owners and waiters drain, preserving exactly-once release.

## Root cause

Buffer ownership transferred a failed snapshot into a retained map without transferring its byte charge. Retrying through normal admission then cloned content already owned by the buffer. Cortex retention scheduling followed fallible settlement even though terminal publication prevented a later retry from reaching that scheduling code.

Issue creation passed undefined fields through ambient merging, and default fingerprints omitted Scope. The conflict update refreshed evidence but not the corresponding description and attribution. Span thresholds used undeclared keys, and total tool duration shared the inactivity code. Optional derived-index reads also reported expected absence as storage failure; one read swallowed genuine availability failures.

Resource summaries derived complete-window claims from bounded detail rows. Role filtering after the limit could hide server history or choose a trailing tool as the server. CPU values above one were clipped or misconverted, and GC recovery added memory categories without a disjoint accounting guarantee.

## Guardrails

[Failure-retention tests](../../packages/harness/test/session/part-write-buffer.test.ts) exercise a full failed buffer, in-place retry, rejected replacement and overlapping snapshots. [Cortex fault injection](../../packages/harness/test/cortex/cancel-queued-followups.test.ts) exercises notification and settlement failures, concurrent terminal publication and durable lookup after controlled retention deadlines.

[Issue and migration tests](../../packages/harness/test/observability/startup-migration.test.ts) retain released-ledger upgrade evidence, custom fingerprints and repeated execution. [Resource-window tests](../../packages/workbench/test/performance/store.test.ts) insert more than 50,000 real SQLite rows with mixed roles, out-of-window data and incomplete child measurements. Existing caller, diagnostics, CPU, GC and rendered issue tests verify missing-versus-error outcomes, measurement units and lifetime count wording.

## Lessons

An owner's retained bytes must remain charged through failure and retry. Terminal cleanup must not depend on successful notification. A bounded detail projection cannot establish complete-window statistics. Description, attribution, time window and units are part of the evidence, not decorative labels. The [retention](../decisions/implemented/bug-fix/2026-10-21-retain-and-release-failed-execution-payloads.md), [issue attribution](../decisions/implemented/bug-fix/2026-10-21-preserve-performance-issue-attribution.md) and [resource measurement](../decisions/implemented/bug-fix/2026-10-21-measure-current-process-resources.md) decisions record the trade-offs.
