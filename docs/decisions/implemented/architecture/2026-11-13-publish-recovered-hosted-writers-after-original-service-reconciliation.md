# Decision Record: Publish recovered Hosted writers after original service reconciliation

Status: implemented

## Problem

A restored service cannot admit its original Hosted writer using a copied registration or a new incarnation alone. The old native Home must permanently fence its writer, the complete original namespace and native material must remain verifiable, and the service's canonical writer mapping must select the same original target request.

Native completion also has to survive a cold restart and the ordinary Node entry path. A restored target initialized through its physical path cannot reopen its dataset through a parent-directory alias that changes Bootstrap's path identity.

## Decision

The installed Hosted capture owner supplies `NamespaceRetirement` with its original opaque native material and Snapshot evidence. Its fixed reference includes the original service installation request, namespace, native digest, source maintenance operation and physical Home. Kernel reservation precedes permanent format-four native fencing. A restricted read-only source opener verifies the completed original fence after the source Runtime closes; it neither constructs an active bridge nor repairs an incomplete marker.

`backup/recovery` initializes a dedicated target through Bootstrap's original pre-initialization hook. The actual native installation begins before logical records exist, then checkpoint import preserves only Bootstrap's original physical base. Native bytes and Snapshot history remain bound to the fixed source archives. The original target keeps its recovery hold until publication completes.

Service publication consumes genuine physical writer inspections and reconciles its complete H1 roster. The Hosted target then consumes the service owner's opaque publication inspection for that runtimeID and original source reference. It preserves the original runtimeID, public key and native binding while adopting the service's committed registry incarnation. Its actual restoration transaction writes an immutable publication receipt and pauses eligible restored Sessions through their existing owner. Nonterminal Cortex and unattended workflow restoration remain unavailable without their respective native owners.

After installation callbacks end, independent native completion writes the registration and monotonic connection checkpoint through the anchored file owner, completes the original Home intent and releases only its original adopted maintenance operation. Ordinary Node preflight and primary SQL publication checks remain mandatory. Only an already verified restored Home returns its physical canonical paths; ordinary format-two readers retain their original paths and metadata.

Restricted shutdown drains the publication owner's accepted native completions even when their observer callbacks have returned. It retains the original primary and process lock until those effects settle, reports cleanup errors and attempts the remaining original resource releases. See [completion drainage](../../../postmortem/0163-hosted-publication-outlived-its-restricted-runtime.md).

## Alternatives considered

**Re-enrolling the target or minting another machine key** loses the original writer identity and cannot prove that its predecessor stopped.

**Passing registration descriptions between Runtimes** cannot establish the original committed service publication or retain its callback and process-lock lifetime.

**Relaxing Bootstrap dataset identity** would accept a different database selection. The restored Node reader instead returns the physical path already verified by native completion.

## Consequences

The verified pipeline admits an actual Hosted writer with no unsettled task facts. It grants neither a model execution nor automatic Continue. Member writers, external storage reconstruction and unclassified resource or task facts remain blocking. Model task settlement and explicit recovery Continue require their owning provenance and are not established by native publication.

## Verification

`packages/organization-runtime/test/backup/native.test.ts` uses actual HTTPS enrollment, a connected WSS source, complete H0 capture and original inactive service target, Hosted format-four fencing, cold native source and target reopening, H1 service reconstruction and publication, Hosted native completion, and ordinary service/Hosted startup. The original runtimeID, key and binary bytes remain readable through the reconnected writer. `test/home-restoration-node.test.ts` verifies Node-only preflight and the physical paths of a completed restored Home without granting SQL authority.
