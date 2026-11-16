# Decision Record: Authorize organization Cortex lineage

Status: implemented

## Problem

Member execution originally accepted only root organization Sessions, so a Cortex child could not use the model resource selected by its accepted parent task. Allowing every `parentID` child would let an unadmitted Session reuse the parent's organization binding and resource grant.

## Decision

The organization Runtime resolves a child Session's durable Cortex metadata before execution. It requires the child `parentID` and `cortex.parentSessionID` to agree, an active or recoverable task status, an existing parent binding on the same project and driver Runtime, and a recorded `parentMessageID` that resolves to a canonical parent root. It walks nested children until it finds the organization actor and accepted root, rejecting cycles, missing records, foreign actors, archived bindings and terminal tasks.

Description and authorization for a child use the accepted ancestor actor, Session and root identity. The child still materializes and validates its own canonical model root, and its scoped provider catalog and model selection remain local to that child. Binding and gateway reservation proofs use the accepted grant's Session and root fields, so a child call cannot mint a second service grant or reinterpret the parent resource selection. A child without valid Cortex lineage remains denied.

## Alternatives considered

**Reject every child Session.** This preserved the previous security boundary but made Cortex delegation unusable for organization members and prevented the planned child execution path.

**Authorize any child whose organization binding matches its parent.** This would treat a caller-created child as an admitted task and would bypass the accepted command receipt, so it was rejected.

**Create a new organization command and grant for every Cortex child.** This would duplicate the parent admission budget and resource selection, while the child is an execution descendant of one accepted task. Reusing the ancestor grant identity keeps service accounting and release tied to the accepted command.

## Consequences

Organization member execution now supports nested Cortex model calls while retaining one accepted service identity and one resource-selection decision. The lineage walk adds bounded Session and message reads to preparation and rejects stale or malformed durable metadata before any provider or gateway request. Service records continue to identify the accepted root; child Session identity remains visible in local transcript and execution state.
