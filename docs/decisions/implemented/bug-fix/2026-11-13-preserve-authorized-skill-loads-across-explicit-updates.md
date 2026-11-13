# Decision Record: Preserve authorized Skill loads across explicit updates

Status: implemented

## Problem

A Skill invocation selected and verified version one, then waited for permission. Applying version two during that wait caused the deferred read guard to compare the original entry with the newly desired collection and reject the already-started load. An ordinary version update had been treated as a permission revocation.

## Decision

A newly resolved Skill entry selects the current complete collection. Its deferred body and reference reads retain that original verified immutable manifest for the duration of the invocation. They obtain fresh accepted execution authority and reauthorize the original activated collection through the existing service owner before and after reading content.

The original staging verifier has a read-only retained-manifest mode. It requires the original local seal, compares the complete ordered immutable release stream with authenticated service pages, verifies the manifest digest and full cached files, and observes EOF. It prepares no replacement files, writes no seal or pointer, and cannot remove the retained manifest on failure. The immutable collection identity is its exact hash and release count; selection revision and updater remain update metadata. Ordinary collection preparation retains its full revision checks.

Another legitimate load may activate version two while the first waits. Revalidating version one neither replaces that active pointer nor requires the active pointer to move backward. A subsequent entry and model preparation use the newly applied version. Current publication withdrawal, project access and accepted execution authority continue to gate every read; retained files are not an authorization fallback.

## Alternatives considered

**Remove deferred guards after initial loading.** Rejected because current revocation and changed cached files must still reject later content reads.

**Synchronize the latest desired collection after permission.** Rejected because it invalidates an already selected entry and can mix two version boundaries within one invocation.

**Republish the old manifest as active before reading it.** Rejected because an overlapping load may already have legitimately activated a newer collection.

## Consequences

Explicit version updates preserve a complete authorized Skill invocation. Local immutable manifests and the existing activated-selection endpoint remain the owners; no new wire schema, phase ledger, key or permission is introduced. Revalidation continues to read complete authenticated manifests and cached files. The trusted test composition loader can receive the original retained header explicitly.

The signed-machine permission-barrier regression verifies an overlapping newer activation, exact loaded content/provenance, an unchanged newer active pointer and rejection after public withdrawal. Separate genuine Member-task and Hosted-creation fixtures verify model/tool update boundaries, exact raw provenance, original grant drainage, once-only creator inheritance and independent selection CAS. Model and business responses use deterministic upstream transports; this does not establish live provider quality or copied-data acceptance. See [PM-0178](../../../postmortem/0178-explicit-skill-updates-interrupted-an-authorized-load.md).
