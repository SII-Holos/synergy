# Decision Record: Conversation motion continuity

Status: implemented

## Problem

A newly announced assistant continuation can have no accepted content page yet. Treating that preparation demand as an unknown historical gap closes the preceding live activity batch until its first Part arrives. A canonical paused session can also retain an older running execution snapshot, leaving the process heading animated after stopping.

## Decision

An unfinished, empty latest assistant message in a working turn marks its initial content demand as a live continuation. It preserves the preceding batch's active presentation while the existing demand row prepares content. Historical pagination remains a grouping boundary; accepted prose still ends the previous batch. Group identities and content leases retain their existing owners.

The shared process-working resolver gives a canonical pause precedence over current-root execution snapshots and projected work. A newly captured submission takes precedence over the previous pause. Paused process content remains available in Balanced mode without a running heading, and the canonical pause reason supplies stopped or failed labels.

Activity labels retain semantic fragment keys and localize numeric components through explicit translation placeholders. Counts use the shared 180 ms role and at most one old/new pair, with quiet four-pixel movement and locale-aware tabular numerals. Initial values, history, corrections and locale changes settle directly. A live total remains present once shown. Routine activity labels coalesce over 120 ms; pause, error, approval, disconnection, submission and compaction transitions are immediate.

The outer viewport pins canonical layout immediately and decays a separate presentation offset over 240 ms. Its clipped content wrapper prevents the offset from increasing scrollable geometry. Repeated growth retargets from the painted offset; native reading absorbs that offset into the real scroll position before cancelling. Explicit disclosure space motion excludes additional compensation. Reduced-motion changes settle current motion. Returning to latest has one preparation-and-scroll owner instead of two competing forced pins.

## Alternatives considered

**Delay all group changes.** A timeout conceals the preparation boundary, delays legitimate prose collection and depends on provider speed.

**Rewrite the stored execution state from the renderer.** Frontend presentation must consume the canonical runtime status without manufacturing backend transitions.

## Consequences

Preparation, genuine history gaps, parallel work and confirmed completion retain distinct behavior. The regressions exercise a pending continuation followed by accepted tool content and conflicting pause, execution, projection and new-submission states. Existing bounded row and history-group tests remain applicable.
