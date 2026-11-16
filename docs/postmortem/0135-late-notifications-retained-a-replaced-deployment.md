# Late notifications retained a replaced deployment

## Executive summary

Successful authorization of a replacement deployment left the prior notification source active. The connection owner retires that source, and delivery rechecks each listener after asynchronous work.

## Summary

While wiring connection-owned background notifications, a held valid response from an older deployment could still reach its consumer after a successful login proved a replacement deployment at the same issuer. A separate callback-lifetime test found that removing a consumer while an earlier listener awaited did not remove it from an already copied delivery list.

## Timeline

1. The live service and native bridge established metadata-only source identity, current authorization and finite transport bounds. The Web subscription adapter then retained sources independently of selected views.
2. A generated-client state fixture held the old source response, authorized a different deployment at the same issuer and released the old bytes. Two neighboring cases passed, but the replacement case received the old notice instead of an empty result.
3. The connection owner was corrected at its successful authorization boundary: older incarnations at that issuer become reauthorization-required, and their credential-bound sources retire before late reads resume. Cached user drafts remain owned by their original Space.
4. A second real delivery fixture held the first listener, removed the next listener and allowed the first to finish. The removed callback ran once. Delivery now rechecks listener membership after every preceding asynchronous callback.
5. Focused source, subscription, existing connection and notification-resolution tests passed 21 cases and 123 assertions. They establish source/state isolation, not completed App background delivery or browser presentation.

## Root cause

Connection descriptions were partitioned by deployment, but learning a successor at the same issuer did not invalidate the older ready source. Separately, a copied listener list was treated as a durable right to call each observer, even after that observer unsubscribed.

## Guardrails

- [x] Machine check: `apps/web/test/organization/notification-connections.test.ts` holds real generated stream responses across deployment and credential replacement and checks shared-source cancellation.
- [x] Machine check: the same test removes a listener behind an awaited predecessor and verifies the remaining shared source stays live.
- [x] Machine check: `apps/web/test/organization/notification-subscription.test.ts` rejects retired native observers, changed stream sequences and audience substitution across selection.
- [x] Owning procedure: the frontend recovery Skill requires proof at the connection owner's authority transition and per-listener revalidation.

## Lessons

URL equality does not establish source lifetime. New authority must retire its predecessor at the owning authorization transition, while selecting another still-valid account must preserve its background work. A captured callback also needs a live subscription at invocation time; a prior list snapshot does not supply that permission. See the [source ownership decision](../decisions/implemented/architecture/2026-11-12-retain-organization-notification-sources-across-space-selection.md).
