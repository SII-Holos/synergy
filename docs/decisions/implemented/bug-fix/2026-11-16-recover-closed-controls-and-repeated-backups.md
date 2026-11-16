# Decision Record: Recover closed controls and repeated organization backups

Status: implemented

## Problem

Ordinary organization histories include acknowledged controls, repeated command attempts, released execution generations and terminal handoffs. Restricting recovery to one task-input attempt and its latest completed grant rejects that retained history. After a successful recovery, a second backup also encounters a restored Home and commands signed before the first deployment rotation.

## Decision

Keep historical acknowledgement validation separate from execution admission. Fold every logical request through its exact first, latest and indexed attempts, original signatures and binding windows. Input modes and decision effects retain opaque payload hashes; Service recovery never reconstructs Native private input or decision bodies. Reconstructible control requests must match their original signed digest. Terminal rejected attempts retain their actual signed skip and reception evidence; unresolved work remains unresolved.

The execution-history owner validates original reception, roots, predecessor and successor provenance, retained-resource generations, releases and handoff closure. Enumerate actual immutable release rows and require their exact continuous generation roster; a latest receipt cannot stand for missing earlier releases. Gateway history uses each call's original released generation and requires response completion and matching usage. Completed and safely cancelled handoffs retain the existing transition, participant, resource-mapping and exact index owners. Historical facts do not authorize current calls or replace physical writer reconciliation.

Version-three recovery publication receipts retain the original public signing identity alongside the fresh identity. The current published identity anchors the complete backward chain, with exact organization, incarnation and key identities; conflicting, cyclic or missing evidence fails. Current live signing and authentication use only current authority. Legacy version-one and version-two receipts remain immutable and do not gain invented source keys. The central owning migration validates existing publication records without backfilling absent facts. Constructed legacy first-write fixtures exercise an actual committed publication with a lost acknowledgement, followed by a fresh public CLI process. The published-receipt retry validates and returns the original receipt without reentering its writer; exact raw bytes and row revision remain unchanged.

Native Service manifests version two preserve either the original fenced Home or a genuinely restored Home. Source preparation uses its version-two selection for a restored Home and binds its incarnation to the actual namespace; legacy version-one selections still require the original fenced Home. Read the completed native intent and verify its committed publication and released hold before using a restored Home as an ordinary source. Preserve its recovery reader, physical identity, original marker and exact source retirement tuple. Offline Member metadata can retain its original incarnation while required Hosted writers must match the current deployment.

## Alternatives considered

**Treat the narrow task-only history reader as the recovery specification.** That omits ordinary retained controls and repeated backups from the original requirement.

**Verify old signatures with the fresh key or copy private signing authority.** Public original identities in actual publication receipts establish historical verification without authorizing old credentials.

**Relabel a restored Home as the initial fenced format.** That discards installation and incarnation evidence and bypasses completion checks.

**Infer complete closure from the newest release or an empty live worker list.** Original generations, durable receipts and actual Native writer proofs have distinct owners.

## Consequences

Closed history and repeated backups reuse the existing command, handoff, release, publication and native recovery owners. Missing original keys or closure evidence blocks recovery. Restoration preserves original actors and records without replaying models, tools, pending decisions or old commands; a later execution still requires its separate explicit current admission. See [selected cloud history](2026-11-16-recover-selected-cloud-session-history.md), [the incident](../../../postmortem/0222-closed-control-history-and-restored-homes-blocked-backup.md) and the behavioral tests under the Organization and Organization Runtime packages.
