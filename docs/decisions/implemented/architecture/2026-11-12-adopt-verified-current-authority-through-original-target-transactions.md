# Decision Record: Adopt verified current authority through original target transactions

Status: implemented

## Problem

A restored H0 namespace can lack authority changes committed before the source finally retires. Replaying redacted journal entries cannot reconstruct private canonical policy, and ordinary policy writers would fork the restored history. A verified H1 archive must supply both the original chain and complete current rows without granting recovery authorization by itself.

## Decision

`AuthorityJournal.withAdoption` reuses the same authenticated archive scan, baseline/transition fold, bidirectional policy/fingerprint checks, historical anchor and complete EOF verification as archival inspection. A private disk index additionally retains full canonical rows for the registered projections. It never reconstructs private rows from redacted transition values. Unprojected records and other journal identities stay with their owning recovery domains.

The opaque preparation belongs to its original Target Runtime, primary Store configuration, artifact ports, signal and callback lifetime. Its public description contains the verified H1 checkpoint. `adopt` requires that Store's actual live write transaction and a covered current head matching the original H0 anchor or exact H1 checkpoint. It replaces present canonical rows, removes projected facts absent from H1, and installs the actual verified baseline, entries, fingerprints and head in that transaction. Equal journal heads still require complete raw-row reconstruction because non-projected fields can differ.

Adoption uses an independent transaction with no earlier observed policy or journal mutation. A private transaction seal rejects later ordinary writes to those keys; each original native write receives one exact, callback-bounded, single-use observation permit. Other mutation guards remain active. An already accepted protected writer cannot cross the seal, and an observer continuation cannot reuse the original write's permit. Domain publication receipts outside those protected keys remain ordinary writes in the same transaction.

The original outer COMMIT guard checks preparation lifetime and successful completion of the whole adoption. A swallowed nested failure cannot commit partial policy, and cancellation after an actual SQL write rolls back the complete transaction. Callback closure drains accepted index work before removing private files; it never extends the publication authority of an escaped callback.

This port establishes archive integrity and atomic reconstruction. The organization recovery coordinator separately supplies original native installation, current-source and permanent retirement authorization. Adoption does not release recovery holds, activate a signer, reconcile other writers or make a Target ready.

## Alternatives considered

**Replay journal projections through ordinary authority transactions.** Redacted entries omit private fields and would create a new branch from H0.

**Copy policy without its original H1 chain.** Current hashes would not prove coverage or explain committed revocation and deletion.

**Treat equal heads as an already applied raw namespace.** Non-projected canonical fields can change without advancing the authority head.

**Suppress every journal observer during recovery.** An escaped or previously admitted write could modify policy after final inspection. Exact single-use native permits and an independent sealed transaction retain the original writers' restrictions.

**Depend on callers to propagate an adoption failure.** Nested Storage callbacks do not create savepoints. The original COMMIT must refuse an incomplete adoption even when its error was caught.

## Consequences

Current private policy and its authenticated continuation can be reconstructed without a second persisted phase ledger or another authority baseline. Preparation uses bounded private disk indexes and preserves unrelated records. The composing recovery owner retains its own idempotent publication receipt and readiness protocol.

`test/storage/authority-adoption.test.ts` covers raw credential and non-projected fields, deletion, exact replay, rollback, foreign ownership, cancellation and original callback closure during a held outer write. Real mutation observers reproduce late same-key continuations and previously accepted writes. Existing archive tests independently cover malformed chains, policy/fingerprint gaps, historical anchors and authenticated EOF through the shared scanner.
