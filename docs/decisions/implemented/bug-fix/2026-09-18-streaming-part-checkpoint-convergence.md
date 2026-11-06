# Decision Record: Converge dropped streaming part checkpoints and stale text snapshots

Status: implemented

## Problem

Streaming deltas, full checkpoints, and asynchronous message pages share the same text buckets. Applying them in the wrong order can lose text; ignoring a checkpoint outside a loaded latest window can leave a missing message without a recovery request. The [streaming checkpoint postmortem](../../../postmortem/0015-streaming-checkpoint-order-and-repair.md) records the observed failures and missing coverage.

## Decision

- Keep coalesced hidden-page deltas in arrival order in the event queue. A full checkpoint supersedes earlier pending deltas for that part in either visibility mode; subsequent deltas stay after it, including when the checkpoint creates the part.
- Preserve accumulated text only for delta-bearing text/reasoning checkpoints whose text is a strict prefix. No-delta writes, including terminal writes and intentional prefix truncations, remain authoritative. `streaming: true` alone does not identify an incremental write because all part-update events carry that transport classification.
- Schedule dropped-checkpoint repair only for loaded latest windows, with a 2 s debounce and a budget of 3 scheduled attempts per 60 s. Check the window mode again when the timer fires and when the page returns, preserving history navigation during either wait.
- Share the session-window loader with compaction. Repairs join pending loads and preserve diffs/inbox; compaction cancels queued repair timers, supersedes a weaker in-flight repair, and retains ownership of diff/inbox invalidation. Scope release and bucket eviction cancel queued work and release in-flight loader state.
- Plan sidebar prefetch part actions before accepting the resource response. A rejected plan must not advance the message watermark. Preserved buckets retain newer live parts; a required retry discards the opportunistic page.

## Alternatives considered

**Rely only on a longest-prefix checkpoint guard.** Rejected: if a hidden checkpoint contains a new prefix and its later delta is applied first, the local text can diverge from the checkpoint or the part may not exist. Preserving the longer string cannot reconstruct the missing increment. Queue ordering is required.

**Re-fetch on every dropped checkpoint.** Rejected: per-event requests create storms under streaming load. Debouncing and a bounded attempt budget recover latest windows while retaining the existing snapshot freshness checks.

**Write orphan parts into detached buckets.** Rejected: the message window would still lack the parent message, and a later page would need another merge path. Recovery uses the existing page loader.

**Force every repair through the shared loader.** Rejected: a weaker repair could cancel compaction and lose its inbox invalidation. Only compaction forces a new generation.

## Consequences

Hidden-page checkpoint and delta application preserves the complete text while keeping coalescing bounded. Repairs recover loaded latest windows without displacing history or erasing unrelated diff state. The budget bounds repair scheduling; retries inside the loader remain separately bounded, and exhausted budgets can defer convergence until another load. Prefetch can be discarded before accepting its watermark, preserving later event delivery. Sessions without loaded windows still recover on their next foreground load.
