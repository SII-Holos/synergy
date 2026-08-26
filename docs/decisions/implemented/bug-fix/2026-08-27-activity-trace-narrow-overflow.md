# Decision Record: Truncate activity trace titles in narrow containers

Status: implemented

## Problem

Activity trace rows (`activity-trace.tsx` / `activity-trace.css`) rendered step and receipt titles with `flex: 0 0 auto` and no min-width/overflow constraints, so long titles (e.g. "Delegated Call subagent Add synergy-config pointer rows and strengthen three repo dev skills") pushed past the message column width when the window or conversation column was compressed, overflowing past the dialog/composer column edge.

## Decision

Make the variable-width title slots shrinkable and ellipsized: `[data-slot="activity-step-title"]` and `[data-slot="activity-receipt-title"]` now use `flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap`. Fixed slots (family label, state label, icons) remain `flex: 0 0 auto`; the subtitle slot already had shrink constraints and keeps them. No markup, data, or behavior changes — only the CSS layout rules.

## Alternatives considered

**Wrap titles instead of truncating.** Rejected: wrapping makes rows variable-height mid-stream and reflows the whole list when a long title lands; truncation keeps the trace visually stable, and the full title remains reachable through the existing expand/`Collapsible` behavior and the step subtitle.

**Truncate in the data layer (`displayIdentifier`-style shortening).** Rejected: shortening text server-side hides information and is already done only for badge identifiers; layout-level truncation keeps the full value in the DOM and in copy/paste.

**Apply `min-width: 0` only on the parent copy container.** Rejected as insufficient: flex children of a min-width:0 container still need their own shrink allowed; the title spans themselves had to opt in with `flex: 0 1 auto` plus overflow rules.

## Consequences

Narrow windows now keep every activity row inside the trace container (verified by `activity-trace-narrow.browser.test.ts` at 440 px with a long title: `titleRight <= traceRight && scrollWidth > clientWidth`). Rows keep their min-height, hover, and expanded-detail behavior. Content is ellipsized per row rather than wrapped, which is a deliberate visibility trade-off for long delegated-call titles — the expanded detail and audit icons still surface full context.
