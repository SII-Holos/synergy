# PM-0176: Current archive used a logical namespace as physical identity

## Executive summary

New sealed knowledge recovery reached its original native artifact owner but rejected H1 as a different checkpoint namespace. H0 and H1 came from the same service: Cohort used the service descriptor hash, while Current used the AuthorityJournal's organization ID. Sharing the original native owner's namespace calculation corrected the mismatch without relaxing recovery guards.

## Summary

The initial new-byte test correctly rejected an incomplete Target artifact inventory. After adding bounded native staging, integration failed its same-namespace check before staging effects. The original H0 manifest hash and import receipt already matched; the namespace label alone differed. Existing old-byte coverage had not exercised this additional native preparation boundary.

## Timeline

1. A genuine new upload, two chunks, seal and immutable release exposed the missing physical inventory.
2. Original-owner native staging added H0 import and same-namespace H1 checks.
3. Integration reached the strict namespace guard and exposed two inconsistent capture labels.
4. Source tracing confirmed that Journal identity checks concern logical organization ownership, independently of checkpoint labels.
5. Current adopted the original service descriptor calculation. A separate test-oracle Runtime-context error was corrected without changing production guards.
6. The complete eight-case knowledge suite passed, including fresh-byte transaction faults and cold recovery.

## Root cause

Current reused `AuthorityJournal.head.namespaceID` when exporting a physical StorageCheckpoint. Cohort and Native installation instead derive that label from the original service kind, organization and deployment identity. A logical policy identifier does not identify that physical checkpoint domain.

## Guardrails

- ServiceNative owns the one service namespace calculation; Cohort, installation validation and Current reuse it.
- Current obtains and verifies actual NativeNamespaceIdentity before and after capture and before exposing its Source capability. Existing primary, frozen and retirement ownership remain in force.
- Journal organization identity remains independently checked. Kernel same-namespace validation remains strict.
- [x] Machine check: `packages/organization/test/cli-recovery-knowledge.test.ts`, selector `public recover adopts a new H1 sealed upload and immutable release with new physical bytes` compares actual H0 and H1 labels, separately checks the logical Journal identity, and verifies public recovery plus cold content reads.

## Lessons

Reuse the owning identity calculation across capture paths. When a new strict guard exposes an inconsistency, trace both original producers before introducing compatibility or weakening ownership checks.
