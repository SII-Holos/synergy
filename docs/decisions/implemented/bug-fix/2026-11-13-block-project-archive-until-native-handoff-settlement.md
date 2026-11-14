# Decision Record: Block project archive until native handoff settlement

Status: implemented

## Problem

Project archive removes execution permission needed to coordinate an outstanding handoff. Archiving while that handoff still owns a Session can leave its source paused and its cancellation inaccessible. A service cancellation request does not establish that native preparation ended.

## Decision

The project owner asks the Session directory to reject pending handoffs inside the original project update transaction before writing an archive transition. The directory pages canonical Session headers and checks the project and retained handoff identity. It uses neither the caller's visible Session list nor an incomplete derived index. The error contains no private Session identity or body.

Handoff preparation and project archive share the service writer. If preparation commits first, archive rejects. If archive commits first, preparation fails current execution authorization. Cancellation still requires the original native proof before the directory releases its handoff identity. Project restore changes project state without dispatching controls or changing Session bindings.

## Alternatives considered

**Allowing handoff control on archived projects** leaves an unresolved transfer crossing a lifecycle transition that explicitly requires settlement, and broadens execution authorization to compensate for an avoidable state.

**Checking only visible Sessions or cancellation acknowledgement** misses private Sessions or native work that still holds its preparation lock.

## Consequences

Archive performs a paged canonical metadata scan in its writer transaction. Its memory use is bounded, while work grows with the service's Session directory. It does not load private bodies or introduce another lifecycle index. Other projects remain archivable. Existing archived-project stop and confirmation behavior remains owned by its original authorization paths.

## Verification

`packages/organization/test/handoff.test.ts` prepares an actual signed-connection handoff for a private Session beyond the first metadata page. An administrator cannot read that Session and cannot archive its project until a genuine signed source cancellation proof releases the handoff. Another project can archive independently; restoring the original project preserves its Session exactly. Two actual held SQL transactions exercise both admission orders. Auth and Session directory suites verify adjacent roles and metadata behavior.
