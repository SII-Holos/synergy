# Decision Record: Sample background returns during rendering delivery

Status: implemented

## Problem

The background-return regression sampled DOM geometry in a zero-delay timer after each requested animation frame. Content work can run between the preceding rendering delivery and that timer. Its geometry can therefore include a new, not-yet-corrected height rather than the frame the test intended to inspect.

A controlled experiment in the existing real conversation fixture queued 176px of content growth after rendering. Resize-delivery samples stayed at the latest position, while the first timer reported a 176px gap. The original completion-at-frame-one scenario rejected that interleaving despite the correct render-delivery samples. This establishes a counterexample to the timer oracle; it does not uniquely attribute every hosted gap failure to that interleaving.

## Decision

Each of the existing 96 requested frames changes a layout-contained ResizeObserver probe and captures the conversation's geometry in rendering delivery. The asynchronous continuation receives that captured value instead of rereading live DOM in a later task. The first timer reading remains separate diagnostic evidence.

Completion still occurs at frames zero, one and sixteen. Initial hydration, 20× transition throttling, hidden-read equality, every-frame visible rows, the two-pixel latest-position threshold, final answer and error assertions remain unchanged. There is no settling delay, skipped first frame, retry or larger deadline.

## Alternatives considered

**Increase the allowed gap or wait for hydration.** Either would conceal the user-visible regression this test must reject.

**Patch production following from a timer-only observation.** An unpainted intermediate layout is insufficient evidence for another scroll owner or compensation. The existing resize owner remains authoritative.

**Rerun until the timer samples happen to pass.** That preserves the invalid observation boundary and provides no stable regression oracle.

## Consequences

The test distinguishes rendering delivery from later content tasks while retaining its original behavioral invariants. A fault that disables resize-time latest pinning must still make the sampled geometry fail. The change does not alter production conversation projection, hydration, virtual retention or scrolling.
