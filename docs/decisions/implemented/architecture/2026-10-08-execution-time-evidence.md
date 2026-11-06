# Decision Record: Execution time from branch evidence

Status: implemented

## Problem

A run ledger outlives foreground work while queued input and auxiliary accounting settle. Treating its open status or wall-clock envelope as execution invents time during waiting, pauses and downtime, and cannot consistently describe parallel descendants.

## Decision

Harness Rollout persists independent branch intervals with a runtime clock identity and monotonic boundaries. Task, descendant and round summaries union their selected execution intervals per clock, then sum confirmed runtime groups. Human waits suspend the affected branch; tool and Cortex coordinators suspend while delegated branches own the work. Foreground completion records its result before auxiliary settlement. Workbench projects these facts without deriving time from running ledger records.

Inbox owns input admission, revision checks and recoverable removal. Roots acquire execution configuration after their canonical commit. Durable cancellation fences materialization and execution; abandonment also settles paused work. Admission-only records cannot overwrite the latest actual main outcome. Local and attached CLI clients poll the same durable input projection through admission and execution, then retrieve the terminal rollout result; they never require a queued Run shell.

Recovery records detection separately from unobserved ends. The owner-local migration appends corrections and conservative historical spans through the journal, preserving earlier revisions and receipts. Confirmed transport spans exclude auxiliary calls and observable wall-clock discontinuities. Historical branch gaps remain a lower bound. Imports run the same versioned upgrade and carry interval evidence through remapped identities. New runs declare the current timing version at creation and never enter historical reconstruction.

The client displays `mm:ss` or `≥ mm:ss`, hides time for an empty session, and retains an accessible name without a time tooltip. It advances accepted snapshots using local monotonic time, freezes on disconnection or hidden pages, and refreshes before resuming. Runtime identity, revision and server monotonic sample reject obsolete updates. Workbench buffers Inbox updates with the rest of its projection and computes each timing summary synchronously, so a delayed read cannot stamp old active intervals with a newer revision. The App owns the clock composable; shared UI owns duration formatting and never reconstructs task time from message timestamps.

## Alternatives considered

**Use the run envelope.** It includes admission delay, idle periods and auxiliary settlement, and recovery cannot infer a real end from the time it discovered a crash.

**Sum execution durations.** It double-counts overlapping parent and child work and concurrent tools.

**Repair active records during reads.** This makes historical results depend on read order and bypasses replay and import guarantees. Corrections belong to the versioned owner migration.

**Persist a timer every second.** It adds write traffic without proving time after a crash. Boundary evidence and explicit partial coverage preserve the useful lower bound.

## Consequences

Execution time remains independent of token and cost accounting. The additional interval records and synchronization fields require SDK generation and archive coverage. Historical records without branch boundaries cannot recover exact task time, so the UI deliberately presents their confirmed duration as a lower bound. Tests cover parallel unions, human waits, cancellation races, recovery, historical replay and monotonic client extrapolation.
