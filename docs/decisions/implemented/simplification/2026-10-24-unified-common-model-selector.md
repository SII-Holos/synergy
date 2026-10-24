# Decision Record: One common-model list with complete catalog access

Status: implemented

## Problem

Recent selections, quick-switch recommendations and the complete provider catalog repeat the same model in one selector. They consume the available menu height without offering different selection actions. Removing shortcuts must not hide available models, and identical model IDs from different service accounts must remain independently selectable.

## Decision

The existing session popover and keyboard dialog share one selector. Its default Common models list merges recent selections in recency order with additional quick-access models in name order. The pure catalog projection resolves these entries against the selectable catalog and deduplicates only exact provider/model ID pairs. Tuple serialization gives recent-history writes, row selection, recommendations and preference resolution the same unambiguous identity, including IDs containing delimiters. Recent records are independent identity values, so changing a new-session draft cannot mutate a historical entry through a shared object.

Browse all models replaces the common list with the complete provider-grouped catalog, with a return action. Search uses that complete catalog from either view and displays one row per provider/model pair with its account label. Clearing search restores the preceding browsing view without replacing the search input. An empty common list opens the complete catalog directly.

The shared List exposes an optional search-change notification for typing and clearing. The selector opts out of Tab-to-select so native Tab navigation reaches the catalog action; other lists retain their default shortcut. List retains ownership of input, fuzzy filtering, scrolling and keyboard selection; the App owns only the catalog projection and temporary browsing state. Existing recent history, quick-switch configuration, catalog eligibility, loading and session-owned model selection retain their current owners. No new persisted list, migration, server request or settings store is introduced.

This replaces the repeated priority sections in the [archived complete-selection decision](../../archived/bug-fix/2026-10-22-complete-session-model-selection.md), while preserving its complete-catalog and account-identity guarantees. The [Web product contract](../../../../apps/web/PRODUCT.md) owns the interaction rules.

## Alternatives considered

**Rename Quick switch to Favorites.** Recommendations are not explicit favorites, and renaming leaves repeated model rows in place.

**Remove shortcuts or use only shortcuts.** Removing shortcuts discards useful preferences; restricting the selector to shortcuts hides valid models and prevents full-catalog search.

**Keep separate Recent and Common tabs.** This hides the duplication behind another navigation step rather than combining entries that perform the same selection action.

## Consequences

The default menu contains one copy of each common provider/model pair and retains independently selectable same-name accounts. Browsing an uncommon model costs one additional action, while searching it remains immediate. Existing catalog and browser suites replace repeated-section assertions with merge ordering, account isolation, browse/return, full-catalog search, empty-common fallback, late catalog updates and shared search notification coverage. A real LocalProvider fixture also verifies that recent-history writes and quick-preference membership use the same tuple identity, rather than relying on already-correct downstream test data.
