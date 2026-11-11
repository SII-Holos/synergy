# Decision Record: Reconcile organization decisions with native winners

Status: implemented

## Problem

Several organization members can answer the same Runtime question or permission request. A disconnected reply has an uncertain logical receipt, and a finite pending page cannot establish that another member resolved it. Persisting password answers would expose secrets while trying to preserve recovery.

## Decision

Read organization interactions through the generated, signed transient operation with the captured root, source and execution binding. Reuse the ordinary single-active decision surface, permission choices and question editor. Keep pending pages bounded and use explicit native identity queries to establish a winner or expiry. These pages never become a complete question snapshot and cannot remove unseen drafts.

Retain each submitted logical request before dispatch. Confirm its receipt against the original payload digest, account, target, binding epoch and native request kind. A native first winner supplies the actual actor and outcome; it does not prove that this client's particular answer was accepted. Retry only the original payload after its logical receipt permits retry and the native request remains pending. Reading the status never submits another answer.

Store organization recovery records individually in IndexedDB, indexed by connection, account, project, root, source and native request. Page headers independently of command bodies. A bounded displayed page and pending residency window do not cap the number of unresolved responses. Exact native-index lookups prevent an older response outside the displayed recovery page from reopening an editable answer. Sign-out removes that connection's records and payloads. An original receipt remains bound to its recorded execution epoch after a later binding change; resubmission still requires the current driver to match.

Polling a later pending window updates its existing identities without inserting the first page or discarding its tail. Explicit first-page navigation remains available after the final continuation is exhausted. Authorization loss aborts the captured owner and clears volatile answers while the component is still mounted; generated HTTP failures and Main bridge errors enter that same lifecycle.

Password questions use native password inputs. Their draft steps and logical command payloads remain in memory, while ordinary draft steps retain the existing persistence behavior. Persist only a sensitive command's identity, target and digest. After reload, a missing original password payload permits receipt reconciliation but cannot be reconstructed or replaced under the old request ID. Explicit native resolution releases the sensitive payload without discarding an unresolved logical receipt.

Organization drafts retain step policies in their [point store](2026-11-12-hydrate-organization-question-drafts-by-identity.md); the previous v2 project record is migration input only. Restore ordinary text only when both the stored and current step policies identify it as text. Capture that policy with the original question action instead of inferring sensitivity from a later pending page. Dispose releases sensitive state and original payloads. The personal v1 consumer retains its authorized complete-snapshot cleanup; unknown drafts on a permanently offline personal Runtime cannot be classified and are not silently removed or reported as cleaned.

The service supplies the Runtime kind used to explain persistent permission scope. Hosted rules affect future matching work by all members in all projects on that Runtime; member rules affect every project on the executing Runtime. Reply controls follow the Session's effective stop authority, and the service reauthorizes every action.

## Alternatives considered

**Treat disappearance from a pending page as successful submission.** Pagination and another member's reply make that inference ambiguous; the original logical receipt and native winner require separate confirmation.

**Retry with a new request ID or the edited answer.** This changes the action being reconciled and can repeat a response whose acknowledgement was lost.

**Persist the password answer for reload recovery.** Durable browser storage would retain the secret beyond the visible interaction. Recovery can retain its identity without retaining the original answer.

## Consequences

Ordinary questions keep their existing draft and keyboard behavior. Sensitive answers require a live original payload for an explicit retry, so a reload can leave status recovery available while resubmission is unavailable. Runtime disconnection or a failed status read remains unconfirmed rather than becoming an inferred winner. IndexedDB failures preserve an explicit unavailable state rather than dispatching an unrecorded answer. Focused checks cover real IndexedDB pagination beyond 128 unresolved responses, metadata-only page reads, owner isolation, policy restoration, disposal, finite-page ambiguity, first-winner attribution and exact receipt validation. Larger valid commands use the [canonical Desktop stream](2026-11-11-stream-canonical-organization-commands-through-desktop.md), without introducing a smaller answer quota in the renderer. Unsubmitted organization drafts now use the separate point owner, including one-time project-record migration and selected-question hydration. The migration may parse the previous complete record once; steady-state cold queue labels do not load those bodies. Personal v1 draft ownership remains unchanged.
