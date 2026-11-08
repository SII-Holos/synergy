# Decision Record: Query current activity beside cancellation receipts

Status: implemented

## Problem

An accepted cancellation remains true after its execution drains, fails to drain or resumes. Returning that receipt alone cannot tell a caller whether native execution or a recorded process is still active. Serializing a receipt read behind a newer control or filling its transport window can also make cancellation status inaccessible.

## Decision

Cancellation receipt queries return an optional, separate execution observation tied to the accepted root. The Runtime reads the native bounded recorded subtree without execution recovery and checks canonical binding, transfer fences and its control version around the observation. Missing or unreadable evidence and intervening control changes become explicit unavailability. A resumed root can be running beside its unchanged cancellation receipt.

The service queries accepted cancellation activity independently of the Session submission lock. It retains bounded observation capacity separately from submissions, and each bridge transport reserves a bounded query/skip window. Read-only queries never issue input, cancel, Continue or skip.

After the remote response the service reauthorizes the reader and checks current directory ownership and revision. A changed binding or handoff suppresses the old observation; removed access denies the read. Offline, saturated and failed observations retain durable acceptance without inventing physical completion.

The wire and HTTP schemas bind current evidence to the accepted cancellation and exclude it from durable results. Generated organization SDK types expose the same observation. The service stores no new execution state, process record or recovery scheduler.

## Alternatives considered

**Rewrite the receipt with current status.** It would destroy original reception evidence and misrepresent an earlier cancellation after resumption.

**Infer physical exit from Run status or missing registry entries.** Interrupted evidence can outlive the Runtime that owned its process.

**Share submission locks and transport capacity for queries.** A pending control can prevent the independent read needed to understand it.

## Consequences

Callers separately display immutable acceptance, timestamped recorded-subtree activity and explicit unavailability. Counts cover bounded recorded evidence; unknown completion and truncation remain visible and do not prove all external effects ended. Queries can consume an online exchange even when the receipt is already stored.

Tests use real SQL, native execution leases, an actual resident WSS bridge and generated HTTP calls. They cover immutable acceptance during drainage and after resumption, unreadable evidence, transfer and control changes, independent reads behind held controls, reserved transport capacity, deadline/offline retention and revocation or rebinding while a reply is pending. No persisted schema change or data migration is required.
