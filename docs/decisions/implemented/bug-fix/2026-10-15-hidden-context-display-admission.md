# Decision Record: Hidden context display admission

Status: implemented

## Problem

Runtime context is admitted as a canonical non-root user message with `visible: false`. The virtual conversation projected every turn member into a load row before inspecting its Part summaries. A hidden message therefore briefly reserved space, triggered latest following and disappeared when its non-renderable summary arrived. Completed-content tests and empty assistant continuation tests did not cover this admission order. Existing-session optimistic messages also lacked local activity feedback while waiting for runtime status.

## Decision

The conversation row builder applies canonical user-message visibility before reading summaries, creating loading rows or grouping process events. Hidden messages remain in the lifecycle projection and model context. Visible deliveries and assistant compaction events retain their existing presentation. No new transport filter or backend semantics are introduced.

The current optimistic user root supplies the existing submitting-input activity through canonical message admission until matching runtime activity, execution state or terminal assistant evidence takes over. The single pending root is owned by the conversation identity; message aliases retain it, while root replacement, removal, pause and retry release it. Explicit runtime state outranks this local feedback. This projection uses the existing pending marker and creates no timer, subscription, polling or durable state. The UI does not predict that project-file preparation has started.

## Alternatives considered

**Wait for the hidden message's Part page.** This caused the transient loading row and an unnecessary request. Visibility is already authoritative in the message header.

**Suppress all loading-row height or following.** Visible historical content still needs bounded placeholders, and new user-visible output must continue following. Filtering hidden messages at display admission addresses the cause without changing scrolling policy.

**Start a second submission lease for existing sessions.** The existing optimistic marker already owns the pending interval. Another lease would add reconciliation and cleanup paths for the same state.

## Consequences

Hidden context no longer creates transcript geometry or body-page demand. Regression coverage includes delayed hidden-message pages during first and subsequent model calls, following and historical reading, stable DOM ownership, zero hidden-page requests, visible delivery/compaction preservation and optimistic activity handoff. Full turn membership, event order and transport budgets remain unchanged. The shared contract lives in [frontend data sync](../../../architecture/frontend-data-sync.md).
