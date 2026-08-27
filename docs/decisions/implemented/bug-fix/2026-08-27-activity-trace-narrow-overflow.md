# Decision Record: Truncate activity trace titles in narrow containers

Status: implemented

## Problem

Activity trace rows (`activity-trace.tsx` / `activity-trace.css`) rendered step and receipt titles with `flex: 0 0 auto` and no min-width/overflow constraints, so long titles (e.g. "Delegated Call subagent Add synergy-config pointer rows and strengthen three repo dev skills") pushed past the message column width when the window or conversation column was compressed, overflowing past the dialog/composer column edge.

## Decision

Make the variable-width title slots shrinkable and ellipsized: `[data-slot="activity-step-title"]` and `[data-slot="activity-receipt-title"]` now use `flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap`. Fixed slots (family label, state label, icons) remain `flex: 0 0 auto`; the subtitle slot keeps its shrink constraints but now shares proportional shrink with the title instead of absorbing all of it (the title used to be `0 0 auto`). Because truncation hides information, both title spans also carry a native `title` attribute holding the full localized text so the complete title stays reachable on hover — the expand path cannot provide this: expanding a step renders `ToolResultBody resultOnly`, which skips the trigger/title entirely, and non-specialized receipts (including `delegate`) have no expandable detail at all.

## Alternatives considered

**Wrap titles instead of truncating.** Rejected: wrapping makes rows variable-height mid-stream and reflows the whole list when a long title lands; truncation keeps the trace visually stable, and the full title remains reachable through the `title` attribute on each truncated span. The expand/`Collapsible` path cannot stand in for this: expanding a step renders only the tool result body, and most receipts — including delegated calls — have no expandable detail.

**Wrap the truncated spans in the shared `Tooltip` component.** Rejected: `Tooltip` renders a `div` trigger wrapper, which is invalid nesting inside the `<button>` trigger rows, and costs a portal per trace row; the native `title` attribute gives hover reachability with no DOM or nesting cost.

**Truncate in the data layer (`displayIdentifier`-style shortening).** Rejected: shortening text server-side hides information and is already done only for badge identifiers; layout-level truncation keeps the full value in the DOM and in copy/paste.

**Apply `min-width: 0` only on the parent copy container.** Rejected as insufficient: flex children of a min-width:0 container still need their own shrink allowed; the title spans themselves had to opt in with `flex: 0 1 auto` plus overflow rules.

## Consequences

Narrow windows now keep every activity row inside the trace container (verified by `activity-trace-narrow.browser.test.ts` at 440 px with a long title: `titleRight <= traceRight && scrollWidth > clientWidth`). Both title spans carry the full title in a native `title` attribute (pinned by `activity-trace.dom.test.ts`), so truncated text stays reachable on hover; the subtitle now shares shrink with the title rather than absorbing it alone. Rows keep their min-height, hover, and expanded-detail behavior. Content is ellipsized per row rather than wrapped, which is a deliberate visibility trade-off for long delegated-call titles — the hover tooltip, expanded detail, and audit icons still surface full context.
