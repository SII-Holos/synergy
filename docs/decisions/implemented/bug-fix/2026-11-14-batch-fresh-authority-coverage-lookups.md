# Decision Record: Batch fresh authority coverage lookups

Status: implemented

## Problem

Authority coverage enumerates history and policy in bounded pages, but each stored fingerprint, derived final fingerprint and current projected row performs a separate point lookup. A complete inspection of 129 policy keys issues 388 native lookup statements, even though every lookup belongs to the same read snapshot. Recovery repeats these fresh inspections at its original ownership checks.

## Decision

`AuthorityJournal.inspect()` keeps its original `Storage.snapshot()` and reads each of its three joins through `tx.readMany()` in pages of at most 128 keys. The head, complete baseline and transition chain, every stored fingerprint and actual domain projection remain inspected. Every lookup result preserves its original key association; missing and malformed records, key/hash mismatches and storage failures retain their original meaning.

The same live transaction supplies the current values, including a writer's own changes. Page results are discarded after validation. No earlier inspection result, authorization decision or separate snapshot is reused. The [journal-end consistency decision](2026-11-12-match-authority-fingerprints-to-the-journal-end.md) still owns the complete comparison and its temporary disk index.

Authority adoption, retained checkpoint handling, mutation permits and final COMMIT guards keep their existing owners. This change introduces no persisted state, migration, public API or authorization cache.

## Alternatives considered

**Keep one lookup per key.** Bounded enumeration alone leaves native database dispatch proportional to every joined key; the original owner regression measures that cost directly.

**Reuse a prior coverage result.** A later canonical mutation or same-transaction write can invalidate it. Fresh bulk reads preserve the current snapshot without retaining another authority result.

**Skip an inspection after a matching checkpoint or receipt.** Retained metadata does not establish the current native rows or owner. This optimization changes only how complete fresh checks read their values.

## Consequences

For one head and three complete 129-key joins, the lookup work bound is seven SQL dispatches while all 388 logical key reads remain. This bound counts native lookup statements, not total database work, memory or recovery wall time. The [postmortem](../../../postmortem/0206-authority-inspection-issued-one-lookup-per-policy-key.md) records the original work failure and distinguishes it from end-to-end recovery timing. Recovery correctness timeouts follow measured cold setup and repeated-operation cost; product protocol deadlines and explicit capacity acceptance budgets retain their separate requirements.
