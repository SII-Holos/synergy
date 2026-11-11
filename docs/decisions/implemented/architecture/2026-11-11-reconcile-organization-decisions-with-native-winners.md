# Decision Record: Reconcile organization decisions with native winners

Status: implemented

## Problem

Several organization members can answer the same Runtime question or permission request. A disconnected reply has an uncertain logical receipt, and a finite pending page cannot establish that another member resolved it. Persisting password answers would expose secrets while trying to preserve recovery.

## Decision

Read organization interactions through the generated, signed transient operation with the captured root, source and execution binding. Reuse the ordinary single-active decision surface, permission choices and question editor. Keep pending pages bounded and use explicit native identity queries to establish a winner or expiry. These pages never become a complete question snapshot and cannot remove unseen drafts.

Retain each submitted logical request before dispatch. Confirm its receipt against the original payload digest, account, target, binding epoch and native request kind. A native first winner supplies the actual actor and outcome; it does not prove that this client's particular answer was accepted. Retry only the original payload after its logical receipt permits retry and the native request remains pending. Reading the status never submits another answer.

Password questions use native password inputs. Their draft steps and logical command payloads remain in memory, while ordinary draft steps retain the existing persistence behavior. Persist only a sensitive command's identity, target and digest. After reload, a missing original password payload permits receipt reconciliation but cannot be reconstructed or replaced under the old request ID. Explicit native resolution releases the sensitive payload without discarding an unresolved logical receipt.

The service supplies the Runtime kind used to explain persistent permission scope. Hosted rules affect future matching work by all members in all projects on that Runtime; member rules affect every project on the executing Runtime. Reply controls follow the Session's effective stop authority, and the service reauthorizes every action.

## Alternatives considered

**Treat disappearance from a pending page as successful submission.** Pagination and another member's reply make that inference ambiguous; the original logical receipt and native winner require separate confirmation.

**Retry with a new request ID or the edited answer.** This changes the action being reconciled and can repeat a response whose acknowledgement was lost.

**Persist the password answer for reload recovery.** Durable browser storage would retain the secret beyond the visible interaction. Recovery can retain its identity without retaining the original answer.

## Consequences

Ordinary questions keep their existing draft and keyboard behavior. Sensitive answers require a live original payload for an explicit retry, so a reload can leave status recovery available while resubmission is unavailable. Runtime disconnection or a failed status read remains unconfirmed rather than becoming an inferred winner. The behavioral checks cover password storage and remounting, finite-page ambiguity, first-winner attribution, exact receipt validation and the authenticated Desktop read path.
