# Conversation scroll ownership

## Executive summary

Secondary tool disclosure remained unstable after individual layout optimizations because it built another virtualized reader inside the transcript. Cold bodies, local geometry and two reading owners had to converge after the gesture. Compact tools need one conversation reader, bounded body demand and explicit ownership of disclosure motion; readiness must distinguish accepted display geometry from asynchronous version validation.

## Summary

A reference-product inspection found that the observed ChatGPT tool batch grew naturally in the main message flow, with explicit access to full tool output. Its header retained the reading context during disclosure. This observation supports an interaction principle; it does not establish ChatGPT's private framework, virtualization, request policy, animation timings or heap ownership. Long object readers can still have independent scrolling.

Synergy's expanded batch allocated a local viewport, another Virtua instance, width admission, a layout cache, reading restoration, focus/selection retention and a local location event. Parent and row motion also ran while visible Part bodies were resolving. Closing and reopening reconstructed these owners, even when accepted content was cached.

## Timeline

On 2026-10-09, the implementation was traced from a batch gesture through projection, mounting, leases, measurement and scrolling. Behavioral tests first reproduced nested scrolling and unbounded initial cold admission within a batch. Replacing the local reader exposed two further mistakes: multi-tool render chunks admitted several bodies at once, and a fixed compact-line estimate in the main mixed-content list underestimated long-prose scroll range. Each tool receives its own row, while the main list retains adaptive estimates.

Exact reasoning location also initially selected a grouped wrapper before the target fragment. A failing test measured a 64px discrepancy; selecting the concrete Part fixes both location and subsequent main-reader restoration. Under 4× CPU throttling, growth before and after the visible fragment preserves its paragraph offset.

A warm-cache animation test separately exposed an overly strict readiness condition: lease acknowledgement arrives asynchronously even when accepted bodies are already available. The row's measurable accepted content gates entrance; initial missing bodies reserve space and stay static. Version validation still gates transcript readiness independently.

Production comparisons rejected an intermediate implementation that animated every main row's height. At 4× CPU, median batch close work increased from 260ms to 549ms and reopen from 273ms to 513ms, because the virtualizer repeatedly measured changing heights. Layout now commits once and connected retained wrappers animate their displacement with transforms. Exits release their space together after fading.

A separate browser regression found 21 nested scroll listeners and reader resize observers after one disclosure, despite removing the explicit batch reader. Every shared turn segment still allocated its standalone reader. Conversation flow now supplies that ownership to both turn segments and reasoning, and the same regression observes zero nested readers. A second regression measured 38 runtime-status reads for a bounded visible tool window. Compact bodies now initialize only selected-Part activity projection, inheriting their root's execution state, while preserving shared tool projection, registered renderers and message slots. Reasoning disclosure also commits its expanded or collapsed layout once, using the same transcript movement owner.

Native heap inspection then found departed conversation viewports reachable through the current Composer's draft controller, its aborted signal, a cancellation exception's stack and disposed reactive owners. Draft settling ran without any draft observers and retained the cancelled controller until another settling timer ran. Three failing behavioral tests reproduced unnecessary document reads and uncancelled observer removals. Draft work is now demand-driven, and cancellation releases the owner's reference before aborting.

## Root cause

The group owned presentation semantics and an independent reading system at the same time. Shared turn rendering also implicitly allocated a reader per segment. Neither a single mount flag nor an animation deadline can establish that asynchronous content, local virtual dimensions and the outer reader have accepted the same state. Rendering chunks coupled the demand for six tools to the visibility of one row. Fixed compact estimates transferred that same assumption into long prose; animated measured heights required continuous virtual layout publication.

The test suite protected local reader behavior and checked settled endpoints, so it could confirm those individual mechanisms without questioning the extra scroll owner. Warm and cold animation paths also needed separate assertions: awaiting a Promise is not evidence that accepted display content was absent.

## Guardrails added

