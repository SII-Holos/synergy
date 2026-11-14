# Decision Record: Observe recorded task activity without recovering execution

Status: implemented

## Problem

A cancellation receipt establishes native reception while execution may still be draining. A cancelled Run, interrupted process record or empty live registry does not establish physical exit. Full Rollout history queries also load evidence that a status read does not need and can prepare historical execution owners.

## Decision

Harness exposes a separate activity query for a Session root. It reads current Run and process metadata in one storage snapshot, follows exact recorded parent roots and validates each record's key and owner. It reads no artifact bodies or historical journal events and does not invoke execution recovery. An unsettled journal head or malformed identity refuses the observation.

The result separates the root's durable status and cancel intent, current execution ownership, active qualified process owners, recorded exits and unknown completion. Live process evidence must belong to the same Runtime, Run and owner. An interrupted record without an observed exit code or signal remains unknown. The result explicitly covers the recorded subtree, not every external effect or detached process.

Discovery retains at most 64 Session owners and selected runs, 256 candidate Run records and 256 process records. Bound exhaustion is explicit truncation. Existing child-key pagination can include branch addresses, allowing nested Run metadata to be discovered without enumerating every descendant record. A branch address alone does not establish live or admitted content.

## Alternatives considered

**Infer exit from cancellation or Session idleness.** Both can coexist with external work whose completion is unobserved.

**Replay complete Rollout snapshots.** Status reads do not need request bodies, tool output or historical accounting, and execution recovery would change the facts being observed.

**Enumerate only direct records.** Run identities occupy branch nodes, so that page shape can omit an entire descendant subtree.

## Consequences

Queries remain bounded in selected metadata and produce small summaries. They can return truncated or unavailable evidence and cannot promise that every external side effect has ended. They start outside an enclosing transaction so Session preparation precedes their read snapshot. Parent indices remain owned by Session; the observation does not introduce another execution registry or durable status machine.

Tests cover an actual child process, confirmed exit and unknown interrupted evidence, native resumption, nested and unrelated roots, wide trees, process-page bounds, missing and corrupt records, unsettled journals, cancellation, and absence of artifact hydration or execution recovery. The storage contract keeps default direct-record pages intact and exercises branch addresses through both traversal and backend-parametric record tests.
