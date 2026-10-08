# Conversation layout flushes

## Executive summary

Conversation disclosure and scrolling still paused after pending-geometry corrections. Repeated style and layout synchronization dominated the remaining cost, amplified by unchanged focus publication and inherited scrolling styles. A consumer querying geometry paid for earlier mutations elsewhere in the renderer; optimizing only that consumer's JavaScript misses the cause.

## Evidence

A supplied 18.47-second Chromium trace matched the merged rendering sources. Renderer busy time was 8.04 seconds, including recording startup overhead. Style recalculation occupied 4.57 seconds and layout 0.69 seconds. There were 56 tasks above 50ms; the longest took 367ms. Of 539 style events, 121 affected more than 1,000 elements and accounted for 4.41 seconds. This establishes broad synchronization, not a particular selector's responsibility.

Direct flushing stacks included resize publication, Markdown selection, the host scroll spy, cache-binding width reads and disclosure measurement. Focus before clicks also retraced summaries. Blink's [Selection implementation](https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/core/editing/dom_selection.cc) confirms that `isCollapsed` updates layout; a DOM range's collapsed state depends on its endpoints. Selection without a cached range may still require browser synchronization.

There were 104 body requests for 87 distinct versioned URLs. Seventeen failed; sixteen failed targets were requested again shortly afterwards. Row cleanup reached lease cancellation, but the trace does not establish every failure's reason. Offscreen consumers must still cancel. Heap rose from about 79 to 118 MiB and returned to about 85 MiB; short-trace counters cannot establish retained ownership or an unbounded leak.

## Root cause

Replacing identical retention arrays invalidated projection consumers. The resize batch then queried live layout while a scrolling root changed an inherited pointer-event property over a large subtree. Width reads ran amid sibling mounts, selection checks forced another update, and the host independently scanned positions already measured by the virtualizer. These boundaries amplified pending work. Consecutive disclosure bindings also measured and animated one target before the next target read its geometry, forcing another synchronization within the same interaction. Their preparation needs a shared read/release/measure/play transaction before paint.

## Guardrails

[Conversation layout publication](../decisions/implemented/bug-fix/2026-10-08-conversation-layout-flushes.md) records the correction. Regressions cover unchanged focus against large history, visible fixed-position measurements, native hit testing during scrolling, selected streaming text, accepted reading offsets, width fences and hidden-list recovery through both dependency entrypoints. Reading, interruption, cancellation, terminal handoff and disposal suites remain required. Large-history comparisons use the same frozen imported data; private traces and identifiers stay outside repository artifacts.

## Verification

Production builds were compared against one frozen history of 328 messages and 1,730 Parts at a 1440 × 900 viewport. Three alternating baseline/candidate pairs used 4× CPU throttling, native clicks and wheel input, without CPU sampling. Each action accumulated browser metrics over 1.2 seconds; these totals are not individual blocking-task durations. Median results were:

| Action                      | Baseline task time | Corrected task time | Baseline style time | Corrected style time |
| --------------------------- | -----------------: | ------------------: | ------------------: | -------------------: |
| First parent disclosure     |            483.8ms |             364.4ms |             166.7ms |              104.2ms |
| First tool-batch disclosure |            614.0ms |             564.0ms |             242.7ms |              225.1ms |
| Parent collapse             |            428.6ms |             339.0ms |             136.8ms |               99.6ms |
| Parent reopen               |            290.9ms |             263.3ms |             117.0ms |               89.7ms |

A single ordinary-speed pair had no tasks above 50ms in either build. The throttled candidate still had long tasks during first disclosure and reopening; batch reopening was approximately unchanged. These observations establish a reduction in repeated work, not a universal latency guarantee. Behavioral tests independently establish that unchanged focus and reading do not retrace summaries and that grouped preparation measures all targets before any animation begins.

Both throttled builds made 40 body requests for 36 versioned targets. Cancelled requests were retried after later reader-window movement rather than immediately; no failed target was retried within 300ms. This comparison does not reproduce every short retry in the source trace and does not justify delaying cancellation or changing retention budgets.

After two warmup cycles and 20 disclosure/collapse cycles, forced-GC heap samples ranged from 26.9 to 27.4 MiB. DOM nodes stayed at 2,103 and event listeners at 401. Initial and final heap snapshots were captured; the browser reported no detached process subtrees and no animation started on a detached target. Other detached trees existed, so this bounded experiment does not establish the absence of every application leak.

The real conversation suite passed 71 tests, shared motion interruption and disposal passed 13, and the shared UI package runner passed. Both dependency entrypoints passed fixed-position and hidden-view recovery after a fresh frozen-lockfile install. Production CSS verification uses the ordinary native hit-testing contract rather than requiring the removed pointer-event override.
