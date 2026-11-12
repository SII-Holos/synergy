# Portable child listing skipped prefix siblings

## Executive summary

Portable Workspace browsing omitted files whose names sorted between a directory and its descendant prefix. A real `a`, `a.txt`, `a/x` tree returned only `a` at the root. The canonical iterator now delays its subtree seek until it actually encounters a descendant and supports a fixed exclusive direct-child cursor.

## Summary

The metadata reader avoided scanning large subtrees by seeking to a directory prefix's upper bound. It applied that optimization as soon as the directory itself was returned. The directory identity and its slash prefix have different lower bounds: `a.txt` follows `a` but precedes `a/`. No content was corrupt; the child listing omitted a valid indexed identity.

## Timeline

1. The remote file-list integration identified the canonical iterator's immediate `a0` lower bound after directory `a`.
2. An isolated real portable graph with directory `a`, file `a.txt` and nested file `a/x` reproduced the omission: the expected root children were `a`, `a.txt`, while the actual result contained only `a`.
3. The canonical iterator moved its subtree seek to the point where an actual descendant is encountered. The same fixture passed without fetching file bodies.
4. Direct-child `after` cursors were added through the existing Workspace reader. Late-page tests observed bounded descriptor decoding rather than a replay of earlier children, and both paged and legacy callback tests retained their original lifetime restrictions.

## Root cause

The implementation treated a directory identity as the start of the interval occupied by its descendants. Binary string order places valid neighboring names inside the larger interval between that identity and the descendant prefix's upper bound. Existing tests covered `a0` at the upper bound but omitted the `a.txt` interval before the slash.

## Guardrails

- [x] Machine check: `packages/harness/test/workspace/portable-tree.test.ts` preserves `a.txt` beside `a` and `a/x` and crosses multi-page descendants without body reads.
- [x] Machine check: late cursors decode only the required indexed descriptors, capture mutable options before iteration and reject positions outside the requested direct-child set.
- [x] Machine check: paged and legacy `WorkspaceContent` callbacks forward the cursor and reject escaped iterators after their original callback ends.

## Lessons

Test both sides of a prefix seek, including valid names between a parent identity and its separator. Preserve one canonical indexed reader and keep pagination positions separate from authority. See [portable child seeks](../decisions/implemented/bug-fix/2026-11-12-seek-portable-children-without-skipping-siblings.md).
