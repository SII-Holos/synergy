# Decision Record: Versioned context for derived Session inference

Status: implemented

## Problem

Read-only consumers need a coherent completed conversation and a way to reject results after source edits. A terminal assistant alone does not prove the root finished, and reading body content again to check freshness duplicates expensive history work.

## Decision

Session owns `SessionContextSnapshot`, which uses the canonical model working set inside a short storage snapshot. A successful Rollout and its terminal assistant establish the completion anchor. The result is deeply immutable and retains the resolved model and source revisions. Storage supplies a revision-only batch read; source checking includes ordering and part-membership records so appends and deletions invalidate existing results. No reader remains open while a model executes.

`SessionCorpus` exposes paginated local text retrieval, canonical neighborhoods and versioned hydration. It reuses the existing text projection and shared CJK/ASCII tokenizer. Role and origin filtering continues through nonmatching storage pages. Targeted preparation reads original text using existing part summaries; old records without a summary require one bounded discovery decode, reported separately. Preparation honors background pause and yields at short checkpoints. It creates no second search database or transcript copy.

## Alternatives considered

**Feature-specific history copies and hashes.** These duplicate canonical projection and hydrate full bodies on every freshness check.

**Process-local history counters.** These cannot establish durable authority across import, direct canonical writes or restart.

**Assistant finish alone.** A root may still be waiting for owned work, fail recording or be cancelled after an assistant finishes.

## Consequences

Derived consumers share one completion and freshness definition. Revision batches grow with the selected working set but avoid decoding content. Metadata changes can conservatively invalidate a result. Legacy transcripts without completed execution evidence remain readable but cannot establish an eligible completion anchor.

Corpus preparation and hydration share the canonical PartContent reader with history search. Streamed Parts retain their stored content version, and immutable chunks are hydrated within the same reader snapshot. Derived summary rebuilding uses the stored summary without reading the body; only selected text is materialized. Joint tests cover a missing derived summary, committed streaming tails and invalidation after an appended tail.
