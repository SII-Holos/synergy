# Decision Record: Show active project name in the session top bar

Status: implemented

## Problem

The desktop session top bar prefixed the model and variant selectors with a bare folder icon (`workspace.main`) and a `/` separator. The icon signaled "project session" without naming the project, so users switching between projects could not tell from the session chrome which project they were working in.

## Decision

The desktop (md+ and wider) session top bar shows the active project's name in place of the folder icon, followed by the `/` separator and the model and variant selectors. For non-Home sessions the name comes from `resolveProjectScope(directory, activeScope, scopes)` in `packages/app/src/utils/scope.ts`: the pure function matches a known scope by sandbox directory first (so a session under a registered sandbox names its parent project, matching the existing `layout` `roots()` and mobile-drawer mappings), then trusts the active Scope resolved by the sync store (`sync.scope`, keyed by scopeID) only when its worktree or sandboxes actually cover the route directory, and finally falls back to an exact worktree match in `layout.scopes.list()`. The displayed label reuses the existing `getScopeLabel` rules — the scope's custom `name`, else the directory basename, else `"Project"` — with long names ellipsizing and the actual route directory exposed through a Tooltip. The label is read-only: it has no navigation or selection interaction. Home sessions keep no project prefix (also when the route carries no directory at all), and the mobile layout is unchanged.

## Alternatives considered

- **Folder icon and project name side by side** — rejected: the name already carries the identity, and the extra icon-only glyph would consume top-bar width and duplicate the sidebar's `workspace.main` token without adding information.
- **A dedicated top-bar naming field or API for the project label** — rejected: project identity already lives on the Scope (`name` with a directory fallback); a new field would fork the naming source, require backend or SDK churn, and still need the same basename fallback.
- **A clickable project switcher in the top bar** — rejected: the label is identity chrome, not navigation; project switching already has the sidebar and Project Scope routes, and a second clickable surface would conflict with keeping navigation mentally aligned with where it lives.
- **Showing the project name on mobile as well** — rejected: the narrow mobile layout reserves the center slot for the model selector and gets project context from the drawer; a prefix would crowd the bar without earning the space.
- **Making the status bar the primary project identity** — rejected: the status bar carries runtime and workspace state signals, while the top bar is the first place a user looks when entering a session; placing the name beside the model selector answers "which project am I in" without scanning the status bar.

## Consequences

- The desktop session top bar names the active project, giving users a stable in-chrome answer to which project a session belongs to across project switches.
- The label reuses the existing `getScopeLabel` rules, keeping custom scope names, directory basenames, and the `"Project"` fallback consistent with the rest of the product.
- Long names ellipsize and the full path is available through a Tooltip, so the top bar stays compact.
- The label is read-only: no navigation or selection interaction was added, and the mobile layout is unchanged.
- No backend, SDK, OpenAPI, or migration changes; the `workspace.main` semantic token remains in use by the sidebar.
