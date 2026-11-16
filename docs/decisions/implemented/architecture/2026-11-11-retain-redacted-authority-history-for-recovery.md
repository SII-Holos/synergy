# Decision Record: Retain redacted authority history for recovery

Status: implemented

## Problem

A restored organization can contain older membership, resource grants or sharing state than the controlled deployment that produced it. Current revisions describe one state; they cannot establish which authorization changes occurred after a checkpoint. Reopening an older database without that evidence can restore revoked access. Private canonical Session content also makes ordinary administrator archive access an unsuitable recovery authority.

## Decision

Harness provides an explicitly selected, Runtime-local authority journal over declared canonical prefixes. Domain contributions own strict, redacted policy projections. The journal never decides current access. Organization authorization remains the only online role and object authority.

The owning central migration captures one immutable baseline and its hash, then initializes derived current fingerprints. Subsequent domain writers identify a validated account, a validated one-time-link cause or a signed machine proof before the protected write. Before images, hash-chained entries and current fingerprints commit in the same native transaction as the actual account, project, grant, resource credential, API token, Session sharing/binding, knowledge selection, publication or cloud-attribution change. Credential values and private bodies never enter these projections. Credential changes retain only hashes; restoring current credentials still requires their canonical owner or explicit credential re-establishment.

The pending-change index, baseline, history and verification scans use native key pages. Per-page bounds do not impose a lifetime history limit. Harmless connection heartbeats and retention counters are outside policy projections. Unhooked policy mutations, missing contracts, missing baselines, changed chains or current fingerprint gaps prevent coverage. Returning an untracked policy to its original value cannot heal a gap observed by the selected writer guard. An unselected journal preserves ordinary personal-domain transactions and never asserts recovery coverage.

The organization private signing record advances to version 2. Its history contract hash and journal baseline are established atomically by the owning migration while preserving the existing signing keys. Current startup checks the exact selected contract. The public signing identity and signature encoding retain version 1. A previous strict private startup reader rejects version 2, so reopening this controlled service through that reader cannot silently bypass its selected journal. Missing completed history is a recovery error, not an invitation to create a replacement baseline.

## Alternatives considered

**Compare current revisions only.** A later change can return to an equivalent visible state, and a restored revision cannot prove whether a revocation occurred after the checkpoint.

**Persist raw authorization records in a general audit table.** Password hashes, credentials and private record fields would acquire a second data owner and a broader exposure path. Domain projections retain the evidence required to identify policy changes without exporting credential material.

**Log after the canonical transaction.** A crash between the authority write and log publication leaves an undetectable claimed history interval. Native transaction participation retains the actual commit and rollback boundary.

## Consequences

Journal coverage is conditional on its exact selected owners and controlled writer cohort. It does not prove arbitrary older code never changed a Home before that baseline, and does not replace a hosted Runtime's independent schema/capability fence. A complete deployment restore still needs source checkpoint/delta evidence, maintenance drainage, resource and hosted namespaces, Snapshot bytes, new deployment identity, current authorization re-establishment when history is unavailable, and unique physical writer reconciliation. The namespace checkpoint and this journal alone do not deliver complete organization backup or permit execution replay.

The journal is a trusted Host recovery port. No ordinary organization account receives raw history or private archives through a Web route. Removing an account, disabling a resource or changing a share still takes effect through current authorization independently of recovery evidence.

## Verification

Harness `test/storage/authority-journal.test.ts` uses actual SQLite to verify redacted attribution, rollback, late commit guards, paged history, immutable baseline/chain checks, unhooked transitions and absence behavior. Organization `test/authority-history.test.ts` exercises real service migration, one-time links, password revocation, publication, selection, sharing and restart; its upgrade fixture retains the original signing key and rolls the private format back when baseline preparation fails. A separate process runs the prior strict private startup reader against the resulting database and refuses readiness. Handoff tests retain their actual signed source/target proof flow and verify journal coverage after binding changes. The native TLS/WSS API-token test still creates and reconciles the original queued task with the unchanged public signing identity.

The mounted generated-client service test also verifies signed machine registration with a configured client Origin while knowledge-machine routes reject Origin/cookies. The knowledge-only guard is scoped to its own route family so it cannot intercept an unrelated registration endpoint.

## Related

- [Organization service](../../../architecture/organization.md)
- [Agent storage](../../../architecture/agent-storage.md)
- [Namespace checkpoints](2026-11-11-pin-portable-namespace-checkpoints-and-fence-restoration.md)
