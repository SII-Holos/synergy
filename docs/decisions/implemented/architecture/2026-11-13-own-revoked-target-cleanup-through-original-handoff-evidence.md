# Decision Record: Own revoked target cleanup through original Handoff evidence

Status: implemented

## Problem

An inactive native destination can retain a real Workspace claim after its member loses Session visibility or its account or device is revoked. Ordinary Handoff Views and machine connections correctly stop authorizing that participant, but an existing preparation still needs discovery, permanent retirement and reconciliation. A self-consistent service-key DTO does not prove that a cleanup instruction came from the enrolled organization.

## Decision

The Handoff owner derives a paged target-participant index from its canonical records, bound to the original Runtime and public key. Its central migration rebuilds that index; ordinary record writes maintain it in the same transaction. Index entries contain references rather than an independent pending state. Active members can discover only their own Runtime's original cleanup metadata, including after Session visibility is lost. Administrator access to another Runtime does not authorize this endpoint.

A distinct machine HTTP protocol verifies fresh requests using the retained original participant key. It can discover original candidates or obtain a finite inspection or retirement envelope for an already cancelled native Handoff with its complete source-cancellation proof. Account or device revocation does not erase that historical identity. Ordinary WebSocket authentication, Runtime authority and current human reads retain their existing fences. Recovery responses contain original bindings and proofs, without current Directory metadata, content, preparation, activation or execution permits.

The enrolled native HTTP owner fixes the Home origin, deployment, machine credential and configured TLS trust before sending a request. After validating the returned request digest and purpose-specific authorization, it creates private callback-bound evidence. The existing Target instance consumes that evidence through a WeakMap; callers cannot authorize effects by supplying their own service or source public keys. Its guards retain the original Runtime, primary Store, signal, expiry and callback lifetime through the actual Epoch and receipt transactions. No signing-key pin ledger is introduced; service-key rotation continues through the established verified-origin trust.

Recovery shares the original Target jobs, complete staging validation, Epoch never-activate transaction, WorkspaceMove intent and physical release. Receipt reader three permits recovery envelopes only for inactive retirement facts; readers one and two migrate through their owning registry while retaining the original facts. Completed cleanup submits those same signed facts through the existing proof endpoint and verifies its immutable acknowledgement. Lost acknowledgements are reconciled by inspection, without resending retirement. Incomplete native evidence remains blocked or unknown.

Native dispatch anchors the original Home, artifact owner, canonical Bootstrap dataset selector and existing store/artifact UUIDs in the same Move transaction that records the dispatch intent. Writable primary ownership is required for physical effects. The owning migration explicitly marks historical intents; only those records may inspect bounded aliases for known historical open flags, retaining their original four- or seven-field references and tokens. A fresh dataset never searches historical aliases, even at the same Home, filename and namespace. Catalog volume identities and coordinator admission identities retain their separate native schemes. Capture checks both owners' current physical evidence; release uses the original ledger root, Host and token without reading or authorizing a replacement directory. See [cold dispatch identity](../../../postmortem/0171-native-move-cold-open-changed-dispatch-identity.md).

An ordinary machine reply must retain its original authorization mode through the final service snapshot. Cancellation and lost Session authority cannot lend cleanup-only permission to an already formed private difference page. A changed mode rejects that reply; a new cleanup request returns only its original facts. See [pending response authorization](../../../postmortem/0172-handoff-response-crossed-cleanup-authorization-mode.md).

## Alternatives considered

**Reopen ordinary machine or human authority.** This would restore private reads or execution privileges to repair an unrelated cleanup operation.

**Trust a caller's signed DTO.** A caller can generate both a signing key and a self-consistent DTO. A controlled real-claim regression retired the actual destination through that unsafe seam; only the enrolled HTTP owner's unforgeable evidence can authorize the Target callback.

**Persist another cleanup queue.** A second pending ledger could disagree with Handoff, Epoch or WorkspaceMove outcomes. The derived index and original receipts already identify the work.

**Retry an unknown retirement as a status check.** Repeating an effect cannot establish what the earlier callback committed. Inspection reads only the original receipt, Epoch and Move.

**Hash storage open options as native identity.** Existence checks and recovery flags vary across cold opens. Hashing the canonical selector alone would instead confuse a replacement dataset with its predecessor; existing UUIDs distinguish them without a new identity ledger.

## Consequences

Target cleanup can converge without restoring Session read access or reconnecting the revoked machine to ordinary control. The public native entry requires its already enrolled Runtime and original Target controller; it does not create another controller, Runtime identity or target selection. Manually composed writable Stores must supply their existing Bootstrap dataset header; missing identity fails closed. Historical alias reconciliation does not cover arbitrary PostgreSQL credential or connection-selector changes. Source-side recovery, renewed handoffs, downloads and independent execution remain separate operations. See [existing native adoption](2026-11-13-adopt-existing-native-workspaces-through-original-handoff-claims.md) and [immutable machine acknowledgements](../bug-fix/2026-11-13-acknowledge-only-original-handoff-machine-facts.md).

Acceptance uses generated clients over real TLS with enrolled native participants for revoked-device cleanup, account removal followed by a cold reopen, lost committed proof acknowledgements and immutable inspection. The same Target rejects self-signed DTOs, foreign Runtime/Store callbacks and ended capabilities. Lower tests use real retained claims for historical four- and seven-field references, release acknowledgement loss, replacement directories and a fresh database at the same Home and filename. Service tests exercise original publication rollback, filtered pagination and the centrally registered owning migration's fresh, upgrade and corrupt-input paths; they invoke that migration directly rather than claiming a complete cold service startup test. Signature/window validation and receipt readers have focused tests; a held callback crossing actual expiry is outside this acceptance batch.
