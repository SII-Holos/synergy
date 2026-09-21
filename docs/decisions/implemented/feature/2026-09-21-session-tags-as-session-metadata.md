# Decision Record: Session Tags as Session Metadata

Status: implemented

## Problem

A growing session history needs lightweight, user-controlled organization that survives restart and supports discovery. Labels, matching behavior, and persistence cannot vary between the Web UI and session lists without making the same tag unreliable across the product.

## Decision

Session tags are optional user-controlled arrays on `Session.Info`. The server validates the submitted array so persisted tags contain at most 20 items, with each item 1–40 characters after trimming.

Session creation trims each value and removes empty strings and exact duplicates before writing the array. The same trimmed, bounded array is used by the create, update, navigation, and list contracts.

Tags are stored without a leading `#`. The marker remains presentation syntax, so values such as `#focus` and `focus` do not create separate stored labels.

A session patch replaces the complete tags array rather than merging individual additions or removals. The client reads the current array, applies its complete change, and submits the authoritative replacement.

Tags remain embedded session metadata. There is no independent tag entity, catalog, rename operation, or delete operation. The Web UI creates a typed tag, selects or removes a tag, and derives available tags from the sessions already represented in the current view.

`/session`, `/session/index`, and `/global/session/recent` accept an exact tag value and apply membership filtering before cursor pagination in the navigation routes, so returned totals and pages describe the filtered result.

## Alternatives considered

- **Create a first-class Tag entity and catalog API.** Rejected because the required behavior is limited to attaching, detaching, displaying, and exactly filtering lightweight labels; an independent lifecycle would add storage, naming, and consistency semantics without enabling a distinct user workflow.
- **Store the `#` prefix as canonical text.** Rejected because it leaks display syntax into persistence and permits visually identical labels to diverge.
- **Merge partial tag updates.** Rejected because an array patch is clearer and composes cleanly with the existing session update contract, provided clients submit the full desired array.
- **Use substring, prefix, or fuzzy matching.** Rejected because exact membership makes filter results predictable and avoids unrelated sessions matching superficially similar labels.
- **Maintain a server-issued availability catalog.** Rejected because available tags can be derived directly from loaded session metadata, keeping tag selection consistent with the sessions the current view can actually offer.

## Consequences

Sessions can be organized with a bounded, normalized tag array without requiring users to manage a shared tag catalog or lifecycle.

Creation and update paths produce deterministic persistence, while exact matching keeps list and navigation behavior consistent.

Full-array replacement gives updates deterministic semantics, but editors must preserve the complete current tag list when changing one item.

A newly typed label is available immediately on that session, while broader tag discovery reflects only the sessions loaded into the current Web UI view.

Exact filtering keeps server-owned pagination semantics predictable and applies the membership test before cursor slicing in navigation routes.

Tag filters query the global navigation index before pagination, including history outside loaded sidebar pages. Query changes cancel outstanding requests, metadata events override older query responses, and reconnect reloads the selected filter. Tag menus retain failed input and serialize saves against the last accepted tag list. Repeated leading hash markers normalize idempotently, and generated tag arrays retain their string element type.

The reusable tag input schema has no default: an omitted PATCH field means no tag edit. Persisted session parsing and creation apply the empty-list default at their own boundaries, so marking a session read preserves both its tags and activity timestamp.
