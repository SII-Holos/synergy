# Decision Record: Mobile session rows share the desktop visual-state contract

Status: implemented

## Problem

Mobile navigation surfaces rendered session rows without the live and worktree identity that the desktop sidebar shows. The desktop sidebar derives every session row's leading glyph from `resolveSessionVisualState`, which maps runtime status (`busy`/`retry`), permission and question waits, git-worktree workspace identity, child-session identity, channel/background/GitHub categories, and BlueprintLoop roles to a semantic icon with a tone color, a pulse (spin) animation, and a localized accessible label. The mobile drawer's Recent list hardcoded the generic `session.default` icon for every row, so a running session looked idle, a waiting session showed no hourglass, and a git-worktree session showed no worktree glyph; the project drilldown list (`SessionRow`) showed a spinner while busy but nothing — not even the green worktree glyph — for an idle git-worktree session. Only the persisted completion dot survived, and the accessible state label was computed with `resolveSessionVisualState(undefined, entry)`, which never sees scope state, so it could only ever describe the category fallback.

## Decision

Every session navigation surface resolves visual state through the same `resolveSessionVisualState` path, fed by the scope store that owns the session.

- `MobileDrawerRecent` replaces its `unreadLabel` callback with a `visualFor` callback returning `{ visual, label }`. Each row renders `visual.icon` with a tone class derived from `visual.tone` (active/waiting/worktree/blueprint states map to the semantic icon tokens), applies `animate-spin` when `visual.pulse` is set, shows the completion dot from `visual.completionUnread`, and emits the localized `label` as screen-reader-only text when the state is meaningful.
- The drawer's Recent list (`mobile-drawer.tsx`) resolves each entry against its owning scope's store — `scopeKeyForNavEntry(entry, globalSync.data.scope)` then `globalSync.peekScopeState(scopeKey)` — instead of the previous store-less `undefined` call. The screen-reader label is surfaced for any state that is not a resting default (running, waiting, worktree, child, channel, background, GitHub, Blueprint, or an unread completion).
- `SessionRow`'s status dot shows the worktree glyph (`workspace.worktree`, success tone) for an otherwise-idle session whose `workspace.type` is `git_worktree`, ranking behind running/permission/error/notification indicators and ahead of the pin glyph, which stays for non-worktree pinned sessions.

## Alternatives considered

**Keep the drawer Recent rows on the static category icon and only color the completion dot.** Rejected: that is the status quo that made live and worktree sessions indistinguishable from idle ones on the most-used mobile surface; the desktop sidebar already had the full resolution and there was no reason for the drawer to reimplement a weaker subset.

**Duplicate the tone/pulse styling table inside each consumer instead of mapping from `SessionVisualState`.** Rejected: the tone-to-class map and the pulse animation live in one small place beside the shared resolver so future tone additions cannot silently skip the mobile Recent list; `SessionRow` and the desktop sidebar keep their existing local presentation because their row layouts differ.

**Drive `SessionRow`'s worktree glyph from a full `resolveSessionVisualState` call.** Rejected for now: the drilldown list already carries live/permission/error state through dedicated row affordances (spinner, warning dot, error dot), and its rows come from the REST page plus the scope store; adding the git-worktree identity to the status dot closes the reported gap without entangling the row's existing state ordering.

## Consequences

Mobile Recent rows and project drilldown rows now communicate the same live, waiting, worktree, child, channel, background, GitHub, and Blueprint identity as the desktop sidebar, with the same spin pulse for running sessions and the same success-tone worktree glyph. Screen-reader users hear the same state the icon shows. The drawer Recent list stays reactive to scope store updates because `visualFor` reads the same per-scope store the desktop sidebar consumes. Costs: one per-row memo in `MobileDrawerRecent`, and `SessionRow`'s status dot gains a `git_worktree` branch before the pin branch (a worktree session that is also pinned shows the worktree glyph, which matches the desktop sidebar's worktree-over-pin precedence). The `session.default` fallback still applies to genuinely idle ordinary sessions, so resting rows keep the quiet look.
