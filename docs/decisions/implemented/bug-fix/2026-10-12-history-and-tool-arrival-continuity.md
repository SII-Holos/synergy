# Decision Record: Preserve readable history and overlapping tool motion

Status: implemented

## Problem

A history page can start inside a long turn rather than before its root user message. Publishing its assistant headers before their Part summaries inserts many temporary unknown-content rows ahead of the retained answer. The virtualizer evicts that answer, then mounts it again after the summaries collapse those rows into the process. Stable final geometry therefore hides an intermediate blank frame without any repeated body request.

A separate jump occurs when a tool's height disclosure starts during an existing following transition. Disabling outer compensation for the disclosure cancels the already-painted offset, abruptly shifting the transcript. Restarting a full transition on every disclosure resize avoids cancellation but delays settling indefinitely while height samples continue.

## Decision

History pagination reads the first bounded Part-summary pages for newly discovered headers before publishing the page. The existing batched summary loader retains its request budgets, cancellation and ownership checks. Readable history remains mounted while the history control is pending. Bodies remain lazy; failed summary reads retain local load/retry rows rather than failing the entire page. First navigation keeps its existing local-loading behavior.

Tool disclosure resizes retarget following from the current painted offset and preserve the remaining animation deadline. Ordinary independent growth retains its normal duration. Reading interruption, forced initial positioning and reduced motion retain their existing semantics. This supersedes the rule excluding all disclosure compensation in [Conversation motion continuity](2026-10-08-conversation-motion-continuity.md); child space motion cannot discard an existing parent offset.

## Alternatives considered

**Retain every unknown history row or render an outgoing clone.** Rejected because it adds another presentation lifetime and can exceed the bounded virtual window. Preparing bounded summary metadata establishes the correct row structure before admission.

**Wait for every historical body.** Rejected because rendering structure only needs summaries. Offscreen bodies remain outside the critical path and existing content stays readable throughout the read.

**Disable all following animation.** Rejected because it removes normal arrival motion while leaving the overlapping-owner cause unexplained. Preserving the offset and deadline handles both consecutive resizes and user interruption.

## Consequences

History-page admission waits for bounded summary reads, not body hydration. A production-browser regression uses a single completed turn with 240 continuations, delays summaries, verifies successful pagination and checks every sampled frame for retained answer DOM, stable coordinates, absence of transient load rows and zero repeated body reads. Virtualized browser tests overlap real child disclosure with an existing follow animation and cover both dependency entrypoints, short tool rows, native clamping and settling. These checks measure intermediate continuity instead of only final screenshots.
