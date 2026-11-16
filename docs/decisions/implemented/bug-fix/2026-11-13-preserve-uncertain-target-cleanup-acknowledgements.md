# Decision Record: Preserve uncertain Target cleanup acknowledgements

Status: implemented

## Problem

An original Target can permanently retire its inactive Epoch and release its WorkspaceMove claim before its proof reply reaches the caller. An empty or inconsistent acknowledgement cannot establish that the native cleanup was never dispatched. Reporting that outcome invites a caller to treat completed physical work as an unsent operation.

## Decision

The original native cleanup capability ends as soon as its Target callback returns. A separate final-response check retains the original registered owner, actual primary Store and artifact owner, cancellation signal and finite plan expiry through result validation, signing, proof submission and acknowledgement validation. This check grants no additional native operation.

After the native callback succeeds, malformed results, signing failures, unverifiable acknowledgements and failed final owner checks return an explicit non-retryable `unknown` outcome. The proof POST also preserves uncertainty for transport failures and cancellation after dispatch. A genuine structured service rejection retains its original code and outcome; known native callback rejections retain their existing semantics.

Cold inspection uses the same original retained native fact and proof hash. It does not repeat WorkspaceMove release, create a new Epoch or reopen an ordinary Runtime connection.

## Alternatives considered

**Treat an absent or invalid ACK as not dispatched.** Rejected because the original native retirement and service proof may both be committed.

**Extend the native capability through HTTP acknowledgement.** Rejected because response reconciliation must not prolong permission to change the original Target.

**Retry cleanup automatically.** Rejected because a transport failure cannot establish absence of the original effect. Inspection already provides the reconciliation path.

## Consequences

Callers can distinguish a verifiable rejection from an uncertain accepted cleanup. The original finite authority and Home/Store ownership checks remain in effect while the original fact stays available for explicit inspection. This change neither adds a recovery ledger nor changes Source receipt recovery or execution authority.

## Verification

The actual enrolled-Home fixture commits native retirement and the service proof, then substitutes an empty acknowledgement. The original Epoch is permanently inactive and the physical claim is absent before the outcome assertion. Additional cases corrupt an acknowledged fact hash, cancel the proof observer and close the restricted owner after service commit; cold inspection must retain the same fact hash without another native release. See [the postmortem](../../../postmortem/0174-target-cleanup-misreported-a-lost-acknowledgement.md).
