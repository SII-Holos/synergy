# Decision Record: Complete session model selection

Status: implemented

## Problem

A session model selector must make every selectable model from an available provider discoverable. A shortcut preference cannot serve as the source of the provider catalog or the search index, because a model can be valid without being pinned or recently used.

## Decision

The session popover and keyboard dialog share one model-selection list. Recent and Quick switch are priority sections, followed by the complete selectable catalog grouped by provider. Each section has distinct row keys, shortcuts identify their provider, and a provider restriction applies to every section. Group identity uses the section and provider ID rather than the translated heading; ambiguous service-account names include their provider ID. The existing versioned catalog loader and model eligibility rules remain authoritative.

The shared List supports optional group labels and selection keys. Its row key remains the navigation identity; a model's provider/model identity determines selected markers across shortcut and catalog copies. Existing consumers retain their default grouping and row-key selection behavior.

Quick-switch preferences only control membership in the Quick switch section. Removing a shortcut does not remove the corresponding model from provider groups or search. Model settings explain that distinction.

## Alternatives considered

**Keep shortcuts as the entire selector.** This keeps the list short but makes valid models undiscoverable until users edit Settings, and searching cannot recover them.

**Replace shortcuts with only the complete catalog.** This restores discoverability but discards the user's useful quick-switch preferences. Separate priority sections preserve both intents without introducing a second picker mode.

## Consequences

Larger catalogs produce longer scrollable lists, and a model can appear in a shortcut section and its provider section. Search covers the complete selectable catalog; retained and deprecated models remain excluded from new selections. No server API, persisted preference format or session selection behavior changes.

The model-catalog tests cover complete provider groups, shortcut independence, stable row keys and provider restrictions. The existing browser availability suite renders the real list instead of a model-list stub and covers unpinned-model search, keyboard selection, late catalog publication and empty shortcut preferences alongside availability recovery.
