# Decision Record: Bind organization execution grants to native task evidence

Status: implemented

## Problem

Service admission and native input reception do not establish that a task root exists. Activating a grant at admission permits arbitrary root identities and confuses lost acknowledgments with permission to repeat input. Reauthorizing existing resources against each collaborator also changes the Session's contract unexpectedly.

## Decision

The service owns a revisioned Session resource selection. The actual selector needs current Session execution access and use authorization for every selected resource. Selection and directory metadata share one transaction; pending commands, retained grants and handoff conflicts block changes.

Task input admission reserves a provisional grant in the A transaction. It snapshots the Session selection, actor, binding, admission and per-call limits. Collaborators inherit the existing selection without adding their personal grants or revalidating the original selector. Current resource availability still applies. Grants are individually addressable; a transactional directory count retains their selection without an inline list or a product quota.

The native receiver constructs a root proof from its retained accepted task, canonical root message and Rollout record. It verifies exact actor/root identity, current binding, transfer state and cancellation evidence. The machine signs that complete proof in a separate Ed25519 domain with a finite validity window. Input reception alone cannot produce this proof.

The service verifies the registered machine and current connection before reconciling B. It then atomically binds the grant and root index after checking current Runtime account/project role, resource availability, Session contract and epoch. Retries return the original binding. A lost B acknowledgment is reconciled without replay; failure to bind does not erase B. Verified command rejection closes only its provisional grant and retains admission evidence.

## Alternatives considered

**Trust a supplied root ID or activate at A.** Neither proves native materialization. The root must match the accepted task's message identity and exist in the native owners.

**Use each collaborator's resource union.** This broadens task authority and prevents collaborators from continuing an existing contract they did not configure.

**Treat receipt reconciliation and binding as one distributed commit.** Service and Runtime storage are independent. B remains durable when the later binding fails.

**Cap retained grants or add a default lifetime call budget.** These impose new task quotas instead of bounding transport work. Native execution owns the original task budget; iterations, auxiliary calls and retries cannot be replaced with one arbitrary gateway call allowance.

## Consequences

Bound descriptors contain no upstream credentials or endpoints. Project archival permits already accepted work to bind; current member Runtime revocation, loss of project execution role, resource disablement and handoff/epoch changes deny binding. The [accepted-root correction](../bug-fix/2026-11-14-preserve-accepted-root-authority-after-actor-removal.md) distinguishes historical interactive input attribution from canonical B while retaining current authorization for released-generation reacquisition and API tokens.

A selection contains one model and up to 32 business connections. Per-call defaults are 8 MiB per request and 16 MiB per response. Bound grants retain their selection until a lifecycle owner proves release. Gateway dispatch, release and member execution activation remain separate integrations; the Agent execution source stays closed.

Version-two grants and directory records remove the extra lifetime call limit and inline grant array. A registered record-access migration preserves legacy occupancy, identities and usage without startup enumeration. Current writers materialize the new shape. Corrupt legacy ownership remains an error; failed business writes preserve its original evidence. Human directory responses omit internal grant accounting. This keeps normal reads bounded while requiring every grant closure to update its retained-use count atomically.

Tests use real SQL rollback/restart, signed protocol fixtures, authenticated sockets and HTTP, and native Inbox materialization across independent databases. They cover forged roots, altered/expired proofs, missing admission, lost ACK, resource disablement, actor/driver revocation, archived projects and unchanged input counts.
