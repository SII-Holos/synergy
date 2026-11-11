# Decision Record: Retain exact Note document versions

Status: implemented

## Problem

Blueprint execution and review records refer to a Note version, but a current-only document store cannot prove that historical content after a later edit. Copying the latest document for an older version silently changes the work being handed off or audited.

## Decision

The Note owner retains immutable version records beside the current canonical document. Creation, content edits, owner metadata edits and archive changes capture the exact document in the same Storage transaction. Conflicting bytes under the same Scope, document and version are rejected. `NoteStore.getVersion` reads an exact Scope and version and retains the document-kind availability gate.

Handoff preparation seals only version references and content hashes, while the canonical Note version store owns bytes. Retention pins protect those versions until source cancellation or surrender. Authoring changes cannot change a sealed selection or its attachment dependencies. Stored snapshots use the base persisted schema and preserve nested opaque owner fields; the selected kind schema validates public semantics without rewriting those bytes.

The owning central migration captures only the version actually retained on disk. It does not invent overwritten versions. Historical references without evidence remain missing and must block lossless transfer until resolved explicitly. Deleting an archived private Note removes its private version history as well; independently published organization releases have their own lifecycle.

## Alternatives considered

**Substitute the current document.** This makes a historical version reference misleading and can change the material being audited.

**Create workflow-specific document copies.** This duplicates the Note authority and leaves content edits and owner metadata on different persistence paths.

**Claim a complete historical backfill.** Existing overwritten bytes are unavailable, so such a backfill would fabricate evidence.

## Consequences

Note mutations retain more content, with storage proportional to actual retained versions. The current document remains the authoring authority. Version records support exact immutable references while preserving unknown owner fields on disk; selected document kinds still govern public reads. Migration and deletion tests distinguish preserved evidence from unavailable history.
