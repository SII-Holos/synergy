# Decision Record: Keep common models and the catalog in one continuous list

Status: implemented

## Problem

Separating common models and the complete catalog into Browse/Back views adds a navigation step to ordinary model selection. Prioritizing frequently used models should change their position, not hide the remaining choices behind another view. Search reachability does not replace direct browsing.

## Decision

The existing shared List owns one continuous scroll area. The Common models group comes first, preserving recent order and additional quick-access ordering. The remaining selectable provider/model pairs follow in provider groups, with common entries excluded from those groups so every pair appears once. Common and search rows retain account labels; provider headings identify the remaining rows. Narrow and coarse-pointer rows retain 44px touch targets.

Search filters the complete unique list without provider headings, and clearing it restores the common-first grouping without replacing the input. An empty common group leaves the full provider-grouped catalog directly available. There is no browsing-mode state or Browse/Back control. Existing recommendations, recent history, account identity and settings stores retain their owners.

This supersedes only the two-view browsing interaction in the [unified common-model selector](2026-10-24-unified-common-model-selector.md). Its tuple identity, common-list composition and preference semantics remain unchanged. The [Web product contract](../../../../apps/web/PRODUCT.md) defines the current selection flow.

## Alternatives considered

**Keep Browse/Back views.** Rejected because an available model remains hidden until an extra navigation action, interrupting continuous scanning.

**Repeat common entries under each provider.** Rejected because the repeated rows offer the same selection action and consume the menu height the common-list consolidation is intended to recover.

## Consequences

All unique selectable rows are mounted in the shared list rather than only the common subset. Native scrolling and keyboard navigation cross group boundaries without a separate route or mode. Real selector and dialog regressions cover wheel browsing, native Tab selection, search clearing, late catalogs, empty shortcuts, same-name accounts and Chinese touch layouts. The existing shared List remains the single scrolling and selection owner.
