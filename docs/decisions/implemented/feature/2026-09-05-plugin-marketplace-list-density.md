# Decision Record: Plugin marketplace list density — taller cards, pill metadata

Status: implemented

## Problem

Marketplace rows read as cramped: an 80px min-height with 14px padding left two-line descriptions nearly touching the card edges, the 8px gap between cards made consecutive rows read as one slab, and the metadata line packed author · tools · runtime · compatibility · updated into one dense dot-separated string at 11px. With several plugins installed, the list collapsed into a single dense block instead of scannable cards.

## Decision

Restyle the marketplace list (registry rows and installed rows alike) around a more generous card rhythm and a structured metadata layer, keeping each row's DOM contract (button → icon → main → status → arrow) and all message IDs unchanged:

- Row min-height rises 80px → 130px with 20px/22px padding and a 16px inter-card gap; radius grows 14px → 18px; skeleton rows and the empty-state card adopt the same height and radius so loading states do not jump.
- The plugin icon grows 42px → 56px (16px radius) to stay proportional to the taller card.
- Row typography scales one step: title 14px → 15px, description 12px → 13px with the 2-line clamp retained.
- Metadata is restructured from dot-separated plain text into rounded pill chips (inset background, 11px, weight 500). The aria-hidden `·` separators are removed from both row components; each metadata item is a plain span styled by `.plugin-marketplace-row-meta > span`.
- The installed/update status dot follows the larger padding (16px inset), and the ≤760px breakpoint drops to 16px/18px padding.

All colors still resolve through the existing workbench surface variables — no theme-token changes.

## Alternatives considered

**Variant A — light relaxation** (100px rows, 12px gap, unchanged type scale) was the smallest diff but kept the dense metadata string and the 12px description; it read as "slightly less crowded" rather than fixed.

**Variant B — comfortable cards** (122px rows, 14px gap, +1px type scale, plain-text metadata) matched the chosen variant's airiness without touching row structure, but the dot-separated metadata string — the main crowding complaint — remained.

**Variant C (chosen) — information layering**: B's dimensions plus pill-ified metadata. It costs the most vertical space per card and slightly more per-card visual noise, accepted for scanability.

## Consequences

- Fewer cards fit per viewport; scrolling rather than density becomes the primary browsing mode. Accepted — the marketplace is a browsing surface, not a dense management table.
- Metadata styling is centralized in one selector (`.plugin-marketplace-row-meta > span`); future metadata items must be plain spans to inherit the pill style.
- No behavior, data, i18n, or routing change: same message IDs, same click targets, same mobile behavior (status column stays hidden ≤760px).
