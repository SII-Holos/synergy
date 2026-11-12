# Decision Record: Capture Hosted knowledge caches from fixed references

Status: implemented

## Problem

Hosted knowledge selection and file metadata live in canonical Storage, while verified material and Skill files live in private filesystem caches. Cached release rows retain absolute directories. Restoring namespace records alone leaves those rows pointing into the source Home; exporting only the latest selection loses older sealed releases and independently selected project versions. A segment's self-consistent counts cannot demonstrate that it covers every cache address in the parent namespace.

## Decision

The Runtime knowledge owner provides a separate native facet through `./backup/knowledge`. Capture requires the active checkpoint owner's opaque archive evidence, current frozen maintenance and the actual Hosted namespace identity. It consumes the canonical decrypted checkpoint parser to completion and indexes exact cache rows, active-manifest release references and file metadata in temporary SQLite tables. Release identity deduplicates files on disk without loading complete collections into memory. Current active headers must retain their complete ordered references, item indexes and immutable seals.

`KnowledgeCache` supplies the same path, manifest and file verification to ordinary cache reuse and native backup. Skill directory names use the canonical Skill manifest name validator; restore validates every declared cache name before preparing target files. Capture reads only directories selected by the fixed namespace, validates their canonical private location, complete file manifest and physical contents, and streams each verified file through canonical binary preparation. File readers observe original cancellation after the descriptor read and before yielding bytes. Extra files, edits, missing bytes and symlinks fail instead of being ignored or replaced. Empty files and collections beyond one metadata page retain the same format; no aggregate history or content quota is added.

The facet exports a typed Storage checkpoint bound to its exact source namespace. The service cohort receives it through a second explicit trusted Hosted port, reusing the same capture evidence as the Home facet and storing a separate `hostedKnowledge` manifest. The encrypted recovery container remains unchanged. The service neither parses Runtime knowledge records nor acquires private filesystem access through an account endpoint.

Restoration verifies the complete native inventory and byte references before exposing a callback-bound prepared result. It materializes exact immutable release files in the target Home, preserving verified existing directories and refusing conflicting contents. The owning relocation method first pages every canonical cache and active-manifest release address in the actual target write transaction and requires an exact match with the fixed inventory before changing any directory. It changes only captured `CachedRelease.directory` addresses, comparing each original or already relocated value. The canonical Store verifies that the transaction is its own currently active write callback at entry and after each awaited operation. Selection headers, release identities, versions, project separation and unknown unrelated records remain unchanged. Physical preparation occurs before SQL; relocation performs no filesystem IO. It supplies data preparation and an execution-independent assertion, not permission to continue a Session.

## Alternatives considered

**Copy the entire cache directory.** This can include unrelated or unfinished data and cannot demonstrate which files a fixed namespace requires.

**Download current versions during restore.** Current authorization or availability may differ, and the latest version can differ from the exact historical selection. Native cache closure must be independently readable without the source or service.

**Replace directory strings throughout the namespace.** Only the knowledge owner knows which paths are cache locations. Historical messages, project files and unrelated objects must retain their original meaning.

## Consequences

Backup includes retained cached versions referenced by both current and older manifests. It requires temporary index and streaming disk space and detects local cache edits before publication. Prepared target files are immutable recovery material; a failed SQL restore can retain unreferenced complete files for exact retry. Namespace checkpoint completeness remains separate from full deployment recovery, resource capture, new-incarnation activation, authorization review and reconciliation with old physical writers.

## Verification

`test/backup/knowledge.test.ts` uses a real HTTPS service and enrolled Hosted Home, then captures the service and Hosted namespace through the encrypted cohort. It restores 103 files and more than 128 cache addresses across old/current versions and two projects, including an empty file, removes the original cache and archive container, and reads Skills and knowledge metadata from an independent empty target Store. It verifies unchanged selection headers, exact old bytes, target-only directories, retained execution holds and expired/foreign-Store preparation assertions. Valid canonically reissued segments exercise an escaping wire Skill name and an omitted complete cache partition with internally consistent counts. The latter must fail against the full namespace and roll back imported references. A real foreign write transaction cannot receive relocation. Descriptor reads that synchronously abort must reject before their first yielded chunk. Other negative cases cover edited files, missing bytes, another source namespace, expired capture evidence and original cancellation. Existing `test/knowledge.test.ts` and `test/knowledge-execution.test.ts` preserve paged selection, immutable seals, edited-file protection and current signed authorization.
