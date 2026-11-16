# Shared transcript windows losing earlier versions

## Executive summary

A fixed transcript watermark was applied after loading each object's latest projection. Updating a message or part after the initial page therefore removed that object from later pages at the earlier watermark. The regression was reproduced locally before the correction; no production loss was established.

## Summary

Immutable event history retained the original content, but chronological windows indexed only current objects and removed tombstones from their indexes. The latest projection cannot answer an earlier snapshot. Interactive history also needs current page contents without retaining every cold object's update in frontend memory.

## Timeline

Browser review identified the fixed-watermark gap. A real service fixture loaded the first page, updated an older message and part, removed another message and part, then read the remaining pages. It reproduced the missing message. A mounted HTTP check separately exposed that numeric watermark query strings were rejected. Both checks passed after correction, including restart from the prior preparation format.

## Root cause

Filtering a current projection by sequence discards an object whose latest update is newer than the requested watermark. Removing its index entry also destroys the route to its earlier version. A frontend replay cursor cannot repair unloaded history without retaining an unbounded set of cold objects.

## Guardrails

Shared windows retain version references into the immutable event log and chronological index entries for tombstones. Each page resolves the last version at or before its watermark. Preparation upgrades in bounded batches under the owning generation, independently of old completed preparation markers.

The explicit `latest` query rebases only a validated cursor's watermark to the current observation. It preserves root, source, generation, kind and position. Clients merge page entities by their own sequence and keep the global replay cursor independent of page observations.

- [x] Machine check: `packages/organization/test/shared-windows.test.ts` verifies earlier versions, tombstones, live rebasing, mounted query parsing and preparation upgrade after restart.

## Lessons

A current projection is not an as-of snapshot. Page freshness and replay progress are distinct observations; a storage index must support the contract exposed by its cursor.
