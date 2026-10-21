# Decision Record: Prioritize Library content and compact browsing

Status: implemented

## Problem

The Library's separate Overview page repeats records already reachable through its content tabs. Experience cards spend a full-width row on a single intent and sparse metadata because their preview is derived from additional intent paragraphs, while encoded intents are normally one line. The Skills page presents routine source overrides and compatibility notices with the same prominent warning treatment as real loading failures.

## Decision

Statistics is the default and first Library tab, followed by Memories, Experiences and Skills. Unified grouped search remains available from its header without a separate Overview destination. Clearing a query restores statistics, and existing group-local retry and detail recovery behavior remain intact.

Experience pages retain server pagination and virtualized rows, pairing cards into two columns when at least 680px of content width is available and reflowing to one column below that width. One native card control presents intent, an available stored trajectory preview and a compact source/time/status footer. It uses the application's shared 14px title/body and 12px metadata roles. Missing previews create no empty placeholder, and pending reward status is neutral rather than an error.

Experience card DTOs include an optional nullable `scriptPreview`. The page and plain list retrieve at most the first 320 stored script characters in one batched query selecting only the preview columns; semantic search projects the same preview from its existing script result. No model call, raw digest read per card, persisted-state change or evaluation-policy change is introduced. Complete content remains available through the existing detail API.

Skill cards lead with name, description and invocation scope. Routine source overrides and compatibility notices use a neutral, initially collapsed disclosure after the list in its existing scroller. Actual loading failures remain above the list. Full paths, compatibility facts and canonical diagnostics remain available in the detail dialog.

## Alternatives considered

**Keep Overview and merely reorder the tabs.** This retains a destination that duplicates record browsing and adds a second summary concept beside statistics. Grouped search remains useful independently of a recent-record page.

**Only reduce experience row padding.** This makes sparse rows shorter without exposing what the recorded trajectory contains. Compact paired cards use available width while retaining a readable intent and preview.

**Fetch or generate a summary for each visible card.** Per-card detail reads create avoidable request fan-out and transfer raw content. Model summaries add latency and may rewrite the recorded evidence. Batched bounded projections use the existing stored script.

**Move every diagnostic to the bottom.** Real loading failures can prevent a skill from being used and need visible recovery context. Routine precedence and compatibility information is optional inspection material and must not imply a broken system.

## Consequences

The default landing content changes from recent records to aggregate statistics. Cross-kind searching is preserved, but there is no mixed recent-record feed. Card previews may end before the full trajectory and do not replace details; very narrow cards show fewer words without altering stored content. Wide and narrow layouts share one pagination and selection owner, and ordinary skill notices no longer compete with the usable catalog. The changes retain the search and recovery invariants recorded in [Library status and search recovery](../bug-fix/2026-09-25-preserve-library-status-search-and-calendar-snapshots.md).
