# Decision Record: Preserve Part discovery after subscription renewal

Status: implemented

## Problem

A first Part checkpoint can arrive after visibility restoration or reconnect renews its subscription. Rejecting the entire obsolete streaming event loses the Part's presentation summary. A previously loaded empty Part page then leaves the completed assistant without a body row, even though canonical content exists. Accepting every obsolete summary instead can regress content that a newer checkpoint or snapshot already supplied.

## Decision

The Web subscription projection strips rejected bodies and retains obsolete unsequenced summaries as local discovery hints. GlobalSync admits a discovery hint only when its Part is absent from the loaded message's summaries. Existing summaries and bodies remain unchanged. The normal row content lease obtains the body under its current subscription and uses the shared version-conflict recovery when necessary.

The event queue coalesces discovery hints independently of current summaries so a delayed obsolete hint cannot remove a pending current update. Sequenced state summaries retain their normal authoritative processing. The discovery marker exists only inside the Web event pipeline; the server protocol, SDK schema and canonical message state stay unchanged. The current rules live in [Frontend data sync](../../../architecture/frontend-data-sync.md#demand-driven-resources-and-content).

## Alternatives considered

**Accept obsolete bodies or replace existing summaries.** This closes the missing-row symptom by weakening version protection and can overwrite a newer checkpoint or snapshot.

**Refetch the conversation on every rejected frame.** This couples high-frequency streaming to history loading, adds requests and disturbs retained reading windows. Part discovery can use the existing bounded body loader instead.

**Reload only when execution completes.** Completion does not cover ongoing tool and reasoning Parts, and it leaves a partially rendered conversation until the turn ends.

## Consequences

An obsolete first checkpoint can create a discoverable row without applying its body or rolling back accepted content. Visibility and reconnect tests must cross first discovery, current hydration and late obsolete delivery; queue tests must cover both event classes together. Canonical body failures remain explicit and bounded by the existing recovery budget. No completion state is inferred from body presence.