[The architecture decision](../decisions/implemented/architecture/2026-10-09-conversation-scroll-ownership.md) removes the local process reader from the transcript. The [conversation browser suite](../../apps/web/test/components/session/conversation-process.dom.test.ts) checks bounded large-history and cold demand, exact reasoning location, paragraph growth, native wheel and Space movement, stable triggers across rapid reversal, warm connected motion, independent choices, recovery and collapse release. [Projection tests](../../apps/web/test/components/conversation-rows.test.ts) check each tool's stable identity and preserve bounded reasoning chunks. The [frontend workflow](../../.synergy/skill/develop-frontend/SKILL.md) records one scroll owner and separate cold/warm geometry verification.

Tests whose assertions specifically required a local window, its edge fades or local Latest control are replaced by main-reader assertions. Focus, selected ranges, locator correction, following, body recovery and layout-cache verification remain. The shared object-reader primitive retains its independent tests.

## Verification

Production verification uses a frozen selected history of 328 messages and 1,730 Parts in a fresh isolated Home. Private histories, traces, heap snapshots, local paths and session identifiers remain outside repository artifacts. Timing comparisons use matched baseline and candidate builds, the same server and data, alternating runs and 4× CPU throttling at 1440 × 900. Each action accumulates browser metrics over 1.2 seconds; these are not individual input delays.

Long-task observation includes tasks intersecting the initiating gesture. The first animation-frame callback is measured with `performance.now()` inside the callback; a requestAnimationFrame timestamp can precede the click and is not a paint-completion measurement. Three paired runs give these medians, in milliseconds:

| Action               | Main-thread work, baseline → candidate | First frame callback, baseline → candidate |
| -------------------- | -------------------------------------- | ------------------------------------------ |
| Parent cold open     | 410 → 321                              | 80 → 144                                   |
| Batch cold open      | 658 → 762                              | 91 → 97                                    |
| Batch close          | 271 → 233                              | 75 → 85                                    |
| Batch cached reopen  | 283 → 279                              | 95 → 143                                   |
| Batch close again    | 268 → 207                              | 73 → 83                                    |
| Parent close         | 387 → 239                              | 58 → 61                                    |
| Parent cached reopen | 335 → 283                              | 50 → 110                                   |

The continuous batch admits 26 main rows in the cold-open sample, versus 19 outer rows and a bounded inner reader in the baseline. Cold batch work increases, and first callbacks do not consistently improve despite lower total work in the other actions. Throttled runs still contain long tasks. One matched unthrottled pair observes no tasks over 50ms in either build across seven actions; candidate first callbacks range from 13ms to 35ms. These measurements establish the ownership change and its tradeoff, not universal freedom from jank.

The main conversation suites pass 110 cases, the Composer suite passes 12 and the complete shared UI runner passes 1,052. Other Web batches passed in the package run; its updated conversation shard was rerun separately. Production builds and the local static gates pass. Fresh production contexts in both themes at 1440px and 375px have no duplicate display-row identity, inner process viewport, horizontal page overflow or uncaught page error.

Heap verification uses 20 disclosure cycles and 42 actual SPA session switches, with an unchanged `performance.timeOrigin` and forced collection every five cycles. Endpoint snapshots inspect strong reference paths as well as browser counters:

| Measurement     | Baseline, start → finish | Candidate, start → finish |
| --------------- | ------------------------ | ------------------------- |
| Used heap       | 29.85 → 32.71 MiB        | 29.99 → 32.25 MiB         |
| DOM nodes       | 1,947 → 2,341            | 1,797 → 1,785             |
| Event listeners | 400 → 415                | 362 → 363                 |

The final baseline snapshot retains two departed conversation viewports through the Composer cancellation chain; the candidate retains none. Candidate animations target 1,705 connected nodes and zero detached nodes. The browser detached-tree report still contains seven unrelated trees, so its zero conversation-row counter alone would not prove the fix. Snapshot growth is dominated by 1.67 MiB of V8 code and 0.28 MiB of native event-timing entries; candidate array and closure growth is about 37 KiB combined. This finite workload demonstrates release of the identified conversation trees and stable DOM/listener counts, rather than absence of all browser or application retention.

## Lessons

A logical group does not need to own scrolling. Keep chronological reading, body admission and restoration under the transcript owner, and reserve independent readers for explicit output objects. Validate geometry at the paint boundary, distinguish cold content from accepted warm content and test native input instead of adding settling deadlines. Finite heap cycles establish measured retention behavior under that workload; they cannot establish the absence of every application leak.
