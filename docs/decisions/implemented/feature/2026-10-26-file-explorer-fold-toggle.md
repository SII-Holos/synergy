# Decision Record: File Explorer expand and collapse toggle

Status: implemented

## Problem

The Explorer header exposes only Collapse all through a downward chevron, which resembles a menu disclosure. Users cannot reopen all folders through the same control. Expanding only cached nodes would omit unread directories and later pages, while asynchronous expansion could undo a subsequent collapse.

## Decision

The header reuses Review's `review.fold` and `review.unfold` semantic icons with a localized accessible name and no tooltip. Any expanded folder or active expansion selects Collapse all; otherwise the action is Expand all. Expanded paths remain in the existing Workspace-generation-owned preference without a separate saved mode.

Explicit expansion traverses every directory page and nested directory under the current hidden/ignored policy through the existing loader and concurrency limit. It does not read file bodies or follow symbolic links. An unreadable directory keeps its retry state without stopping other branches. A generation fence stops traversal after collapse, manual folder changes, filter changes or context disposal. The Explorer's abort signal also fences work when its rendering owner is disposed. In-flight shared reads may finish populating the cache but cannot schedule more traversal or reopen folders after cancellation.

## Alternatives considered

**Change only the icon.** This removes the misleading chevron but leaves the requested inverse action unavailable.

**Expand cached directories only.** This is cheap but silently omits unread nested directories and continuation pages, so the button would not perform Expand all.

**Launch an unrestricted recursive read.** This bypasses existing request admission and can reopen folders after a newer user action. The existing directory loader already owns paging, errors and request sharing.

## Consequences

The same compact control supports both directions and remains available to stop an active expansion. Large trees require explicit directory enumeration and can retain more expanded state; the existing read concurrency and virtualized rows remain in use. Symbolic links stay available for manual inspection rather than bulk traversal. Browser regressions cover nested and paginated reads, cancellation, late responses, unreadable branches and the visible toolbar action.
