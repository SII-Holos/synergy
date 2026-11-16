# Session event capture outlived its native callback

## Executive summary

Canonical Session mutations returned before their transactional Bus capture completed. During recovery, queued capture then wrote after the original restoration callback had closed and correctly hit its native-authority guard. Mutation methods must await their own capture; the outer transaction's pending queue does not extend a domain callback's lifetime.

## Summary

Completed Hosted task recovery and published Artifact recovery both failed when a delivery record was written through an expired restoration frame. A creation rollback fixture also exposed detached capture after its original receipt write failed. Ordinary successful transactions could conceal the missing wait because Storage drains pending captures before COMMIT.

## Timeline

The original two recovery cases reproduced the native callback refusal with their history and Artifact checks intact. Adding awaits at the six canonical Session and message publication sites made both original cases pass. The original creation rollback, paused roundtrip, independent Continue and resident Runtime cases also passed without changing their native-owner checks.

## Root cause

Bus publication inside a write transaction returns the asynchronous capture of the event and its durable deliveries. Session publication ignored that promise. RuntimeMaintenance closes its restoration frame as soon as the original callback returns; Storage subsequently drains pending captures before COMMIT. Those are distinct lifetimes. A transaction-level guarantee therefore did not authorize the late domain write. If the body threw first, detached capture could instead reach the transaction after rollback.

## Guardrails

Session Info, message updates, assistant context usage, metadata merge, message removal and Part removal await the original Bus promise. Existing awaited Part updates, completion and returned deletion callbacks retain their paths. Storage capture serialization, rollback behavior and restoration guards remain unchanged.

- [x] Machine check: `packages/organization-runtime/test/backup/native.test.ts` retains actual completed-model and published-Artifact recovery with exact history and byte verification.
- [x] Machine check: `packages/organization-runtime/test/command-intake.test.ts` retains original Session and Scope rollback when receipt publication fails.
- [x] Machine check: `packages/organization-runtime/test/session-adoption.test.ts` retains original cleanup history without reviving execution.
- [x] Machine check: `packages/organization-runtime/test/execution-handoff.test.ts` retains independent Continue after actual target activation.
- [ ] Machine check: the complete hosted platform matrix must verify the final source revision.

## Lessons

Await the mutation's durable publication before returning its accepted work. Keep callback authority shorter than or equal to its original owner; do not reopen a closed frame or weaken its guard to finish detached work.
