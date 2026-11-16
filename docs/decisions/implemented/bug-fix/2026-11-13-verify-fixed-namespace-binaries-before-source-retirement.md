# Decision Record: Verify fixed namespace binaries before source retirement

Status: implemented

## Problem

Record equivalence and a verified H1 authority journal do not establish equivalence of the namespace's canonical binary references or actual bytes. Public recovery could retire its original Source and report ready while Target reads still returned H0 bytes at an address changed after H0.

## Decision

The Organization writer owner includes every fixed H1 artifact key, SHA-256 digest and size in its private disk inventory. It consumes each distinct authenticated H1 artifact through the canonical checkpoint stream to verified EOF. It compares the complete actual Target artifact inventory in both directions and consumes each distinct physical Target location, checking its actual byte count and digest against H1. It does not reconstruct unsupported H1 binary changes.

The existing preflight becomes a callback-bound scope retaining the original Target native artifact checkpoint. Both live current-source reconstruction and pre-reservation cold reconciliation enter that scope before the original irreversible source reservation/fence. The native gate remains held while those effects occur. Metadata read snapshots finish before subsequent transactions, so retaining the checkpoint does not hold a Target SQL reader across its own writer.

At the final Target write transaction the writer owner checks the complete canonical inventory, counts and original verified physical locations again. An owning seal is installed before that asynchronous verification; incomplete or caught failures reject the real outer COMMIT, and later mutations cannot bypass the successful check. Existing Hosted publication uses its original writer inspection and publication seal.

Storage exposes a narrow checkpoint retention operation. It accepts only its genuine open native checkpoint and original Runtime, Store/configuration and artifact ports, within the actual Storage write transaction. It retains each physical pack through that transaction's real settlement and attaches the original checkpoint lifetime guard to COMMIT. A known outcome releases its temporary pin; an unknown COMMIT retains the last native pin. It does not grant object-backend authority or create another persistent recovery ledger.

## Alternatives considered

**Compare artifact metadata alone.** Metadata can remain intact while the actual Target pack is corrupt.

**Verify bodies and release before retiring Source.** Garbage collection or a later metadata change could invalidate the checked selection before actual publication.

**Keep the SQL read snapshot through later publication.** The Target would wait for its own reader while trying to acquire write admission.

**Reconstruct changed H1 bytes in this guard.** Reconstruction needs its original owning staging/publication and retention protocol; the current unit instead refuses unsupported deltas while the live Source can still release its original hold.

## Consequences

Stable native binary namespaces remain recoverable through the original inactive key, fixed H1, source reference and target publication receipt. Added, missing, replaced or corrupt binary facts block before permanent retirement. This does not implement nonempty Publications, Library, external stores or another writer's semantic recovery.

`packages/organization/test/cli-recovery-artifact.test.ts` proves the real public same-address regression, missing/extra keys, actual Target byte corruption and a swallowed final mismatch followed by original-receipt retry. `packages/harness/test/storage/checkpoint-retention.test.ts` covers genuine checkpoint/write ownership, foreign Store and copied evidence, unknown native settlement and a transaction escaping callback lifetime. The original public recovery and unknown/native-prefix retry suites remain unchanged and pass with the new guard. The checkpoint contract is registered in `POSTGRES_TEST_FILES`; the same three checkpoint retention cases also pass against an actual PostgreSQL 18.7 database.
