# Renewed cleanup intent reused an old generation

## Executive summary

The native resource observer treated the original request's release row as its remaining cleanup work. A later resource generation could therefore outlive that row. The replacement initially reused an entry for an older known generation, allowing its valid historical receipt to hide a newly committed bind whose response was lost. Cleanup now retains unresolved dispatch intents separately from each observed grant generation.

## Summary

Temporary native Homes and an actual verified HTTPS/WSS organization service reproduced both failures. An ordinary root released generation one, continued under generation two and completed; the original observer left generation two held. A second fixture retained the local generation-one cleanup entry, committed a generation-two bind and lost that response. Selecting generation one's immutable receipt correctly settled the older entry but missed the new allocation.

## Timeline

1. The original request row settled once, then the same native root reacquired a resource generation that was not automatically released.
2. Per-generation native cleanup entries fixed that first case.
3. A real committed-bind response loss while the older entry remained pending reproduced a second retained generation.
4. Each description/bind gained a separate unresolved intent and its exact original signed commit expiry. A verified success confirms that dispatch; otherwise a transient predecessor or absence cannot settle it before that original window closes. A delayed native bind reproduced the unsafe old-generation observation while its real server callback could still commit. Inspection later resolved the retained intent to generation two, preserving the older receipt.
5. Cold native reopening migrated settled legacy receptions and released an otherwise unrecorded renewed generation. Independent Continue after source cancellation and target activation also released through the production native execution attachment.

## Root cause

Logical reception and resource occupancy have different lifetimes. A request is accepted once, but its grant can be reacquired and explicit continuation can create a successor grant. A known generation selector must keep selecting its historical receipt; it cannot simultaneously identify a later uncertain allocation. Reusing that selector erased the only local evidence that another dispatch needed reconciliation.

## Guardrails

The native owner records bodyless canonical input/control references and the actual parsed proof expiry before every dispatch, tracks each observed grant/generation and indexes pending work in the same transaction. Unresolved requests keep separate identities across restart; observing an older generation or absence is not final while their signed requests can still commit. Final cleanup uses the service inspection timestamp rather than the native scheduler clock; an earlier service watermark preserves the unresolved intent. Service commit guards reject delayed expired description/binding callbacks. The original released row is not reopened. Service grants and occupancy remain the authority; cleanup inspection never mints a grant or invokes a model. The observer uses canonical native terminal drainage for release and preserves permanent handoff/control closure as a separate nonterminal settlement.

- [x] Machine checks: `packages/organization-runtime/test/renewed-release-observer.test.ts` retains both failures, unknown description, a still-running delayed bind, cold legacy migration and shutdown drainage. Service `test/execution-inspection.test.ts` checks delayed description/binding rejection after the original signed window closes.
- [x] Machine checks: `packages/organization-runtime/test/execution-leases.test.ts` covers exact Store/artifact ownership, generation identity and paged root partitions.
- [x] Machine checks: `packages/organization-runtime/test/handoff-controllers-http.test.ts` covers automatic cleanup after independent Continue and old-source closure after target activation with real enrolled machines.

The [resource-generation decision](../decisions/implemented/architecture/2026-11-12-close-handoff-resource-generations-without-input-replay.md) preserves the distinction between reception, execution authority, resource occupancy and terminal evidence.

## Lessons

A historical receipt resolves only its exact generation. Persist an uncertain new dispatch independently before making an allocation-capable request, even if an older generation is still pending local reconciliation.
