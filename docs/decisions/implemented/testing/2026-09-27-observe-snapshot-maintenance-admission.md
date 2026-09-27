# Decision Record: Observe snapshot maintenance admission

Status: implemented

## Problem

The snapshot lease ordering test starts an exclusive maintenance request, sleeps for 100 ms and then starts another reader. A Linux coverage run observed the second reader before maintenance after releasing the first reader. The request crosses asynchronous Home and Scope gates; invocation order and elapsed time do not establish that its exclusive Scope owner has been registered. Even observing neither contender's callback after another delay does not establish their admission order.

## Decision

The fixture holds a real first reader in an isolated data root and observes the exclusive owner in that Scope's lease record before launching the later reader. Maintenance stays behind an explicit release promise. Real rejected reader acquisitions verify exclusion both while maintenance waits for the first reader and while maintenance owns the Scope. The original final callback order remains asserted, and another exclusive operation verifies ownership is released afterward.

Cleanup cancels waiting operations, releases both held owners and drains the contender promises on success and failure. Admission uses its own bounded API budget inside the unchanged test deadline; no fixed sleep establishes readiness. Production lease semantics and file-lock ordering are unchanged.

## Alternatives considered

**Increase the readiness sleep or retry a failed suite.** Rejected because elapsed time cannot prove Scope admission and a green rerun does not explain the failed order.

**Add a production FIFO queue or test-only admission hook.** Rejected because the contract excludes later readers after the exclusive owner is registered, rather than promising function-call order across asynchronous Home and Scope admission. The existing durable ownership record already provides the fixture's readiness evidence.

## Consequences

The fixture knows the persisted owner shape, as the adjacent cancellation regression already does. Its assertions remain about observable exclusion, callback order and final release. The CI failure demonstrates the old readiness assumption was insufficient; it does not identify the exact asynchronous operation that delayed that runner's maintenance request.
