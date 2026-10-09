# Decision Record: Foreground reply completion

Status: implemented

## Problem

Detached experience generation and title work retain the Run until their recorded calls settle. Using that accounting status to gate the conversation footer and copy actions makes a finished reply appear active during auxiliary inference, and adds auxiliary latency to its displayed duration.

## Decision

The foreground read model combines existing execution segments with canonical terminal message metadata. It exposes reply completion after the last segment ends and before detached accounting settles, provided no approval, workflow, steering or owning Cortex child remains pending. The completion must belong to the latest execution period. Cancellation and interruption retain precedence.

The chronology index supplies message metadata without response-body hydration. Effective rollback visibility applies, and a terminal Run's end bounds historical reads. The projection is reconstructed on refresh and navigation without a new persisted state or migration. Ending a segment publishes the existing root activity invalidation after its durable write.

The compact footer exposes the terminal foreground status even when the execution summary is absent or still running. It displays duration only from a matching terminal execution summary, preserving the interval measurement and lower-bound marker defined in [execution time evidence](../architecture/2026-10-08-execution-time-evidence.md). Reply timestamps must not substitute for actual execution duration or include human waits. Execution details retain auxiliary calls and usage. The lifecycle continues draining detached jobs before closing the Run. See [Sessions and messages](../../../architecture/session-and-messages.md#message-parts) for the current state definition.

## Alternatives considered

**Close the Run when the reply finishes.** This rejects late auxiliary writes or loses their attribution, timing and usage.

**Finish the footer when text stops arriving.** Streaming pauses, tool transitions, pending children and resumed work do not establish completion, and local timing cannot survive refresh consistently.

**Derive elapsed time from reply timestamps.** A reply timestamp establishes completion but includes human waits and gaps between execution segments; only the canonical interval projection can supply elapsed time.

## Consequences

Foreground actions do not wait for auxiliary inference. The footer can briefly show status without a duration while its matching execution summary loads; footer and details then share one elapsed-time definition. The projection adds metadata reads for completed segments, bounded by the existing chronology and historical Run end. Behavioral tests retain a running recorded call past reply completion, verify its eventual accounting and cover pending work, rollback, interrupted execution and stable DOM presentation.
