# Decision Record: Chronological reasoning and stable conversation motion

Status: implemented

## Problem

A new empty model reply inserts provider-waiting feedback between existing work. Reading pending root execution metadata also suspends the whole page, hiding the conversation behind a loading fallback. Terminal Markdown crossfades the whole paragraph as streaming ends. These transitions can make a continuous task blink or jump. Grouping all reasoning above the narrative loses its relationship to the tool result that prompted it. Mandatory initial and timed progress messages also encourage routine narration rather than material findings.

## Decision

The existing ordered activity projection retains reasoning entries at their actual message/part positions. Initial reasoning appears inside the narrative and defaults open while the task is working. Later reasoning uses an independent disclosure; within a continuous tool batch it follows the preceding tool and shares its history without splitting successful-operation statistics. Stable keys, bounded history pages, manual disclosures, reading retention and keyboard focus remain owned by the existing conversation state.

The waiting-to-content handoff uses one metadata row. Waiting appears only before the turn has visible content; an empty later model reply cannot insert another row. Root execution metadata is a non-suspending resource with an explicit empty initial snapshot and latest-value reads, retaining the existing connection, Scope and Session guards. Neither its first query nor a refresh may hide the already-visible conversation. Markdown settlement preserves matching streamed nodes, applies richer terminal markup atomically and enhances it once per content identity. It no longer makes duplicate layers or fades the entire text out.

New live prose receives one subtle entrance; tool entry and history collection use interruptible measured-height motion with the existing 180/240ms roles. Closed descendants establish visibility before an ancestor measures height. Reversals start from the rendered height and invalidate obsolete completion. Hidden content is inert during exit. Component-owned bindings release animation and preference listeners; detached reading and reduced motion settle without spatial animation.

The shared primary progress guidance favors continuing with tools. An initial explanation is optional. An important finding, changed approach, decision or blocker warrants an update; elapsed time or another model reply alone does not. The prompt describes useful collaboration without exposing rendering, persistence or orchestration.

The update trigger and optional initial explanation are superseded by [novel progress guidance](2026-10-08-novel-progress-guidance.md), which asks for brief initial direction on substantial work and new information in later updates.

This supersedes the reasoning-placement and timed-progress choices in [live tool history and reasoning segments](../feature/2026-10-02-live-tool-history-and-reasoning-segments.md), while retaining its continuous grouping and pagination decisions. No message persistence, model protocol or SDK contract changes.

## Alternatives considered

**Keep a global reasoning viewer** retains bytes but moves later reasoning away from the tools and findings that explain it.

**Split batches at every reasoning part** restores chronology at the cost of repeated controls and statistics that reset on routine model replies.

**Fade every completed paragraph** hides already-readable content during routine execution and requires duplicate layers with competing heights.

**Require initial and timed progress prose** encourages updates without new information and prevents otherwise continuous tool work.

## Consequences

The conversation keeps its chronology and current activity without repeating wait rows or replaying text settlement. More reasoning disclosures exist, but later ones remain folded and collect with tool history. Rich terminal Markdown can still change content height when it adds formatting; reading anchors remain the viewport owner's responsibility. Height motion performs bounded layout reads on disclosure changes, never on every text delta. Tests cover real browser frames, interrupted collection, focus protection, node identity, reduced motion and assembled primary prompts; production Web and real-model interaction remain part of acceptance.
