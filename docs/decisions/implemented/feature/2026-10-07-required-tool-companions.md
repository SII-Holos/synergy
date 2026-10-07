# Decision Record: Resolve required tool companions in Harness

Status: implemented

## Problem

A deferred operation can require a lookup or lifecycle tool in another group. Filtering the operation by host capability alone leaves the dependency absent from the model request, while expanding the dependency's entire group exposes unrelated tools. Separate discovery and resolver implementations can also disagree about which partial tool families are usable.

## Decision

Exposure metadata declares directional required companions. Harness derives the available family after authorization and runtime filters, removes dependents with unavailable companions, and derives visible companions transitively from the current exposure seeds. Discovery and model-tool resolution share the same closure. Session state retains explicit expansion only, so temporary activation does not become durable group expansion.

## Alternatives considered

- Host-specific exposure wrappers duplicate generic discovery behavior and leave adapters responsible for policy ordering.
- Expanding whole companion groups is simpler but increases model context with unrelated tools and conflates a dependency with group membership.
- Making every prerequisite resident avoids expansion but pays that context cost on unrelated requests.

## Consequences

Hosts keep one metadata source; the Harness owns filtering and visibility. Internal tools cannot be activated through a companion. An incorrectly declared required dependency intentionally suppresses its dependent, so optional workflow suggestions belong in tool guidance instead. Existing tools without companions keep their exposure behavior. There is no persisted schema change.
