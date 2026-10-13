# Decision Record: Task detail disclosure and navigation

Status: implemented

## Problem

The compact Task details surface previews rows on hover even though those rows already open a detail on activation. The extra overlay obscures a small reading area. Subtask inspectors cap related records inside a second scroller, leaving unused space below them. Reusing an open Task details tab also delivers a new target to a dashboard that only applies its initial navigation state.

## Decision

Compact Task details uses click and keyboard activation for disclosure. Workspace identity, status, metrics and task rows have no hover or native-title detail preview. Accessible descriptions preserve workspace and schedule metadata; row actions retain their independent hover, pressed and focus feedback. This supersedes the hover disclosures in [compact task details](2026-10-04-compact-task-details.md) while retaining its flat sections and bounded lists.

Subtask timing and related records flow inside one inspector body scroller. Related lists have no independent height cap, and the first section has no extra leading section margin. Bounded evidence readers retain their existing content budgets.

The retained dashboard consumes explicit node and round targets after mounting. Node targets open execution records; round targets select that round's overview. Persisted dashboard state identifies updates from the navigation owner and is not reapplied as an external target. Returning retains the existing overview selection and reading position; opening the panel without a target preserves its current view.

## Alternatives considered

**Keep shorter hover previews.** They still obscure adjacent rows and duplicate click disclosure in the compact surface.

**Increase the related-list height cap.** A larger fixed cap still wastes space in tall panels and introduces a second vertical reading position in short ones.

**Remount the complete dashboard for every target.** This discards its retained request selection, disclosure and scroll state. The existing record panel already handles reactive selection, so the dashboard forwards navigation to that owner.

## Consequences

Users activate a row to read its detail and scroll subtask records through the available inspector area. Workspace path copying remains a direct action; hover no longer reveals the path visually. Existing summary controls and accessible metadata remain available. Browser regressions cover pointer and keyboard disclosure, tall and narrow inspector geometry, repeated targets, target changes during inspection and return to the retained overview.
