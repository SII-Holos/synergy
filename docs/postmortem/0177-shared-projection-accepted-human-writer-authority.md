# PM-0177: Shared projection accepted human writer authority

## Executive summary

A creator's authenticated HTTP request could commit a shared event batch without the current Runtime producing it. Sharing control and projection production had separate authority requirements but reached the same writer. Removing the human batch path preserves one machine-authenticated producer while retaining human sharing controls and immutable blob uploads.

## Summary

The HTTP batch handler validated the route, DTO and creator credentials. Its domain writer checked the Session's current read authorization and creator identity before committing the same projection ledger used by the Runtime exporter. A real HTTPS regression received 200 with creator credentials even though the request carried no machine proof.

## Timeline

1. The synchronization audit traced both human and authenticated Runtime batch paths.
2. Existing blob policy independently established creator upload authority, so that immutable-content path remained in scope as a supported feature.
3. Genuine member enrollment, signed WSS connection and Session creation reproduced acceptance of an HTTP projection write.
4. The human route and domain writer were removed; existing projection tests moved to a genuine signed Runtime producer.
5. The regression verified rejection without checkpoint/event changes and then accepted the original batch through the actual Runtime connection.

## Root cause

The implementation reused creator authorization for a native observation mutation. Matching Session/project/epoch metadata and a correct hash established internal consistency but did not authenticate who observed the events. Unit fixtures that populated projections with creator credentials preserved this extra authority path.

## Guardrails

- The current registered Runtime connection supplies the sole external batch producer; sharing validates its active identity and canonical driver binding before committing.
- Tests for projections use actual machine keys and the production connection receiver. Creator uploads remain separately authorized and cannot publish an event reference.
- [x] Machine check: `packages/organization-runtime/test/sync-writer-authority.test.ts`, selector `creator HTTP credentials cannot replace the current Runtime shared projection producer`, verifies rejection, unchanged state and genuine Runtime success over actual HTTPS/WSS.
- [x] Machine check: `packages/organization/test/sharing.test.ts` and adjacent transcript, window, task, presentation and retention suites verify the existing ledger invariants through signed producer frames.

## Lessons

Trace every writer into an authoritative ledger. Authorization to control visibility or upload immutable bytes does not establish authority to produce native observations.
