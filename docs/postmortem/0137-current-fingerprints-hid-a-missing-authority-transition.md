# Current fingerprints hid a missing authority transition

## Executive summary

Authority inspection accepted matching current policy and fingerprints even when the transition that produced them was absent from history. Coverage now also requires those fingerprints to equal the journal's derived end state.

## Summary

A real native policy transaction updated the row, fingerprint and journal. The fixture then restored only the preceding header and removed that transition. The remaining baseline/hash chain was valid and the new fingerprint still matched the new row, so the old inspector incorrectly reported complete coverage.

## Timeline

1. A native attributed policy change committed all canonical facts.
2. Controlled restoration of the earlier header and removal of its entry left the new row and fingerprint intact.
3. Inspection correctly reported a valid remaining chain but incorrectly reported coverage.
4. A private streamed fold derived the expected final fingerprints from baseline and transitions.
5. Comparison with that end state rejected coverage while preserving all canonical facts.

## Root cause

The inspector checked current-row-to-fingerprint consistency and baseline-to-head chain validity independently. It did not join the final fingerprint state to the transitions claimed by that chain.

## Guardrails

- [x] Machine check: `packages/harness/test/storage/authority-journal.test.ts` reproduces the actual partial history rollback and checks incomplete coverage with the current row preserved.
- [x] Machine check: the same suite verifies that recorded deletion and recreation retain complete coverage and do not retain obsolete fingerprints.
- [x] Machine check: Organization authority-history and inactive recovery signing suites exercise canonical consumers.
- [x] Procedure: the persistence Skill requires state/history consistency without inventing repair events.

## Lessons

A valid chain and internally consistent current state must also agree with each other. Verification data may explain the discrepancy; it cannot create the missing authority. See [the decision](../decisions/implemented/bug-fix/2026-11-12-match-authority-fingerprints-to-the-journal-end.md).
