# Decision Record: Page explicit knowledge selection and active manifests

Status: implemented

## Problem

A complete applied collection cannot fit permanently into one request, response or stored JSON array. Splitting an update across independent pointer writes would expose a partially selected set and lose unrelated releases when a user changes one item. Model-boundary refreshes also need to avoid retaining a full material catalog in memory or duplicating the same manifest on every call.

## Decision

The service stores a bounded selection header over immutable ordinal reference rows and an exact item lookup index. Member/project and hosted Session pointers retain their distinct ownership. The central migration preserves the original ordered references, checksum and revision; it does not replace historical choices with current releases.

An explicit update begins with a stable request ID and copies the complete previous manifest into private staging. Each bounded page carries its sequence and exact changes, with a persisted request digest. A repeated page cannot increment its sequence twice or change accepted content. Commit checks the expected page sequence, reauthorizes every selected release and atomically compares and replaces one pointer with its immutable manifest. Current authorization also applies to inspecting or retrying a committed receipt.

The Web view queries references only for its visible catalog IDs, in windows of at most 100. Its durable change ledger retains the request ID, update ID, exact page, sequence and expected commit sequence. An unknown commit acknowledgement is inspected before an explicit retry. A single-item change preserves every unrelated reference in the server-staged complete collection. Whole-array HTTP methods are absent; fixture helpers may aggregate paged reads for assertions.

The Runtime stages and verifies releases a page at a time. Its active pointer contains only a summary and an immutable manifest identity; cached release rows and membership indexes remain in Storage. Exact content hashes reuse sealed manifests across repeated model boundaries. File downloads remain checksum-verified and preserve local edits. Pointer acknowledgement loss is reconciled through the canonical exact pointer before staging cleanup. Old active manifests remain available to readers already holding them. The central Runtime migration retains existing cached releases without moving their files.

Material context and search use bounded windows with explicit continuation. Skill parsing, conflict resolution and named loading continue through the canonical Skill owner. The complete Skill catalog retains that owner's existing discovery interface; this change does not claim a new streaming Skill resolver.

## Alternatives considered

**Raise the JSON body limit.** The next larger collection would encounter the same whole-array storage and memory growth.

**Patch the active pointer per page.** Interrupted updates would expose mixed versions.

**Have the browser resend the full selected collection.** A bounded catalog window cannot prove or preserve invisible selections.

## Consequences

Normal collections have no lifetime item quota. Each frame and metadata read has a finite window, while final checks still cover the complete selection. Real Storage and HTTP tests cover 1,001 published releases, exact retries, concurrent commits, revocation, withdrawal and rollback. Runtime tests stage 1,001 real empty material directories, preserve two Session Skill selections, upgrade retained state, reuse immutable seals and recover an actually committed pointer whose acknowledgement was lost. UI and Desktop tests cover paged selection flow and the exact route allowlist.
