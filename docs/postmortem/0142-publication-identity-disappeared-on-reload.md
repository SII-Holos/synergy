# Publication identity disappeared on reload

## Executive summary

A publication could commit while its HTTP response failed. The editor kept its request ID only in memory, so reloading removed the evidence needed to reconcile that exact request. Publication recovery now persists bounded metadata before dispatch and queries the existing owning receipt before any explicit identical retry.

## Summary

Knowledge and artifact publication already committed immutable versions and account-bound idempotency receipts atomically. The renderer did not retain the original Publish request across reload, and the service exposed no read-only receipt operation. Repeating publication required write permission, which could disappear after a project was archived even though its original version remained readable.

## Timeline

1. Real mounted HTTP tests received 404 from both proposed receipt endpoints. They required a missing observation without publication and an exact original result after later versions, archive and restart.
2. The owners added current-read-authorized queries over their existing account/request receipts. Changed request contents conflicted; removed project access remained denied and artifact source removal did not expose source metadata.
3. The initial App fixture accidentally selected the organization-level Knowledge page before project navigation settled. Its timeout and subsequent browser-reaping failures were excluded as behavioral evidence.
4. The same immutable pre-fix browser bundle was then served with the corrected project deep link. A real editor upload sealed, its final Publish was received once and returned a simulated lost-response 503, and reload had no original-request recovery control. That strict missing recovery assertion established the renderer defect.
5. The renderer introduced one point metadata owner before final dispatch and an explicit owning-receipt recovery flow. Recovery preserves the original identity and historical uncertainty across retries and source retirement.
6. A second review found cleanup continuing after earlier metadata owners awaited. A real two-connection fixture held the original IndexedDB open callback, completed logout through the other owner, selected a new native login and wrote its publication. Releasing the old cleanup deleted that new record and reported storage failure. A separate native cursor-delete success event aborted the original signal, but the old helper still committed deletion. Both failures required cancellation at the actual deletion transaction, in addition to checking the original connection generation before entering cleanup.

## Root cause

Component lifetime was treated as publication lifetime. Upload sealing, publication admission and observing a publication result are separate facts; only the last one confirms the original request. A later failed attempt cannot retroactively establish that an earlier unknown attempt never arrived. Cleanup also treated a Space key as sufficient ownership after an await, allowing an earlier logout to delete a later login's same-key metadata.

## Guardrails

- [x] Machine check: `packages/organization/test/publication-receipts.test.ts` exercises real Storage, mounted HTTP and generated clients for exact request identity, current read access, immutable versions, archive, restart and private source removal.
- [x] Machine check: `apps/web/test/organization/publication-record.test.ts` verifies strict metadata, exact results and monotonic historical uncertainty.
- [x] Machine check: `apps/web/test/organization/publication-recovery.browser.test.ts` exercises real reload, original receipt lookup without replay, actual IndexedDB pagination/isolation and late source retirement. Its final seven cases and 39 assertions include the list-refresh label, two connection owners completing logout across a later login, and cancellation after cursor deletion but before transaction commit.
- [x] Owning procedure: the frontend Skill requires sealed-before-dispatch metadata and original receipt recovery without automatic replay or file-body persistence.

## Lessons

Retain the logical request before a side effect can outlive the renderer. Missing is an observation, not a non-dispatch proof. See [publication recovery](../decisions/implemented/bug-fix/2026-11-12-reconcile-publications-after-renderer-reload.md).
