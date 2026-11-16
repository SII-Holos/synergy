# Authenticated archive policy disagreed with its journal

## Executive summary

An authenticated namespace archive could contain a valid authority hash chain alongside policy records that disagreed with that chain. Live inspection rejected the same state, but the archived checkpoint reader returned it. Archive reads must verify their own complete projected policy, fingerprints and derived journal end.

## Summary

Container authentication establishes that the received bytes match the captured archive. It does not establish that those captured domain records are mutually consistent. The archived reader checked its baseline and complete chain but omitted the live inspector's policy coverage check.

## Timeline

1. A genuine policy mutation committed a new policy and fingerprint. Restoring the old journal header and removing the transition left a valid earlier chain.
2. The live inspector reported incomplete coverage. A newly exported authenticated archive of exactly those records was nevertheless accepted by the archived reader.
3. Independent changed-policy and missing-fingerprint cases also reproduced acceptance. The three intended rejection tests failed against resolved promises.
4. Archive verification reused the canonical final-state fold and registered projectors, indexing only projected hashes and exact references on disk after complete authenticated consumption.
5. Five inconsistent archive cases reject; valid multi-page continuations and historical checkpoints still read independently of the later live state.

## Root cause

The archived reader treated hash-chain integrity as sufficient historical evidence. Policy/fingerprint consistency was only implemented in the live storage inspector, leaving the same authority reader with weaker archived validation.

## Guardrails

- [x] Machine check: `packages/harness/test/storage/authority-journal.test.ts` exports real authenticated archives with a lost transition, changed policy, missing fingerprint, missing policy and extra policy; all reject without changing canonical facts.
- [x] Machine check: the same suite reads a complete fixed continuation spanning metadata pages after the live source advances, rejects wrong anchors and requires authenticated EOF and original cancellation.
- [x] Machine check: Organization authority-history and inactive-signing suites exercise the actual recovery consumers.

## Lessons

Internal archive consistency and source freshness are separate requirements. Registered projectors can validate an archive's own policy state without exposing credentials, repairing history, granting recovered execution or proving that another writer retired. See [the owning decision](../decisions/implemented/bug-fix/2026-11-12-match-authority-fingerprints-to-the-journal-end.md).
