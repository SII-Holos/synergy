# Decision Record: Batch native compaction coverage owner preparation

Status: implemented

## Problem

The first model header read prepares its Session's registered migrations. Compaction coverage preparation opened one write transaction and point-read for every historical header, including ordinary user messages that require no update. That made unchanged history incur native SQLite worker round trips proportional to individual messages before selected-body and rollout work could begin.

## Decision

The existing compaction coverage migration groups at most 128 original header keys per writer. It rereads those keys together inside that writer's original transaction, applies the unchanged canonical coverage upgrader to the current values and uses the native bulk writer only for changed records. Enumerated values are addresses rather than the later write authority. Missing records and original storage failures still reject preparation; a failed page cannot partially publish coverage. Upgrade checkpoints remain outside SQL, and progress advances after the original writer commits.

The migration identity, central completion receipt, portable import transform, existing coverage, owner filtering and current record format remain unchanged. Every new invocation rereads durable state; no long-lived cache or alternate migration path is introduced. See [compaction coverage](2026-10-26-compaction-prefix-coverage.md) and [Session history](../../../architecture/session-and-messages.md).

The [incident](../../../postmortem/0209-compaction-coverage-preparation-opened-one-writer-per-header.md) records the native work regression and separates it from host latency.

## Alternatives considered

**Increase the history guard or reduce the 5000-message fixture.** Either would retain the per-header native work and weaken the original complete-workload evidence.

**Upgrade enumerated values without rereading inside the writer.** Another writer may commit current coverage or metadata before migration admission; stale enumeration cannot replace those records.

**Retain each no-op header's individual writer.** This preserves the same point-read and transaction overhead even when no canonical value changes.

## Consequences

The work bound concerns native read/write windows rather than host latency. Sparse legacy summaries still gain their existing coverage cursor, while ordinary headers and current coverage retain their revisions. A real writer-admission barrier verifies that a concurrent current value wins over earlier enumeration. Existing central migration, portable import and restart cases remain required, together with the original 5000-message history, selected-body and rollout assertions under their existing guard. This change establishes no product timing SLA or capacity result.
