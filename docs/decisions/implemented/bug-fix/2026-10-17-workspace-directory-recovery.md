# Decision Record: Keep directory recovery actionable under large histories

Status: implemented

## Problem

An unavailable current directory sorted behind historical Worktrees. Adding its path again returned an existing unavailable record or an identity conflict without a usable next step. Management placed every affected task before the binding form, and confirmation joined all task titles into the shared dialog header. Large histories pushed the recovery controls and confirmation buttons outside the viewport.

## Decision

The chooser prioritizes the recovery, current and main directories. Unrelated Worktrees start collapsed but remain searchable. An unavailable local location exposes its reason and a recovery action; registration of an existing unavailable location opens the same explicit recovery form with the chosen path.

The form precedes a collapsed, bounded affected-task list. Its action stays in the footer. Confirmation identifies the destination and shared effect using a count instead of task titles. The shared confirmation dialog keeps its accessible description in a bounded body and its actions in the footer. Refresh list describes a metadata read, while only confirmed, revision-checked rebinding changes directory authority. Cancellation, owner changes and failures retain the existing binding protections.

## Alternatives considered

**Automatically rebind on registration or refresh.** Rejected because an existing path can contain replacement files. Recovering a catalog entry is not permission to redirect every Session that shares it.

**Only cap the chooser height.** Rejected because it leaves the failed location behind unrelated entries and the primary recovery action behind hundreds of task titles. Bounding the outer dialog also cannot rescue actions inside a nonshrinking description.

## Consequences

Recovery remains usable with large histories and short windows, while users explicitly choose whether all sharing Sessions should adopt a directory. Historical tasks and Worktrees remain available through disclosure and search. This changes presentation and error routing without a storage migration, new API, polling or conversation subscription. Browser regressions cover large catalogs, long confirmations, existing unavailable registration, cancellation, failure retry and expired recovery owners; real-storage Workspace tests retain identity, generation and busy-resource fences.
