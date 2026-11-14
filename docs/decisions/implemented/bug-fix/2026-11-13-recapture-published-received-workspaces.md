# Decision Record: Recapture published received Workspaces through their owners

Status: implemented

## Problem

A native transfer publishes its private destination inside the receiving Runtime Home. Applying the ordinary Home-overlap rejection to that Workspace prevents it from serving as a later transfer source, even after genuine publication and cold reopening.

## Decision

Keep the general Home protection and allow only the original published Workspace through both owning callbacks. Harness resolves its committed publication index, original prepared/native row, permanent activated target epoch and current catalog. Scope, host, path, physical identity and binding generation must match. The same records are rechecked after capture, and the boolean ownership API delegates to this inspection.

Local Runtime compares the actual retained native receipt and intent, deterministic private directory, primary/artifact owner, Home/process lifetime and current physical identity. The entire physical Workspace claim, exclusive access and native tree capture run inside both callbacks. Home roots, parent trees, unrelated subdirectories and unpublished, rebound or replaced directories remain ineligible.

The receipt proves the original directory's preparation and publication. It does not require current files to equal the received snapshot: the later source freezes its writers and captures current dirty and untracked bytes. Ordinary catalog revisions may advance while the original binding generation remains fixed. Existing records provide all evidence; no schema, migration or new phase ledger is introduced.

## Alternatives considered

**Allow the received directory prefix.** A prefix does not prove publication, Scope or physical identity and would admit unrelated Runtime data.

**Verify the original tree before recapture.** Legal edits would make a usable current Workspace fail. Preparation identity and current content are separate facts.

**Check a boolean before asynchronous capture.** Returning from the owner before the capture permits its evidence to change during the actual read.

**Add another ownership ledger.** The committed publication, Epoch and native preparation already own the required facts.

## Consequences

Published received copies can be recaptured after cold reopening. The complete private-copy return between two enrolled Member Homes also preserves the Session, current files and paused activation under a new Epoch. Main handoff, native download, additional Working locations, cloud Environment mapping and independent model continuation require their separate delivery evidence. See [the failure analysis](../../../postmortem/0173-received-workspace-copy-could-not-be-transferred-again.md).

## Verification

The original two-Home fixture fails at the second capture after its real first publication and cold reopen. The final fixture captures changed and newly untracked bytes and exercises foreign primary/Scope, physical replacement, Home roots/ancestors/unrelated subtrees, ordinary metadata revision, cancellation and binding-generation change. The three native target cases cover original preparation and rejection without publication. Harness and Local Runtime typechecks and owned lint/format checks pass; these are owning-layer tests rather than full second-target acceptance.

A separate three-party HTTPS/WSS regression completes both transfers through production dispatch and inspection, with explicit target consent on each leg. It verifies current dirty, untracked and ignored bytes, preserved source directories, the same Session at epoch three and full message/actor/Part identity. The lower Core regression also covers removed, added and reordered messages and cold destination reopening. See [destination ordering](2026-11-13-invalidate-destination-message-order-after-transfer.md).
