# Decision Record: Background summary grouping

Status: implemented

## Problem

Retained background conversations receive lightweight Part summaries while full bodies remain demand-driven. A newly received message can therefore have usable summaries without a Part-page snapshot. Treating every absent page as a visible unloaded span fragments continuous activity into temporary groups, reserves empty rows and changes automatic disclosure as page requests finish. A retained execution snapshot can also still report running after a completed terminal message arrived; refreshing that snapshot can briefly reopen and then collect the process. Scroll-offset assertions alone cannot detect either content instability.

## Decision

A missing page with renderable summaries creates a validation row with no reserved height. It keeps the existing page loader and explicit failure/retry surface but does not end a logical activity group or mark that group inactive. Known summaries determine process grouping and automatic disclosure independently of page validation. Missing content with no renderable summaries and confirmed pagination gaps retain their existing loading geometry and group boundaries.

Body leases, viewport virtualization, retained reading anchors, message visibility and transport interests keep their existing owners. Background views do not fetch bodies, and closed process groups do not materialize their tools just to validate a page. Actual newly discovered content still updates the authoritative display projection.

A completed terminal reply after the latest same-root input takes precedence over a stale running execution snapshot for process presentation. Reuse the existing turn terminal predicate; a later hidden continuation still reopens work, and an incomplete terminal message retains the existing completion handoff. Reading and explicit disclosure remain authoritative. The display decision does not wait for or add an execution request.

## Alternatives considered

**Load all background bodies.** This increases transport and memory work to compensate for a display-grouping error. The existing summaries already describe the known activity sequence.

**Wait for every page before revealing a retained conversation.** This reintroduces a warm navigation barrier and makes unrelated historical pages delay readable content.

**Remove page validation.** Live summaries do not establish snapshot completeness. Validation and genuine pagination must remain available, including explicit errors and retries.

## Consequences

Page response ordering cannot split or reopen a continuous group described by accepted summaries. Behavioral tests cover many new background message identities with independently delayed pages, running and completed tasks, stale execution snapshots, nested reading anchors, stable collection, bounded body demand and zero hidden or unchanged-body reads. Confirmed pagination gaps remain separate. Production acceptance measures group membership and empty loading geometry alongside scrolling, so a stable final offset cannot hide incomplete rendering. The ownership rules remain in [frontend data sync](../../../architecture/frontend-data-sync.md).
