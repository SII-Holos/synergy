# Decision Record: Seek portable children without skipping siblings

Status: implemented

## Problem

The canonical portable Workspace child iterator sought to `a0` immediately after returning directory `a`. That is the upper bound of the descendant prefix `a/`, but a valid sibling such as `a.txt` sorts between `a` and `a/`. Browsing therefore omitted that sibling. Pagination also needed a direct indexed position rather than replaying earlier pages.

## Decision

The canonical iterator reads the next indexed identity after each returned child. It skips a descendant range only after encountering an actual descendant, seeking to the exclusive upper bound of that child's slash prefix. Siblings before that range remain visible. The existing portability codec and private disk index remain the only metadata representation.

`children(directory, {after})` accepts the complete canonical path of a direct child as its exclusive position. It validates the directory relationship and captures the position when called, before deferred iteration. The indexed reader starts at that position. Bounded legacy manifests use binary search over their existing sorted child index. Consumers stop the iterator after their requested window; the reader adds no aggregate entry quota.

`WorkspaceContent.withTree` forwards the position through its existing Runtime, Store, artifact, cancellation and callback guards. A cursor does not establish Workspace authority, a content revision or permission to read file bytes. Remote callers retain their own exact saved-head and catalog-revision checks.

## Alternatives considered

**Skip the whole directory range immediately.** The directory identity is not the beginning of its slash-prefixed descendants. This loses neighboring files.

**Filter every descendant or restart each page at the root.** Both make work grow with unrelated entries instead of the returned window. One indexed seek skips each encountered descendant range, while an exclusive cursor begins directly at the requested position.

**Add another directory decoder or inventory.** The canonical metadata index already contains the required ordering and immutable identities. Another representation would duplicate integrity and lifecycle rules.

## Consequences

Metadata lookup remains independent of file bodies and does not claim complete-content verification. Tests reproduce the missing `a.txt` beside `a` and `a/x`, cross a multi-page subtree, observe bounded metadata decoding for late positions, fix mutable query inputs, reject non-child cursors and retire both paged and legacy iterators at their original Workspace callback boundary.
