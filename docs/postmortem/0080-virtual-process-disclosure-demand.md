# Virtual process disclosure and delayed geometry publication

## Executive summary

Long intermediate prose overlapped while a process reopened. Each virtual row animated from zero height, so the virtualizer admitted too many rows, then positioned expanding text using transient measurements. Existing short-text and compact-tool tests checked settled behavior but missed the dense transitional layout. Disclosure motion must preserve the dimensions used for demand admission.

## Summary

A browser fixture with 60 long intermediate text Parts reproduced the defect with all bodies already local: 61 process body rows mounted together, with a maximum sampled adjacent-row overlap of approximately 85 px. With natural row heights during the same opening, seven rows mounted and overlap stayed within 0.02 px rounding. A separate 120-Part cold fixture with 80 ms controlled body latency requested 62 distinct bodies before the fix and 19 afterward. These are controlled workload counts, not production throughput estimates.

A separate delayed-body regression found approximately 789 px of overlap even after removing height entrances: body DOM was visible one frame before its virtual offsets changed. A production build with a copied history reproduced approximately 57 px of the same mismatch with five new body requests and no accepted-body rereads during subsequent scrolling. After separating content measurement from motion readiness, 75 production opening frames stayed within the existing 2 px entrance-motion bound. The following 120 scroll frames had no overlap or new body requests; both runs made five initial body requests and no accepted-body rereads. Controlled delayed-body regressions also remain within the motion bound. Three native history-page loads on the copied production history retained the reading anchor within 0.5 px. The following 240 scroll samples had no overlap or blank transcript; the operation read 12 new bodies with zero accepted-body rereads. Compositor frames around asynchronous body admission were inspected separately from prepaint DOM diagnostics.

## Timeline

1. Frame inspection located overlapping prose during an explicit parent expansion.
2. A warm browser reproduction established that network access was unnecessary for the defect.
3. Holding body reads delayed exposed excess demand from the same geometry change.
4. A targeted parent-row motion change passed the warm overlap and demand assertions.
5. Additional history video and copied-data acceptance exposed the independent delayed body/offset mismatch. A cold hydration red test and both dependency entrypoints cover its correction.
6. Production acceptance revealed that an interactive viewport can still be awaiting motion readiness. Holding an unrelated body pending reproduced the remaining 57 px overlap before the final correction.

## Root cause

Manual disclosure attached height keyframes to each outer virtual row. The initial zero-height measurements expanded the virtual range, creating extra renderers and body leases. As text grew, offset publication lagged the changing boxes, so adjacent paragraphs overlapped. The height keyframes also overrode pending-row minimum-height reservations. Correct cancellation of offscreen pending reads could not compensate for the incorrect admission window.

The virtualizer deliberately deferred ResizeObserver publication to avoid nested delivery loops. Asynchronous content changes could therefore paint with the previous size cache. Initial-row measurement did not cover later body arrival or Markdown replacement. Descendant inline-style changes must participate too: removing a pending minimum-height reservation changes geometry even when the text DOM is already present. Geometry admission now includes descendant body changes, invalidates superseded queued rectangles and participates in the existing history-prepend transaction. An initial correction skipped content measurement while shifting, which kept the reading anchor fixed but still painted newly hydrated older replies over it. A native prepend fixture reproduced roughly 2,815 px of adjacent-row overlap. Both initial and changed body measurements must participate in shift compensation; other initial rows keep their existing ordering. These reads must share one animation-frame batch: independently publishing each Markdown completion in microtasks moved the viewport repeatedly and failed background-return tests. Initial measurement and automatic exits keep their existing ordering. The first content-observation candidate incorrectly waited for motion readiness. A copied production history still overlapped by approximately 57 px because an unrelated pending body delayed that readiness even though the viewport was already interactive. A regression that holds the final body pending while expanding intermediate history reproduces this difference. Measurement now depends on active row ownership, independently of animation eligibility. A prepend test also exposed subpixel churn: resolved CSS rounded an already accepted observer measurement, triggering reading-anchor restoration and another resize delivery. Content measurements now ignore rounding differences within 0.01 px; delayed previous replies and prepend anchors are tested together.

## Guardrails

[Long process browser tests](../../apps/web/test/components/session/conversation-long-process.dom.test.ts) assert transitional geometry, bounded body demand and reuse of already rendered bodies during scrolling. The existing disclosure suite retains reversal, final-answer identity and inner batch lifecycle coverage. The [frontend workflow](../../.synergy/skill/develop-frontend/references/conversation.md) requires long prose alongside tool-dense fixtures.

## Lessons

Visual measurement errors can become request-volume errors when the same virtual window owns content leases. Warm-cache reproduction distinguishes rendering defects from latency. Cached bodies still require correct layout on remount; transport caching alone cannot guarantee a stable transcript. Geometry polling can observe unpainted DOM states; compositor-frame comparisons distinguish those states from visible overlap before expanding a fix.
