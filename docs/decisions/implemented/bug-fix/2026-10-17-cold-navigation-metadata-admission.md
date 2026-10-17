# Decision Record: Bound cold navigation metadata preparation

Status: implemented

## Problem

A missing or composition-invalidated navigation index can make the first sidebar request upgrade every resident Session while holding the shared storage writer. Historical body cleanup and recovery enrollment amplify that work. Concurrent catalog requests exhaust admission deadlines, and swallowed errors make retained conversations appear absent. Startup-only and warm-index tests do not exercise this path; the [postmortem](../../../postmortem/0078-cold-navigation-migration-admission.md) records the failure.

## Decision

The central metadata runner prepares at most 128 distinct Session owners per transaction and releases the writer between batches. Pure predicates skip migrations without input, retain missing receipts for future input and observe preceding dependency upgrades. Existing migration IDs and completed receipts remain authoritative. Historical body cleanup and recovery enrollment run through explicit Session preparation. Dispatch passes the declared Session owner fields without its internal discriminator.

A versioned record migration invalidates legacy navigation composition markers without scanning owners at startup; successful reconstruction publishes index version 2. Navigation prepares metadata before writer admission, then rechecks and reconstructs the projection from indexed canonical Session keys. It preserves existing activity cursors and includes concurrent publication. Ordinary Session writes do not rebuild an outdated index or mark a partial new index complete. Failed storage reads propagate. The sidebar retains accepted rows and distinguishes retryable failure from accepted emptiness.

Scope catalogs use the storage batch-read contract, including archived records before filtering. Concurrent refreshes must not multiply individual reader admissions by the retained project count. Interaction acceptance covers streaming-triggered refreshes as well as the first cold request.

## Alternatives considered

**Increase storage admission deadlines.** A longer deadline leaves unrelated writes queued behind work proportional to historical message volume and cannot distinguish failure from empty data.

**Prepare all historical owners during startup.** This transfers the same unbounded work to application admission and regresses cold startup.

**Keep a single atomic upgrade for the complete navigation catalog.** Atomic owner upgrades and receipts are sufficient; holding the writer across all owners prevents independent work. Publication reads the current canonical records in its own transaction.

## Consequences

Interrupted preparation can leave completed metadata batches without a published index. Durable per-owner receipts make retry idempotent, and publication rechecks current state. A single owner migration can still be expensive, so metadata callbacks must not traverse bodies. Explicitly opening an old Session remains responsible for its historical upgrades. Performance guards assert bounded work and writer progress alongside generous CI hang limits, with isolated real-data timings recorded separately.
