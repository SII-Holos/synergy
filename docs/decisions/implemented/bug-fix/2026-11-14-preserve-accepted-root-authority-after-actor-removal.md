# Decision Record: Preserve accepted-root authority after historical actor removal

Status: implemented

## Problem

A shared Hosted task can receive a collaborator's authorized question reply after its original input actor leaves the organization. Requiring that historical actor to remain an active account at every resource description fails the already accepted task even while its actual Runtime, retained root and selected resources remain valid. Admission, canonical native acceptance and reacquiring released resources require different checks.

## Decision

Execution descriptions and root binding reconcile the exact original signed native acceptance B against the Service command before resolving the original grant. A delayed B receipt can bind the original provisional grant after historical interactive actor removal; the provisional row alone cannot authorize work. The original actor remains immutable input provenance. A reply keeps its own authenticated decision actor and never replaces the task actor.

For interactive work with canonical B, initial binding and a still-held execution grant use the current registered Runtime and authenticated connection, exact Session driver and epoch, actual Runtime account/project role, retained occupancy, unchanged resource selection/revision and current resource availability. Structural actor/organization identity checks remain mandatory. Closed grants, handoff and independent-control rules are unchanged.

Reacquiring a nonheld grant still checks the effective actor's current account and Session execution access before retaining another generation. API/token-bearing actors always retain the original strict token, permit, account and Session checks. Human queries, new input, question replies and cross-Session tool reads retain their separate current-account authorization; canonical B does not authorize those actions.

## Alternatives considered

**Require the original interactive account for every accepted-root operation.** This treats historical input attribution as revocation of another valid Runtime owner and interrupts shared work after an authorized reply.

**Rewrite the task actor to the collaborator answering a question.** The reply actor owns that decision, not the original input, root, resource grant or machine lease. Rewriting attribution would change those independent identities.

**Skip current actor checks for every receipt-bearing grant.** A released generation requires fresh execution authority before reacquisition, and API tokens retain their explicit current-authority rules. A receipt does not exempt either case.

## Consequences

The fix reuses the original grant and signed proof. It adds no actor, grant, wire field, persistence format or authority cache. The [canonical execution rules](../../../architecture/organization.md#session-resources-and-execution-grants) and [original binding decision](../architecture/2026-11-09-bind-organization-execution-grants.md) remain the owning references. The [postmortem](../../../postmortem/0207-historical-actor-check-revoked-accepted-root.md) records the actual failure and validation boundaries.
