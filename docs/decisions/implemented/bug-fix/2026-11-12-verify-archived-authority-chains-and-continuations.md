# Decision Record: Verify archived authority chains and continuations

Status: implemented

## Problem

An authenticated namespace checkpoint can contain corrupt logical history. Reading only its authority header after authenticated EOF does not establish that the baseline and hash chain reach that header. Recovery also needs to distinguish a fixed archived continuation from the source's later live head.

## Decision

The canonical authority owner shares one baseline and entry-chain verifier between live inspection and archived checkpoint reading. It verifies canonical keys, baseline counts and hash, entry journal identity, contiguous sequence, previous hashes, entry hashes and final head. An archived reader rejects untracked history.

Archived reading consumes the complete authenticated checkpoint before certifying history. Its private temporary disk index orders journal rows independently of their physical archive order and bounds metadata memory. Original manifests, recovery-key methods and cancellation are captured before asynchronous work; the index is removed after success or failure.

An optional earlier checkpoint requires the same journal, namespace, baseline, contract and start identity. Its sequence must occur on the verified chain with its exact tail hash. The result remains the fixed archived end, even when the live source has continued. Both an initial baseline and a nonzero earlier head can serve as anchors; equality is valid, while gaps, forks and newer anchors fail.

## Alternatives considered

**Trust the authenticated container and header.** Container integrity authenticates its bytes; it does not prove their authority-history relationships.

**Page the current source journal during restore.** Separate reads can observe later heads and cannot establish one fixed archived continuation.

**Keep another recovery-specific chain verifier.** Live and archived checks must use the same canonical baseline, key and entry semantics.

## Consequences

This verifies historical chain continuity only. It does not apply private account or resource state, establish current ACL coverage, retire an old writer, activate signing material or release recovery holds. No journal, receipt or recovery phase is added.

Harness `test/storage/authority-journal.test.ts` reproduces an authenticated export containing a corrupted entry that the header-only reader accepted. It also captures a real continuation beyond a metadata page, advances the live source again, and verifies fixed end identity, immutable input capture and rejection of changed anchors. Organization inactive-signing tests preserve historical H0 while the actual source has H1. See [the postmortem](../../../postmortem/0134-authenticated-checkpoint-contained-invalid-authority-history.md).
