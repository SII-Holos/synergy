# Decision Record: Conversation motion continuity

Status: implemented

## Problem

A newly announced assistant continuation can have no accepted content page yet. Treating that preparation demand as an unknown historical gap closes the preceding live activity batch until its first Part arrives. A canonical paused session can also retain an older running execution snapshot, leaving the process heading animated after stopping.

## Decision

An unfinished, empty latest assistant message in a working turn marks its initial content demand as a live continuation. It preserves the preceding batch's active presentation while the existing demand row prepares content. Historical pagination remains a grouping boundary; accepted prose still ends the previous batch. Group identities and content leases retain their existing owners.

The shared process-working resolver gives a canonical pause precedence over current-root execution snapshots and projected work. A newly captured submission takes precedence over the previous pause. Paused process content remains available in Balanced mode without a running heading, and the canonical pause reason supplies stopped or failed labels.

An unfinished tool within a canonically paused session shows a static paused indicator instead of continuing its spinner or shimmer. Resuming exposes the recorded tool state again; presentation never rewrites a tool outcome to success or failure.

The current paused turn also overrides a stale running completion summary with an interrupted or failed presentation, preserving its recorded duration and detail target. Completed turns with independently running subtasks keep their supplied summary.

Activity labels retain semantic fragment keys and localize numeric components through explicit translation placeholders. Counts use the shared 180 ms role and at most one old/new pair, with quiet four-pixel movement and locale-aware tabular numerals. Initial values, history, corrections and locale changes settle directly. A displayed total remains present for that batch even when pending facts catch up across activity phases. Routine activity labels coalesce over 120 ms; pause, error, approval, disconnection, submission and compaction transitions are immediate.

Scalar memo boundaries prevent a replaced projection object from being mistaken for a new identity or count. Resize markers distinguish height disclosure from opacity-only arrival. Following compensates native bottom clamping after content shrink, and retained navigation frames preserve active scroll transforms.

The outer viewport and bounded process viewport pin canonical layout immediately and decay a separate presentation offset over 240 ms. Clipped content wrappers prevent the offset from increasing scrollable geometry. Repeated growth retargets from the painted offset without restarting for unchanged destinations; native reading absorbs that offset into the real scroll position before cancelling. Explicit disclosure space motion excludes additional compensation. Navigation spanning a viewport uses a bounded 180 ms opacity transition so virtual rows cannot slide an empty screen into view. Reduced-motion changes settle current motion. Returning to latest has one preparation-and-scroll owner instead of two competing forced pins.

Process following belongs to the bounded viewport. An outer reading pause, including the pause established by opening a group, does not disable an otherwise-following live process. Its own reading input still captures and preserves an anchor. A parent transition back to following resumes active groups; mounting into a following parent and resuming completed history do not discard saved local reading. The outer conversation owns the only floating return-to-latest control, avoiding duplicate nested buttons while retaining native bottom and End-key recovery.

Session presentation keeps one inert, inaccessible snapshot of the outgoing rendered window within the same server and Scope. The previous view releases its subscriptions normally; its retained frame has no IDs or event handlers. Incoming title and content share one 180 ms fade after body and reading admission. Superseded loading targets cannot admit an older destination. A Scope boundary drops the outgoing frame, and reduced motion preserves loading continuity while removing the fade.

A captured first submission already owns its future Session ID before the route commits. The presentation owner, viewport binding, admission callback and reading bookmark use that resolved conversation identity together. Scalar memos gate owner and readiness effects so replacing their reactive inputs with equal values does not announce a departure or restart presentation. Promoting the draft route to the same Session retains its admitted, still-mounted viewport. Route-only ownership and repeated departure previously left the second message blocked after the first reply completed. Production acceptance delays Session creation, types the next draft during that delay, and sends it after the first reply while checking retained viewport and editor nodes.

The conversation pane starts at the shared toolbar origin without top padding at every breakpoint. This keeps the positioned presentation layer's session controls aligned with the portaled workspace control and the workspace's own header. The conversation viewport owns content clearance below the header; the pane retains its bottom spacing. Toolbar geometry tests compose the real presentation layer and compare the header origin and button centers across breakpoints and workspace disclosure.

Composer available-space measurement identifies the current session top bar's bottom edge explicitly, including its inset within the pane. Presentation wrappers and retained snapshots do not reserve chrome height. Browser coverage composes the real presentation layers with the Composer, checking empty text visibility, pointer resizing, expansion, collapse and retained navigation; fixed-height resize-control fixtures remain responsible only for gestures.

Session-view reading memory stores a message, optional Part and paragraph, viewport offset and follow intent in a bounded runtime-only map. It shares the layout owner's server boundary and pruning lifecycle, with a maximum of fifty entries. Returning readers locate accepted content before restoring the paragraph; shared message IDs on pagination demand rows cannot substitute for a body. Admission waits for the requested block when hydration has not rendered it yet, then falls back through the message and nearby root when necessary. A validated local submission explicitly requests latest following; canonical handoff and historical arrival do not repeat that request. Layout measurements use canonical offsets rather than animated coordinates.

The in-transcript return-to-latest button owns its activation event. Its pointer or keyboard click must not bubble into the viewport's reading-interruption handler and cancel the same pending navigation. Later reading input still invalidates the captured intent. Production history acceptance exercises pointer, Enter and Space activation after locating an older message, under delayed reads and CPU throttling, before reconnect recovery.

An explicit location inside a process installs its target identity and offset as the reading anchor before the inner virtualizer moves. Pausing at the old position and waiting for a native scroll event leaves a gap in which body hydration can restore the old anchor and evict the newly located Part. The shared viewport accepts the location's anchor atomically with pausing; subsequent native reading replaces it normally. Regression coverage combines a location and body mutation in the same browser task, before native scroll delivery, and verifies that the requested content stays aligned.

The outer viewport also records the offset at native movement input. If the scroll position has already changed before its scroll event is delivered, resize handling must leave that movement intact instead of restoring the previous reading anchor. An intervening layout compensation updates the pending offset without consuming the user's movement; the next uncompensated scroll event accepts its new reading anchor. Following, explicit interaction and viewport replacement clear pending movement. Behavioral regressions cover both direct movement and movement after an earlier compensation, then verify that later content growth still preserves reading.

A reading anchor must intersect the viewport, including its lower edge. A native scroll can arrive before the virtual list replaces its old mounted window; accepting a retained row below the viewport preserves an offscreen point and pushes newly visible history away as bodies hydrate. An empty visible window therefore has no reading owner. A later resize acquires the newly visible owner before subsequent growth needs compensation. Browser coverage rejects an offscreen retained row, and hook coverage verifies that content admitted after an empty window acquires stable reading ownership.

## Alternatives considered

**Delay all group changes.** A timeout conceals the preparation boundary, delays legitimate prose collection and depends on provider speed.

**Retain two live page owners while navigation prepares.** Duplicating session-level commands, body leases and callbacks risks acting against a changing route. Retaining the bounded outgoing rendered frame preserves visual continuity without keeping the previous session's reactive owner alive.

**Restore only an absolute scroll offset.** Late Markdown and process disclosure can change geometry above the reader. Logical content identity supplies the restoration target and native reading resumes ownership after it lands.

**Rewrite the stored execution state from the renderer.** Frontend presentation must consume the canonical runtime status without manufacturing backend transitions.

## Consequences

Preparation, genuine history gaps, parallel work and confirmed completion retain distinct behavior. The regressions exercise a pending continuation followed by accepted tool content and conflicting pause, execution, projection and new-submission states. Existing bounded row and history-group tests remain applicable.
