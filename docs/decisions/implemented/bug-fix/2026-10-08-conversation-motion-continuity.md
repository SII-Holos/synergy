# Decision Record: Conversation motion continuity

Status: implemented

## Problem

A newly announced assistant continuation can have no accepted content page yet. Treating that preparation demand as an unknown historical gap closes the preceding live activity batch until its first Part arrives. A canonical paused session can also retain an older running execution snapshot, leaving the process heading animated after stopping.

## Decision

An unfinished, empty latest assistant message in a working turn marks its initial content demand as a live continuation. It preserves the preceding batch's active presentation while the existing demand row prepares content. Historical pagination remains a grouping boundary; accepted prose still ends the previous batch. Group identities and content leases retain their existing owners.

The shared process-working resolver gives a canonical pause precedence over current-root execution snapshots and projected work. A newly captured submission takes precedence over the previous pause. Paused process content remains available in Balanced mode without a running heading, and the canonical pause reason supplies stopped or failed labels.

Activity labels retain semantic fragment keys and localize numeric components through explicit translation placeholders. Counts use the shared 180 ms role and at most one old/new pair, with quiet four-pixel movement and locale-aware tabular numerals. Initial values, history, corrections and locale changes settle directly. A live total remains present once shown. Routine activity labels coalesce over 120 ms; pause, error, approval, disconnection, submission and compaction transitions are immediate.

The outer viewport pins canonical layout immediately and decays a separate presentation offset over 240 ms. Its clipped content wrapper prevents the offset from increasing scrollable geometry. Repeated growth retargets from the painted offset; native reading absorbs that offset into the real scroll position before cancelling. Explicit disclosure space motion excludes additional compensation. Reduced-motion changes settle current motion. Returning to latest has one preparation-and-scroll owner instead of two competing forced pins.

Session presentation keeps one inert, inaccessible snapshot of the outgoing rendered window within the same server and Scope. The previous view releases its subscriptions normally; its retained frame has no IDs or event handlers. Incoming title and content share one 180 ms fade after body and reading admission. Superseded loading targets cannot admit an older destination. A Scope boundary drops the outgoing frame, and reduced motion preserves loading continuity while removing the fade.

Session-view reading memory stores a message, optional Part and paragraph, viewport offset and follow intent in a bounded runtime-only map. It shares the layout owner's server boundary and pruning lifecycle, with a maximum of fifty entries. Returning readers locate accepted content before restoring the paragraph; shared message IDs on pagination demand rows cannot substitute for a body. Admission waits for the requested block when hydration has not rendered it yet, then falls back through the message and nearby root when necessary. A validated local submission explicitly requests latest following; canonical handoff and historical arrival do not repeat that request. Layout measurements use canonical offsets rather than animated coordinates.

## Alternatives considered

**Delay all group changes.** A timeout conceals the preparation boundary, delays legitimate prose collection and depends on provider speed.

**Retain two live page owners while navigation prepares.** Duplicating session-level commands, body leases and callbacks risks acting against a changing route. Retaining the bounded outgoing rendered frame preserves visual continuity without keeping the previous session's reactive owner alive.

**Restore only an absolute scroll offset.** Late Markdown and process disclosure can change geometry above the reader. Logical content identity supplies the restoration target and native reading resumes ownership after it lands.

**Rewrite the stored execution state from the renderer.** Frontend presentation must consume the canonical runtime status without manufacturing backend transitions.

## Consequences

Preparation, genuine history gaps, parallel work and confirmed completion retain distinct behavior. The regressions exercise a pending continuation followed by accepted tool content and conflicting pause, execution, projection and new-submission states. Existing bounded row and history-group tests remain applicable.
