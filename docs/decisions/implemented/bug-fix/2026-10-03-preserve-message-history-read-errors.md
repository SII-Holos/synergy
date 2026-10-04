# Decision Record: Preserve storage failures during newest message reads

Status: implemented

## Problem

The newest-first message reader uses individual reads before switching to bounded batches. Treating every individual read failure as an absent message makes an unavailable or unreadable record look like a successful history read with that message omitted. Batch reads already propagate these failures.

## Decision

Only `Storage.NotFoundError` is skipped during individual message-info reads. Other failures, including part hydration failures, propagate with their original identity. A reader may skip a message deleted after it captured the chronology index; storage availability and integrity failures cannot certify a complete result. Missing parts after a concurrent deletion naturally produce an empty part list without concealing failed reads.

## Alternatives considered

**Continue after any failed read.** This conceals missing evidence from history consumers and gives individual and batch reads different failure semantics.

**Reject every missing record.** A chronology snapshot can outlive a concurrent message deletion. Rejecting that expected condition would make ordinary deletion invalidate an otherwise usable history traversal.

## Consequences

History consumers can observe and handle storage failures instead of receiving an apparently successful incomplete history. Message formats, index ownership and missing-record behavior remain unchanged; no migration is required. SQLite and PostgreSQL regressions verify first, later individual and batch failures, part hydration failures, actual deletion during iteration, chronological streaming and cursor pagination.
