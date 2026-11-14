# Snapshot retention outlived its source reader

## Executive summary

Object Snapshot capture could publish a retained root after its original artifact configuration changed, then reject only when the enclosing indexed-reader callback finished. Pure reader checks now cover later Git work and the actual stored-content COMMIT.

## Summary

An isolated paged Workspace fixture used actual Git capture and stored Snapshot persistence. One barrier held the returned result of a successful `write-tree`; the test then changed the original Storage handle's artifact directory. Capture rejected, but restoring that configuration and querying retained roots still found a published root. A second barrier changed the configuration after the real publication transaction completed its body, exposing the same late check at COMMIT.

## Timeline

1. The indexed reader verified metadata and read all admitted file bodies under its original source configuration.
2. Snapshot capture awaited native tree and retention work before the outer reader checked its callback again.
3. Both controlled configuration changes caused rejection only after canonical retention had already published.
4. The reader's pure current check was carried through retention to the real database commit guard, independently combined with cancellation.
5. Both original barriers rejected without a canonical retained root. The late transaction rolled back its manifest, legacy-input fence and preparation removal together.

## Root cause

The read callback's lifetime covered the whole operation, but its final check was not a publication fence. Native Git and stored-content preparation introduced asynchronous boundaries after the last file read. The publishing owner needed the same original source check at its own final commit decision.

## Guardrails

- [x] Machine check: `test/snapshot/paged-content-consumer.test.ts` holds an actual successful Git tree write and verifies rejection without retained publication after source replacement.
- [x] Machine check: the same test changes the artifact configuration after the actual writer body and checks complete publication rollback plus retained preparation evidence.
- [x] Machine check: the suite retains late-body cancellation, immutable-byte failures, original selection and durable reads after source and cache loss.
- [x] Procedure: the [persistence workflow](../../.synergy/skill/change-persistence/SKILL.md) requires the original pure reader guard at the publishing COMMIT, rather than a callback-end assertion.

## Lessons

An error returned after publication does not prove publication was prevented. Validate the actual retained state after restoring the original owner, and carry restrictive lifetime checks to the owning commit boundary. Invalid contexts leave original preparations for explicit reconciliation rather than issuing new cleanup writes through another configuration. See the [capture decision](../decisions/implemented/architecture/2026-11-12-capture-object-workspace-snapshots-through-indexed-trees.md).
