# Decision Record: Pause retained execution readers

Status: implemented

## Problem

Execution leases stopped when their retained view became inactive, but context history, trajectory and inspector HTTP reads could still run on reconnect. Request-body rendering also called a component factory from a reactive metadata expression, recreating the reader after an unchanged node response. Subscription savings alone did not bound inactive work or preserve the reader's state.

## Decision

Context history uses the same consuming predicate as its execution lease: Session, panel, page visibility, capability and explicit demand. Dashboard, trajectory and inspector reads observe their owning view's activity. Hiding aborts pending reads and invalidates late completions without clearing accepted data or selected inspector DOM. Reactivation resumes cancelled evidence ranges and recovers metadata in place. Evidence readers mount as stable components; metadata and label updates flow through props instead of recreating the request reader.

[Provider integration tests](../../../../apps/web/test/context/execution-residency.dom.test.ts) hide each owner independently, restore the projection while hidden and resolve cancelled work late. [Real execution UI tests](../../../../apps/web/test/components/execution/delegation.dom.test.tsx) retain the inspector and reader nodes, count reconnect requests, and resume pending request/response bodies. This implements the activity lifetime in [bounded residency](../architecture/2026-10-12-frontend-residency-projections.md).

## Alternatives considered

**Release only WebSocket leases.** HTTP recovery and selected body readers have their own lifetimes. A released lease does not cancel those operations.

**Unmount the inspector while hidden.** This stops requests but discards its reading position, selected section and admitted evidence. Activity and DOM lifetime must remain separate.

**Accept remounts when metadata changes.** Unchanged evidence would be refetched and local reader state lost; a stable component can update its metadata without changing identity.

## Consequences

Hidden views retain bounded presentation state while releasing pending detail work. Recovery can make a metadata request on reactivation, but unchanged admitted bodies remain reusable. Explicit copy/download work keeps its existing domain lifecycle. No API or persisted-state format changes are required.
