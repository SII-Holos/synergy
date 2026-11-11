# Decision Record: Preserve portable Session epochs and bounded streams

Status: implemented

## Problem

A single transfer gate cannot distinguish a permanently surrendered old copy from a legitimate later return to the same device. The personal ZIP transfer also bounds the aggregate object count and size, which cannot represent ordinary large organization data without either dropping evidence or loading the whole transfer into memory.

## Decision

Retain an immutable source/destination ledger for every Session, source epoch and handoff identity, with a separate current epoch pointer and allocation watermark. Source freeze blocks native scheduling and Storage mutation through the existing transfer gate seam. Surrender remains irreversible. Target activation publishes through a trusted owner transaction once; never-activate retirement permanently excludes activation. Returning to an old source requires its exact surrendered predecessor and advances the current pointer while retaining the old ledger. Cancelled and retired epoch numbers remain allocated.

Source preparation first persists a draining intent. Registered native owners stop scheduling and drain execution before final mutation fences are installed. A preparation failure can cancel that exact intent without inventing a completed freeze. Internal children retain their canonical interaction and Cortex state; an opaque Runtime-bound owner receipt permits their final freeze without writing a human pause. Imported children remain behind their paused aggregate root's scheduling hold. Owner continuation requires the latest cancelled-source or activated-target ledger and a separate root Continue.

The transfer owner migration retains legacy gates and indexes existing epoch ledgers. An incomplete historical pointer remains uncertain and non-executable; an upgrade does not infer that remote work stopped. The existing personal v1 ZIP format retains its contract.

Portable v2 streams contain bounded content chunks and hash-linked manifest pages with a final root, owner versions and complete entry/byte totals. A disposable disk index verifies page order and duplicate identities without retaining the aggregate in memory. Consumers must exhaust and verify every entry before the reader reports completion. There is no product limit on total entries, transfer bytes or per-file chunk count; per-frame sizes and safe integer validation remain enforced.

Destination staging stores independently addressable private records and binary references. Owners receive only their declared Session partition. Canonical records, indexes and binary aliases publish under all exact aggregate reservations in one activation transaction; a missing child owner or failed publication rolls back the whole aggregate. A normal write transaction cannot substitute for activation authority.

Native artifact streaming reuses the existing immutable artifact location and prepared-publication owner. Large raw streams append without collecting their full bytes. Existing compressed blocks stream through their declared bounds. Binary read streams pin their pack until consumption ends, including when the canonical reference is deleted concurrently.

## Alternatives considered

**Delete the old gate when a Session returns.** This would erase the permanent rejection fact needed to reject old proofs and commands.

**Increase the ZIP limits.** This would leave aggregate memory proportional to user data and introduce another arbitrary product ceiling.

**Keep all duplicate identities in a process set.** This would make validation memory grow with a large transfer. The private index is disposable and can be rebuilt from immutable source pages.

## Consequences

Tests cover source surrender across restart, unrelated same-ID rejection, legal return, idempotent activation, retirement, legacy and incomplete ledger upgrades, more than 100,000 entries, corrupt totals and duplicate identities. Artifact tests include 65 MiB streams, old compressed data, truncation and concurrent collection. These are kernel invariants; organization source preparation, complete domain aggregate export, WorkspaceMove and UI activation remain separate integration responsibilities.
