# Decision Record: Keep project directory metadata outside whole-Session loading

Status: implemented

## Problem

Cold navigation to a project Session can replace the entire right pane with an empty surface even when its message window or captured submission is ready. New Worktree Sessions reliably take the cold path; main-directory and existing Sessions also reproduce it, including returns after resident-view eviction. A warm resident return does not reproduce it. The directory resource's first `latest` read has no initial snapshot, so it suspends the whole Session route, whose Suspense has an empty fallback. See the [incident follow-up](../../../postmortem/0051-session-switch-repeated-display-admission.md#follow-up-project-metadata-suspended-the-entire-cold-session-route).

## Decision

Keep the generated project-directory read and its existing client/Scope ownership. The page delegates that resource to `createProjectDirectoryResource`, which provides an explicit null initial snapshot and typed success/error results. Consumers continue reading `latest`; pending and failed metadata affect folder-dependent controls without suspending the toolbar, Composer or available conversation content. Refresh and mutation use the existing resource actions. Resident views keep their snapshots and DOM, and normal storage preparation, message loading and conversation viewport admission remain unchanged.

The focused DOM regression exercises the actual resource under Solid Suspense and RetainedSessionViews: cold and evicted views keep their shell/editor and captured content; warm return keeps the original editor and draft; failure, refresh and a late previous-owner reply stay local. A fast generated-SDK resource test covers inactive, pending, accepted, failed and mutated snapshots. Complete-page isolation checks separately hold directory, storage-preparation and timeline reads to establish which producer caused the blank surface.

## Alternatives considered

**A Worktree-only placeholder.** The same failure affects ordinary project Sessions and evicted views. Special-casing creation would leave the general cold-navigation defect intact.

**More optimistic messages.** Submission capture already happens before durable Session creation. Its ready content is hidden by the ancestor Suspense, not missing from the store.

**Replace the entire pane with a spinner or retain the old Session until directories return.** Optional folder metadata is not a prerequisite for a target's available transcript or editor. Blocking them on it adds latency and does not fix initial navigation.

**Remove all Suspense or bypass history preparation.** Other feature loaders still need local loading behavior, and canonical history/body preparation must retain its existing correctness rules. The fix belongs at the optional metadata resource.

**Add another global cache or loading registry.** No additional data owner is necessary. An explicit initial resource value solves the first-read suspension while preserving current freshness, error and owner semantics.

## Consequences

The same fix applies to new, cold and evicted project Sessions without changing navigation ownership or server APIs. Directory requests can still take time or fail, but cannot hide otherwise-ready content. The resource is extracted only to give its non-suspending behavior direct regression and coverage evidence. It does not claim that all historical loading is instantaneous, that every possible full-page fallback is removed, or that the user's live request latency has been measured. Native Desktop packaging and transcript motion remain separate acceptance surfaces.
