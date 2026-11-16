# Decision Record: Match authority fingerprints to the journal end

Status: implemented

## Problem

Current policy rows and their stored fingerprints can agree while their committed history is missing. The baseline and remaining hash chain can also be internally valid. Checking those two relationships independently could incorrectly report recovery coverage.

## Decision

Coverage inspection derives the expected final fingerprints from the canonical baseline and every committed transition. The existing chain walk supplies those parsed observations to a private temporary disk index. Baseline keys must have their declared domain owner; transitions must match the prior fingerprint and their exact before/after projections before updating or removing that derived key.

The same read snapshot compares stored fingerprints against both actual policy projections and the derived journal end, in both directions. Missing, extra or changed final fingerprints prevent coverage. Recorded deletion and recreation remove and establish the expected key through their actual transitions. Hash-chain validity remains distinct from coverage of the current records.

Archived checkpoint reads apply the same registered projectors and final-state fold after complete authenticated EOF. Their private disk index retains projected hashes, fingerprints and history from that fixed archive rather than reading the later live policy. Missing, extra or changed policy, a missing fingerprint, an inconsistent transition or a different registered projection contract rejects the archived checkpoint. Container authentication cannot establish these relationships by itself.

The temporary index is verification data only. It is not another journal or persisted authority, cannot repair canonical facts, and is removed after the read. Its native setup and disposal are shared with archived history indexing. Ordinary authorization continues to read its current owning records.

## Alternatives considered

**Trust matching current rows and stored fingerprints.** Both can survive a partial history rollback and therefore do not prove that the journal reaches the current state.

**Read the journal again for every fingerprint.** Repeated full scans would multiply work by the number of policy records. One streamed fold and indexed comparisons keep work bounded without retaining a complete map in memory.

**Rebuild missing canonical history automatically.** That would invent attribution and could turn an inconsistent restore into apparent authority. Inspection reports incomplete coverage without modifying those facts.

## Consequences

Inactive recovery signing refuses the inconsistent state through its existing coverage check. This does not apply a later source policy, establish an authenticated live source barrier, retire a writer or enable recovered execution. No schema migration or new persistent record family is added.

Coverage remains limited to registered projections. Unprojected native policy, source freshness and a rollback of the entire history together with its matching policy require independent evidence; internal consistency cannot establish them.

Harness `test/storage/authority-journal.test.ts` performs a real policy transition, then restores only the earlier header and removes its entry while retaining the actual new policy and fingerprint. The earlier inspector reported coverage; the corrected inspector preserves the valid hash-chain observation while refusing coverage. Recorded deletion/recreation, ordinary transitions, ignored metadata, rollback, pagination and archived continuity retain their own tests. Organization authority-history and inactive-signing suites exercise the actual consumers. See [the postmortem](../../../postmortem/0137-current-fingerprints-hid-a-missing-authority-transition.md).

The same suite exports genuine authenticated checkpoints containing inconsistent policy/fingerprint/history relationships. The archived reader rejects all five missing, changed and extra-record cases while valid fixed continuations remain readable after the live source advances. The [archive postmortem](../../../postmortem/0139-authenticated-archive-policy-disagreed-with-its-journal.md) records the independently reproduced archive gap.
