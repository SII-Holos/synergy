# Service recovery skipped retained binary changes

## Executive summary

Public recovery could permanently retire its original Source and report readiness while the Target still returned H0 bytes at a canonical binary address changed in H1. The archived H1 bytes remained retained, but the restored namespace was not current.

## Summary

The isolated public CLI fixture writes a canonical binary before H0, replaces it through the original Storage owner after H0, and verifies the changed Source bytes. Recovery returned success and Source became format 4, while an ordinary Target read still returned the old bytes. Policy reconstruction and native completion did not establish binary equivalence.

## Timeline

1. Create a real service backup and install its independent recovery-held Target.
2. Replace bytes at the same canonical Source address and capture fixed H1.
3. Observe successful public recovery, permanent Source retirement and stale Target bytes.
4. Add complete artifact inventory and actual byte verification before permanent effects.
5. Verify changed, missing, added and corrupt bytes reject safely, plus final transaction rollback and exact retry.

## Root cause

Writer reconciliation indexed record entries and skipped artifact entries. A verified authority journal describes its policy domains; it cannot certify unrelated canonical binary addresses or body integrity. A location descriptor also cannot establish that a Target pack still contains the expected bytes.

## Guardrails

- Inventory all fixed H1 artifact keys, sizes and digests in the original private disk index, and consume complete authenticated Source streams.
- Compare both directions against actual Target addresses and bodies, retaining the original native checkpoint through retirement and the actual Target write transaction.
- Recheck complete counts and verified locations at COMMIT; a caught seal failure must still roll back the original transaction.
- Release SQL readers before subsequent writers. Keep the last native pack pin after an unknown commit until its owning result can be reconciled.
- Verify the original Source remains at format 2 with a released maintenance hold and no reservation on unsupported binary changes. Preserve Target held state and inactive key.

## Lessons

Namespace completeness requires canonical binary addresses and actual bytes as well as records. The artifact suite passes five cases, the checkpoint owner suite passes three cases on SQLite and real PostgreSQL, and the original five public recovery cases remain green. This guard refuses unsupported H1 changes; it does not reconstruct changed bodies or implement nonempty Publications, Library or external-writer recovery.
