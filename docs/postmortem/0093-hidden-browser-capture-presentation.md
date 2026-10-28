# Hidden Browser capture waited for presentation

## Executive summary

A native Browser smoke run exceeded its unchanged deadline after valid geometry output. Local command traces reproduced screenshot waits on hidden native pages. Selecting Chromium's new-surface capture path exposed a second failure: immediate empty images before the target frame sink existed. Desktop combines the upstream capture path with reapplication of its existing drawing policy after native mounting. Valid viewport dimensions and one successful platform run were insufficient evidence.

## Summary

The failing CI execution was isolated to the native Desktop task; aggregate coverage thresholds passed but the execution gate remained red. The last CI geometry marker did not identify its pending command. The relevant native implementation was identical at the inspected base and head. Neither fact establishes an infrastructure-only failure or justifies an unchanged-source retry.

## Timeline

- The unchanged macOS fixture timed out. An instrumented run identified a post-detach `Page.captureScreenshot` that never completed before the original deadline.
- A delayed Linux control also stalled on a detached capture. Removing the clip or disabling beyond-viewport capture did not fix it. The latter had passed on macOS, demonstrating why the Linux counterexample mattered.
- Enabling the pinned Chromium new-surface path preserved the existing screenshot parameters and completed both platforms' controls. A 2048-pixel macOS document retained its distinct top and bottom pixels.
- The permanent regression added fresh pixels and actual PNG dimensions. Chromatic pixel sentinels exposed display-profile rounding, so exact assertions use black and white. Linux's non-overlay scrollbar required an explicit document width rather than equating content width with `innerWidth`; neither correction relaxes the dimensions or pixel assertions.
- Configured probes returned `Unable to capture screenshot` immediately on both platforms. Later successful runs did not close that failure. A macOS compositor trace showed the target local surface embedded but its frame sink unregistered and no target frame submitted before all six internal copy attempts failed. The trace did not expose the copy request's target ID or error enum; the missing-support interpretation also depends on the pinned Viz source.
- Merely subscribing to a first frame stalled on both platforms. Reapplying false before each capture and subscribing every time passed macOS but stalled Linux's second subscription. Subscribing only for a new primary frame passed simpler probes, but an expanded macOS lifecycle fixture stalled earlier, while observing human presentation.
- Toggling background throttling true then false emitted two `visibilitychange` events on both platforms. The zero-event assertion rejected that candidate despite successful pixels.
- Reapplying only the existing false policy after native mounting passed the expanded nine-capture fixture on both platforms without frame-subscription waits, capture-time policy injection or compositor tracing. The Linux control retaining that mounting correction but disabling the new-surface path still stalled on its second capture. The production macOS native suite then passed all ten cases; its page-pool case completed in 7.32 seconds versus the same case's 30-second pre-fix timeout.

## Root cause

The reproduced hang follows the pinned Chromium legacy `RequestForceRedraw` path, whose renderer completion depends on frame presentation. Native parenting does not make that callback inevitable. The selected upstream path requests a new surface and copies the requested repaint without that prerequisite.

That path still needs an initialized rendering target. Electron's false background-throttling setter updates the current renderer and, when it remains hidden, synchronizes the platform view with hidden painting. Constructor preferences alone do not perform that mounted-widget transition. The page pool applies the unchanged policy immediately after both native mounting paths. The [decision record](../decisions/implemented/bug-fix/2026-10-27-hidden-browser-capture-surface.md) owns the alternatives and upgrade obligations.

The exact pending operation in the original CI execution remains unknown. Its last geometry log is not event-level attribution. Existing native fullscreen-exit acceptance is also unresolved and is not covered by this repair.

## Measurement corrections

The expanded fixture initially mixed trusted and isolated JavaScript worlds when reading event counters, omitted required viewport/navigation fields, assumed PNG pixels always matched CSS pixels after renderer recovery, and assumed the first navigation away from an unlocked blank page must replace the process. These were test precondition defects, not product failures. Counters use one world; commands satisfy the strict schema; PNG dimensions use the measured device pixel ratio while result metadata stays in CSS pixels; cross-site tests establish a site-locked baseline first. Human-frame observation is installed before presentation, and fixed dimensions use a different aspect ratio from native bounds. Independent review also found that the added detach scenarios invalidated the later visible-input precondition. A native parent-membership assertion reproduced that coverage regression; each input scenario explicitly establishes and checks its presentation state.

## Guardrails

- Production and real native fixtures invoke one pre-ready Chromium configuration function. Conflicting disables and late invocation fail explicitly.
- Nine native captures retain full-page size and fresh top/bottom pixels across viewport, presentation, recovery and cross-site renderer transitions. Native view identity, hidden attachment, membership cleanup, focus and page visibility events are checked independently.
- Existing concurrent-capture and human-selection unit tests remain in place. No assertions, coverage thresholds, fixture selection or deadlines are weakened.
- Cross-platform controls use isolated fresh processes. Raw experiment outcomes are summarized before diagnostic caches and task-owned processes are removed.

## Lessons

Trace the pending native command rather than attributing a timeout from its last log line. A failed experiment is evidence even when a later platform or run passes. Separate presentation, painting, PNG contents and host-window visibility, and keep CI success distinct from native acceptance.
