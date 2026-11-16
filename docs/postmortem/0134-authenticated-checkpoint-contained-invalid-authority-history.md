# Authenticated checkpoint contained invalid authority history

## Executive summary

The archived authority reader accepted an intact checkpoint whose journal chain was invalid. It now verifies the baseline and full chain through the same owner used by live inspection.

## Summary

A real policy transaction produced canonical history. A controlled native write corrupted one entry hash, and live inspection correctly reported an invalid chain. Exporting those actual bytes produced a valid authenticated namespace archive. The old archived reader returned its unchanged header successfully, treating container completeness as sufficient history evidence.

## Timeline

1. A real policy mutation committed an attributed journal entry.
2. The fixture corrupted that entry while preserving the canonical header.
3. Live inspection reported invalid history.
4. A complete checkpoint authenticated the actual corrupt bytes.
5. The archived header reader incorrectly resolved; the shared chain verifier makes the same fixture reject.

## Root cause

The archive reader verified transport completeness but omitted the logical checks already owned by live history inspection. Reading a later source head also needed an explicit fixed earlier anchor, rather than unrelated paginated observations.

## Guardrails

- [x] Machine check: `packages/harness/test/storage/authority-journal.test.ts` rejects an authenticated checkpoint with corrupt history and verifies exact earlier heads across a fixed multi-page continuation.
- [x] Machine check: `packages/organization/test/backup/authority.test.ts` keeps inactive target signing preparation bound to historical H0 while the actual source has later H1.
- [x] Procedure: the persistence Skill separates container integrity, history continuity and current private authorization.

## Lessons

Authenticate bytes and verify the domain relationships they claim. A historical chain is evidence of continuity, not current access or physical writer retirement. See [the decision](../decisions/implemented/bug-fix/2026-11-12-verify-archived-authority-chains-and-continuations.md).
