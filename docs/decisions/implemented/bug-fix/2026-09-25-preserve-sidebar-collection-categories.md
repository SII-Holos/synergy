# Decision Record: Preserve sidebar collection categories

Status: implemented

## Problem

A Recent/Projects split puts Home, Channel and Background beneath Projects despite their independent ownership. Repeating the selected category above its list consumes navigation space, while a full-width tab strip with additional horizontal margins extends beyond the sidebar.

## Decision

The expanded desktop sidebar exposes Recent, Home, Channel, Background and Projects as five peer tabs below New, the registered global destinations and global tag search. Each tab renders its existing navigation projection and pagination. Channel providers and managed Projects retain their nested ownership; generic Projects retain their management actions. Recent keeps global unread acknowledgement without a second category heading. Global tag search keeps its canonical paginated request and clears back to the selected collection.

The tab strip uses the available inner width and five shrinkable grid columns. Long translated labels retain their full accessible name and native title while truncating visually when needed. Only collection entries scroll; the top controls and account stay fixed. This refines the desktop collection arrangement in [navigation, working location and browser recovery](2026-09-25-clarify-navigation-location-and-browser-recovery.md); its mobile, working-location and recovery decisions remain unchanged.

## Alternatives considered

**Keep Home, Channel and Background under Projects.** This preserves two short tab labels but assigns unrelated session categories to the wrong owner and makes them harder to find.

**Clip the overflowing strip.** Clipping hides the symptom while leaving controls or focus outlines outside their intended surface. Intrinsic sizing keeps the controls within the supported width range.

**Keep collapsible category headings under each tab.** A second category selector duplicates the active tab. Nested project and channel disclosures remain useful because they represent actual hierarchy.

## Consequences

The sidebar spends a small fixed area on five category choices and gives each one a direct entry. Browser regressions cover category ownership, keyboard selection, unique headings, tool order, fixed controls during scrolling, translated labels at 230/300/420 px, tag search, pagination and unread acknowledgement. Data loading and persistence retain their existing owners.
