# Decision Record: Reuse existing Browser pages for message links

Status: implemented

## Problem

Clicking a message link should reveal its existing Workspace page without discarding reading or form state. Counting all same-document matches as ambiguous creates another page when duplicate tabs or different fragments already exist. Checking only the loaded Scope catalog and committed address also misses historical task pages, unloaded catalogs and a page navigating toward the requested target.

## Decision

The App resource opener searches only Browser tabs already present in the initiating task's right Workspace. Each tab supplies its owner route; missing catalogs load through the existing shared catalog service before matching. Catalog membership alone never imports another task's page.

Match active pages using normalized full URLs, preserving query parameters. A loading navigation supplies its requested URL instead of the previous document's address. Prefer exact matches over pages differing only by fragment. If the selected candidates share one login profile, reuse the active matching tab or the first match in tab order. Exact matches activate the existing tab without opening or navigating a native page; fragment changes retain explicit navigation. Multiple profiles remain ambiguous and use the ordinary new-page path, as does explicit new-tab intent.

Existing owner, capability, cancellation and selection checks apply after asynchronous catalog reads. The opener uses the matched catalog's route for fragment navigation. No API, persistence, native page lifecycle or profile identity changes are required. This refines Browser selection within [semantic message references](../feature/2026-10-16-semantic-message-references.md).

## Alternatives considered

**Create a page whenever more than one tab matches.** Rejected because duplicates then cause further duplicates, even when all candidates use the same profile and one matches the full URL.

**Search every page in the shared project catalog.** Rejected because a link click in one task should not import a page used only by another task.

**Match saved tab labels or ignore query parameters.** Rejected because presentation metadata may lag navigation, and different queries can identify different documents or operations. The canonical catalog supplies current page state.

## Consequences

Ordinary repeat clicks preserve the existing page and its native state. Same-profile duplicates resolve deterministically, while distinct profile identities and explicit new-tab actions retain separate pages. Restored tabs may require a metadata read before selection; newer task or tab choices cancel that pending selection. Redirect aliases beyond the current loading target and suspended-page recovery retain their existing behavior.

The rendered resource-opener suite covers exact-match precedence, duplicate selection, in-progress targets, owner-specific catalog loading, late replies, query/fragment behavior, new-tab intent and profile/task isolation. It retains existing preview, capability, cancellation and unknown-creation retry coverage.
