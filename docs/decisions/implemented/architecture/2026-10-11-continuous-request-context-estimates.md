# Decision Record: Continuous request context estimates

Status: implemented

## Problem

Task details follows requests before their assistant messages finish. Coupling classification publication to completion leaves a new request without categories throughout inference and tool settlement. Mixing provisional totals with provider usage would distort accounting, while switching to empty snapshots interrupts source inspection.

## Decision

Harness stores an optional `contextEstimate` on the immutable request's Rollout call as soon as bounded estimation resolves. The existing serialized call update merges only that field and publishes the existing revisioned event. Classification uses final request provenance shared with the source index. Estimates remain separate from provider input, cost and cache evidence and survive archive round trips without adding spend.

The Runtime caches category estimates by Session, provider/model, algorithm version and bounded sample fingerprint, including represented character counts. The LRU retains at most 512 numeric entries and no prompt bodies. Estimation retains the two-worker, one-second and 8,192-character limits, never queues excess work, and stops on Runtime shutdown. Every new request aggregates its own categories so trimming and compaction can reduce totals.

Workbench uses the public pure Harness reconciliation function when provider input is available, even without cache splits. Formal snapshots retain their call identity and reject late writes after an assistant advances to another call. A matching formal context snapshot takes precedence over reconciliation, and an estimate is used only before actual classification is available. The additive API estimate field leaves existing actual-only fields unchanged; no historical backfill or storage migration is required.

The Web projection shares classification across composition, source browsing, history and tooltips. Automatic following retains the last displayable snapshot under its original identity until a new one is ready. Explicit historical selection, disclosure, focus and source content survive calibration. Scope changes clear retention, revisions reject stale history, and missing intervals remain gaps. Approximate totals use the existing numerical marker without lifecycle labels. Cache-hit wording is uniform. Only the cumulative Token ring fits compact text between 12px and 18px, retaining the full accessible number.

## Alternatives considered

**Publish only after assistant completion.** This ties optional diagnostics to unrelated tool latency and produces empty context views during the part of execution users are inspecting.

**Write estimates into assistant usage or accounting.** This gives provisional input the meaning of provider evidence and can corrupt totals, cache ratios and cost. The separate field preserves those meanings.

**Replace missing data with new lifecycle labels.** Additional copy cannot make classification available or preserve a reader's state. Request-owned early publication and coherent snapshot retention address those behaviors directly.

**Re-estimate every category for every request.** This repeats unchanged bounded work. Category caching reuses stable inputs while preserving model changes, clipping and compaction reductions.

## Consequences

Estimation is best effort: exhausted capacity, timeouts or optional persistence failures can leave a request without classification. The model continues independently and the automatic view retains its last usable request. Classification remains an estimate of category attribution even after provider-total calibration. No estimate is borrowed across request identities.

Behavior tests cover publication before stream completion, both arrival orders, accounting isolation, cancellation, persistence failure, cache limits and shutdown, and archive preservation. Web tests cover revision races, selection retention, real component identity and lazy content, plus actual circle geometry across widths, fonts, zoom and themes. Full platform coverage remains a CI responsibility.
