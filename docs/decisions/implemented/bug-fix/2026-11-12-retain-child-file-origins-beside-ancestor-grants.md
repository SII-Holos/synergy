# Decision Record: Retain child file origins beside ancestor grants

Status: implemented

## Problem

Organization file tools rejected valid Cortex children because the adapter required the accepted resource root to equal the child tool's native root. Delegated children retain their own native Session, Run and tool records while the existing execution lineage authorizes their accepted ancestor's resource grant.

## Decision

The member file-resolution owner accepts the original opaque Environment origin and retains a separate caller assertion. It validates native admission through that origin, snapshots the caller's binding and Cortex parent/task links, and reuses the existing canonical executionLineage resolver to compare the original accepted lineage. The provider checks this assertion across binding and remote I/O while retaining its original connection, accepted actor/root and fixed FileReference.

The child origin stays unchanged. Ancestor authorization does not replace the child's root, Run or tool; a direct Session still requires its own accepted root. Cold operation recovery keeps the previously recorded ancestor authority and remains inspection-only, without a new bind, caller substitution or write dispatch.

## Alternatives considered

**Remove the root guard without validating the caller.** An old or changed caller could continue using a retained ancestor grant. Canonical native admission and the fixed lineage must both remain valid.

**Rewrite the origin as the accepted ancestor.** The ancestor does not own the child's Run or tool record. Such a rewrite would discard the native caller's provenance.

**Create a separate grant for every child.** The existing lineage already owns delegation to the accepted ancestor; another admission would duplicate that authority and alter resource accounting.

## Consequences

Ordinary View/Edit/Save can operate through real Cortex child tool contexts while wire proofs and cold receipts remain bound to the ancestor's original accepted task. The regression also verifies that child cancellation prevents further RPCs from its old lease and that a lost write acknowledgement is reconciled on a cold Runtime without replay. See [the postmortem](../../../postmortem/0154-cortex-files-confused-caller-and-ancestor-roots.md).
