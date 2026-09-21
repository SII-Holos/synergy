# Decision Record: Preserve session recency during worktree cleanup

Status: implemented

## Problem

The managed worktree sweep migrates idle bound sessions to the main checkout. Its generic workspace update also advances navigation activity, so reclaiming many old worktrees moves historical sessions ahead of current conversations.

## Decision

Session workspace mutations accept the existing activity-preservation option. The automatic cap sweep and missing-worktree reconciliation pass it through their binding cleanup; navigation activity remains unchanged while the workspace update is persisted and published. Explicit workspace changes keep their existing behavior. See [worktree ownership](../../../architecture/workspace-and-files.md#worktree-ownership).

## Alternatives considered

**Suppress workspace updates during cleanup.** Sessions would keep stale execution directories after their worktree disappears.

**Freeze activity on every workspace update.** That changes explicit user actions as well as maintenance; the cleanup caller knows which kind of operation it owns.

## Consequences

Recent ordering remains based on conversation activity during maintenance. Metadata timestamps and workspace events can still advance. Real temporary Git/Scope fixtures cover both cleanup paths and verify that subsequent conversation activity still promotes the session. Existing incorrectly advanced activity is not guessed or rewritten.
