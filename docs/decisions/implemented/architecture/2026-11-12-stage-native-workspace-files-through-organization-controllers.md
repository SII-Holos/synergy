# Decision Record: Stage native Workspace files through organization controllers

Status: implemented

## Problem

The signed organization handoff controllers rejected every current Working location even when native file capture and private target preparation were installed. Enabling those owners also exposed a publication dependency: native Workspace catalogs must precede Core, and organization command adoption must follow Core. Incoming owner priority alone cannot express both requirements.

## Decision

The native organization composition selects `session-workspaces`. The source captures the complete member file closure inside its exact `NativeSessionTransferPhysical.withCapture()` callback. Its frozen fact includes a required nullable `fileClosureHash`, distinct from `workspaceMoveReceiptHash`. The former binds the native file closure; the latter represents an independently published directory/resource CAS receipt and remains null for fresh private native destinations.

The target verifies that the selected file owner and frozen file hash agree, reconstructs the complete closure from staging and invokes the canonical native target preparer. Each member receives the resulting logical Workspace identities and preparation receipt. Conflicting caller identities or receipts are rejected before a prepared fact can publish. The complete mapping participates in the retained conversion hash.

Paused activation runs the epoch and canonical publication transaction inside `SessionTransferWorkspaces.withTargetPublication()`. Native directories remain privately prepared until their catalogs and the canonical aggregate publish together. The controller never sends input or Continue. Lost responses reconcile the original native facts without repeating publication.

Portability contributions declare `publicationAfter` separately from staged dependencies and `publicationBefore`. Both publication directions form one deduplicated graph, validated before body receive and before publication. The organization owner declares `publicationAfter: ["session-core"]` and preserves its reader/header 3 Core-publication capability in reader 4, which adds complete object-mapping receipts. Incoming reader 3 remains an explicit native-history format; readers unable to consume the declared version reject before body access.

## Alternatives considered

**Use the source file digest as a WorkspaceMove receipt.** Immutable file verification cannot prove a destination head CAS or existing-directory merge. Separate fields preserve those different facts.

**Override the caller's Workspace mapping.** A different identity or receipt changes the selected destination. Rejecting disagreement preserves the accepted mapping.

**Reorder controller arrays or tolerate missing Core.** Array priority only orders ready owners. Organization publication requires Core's canonical record, while the Workspace owner reads staged Core but publishes first. Explicit prerequisites preserve both relationships.

## Consequences

Fresh native directory preparation supports the signed controller primitives without advertising Main's overall handoff capability. Environment mapping, additional writable locations and existing-directory difference acceptance retain separate blocking owners. [Cross-Realm receipt consumption](2026-11-12-consume-cross-realm-workspace-move-receipts-before-paused-handoff.md) connects the independent object WorkspaceMove owner without replacing native destination preparation. Cancellation preserves the original directory and paused Session; it does not authorize execution or undo an independent directory publication.

## Verification

`test/handoff-controllers-http.test.ts` uses enrolled member/hosted Homes, HTTPS/WSS, canonical Workspace binding and private native target directories. It verifies binary and ignored files, paused publication with no Inbox/message input, cancellation, conflicting identity/receipt mappings and lost source/activation replies without duplicate publication. `test/session-transfer.test.ts` rejects readers 1 and 2 before body access. Harness `test/session/transfer-publication-order.test.ts` covers Core/organization/Workspace ordering, immutable contributions, missing owners and cycles. Service and protocol tests bind the distinct file hash and reject changed signed facts.
