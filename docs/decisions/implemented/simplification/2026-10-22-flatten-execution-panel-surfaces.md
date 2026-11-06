# Decision Record: Flatten execution panel surfaces and drop the trajectory text label

Status: implemented

## Problem

The execution trajectory panel stacked borders inside borders. Each column carried an outer card border, and the search field and each evidence block inside it carried a second full border, with the evidence header adding a third rule. A `1px` line therefore appeared at two or three nesting levels in the same column, which reads as heavy compared with Settings, where a card keeps one border and its contents rely on inset fill alone. The product anti-references already reject nested-card chrome and border-within-border shells.

The conversation header also paired the trajectory icon with a text label on wide layouts. The adjacent task-details action next to it is icon-only, so the header mixed a labeled button and an icon button for two sibling session actions.

## Decision

Each execution column keeps exactly one outer card border. Summary, search and evidence surfaces inside it are distinguished by inset fill and radius only; `.execution-search` and `.execution-evidence-block` no longer declare a border. The evidence header keeps its internal divider because it separates a header row from its body inside one surface rather than drawing a second container outline.

The header trajectory action renders its icon alone and uses the shared icon-button geometry, matching the sibling task-details trigger. Its accessible name and tooltip continue to carry the meaning the removed label provided, so the control stays identified for assistive technology. The orphaned `execution.trajectory.short` message leaves the catalogs.

## Alternatives considered

**Weaken the nested border color instead of removing it.** A lighter second line still draws a container boundary inside a container that already has one, so the stacking remains and only its contrast changes.

**Keep the outer borders and drop the card fills.** Without a fill the inner surfaces would then need their borders back to stay distinguishable, which returns to the same stacking.

**Keep the header label and make the task-details trigger labeled too.** That adds text to a second toolbar action rather than removing the one label that had no neighbor carrying text; the toolbar stays denser than its siblings elsewhere in the header.

## Consequences

Execution columns read as one card with quieter inner grouping, consistent with the Settings surface rules. Inner regions remain reachable and clickable; only their outlines changed. Removal of the header label is compensated by the existing accessible name and tooltip, so nothing becomes an unlabeled icon.

New execution surfaces added inside these columns should use inset fill rather than another border, and any future header action should follow the icon-button geometry of its neighbors. Rendered checks confirm the trajectory trigger keeps the same `32×32` box as the task-details trigger and that the inner regions compute to no border.
