# Decision Record: Prepare derived Session history when it is requested

Status: implemented

## Problem

The central migration runner treated `execution: session` as startup work. Upgrades prepared display and text indexes for every historical owner before a later global identity upgrade invalidated those projections. Legacy checkpoint conversion issued separate record reads for each message and Part. Unknown totals and repeated terminal progress bypassed throttling and flooded the Desktop startup renderer.

## Decision

The central runner registers Session execution migrations without running their installation-wide `up` callbacks. Actual history access prepares those migrations for the selected existing owner in dependency order and persists per-owner receipts. Concurrent requests share preparation, failed steps remain retryable, and successful steps are retained. Preparation stays outside an enclosing retryable SQL transaction; receipt publication checks that the owner still exists. Metadata-only access retains the existing narrow on-access migration path.

The shared snapshot-store migration remains startup work because it inventories and registers store ownership across sessions; it is not merely a derived Session projection. Canonical and unclassified global migrations retain their startup barriers. Deferred historical import continues to use its convergence cohorts independently of lazy display preparation.

Legacy file-checkpoint conversion reads messages and Parts through two owner-indexed paged scans. Tool-input normalization compares only owned input and intent fields instead of serializing large output bodies. Progress counts scanned records, uses unknown totals until discovery completes, resets on explicit phase advancement, throttles repeated updates and flushes the final observed count. The Desktop overlay suppresses identical rendered status scripts and permits retries after delivery failure or reload.

Background owner preparation retains background queue priority and bounded work batches but does not reuse a single absolute 100 ms admission deadline across the entire multi-step pass. A completed first step must not make every subsequent step fail admission; queue admission keeps its ordinary bounded timeout.

## Alternatives considered

**Move every migration to the background.** Shared authority and canonical schema upgrades must complete before ordinary reads. Only explicitly classified owner-local work is deferred.

**Reorder every global migration around display creation.** This still scans idle history and can repeat the cost on the next projection version. Demand-driven preparation runs after the canonical startup barrier.

**Increase the Desktop startup timeout.** This does not reduce work or correct false progress. Existing migration-aware waiting remains in place.

## Consequences

Opening an unprepared historical Session pays its own projection cost. Global completion of a Session execution migration means registration for on-demand execution, not that every owner's projection already exists. Per-owner receipts make interrupted preparation resumable. Existing-home startup can still spend time on required canonical migrations; a fast already-upgraded restart does not measure a fresh full upgrade. Migration, deferred import, checkpoint, terminal progress and real Electron tests cover these distinct paths.
