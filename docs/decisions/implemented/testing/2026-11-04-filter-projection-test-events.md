# Decision Record: Keep projection fixtures scoped to their events

Status: implemented

## Problem

The real WebSocket projection test's contributor emitted a patch for every event passed to its callback. Active projection contributors receive the event bus and own their event-type, Scope and Session filters. Runtime background events could therefore add a fixture patch and intermittently break its exact expected count. The production execution contributor already applies those filters.

## Decision

Apply the same event identity filters in the fixture. Inject unrelated event types, Scopes and Sessions explicitly so the test fails deterministically without them. Keep the initial snapshot plus thirty updates as an exact thirty-one-patch assertion.

Wait for the subscribed socket's initial and final revisions as well as the other socket's coalesced cursor. A receipt on one socket cannot establish delivery on another. Retain payload privacy, frame size, capability negotiation and disconnect-release assertions.

## Alternatives considered

**Accept at least thirty-one patches.** This would hide an incorrectly scoped contributor and weaken the original contract.

**Filter all transport callbacks centrally.** Contributors may consume several event types; their declared event type also controls raw-event omission. Changing that contract is unnecessary for this fixture defect.

## Consequences

The test remains a real multi-client WebSocket integration and no longer depends on the absence of Runtime background events. Verification includes its original CI batch with randomized order. Published product behavior is unchanged.
