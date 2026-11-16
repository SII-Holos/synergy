# Decision Record: Read native interactions without private history access

Status: implemented

## Problem

Collaborators need pending permissions, questions and final decision attribution without receiving private Session history or arbitrary native permission metadata. A disappearing pending request does not prove that the viewer's answer committed. Reusing creator-only history permits would either block collaboration or broaden private body access.

## Decision

Expose a separate transient interaction query through the existing organization machine transport. Current Session read authorization applies before dispatch and after response. Its separately signed finite permit binds the exact query, account, deployment, connection and Session binding. The Runtime resolves the canonical root or Cortex child and rechecks the binding after reading. The service retains neither pending bodies nor a read command receipt.

Native PermissionNext and Question remain the pending owners. Their public windows share a Scope-local ordinal and view identity, filter the requested Session lazily and return bounded pages. Opaque continuation binds the root, source and native view; a removed cursor request does not break continuation, and a disposed view cannot silently reuse its cursor. Permission projections omit arbitrary metadata. Visible prompt text passes through the native secret masker, and the Runtime kind explicitly qualifies Runtime-wide Always semantics.

Decision queries name a bounded set of exact native request identities and return pending, expired or the canonical attributed winner. Question values and native Scope identifiers are absent. Reading a winner never settles a tentative native promise; the accepted logical command's receipt reconciliation owns uncertain commit recovery. Frontend clients must retain their own command identity separately from these native decision identities.

Count limits bound each response, not the number of lifetime requests. Transient exchanges have separate bounded capacity, cancellation and deadlines. The protocol rejects responses exceeding its byte window rather than silently truncating prompt content.

## Alternatives considered

**Supply pending requests through private history reads.** Private body ownership and collaboration authorization differ, so one permit cannot represent both.

**Persist a second pending queue in the organization service.** Its expiry and first-winner state would compete with the live native owners and their durable decision receipts.

**Treat absence from a page as successful submission.** Pagination, another actor, cancellation and restart can all remove a request without committing the viewer's answer.

## Consequences

Native and protocol tests cover continuation after a removed request, separate Session filtering, native view changes, strict target matching, signatures and omitted metadata. Service tests hold replies across membership revocation and binding changes and retain creator-only private history access. A generated HTTPS client crosses the actual member WSS bridge, reads a prompt larger than one command frame, answers it and observes value-free native winner attribution. Large individual prompts still require a separately bounded detail-reading integration; this decision does not claim complete conversation UI, handoff or PRD acceptance.
