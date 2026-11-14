# Service sync writes blocked authenticated heartbeats

## Executive summary

Service heartbeat handling waited behind synchronization completion and writer admission. A held, valid synchronization operation therefore expired its original authenticated socket. Fresh canonical heartbeat checks must progress independently while the same accepted operation retains its write, failure and drainage ownership.

## Summary

The unchanged complete capacity workload missed its backlog-drain deadline while Runtime connection epochs advanced repeatedly. This suggested a liveness problem but did not establish its cause. Two controlled real WSS regressions then held the original Service synchronization callback and the original native writer separately. Both reproduced a Service-initiated timeout before the held operation was released.

## Timeline

- The full workload retained drafts while frequent reconnects were observed; repeated handshakes alone did not distinguish client timeout, Service expiry or another exception.
- With the original 25 ms heartbeat and 300 ms offline settings, the held callback case received zero later heartbeats and the held writer case received one. Both remained at the heartbeat-progress stage with two pending frames and closed with Service code 4008.
- After the three Service owners were corrected, the two original held-gate cases passed with eighteen assertions, preserving the original settings and exact final synchronization checkpoint.
- The selected original Service and Runtime neighbor run passed eighty tests and 582 assertions. The four enhanced real WSS cases then passed 31 assertions, including post-echo persistence failure, queued-prefix fairness and close/suspend drainage. Harness, Service, Organization Runtime, Local Runtime, Presets and Web owning type verification passed. The complete unchanged capacity workload remains separate acceptance.

## Root cause

The Service entered ordinary operation admission through a write transaction before running its frame callback. Its socket pending chain also awaited completion of the previous synchronization frame before processing a heartbeat. Either the occupied writer or the held domain callback prevented lease renewal. The timeout came from Service lease expiry, not a synchronization ACK deadline. Presence persistence was coupled to liveness even though stored last-seen timestamps grant no execution or online authority.

A priority path alone would be incomplete: it must freshly reject revoked identity and maintenance suspension, retain first-flight presence and predecessor references through close, preserve frame/byte charges and prevent later heartbeats from starving an already queued data frame. The [decision](../decisions/implemented/bug-fix/2026-11-14-preserve-authenticated-heartbeats-through-held-service-writes.md) records those ownership choices.

## Guardrails

- [x] Machine check: `packages/organization-runtime/test/connection.test.ts` holds the original synchronization owner and native writer separately over real WSS, preserves heartbeat/expiry settings and verifies the exact committed checkpoint after release.
- [x] Machine check: original Service connection, maintenance and sync-storage-observation suites retain revocation, close, final batch/blob COMMIT and storage-observation guards; original Runtime export, native write failure, handoff connection and connection neighbors retain their own lifetime assertions.
- [x] Machine check: added original WSS negatives verify post-echo presence write failure remains visible, later heartbeats cannot starve a queued data prefix, and close/suspend drains the first flight and its predecessor.
- [x] Machine check: final owning type verification passed for the six affected owners.
- [ ] Machine check: the complete unchanged capacity workload must pass before this change is credited with its closure.

## Lessons

Diagnose the actual closer and held stage before changing transport scheduling. Keep fresh authority inspection separate from liveness sampling, and retain every accepted persistence callback through its original owner rather than increasing deadlines or discarding pending facts.
