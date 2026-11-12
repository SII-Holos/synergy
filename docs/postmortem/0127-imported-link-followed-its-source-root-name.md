# Imported link followed its source root name

## Summary

An incoming tree passed source containment validation, but an unchanged link target could refer outside the destination after the importer renamed its root. Source validity alone did not prove that relocation preserved the selected import range.

## Timeline

1. A validated tree contained `entry/link` with literal target `../entry/file`.
2. Importing it as `destination` returned that same target, which resolves to `entry/file` outside `destination`.
3. A behavioral test reproduced the incorrect acceptance.
4. Shared header relocation now checks both locations and rejects the unsupported target without rewriting it. Legacy imports delegate to the same rule.

## Root cause

Containment was tested before changing the entry root. The importer assumed that preserving relative text necessarily preserved its meaning under a new root name.

## Guardrails

- [x] Machine check: `packages/harness/test/workspace/tree-import.test.ts` rejects root-dependent links after relocation and preserves safe literal relative links.
- [x] Machine check: the same test compares legacy entries with paged headers and rejects foreign prefixes and destination traversal.
- [x] Owning operation: canonical `WorkspaceTree.importHeader` provides one relocation rule without copying body chunk arrays.

## Lessons

Validate link containment in the destination namespace after every path mapping. Reject a changed meaning rather than silently altering captured bytes. The [decision](../decisions/implemented/bug-fix/2026-11-12-confine-imported-links-after-root-relocation.md) records the shared import rule.
