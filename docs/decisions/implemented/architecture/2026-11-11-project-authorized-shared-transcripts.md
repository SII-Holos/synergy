# Decision Record: Project-authorized shared transcripts

Status: implemented

## Problem

Organization synchronization exports bounded summaries and tool lifecycle metadata. A project conversation cannot reconstruct its actual dialogue from those summaries. Capturing only future events also omits history when sharing starts after a Runtime restart, and deleting a pending draft by identifier after acknowledgement can lose a newer update to the same part.

## Decision

Explicitly shared Sessions publish strict portable message and part projections. Text, reasoning and tool input/output retain content independently of summaries. Large text uses immutable, authenticated blob references. The projection selects public fields, masks registered credentials and omits arbitrary tool metadata, local attachment locations and permanent asset URLs. Private Session bodies remain Runtime-owned.

The canonical Session and Message owners remain authoritative. At each sharing generation, the Runtime backfills their current history before streaming updates. Retained projections support retries; an owner migration adds ordered draft and resumable root indexes. Batch construction preserves publication order and bounds both event count and encoded transport bytes. Repeated part updates coalesce while a projection is pending. Acknowledgements remove only draft versions whose content hashes match the transmitted versions.

The organization service keeps a derived current-object index beside its sequenced event history. Existing history prepares through a versioned, paged owner operation with authorization and transaction guards. Snapshot pages return a fixed replay watermark; replay after that watermark reconciles objects updated during pagination. Every page and blob read checks current project access and sharing generation. Blob responses stream bounded chunks and support byte ranges and request cancellation.

Handoff rebinding retains committed shared history and its sequence. The directory commit publishes a new authoritative root projection at the next sequence, binds subsequent writes to the destination epoch and leaves synchronization pending for the destination's baseline. Old drivers cannot publish through the new binding.

## Alternatives considered

**Use summaries as the shared conversation.** Summaries cannot preserve tool process, reasoning, corrections or complete dialogue and do not support ordinary conversation rendering.

**Copy the canonical Session database into the organization service.** This would create competing Session authority and expose private paths, owner records and unrelated runtime configuration.

**Load every retained projection and sort it for each generation.** Persistent ordering allows bounded pages and removes a fixed startup scan limit without requiring the whole transcript in memory.

## Consequences

Shared history becomes readable while execution stays with its original owners. Projections and immutable evidence add storage and require eventual generation-aware reclamation. Snapshot consumers must finish pagination and replay from the returned watermark; route existence alone does not establish frontend or end-to-end acceptance. Runtime handoff data transfer and activation retain their separate verification requirements.
