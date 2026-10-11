# Decision Record: Foreground reply completion

Status: implemented

## Problem

Detached experience generation and title work retain the Run until their recorded calls settle. Using that accounting status to gate the conversation footer and copy actions makes a finished reply appear active during auxiliary inference, and adds auxiliary latency to its displayed duration.

## Decision

The foreground read model combines existing execution segments with canonical terminal message metadata. It exposes reply completion after the last segment ends and before detached accounting settles, provided no approval, workflow, steering or owning Cortex child remains pending. The completion must belong to the latest execution period. Cancellation and interruption retain precedence.

The chronology index supplies message metadata without response-body hydration. Effective rollback visibility applies, and a terminal Run's end bounds historical reads. The projection is reconstructed on refresh and navigation without a new persisted state or migration. Ending a segment publishes the existing root activity invalidation after its durable write.

The lifecycle persists foreground segment completion before capturing file endpoints. The execution lease still owns endpoint capture and publication before the next segment can establish its baseline; completion presentation does not release execution ownership. Terminal streaming writes flush only the current Session. Tool settlement, terminal message persistence, cancellation and recording failures retain their existing ordering.

File comparisons remain FIFO per Session, but release that queue before title/body inference. Same-root model summaries keep their publication order across intervening diff-only jobs. Each job retains its own completion, cancellation and detached accounting. Atomic partial updates preserve newer file evidence when older inference returns, and an inference timeout cannot change a settled diff to an error. Normal summary requests hydrate only their root's messages, extend the persisted aggregate cursor, and validate paired snapshot roots in one bounded object traversal. Missing aggregate cursors retain owner-local reconstruction; they are not reconstructed globally during startup.

The compact footer exposes the terminal foreground status even when the execution summary is absent or still running. It displays duration only from a matching terminal execution summary, preserving the interval measurement and lower-bound marker defined in [execution time evidence](../architecture/2026-10-08-execution-time-evidence.md). Reply timestamps must not substitute for actual execution duration or include human waits. Execution details retain auxiliary calls and usage. The lifecycle continues draining detached jobs before closing the Run. See [Sessions and messages](../../../architecture/session-and-messages.md#message-parts) for the current state definition.

Snapshot comparison initializes absent caches only. File metadata lookup requests bounded batches of literal paths from each endpoint instead of enumerating all retained files, preserving binary, symlink, deleted-file and unusual-filename behavior.

## Alternatives considered

**Close the Run when the reply finishes.** This rejects late auxiliary writes or loses their attribution, timing and usage.

**Finish the footer when text stops arriving.** Streaming pauses, tool transitions, pending children and resumed work do not establish completion, and local timing cannot survive refresh consistently.

**Derive elapsed time from reply timestamps.** A reply timestamp establishes completion but includes human waits and gaps between execution segments; only the canonical interval projection can supply elapsed time.

**Detach endpoint capture from execution ownership.** A subsequent execution could write files before the previous endpoint is frozen, attributing those writes to the wrong task. The endpoint remains ordered while its presentation is independent.

**Skip snapshot cache validation.** A surviving reference does not establish that its tree and blobs exist. Batch validation removes duplicate traversal while preserving durable restoration and session ownership checks.

## Consequences

Foreground actions do not wait for auxiliary inference. The footer can briefly show status without a duration while its matching execution summary loads; footer and details then share one elapsed-time definition. The projection adds metadata reads for completed segments, bounded by the existing chronology and historical Run end. Behavioral tests retain a running recorded call past reply completion, verify its eventual accounting and cover pending work, rollback, interrupted execution and stable DOM presentation.

Full lifecycle tests hold endpoint capture while checking foreground completion, then verify checkpoint and Run settlement. Summary tests hold inference across newer diff revisions and reject hydration of earlier turns. Snapshot tests preserve damaged-cache recovery. These ordering checks use explicit gates rather than workstation-specific performance thresholds. See the [completion settlement incident](../../../postmortem/0066-completion-waited-for-file-settlement.md).
