# Decision Record: Conversation scroll ownership

Status: implemented

## Problem

Expanding a tool batch combined parent disclosure, a local scroll window, a second virtualizer, independent layout caching and local reading restoration. Cold body admission, resize and user movement crossed these owners. A list could animate before its bodies had measurable geometry, then admit another set of readers as its own scroll range changed. Fixing individual timings left the ownership problem intact.

## Decision

The transcript virtualizer owns every expanded compact process row and the main native viewport owns following, reading, location and keyboard movement. Batch headers retain semantic grouping and independent expansion preferences. Each tool owns one Part-keyed virtual row; bounded reasoning chunks retain individual fragment targets. Heavyweight captured outputs open the existing inspector. Shared nonvirtual activity rendering uses bounded pages in its containing reader.

Shared turn segments and reasoning inside the conversation flow inherit that reader and allocate no local scroll controller, input listeners or reader resize observers. Compact activity bodies project only their selected Parts through the shared activity projector and timeline renderer; they do not initialize an entire turn's metadata, completion and status calculations. Footer-only text preparation stays with the footer. Main-list estimates remain adaptive across prose and compact tools. Cold process rows reserve summary-based space but skip entrance on unfinished body geometry; accepted warm bodies can animate before their asynchronous lease acknowledgement completes.

Manual gestures commit virtual layout once and preserve its accepted reading offset. Retained visible rows animate their displacement with a compositor transform; admitted rows fade, and mounted exits fade before one coalesced removal. Measured heights do not animate. Preparations coalesce by generation, and row or owner disposal cancels its animations. Native reading input interrupts displacement before establishing its new anchor. One-use receipts cannot replay during later hydration or virtual remount. The trigger and the visible Part or paragraph use the main reading owner throughout the change. This adapts the [Chrome animation guidance](https://web.dev/articles/animations-guide#avoid_properties_that_trigger_layout_or_paint) to the transcript's measurement boundary.

Cancellation ownership includes the adjacent Composer lifecycle. Draft work exists only for active draft observers. Cancellation first releases the owner's controller, then aborts the work, so an aborted exception stack cannot keep a departed conversation's reactive tree reachable from the current Composer. Removing the last observer and disposing a document obey the same rule.

The observable reference-product comparison and local experimental evidence are recorded in [the postmortem](../../../postmortem/0061-conversation-scroll-ownership.md). The comparison concerns public interaction and rendered DOM; it does not establish ChatGPT's private implementation. The transcript continues using the pinned Virtua implementation and the existing [ordered DOM reconciliation correction](../../../../patches/README.md).

This supersedes the nested-reader choice in [bounded process windows](../feature/2026-10-04-bounded-process-windows-and-system-event-details.md) and its local reading procedures in [process stability](../bug-fix/2026-10-05-conversation-process-stability.md). Their system-event ownership, native input, live arrival and recovery requirements remain relevant.

## Alternatives considered

**Add readiness timers and another local restoration pass.** These can change the symptom but leave two virtual ranges, caches and scroll owners negotiating the same disclosure. Body latency and background recovery cannot be reduced to one settling deadline.

**Mount every expanded tool in the main document.** This removes nested scrolling but makes DOM, body reads and reactive owners grow with history length. Main-list virtualization retains the simpler reading model with bounded demand.

**Keep a small inner reader for each batch.** This limits visible height but transfers ordinary transcript reading into many separate scroll positions and requires extra retention and restoration. Independent object readers remain appropriate for explicit captured-output inspection.

## Consequences

An expanded batch can occupy more document height; the reader sees one continuous chronological conversation. The main virtualizer bounds mounted content and leases, while the existing session-owned preferences preserve parent, batch and reasoning choices. Removing the batch viewport also removes its virtualizer, geometry cache, local location dispatch and reading-owner loop.

Tests replace assumptions about local windows with main-reader invariants: exact Part location, native movement, paragraph preservation, bounded cold admission, connected motion, stable trigger geometry, reduced motion and release on collapse. Frozen production comparisons and forced-GC cycle measurements assess this change under controlled conditions; they do not promise zero long tasks or the absence of every application leak.
