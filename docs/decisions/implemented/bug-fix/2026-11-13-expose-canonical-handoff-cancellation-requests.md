# Decision Record: Expose canonical Handoff cancellation requests

Status: implemented

## Problem

A committed cancellation request remained indistinguishable from an untouched Handoff after its acknowledgement was lost. The public View stripped the flag already owned by the Handoff record. See [the postmortem](../../../postmortem/0165-handoff-view-hid-committed-cancellation-requests.md).

## Decision

The current public View includes required `cancelRequested` from the canonical record. The legacy View, storage formats, writer, permissions and native cancellation protocol retain their existing contracts. This read-only observation requires no migration or new receipt.

A true flag confirms the cancellation request, not source cancellation or release. The actual source-cancelled fact still owns that permanent outcome and lock transition. A client can reconcile the original request through GET after an uncertain response without replaying it.

## Alternatives considered

**Resend cancellation automatically.** An unknown acknowledgement does not authorize another dispatch, and replay cannot replace a missing read observation.

**Infer cancellation from a nonterminal phase.** Preparing or prepared may describe either an untouched Handoff or a committed cancellation request awaiting the native source.

## Consequences

Generated clients receive an explicit boolean instead of absence. A real TLS regression commits cancellation, loses the acknowledgement, reads the canonical true flag and independently drives the native cancellation fact. It also checks false before the request. Main capability and native adoption support remain unchanged.
