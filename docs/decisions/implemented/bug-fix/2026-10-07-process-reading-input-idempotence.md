# Decision Record: Idempotent process reading input

Status: implemented

## Problem

Repeated reading input can publish an unchanged set of reading process blocks as a new array, invalidating conversation projections without any message or Part change. Input handling also captures the same geometry repeatedly within a frame. Virtual row mounting produces content mutation records, but it does not establish that an existing body changed. Optimizing these paths must retain the reading protection defined in [Process stability](2026-10-05-conversation-process-stability.md).

## Decision

The App reuses the `readingBlocks` array when membership is unchanged, for both registration and release. Shared `ProcessViewport` separates per-input interaction from transition-only reading notifications. Every reading interaction still cancels obsolete following and restoration work and can reacquire the App's single retained reading owner, including an already-paused window after another window takes ownership. Saved paused windows register on mount; cleanup releases their registration.

Ordinary input captures its first Part or paragraph anchor synchronously, before a possible body mutation. The viewport coalesces subsequent ordinary captures at the same native scroll offset until the next animation frame. Real scroll displacement captures the current visible anchor synchronously, even within that frame, so immediate growth between an old and newly visible paragraph restores the new reading position. Disclosure cancels ordinary capture work and synchronously captures its concrete target before layout changes. Explicit Latest and disposal cancel pending capture and restoration work. Outer conversation interaction remains synchronous and independently owned; this change does not coalesce its captures.

The App supplies a conservative mutation predicate using the exact DOM root of its inner Virtua virtualizer, passed through Virtua's supported `as` component. Only direct `childList` records at that root are virtual mount/unmount churn. Nested `childList`, `characterData`, and mixed deliveries containing any real body record retain pre-measurement preservation. Shared UI defaults to preserving every mutation record and has no product-specific marker inference. Revision and resize preservation continue to cover structural changes and size commits.

## Alternatives considered

**Only deduplicate reading notifications.** This removes repeated state callbacks but does not make the App collection defensive and loses the input signal needed for cancellation and paused-owner reacquisition.

**Return immediately when already paused.** Repeated input remains meaningful even without a following-state transition: a newer input must cancel restoration and can take retention ownership back from another window.

**Defer the first anchor capture to the next frame.** A body mutation can precede that capture, replacing the pre-layout reading offset with the changed geometry. The first synchronous capture protects that ordering while unchanged-offset input shares the same frame gate.

**Rebase the first anchor's offset after actual scrolling and recapture at frame release.** The original paragraph can move offscreen. Immediate growth between that paragraph and the newly visible paragraph then changes the visible reading position before frame release, and restoration against the old paragraph cannot recover it. Real native displacement therefore bypasses the gate and synchronously captures the current visible paragraph.

**Remove content observation or ignore all virtualizer descendants.** Same-version body hydration and unsequenced text growth need not change summary revision. Their nested mutation records must protect the anchor before virtual measurements; mixed deliveries cannot be treated as pure churn.

The later [conversation rendering lifetime decision](../architecture/2026-10-07-conversation-rendering-lifetime.md) extends this input policy with one accepted viewport reading owner and native movement arbitration. That current contract takes precedence over the earlier pause-on-every-scroll behavior; the combined branch retains its implementation and regressions.

## Consequences

Unchanged reading membership no longer invalidates conversation projections, while input cancellation and reading retention remain independent of notification transitions. Ordinary same-frame input at an unchanged scroll offset shares its geometry capture; real displacement and targeted disclosure remain synchronous. This deliberately avoids a one-scan-per-frame limit for actual scrolling. The App owns the narrower virtual-root classification; other shared UI consumers retain conservative protection. Browser regressions exercise repeated input, owner reacquisition, immediate characterData/childList growth with scroll displacement, same-frame cross-paragraph scrolling with intermediate growth, mixed mutations, live append, prepend, reopening, Latest, and focus/selection retention. Physical trackpad performance remains device-specific rather than established by these deterministic tests.
