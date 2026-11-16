# Decision Record: Preserve display projections during attachment index preparation

Status: implemented

## Problem

Preparing missing attachment metadata rewrites an existing Part display even when the canonical Part and its bounded summary have not changed. This loses display extensions and advances the generation again after an earlier control migration, breaking retry idempotence and cached manifest comparisons.

## Decision

The display owner compares the schema-known bounded summary with its current stored projection. An unchanged summary keeps the complete display row and generation while still maintaining the original search dirty owner. A changed or missing summary uses the original Part writer, merges retained extensions and advances generation once. Attachment metadata preparation uses this refresh operation in its original capture transaction.

Content hash equality alone does not prove summary equality. A stale attachment count with the same content hash is repaired, while unrelated stored fields remain intact. Canonical Part bytes and migration receipts retain their existing owners.

## Alternatives considered

**Omit display maintenance from attachment preparation.** Old bounded attachment counts and other known summary fields can remain stale despite an unchanged content hash.

**Replace every display unconditionally.** This discards extensions and repeats generation changes for metadata-only work.

**Prepopulate another migration receipt in the fixture.** That hides the cross-owner side effect and cannot protect real upgrades or interrupted receipt publication.

## Consequences

Cold attachment metadata rebuilding preserves current display and state exactly and still recreates search dirty metadata. Presentation upgrades repair stale known fields once, preserve extensions and remain stable on retry. Existing Blueprint HTTP, manifest, cached-result and interrupted-receipt assertions retain their exact generation and data checks.
