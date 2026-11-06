# Decision Record: Keep owner preparation outside business transactions

Status: implemented

## Problem

Concurrent cold Session admission could hold the serialized storage writer while awaiting a shared owner-preparation Promise. That Promise belonged to an outside reader and needed the same writer to complete its migration receipts. The circular wait exhausted storage admission deadlines and prevented independent tasks from finishing. Prewarming or additional diagnostic awaits could hide the race.

## Decision

Prepare user-message owners before entering their publication transaction. Within an existing transaction, owner preparation reads the owner and migration receipts from that transaction in one bounded batch. A current or absent owner needs no further preparation. A present owner with missing receipts fails explicitly, requiring its caller to prepare before entering the transaction. Transactional readers never join the shared outside preparation Promise or start a migration.

Outside transactions, retain the existing Runtime/store-scoped deduplication, migration dependency order, retry and durable receipts. No persistent format, execution limit or event protocol changes.

Rollback, unrollback and visual-state writes prepare their historical owner before entering the mutation transaction, then repeat authoritative validity checks inside it. Implicit Agent inheritance uses canonical message summaries instead of materializing model-history bodies during Inbox admission. Reinstalling an optional component cannot make that metadata-only operation depend on unrelated historical body preparation.

## Alternatives considered

**Extend admission timeouts or submit tasks gradually.** These delay the failure or avoid its trigger without removing the dependency cycle.

**Run a second preparation inside the writer.** This duplicates work admitted outside it and can move historical work into a retryable business callback. Durable receipts provide a safe read-only check instead.

**Skip preparation when a writer is active.** An unchecked bypass can expose records that still need an upgrade. Transaction-local receipts distinguish readiness from an incomplete concurrent attempt.

## Consequences

Cold owner admission performs its preparation before atomic message publication. Existing transactional readers pay a bounded metadata check and see their own receipt state. Callers attempting to prepare historical records inside a transaction receive an explicit conflict rather than a deadlock. Tests retain an outside preparation behind a barrier while a writer reads an already-prepared owner, and verify that neither reader nor writer transactions execute missing migrations. Message publication rollback tests preserve atomic input and part behavior.

Upgrade, independent-input composition, rollback acknowledgment, model history, import and visual-state tests cover the additional transaction entry points. The visual write preflight adds a target-local read; revision and ownership checks remain transactional, so concurrent writes and rolled-back content still fail correctly.
