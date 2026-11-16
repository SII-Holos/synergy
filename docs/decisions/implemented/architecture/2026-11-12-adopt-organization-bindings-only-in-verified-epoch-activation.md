# Decision Record: Adopt organization bindings only in verified epoch activation

Status: implemented

## Problem

Portable Core previously published an imported organization's original driver and epoch. A destination could contain a paused Session while native reading and execution still considered the source its owner. Returning to an older surrendered copy also failed immutable binding validation. Deleting that copy before rewriting it created a canonical Session tombstone, which correctly prevented its apparent revival by a delayed writer.

## Decision

`SessionSchemaRegistry` provides an owning transfer-adoption path separate from ordinary mutation and import. It requires the actual current destination epoch transaction and checks the reserved Session, Scope and aggregate root before invoking domain callbacks. An owner supplies both adoption and validation and may transform only its registered fields. All other owners retain their ordinary mutation validation. Core uses this path before canonical publication and keeps source identity, parent lineage and unknown retained evidence intact.

The organization owner accepts only a verified service activation permit inside that exact Runtime context. New permits carry the canonical source binding read from the service Directory, including creator and project; a source cannot nominate those claims. Adoption compares that signed binding with the retained Core record, destination reservation, manifest hash, source and target identities, epochs and aggregate root. It changes only driver and epoch. An activated parent's binding must agree. Replacing a prior surrendered copy additionally preserves its organization, project, creator, Session and parent identity and requires that copy's earlier destination-owned epoch. The existing epoch reservation independently proves the prior surrender. Ordinary updates and transcript imports retain their original rejection rules.

Legacy permit decoding remains available to verify retained facts and signatures. The adoption path rejects a permit without the signed source binding. Existing immutable permits are never rewritten or resigned to add claims. An activation permit authorizes paused publication; execution requires a separate current grant and Continue.

Core replacement preserves the existing info record and writes retained keys in place. It removes only old Core records and binary references absent from the exact incoming partition. Staging exposes a member-bound indexed binary lookup for that difference check; no aggregate-sized key set or repeated full artifact scan is required. The native tombstone protection remains unchanged. Immutable Snapshot and other domain ownership still publish through their own activation callbacks.

## Alternatives considered

**Update the organization binding after Core publication.** Existing binding validation already rejects a return copy before that update, and an intermediate imported binding can disagree with native admission.

**Allow ordinary Session updates to change bindings during transfer.** That turns a general mutation path into an ownership mint. The dedicated path requires both the signed domain authority and the canonical epoch transaction.

**Delete the whole old Session tree and disable the tombstone check.** Tombstones prevent delayed writers from reviving deleted Sessions. Exact replacement can preserve the identity record and remove obsolete keys without weakening that protection.

## Consequences

Real two-Home fixtures activate the original root and child at the new paused binding and then return them to the previously surrendered Home at the next epoch. Original surrender records remain retained, obsolete Core records and binary aliases disappear, and ordinary binding mutation remains rejected. Valid signatures with a different creator or manifest, publication without domain authority and retained permits missing source ownership do not publish canonical Sessions. Service tests verify that source ownership remains identical before and after Directory commit and that changing it invalidates the signature.

This unit implements owning native binding adoption. Machine dispatch, intake receipt transfer, obsolete aggregate-member retirement, resource grant rebinding and independently authorized continuation remain separate coordination work. It does not establish a complete organization handoff or physical Workspace migration.
