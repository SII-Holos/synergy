# Decision Record: Timeline guard value snapshot for disposed-owner re-evaluation

Status: implemented

## Problem

Session switching could crash the Web renderer with `k(...) is not a function`. The signature is a Solid runtime TypeError: a non-keyed `<Switch>/<Match>` guard memo is re-evaluated after its responsive owner was disposed (the previous turn unmounted mid-switch), the memo accessor returns `undefined`, and Solid's `untrack(switchFunc)()` path calls it as a function. This is a different mechanism from the store-intermediate-state `reading 'find'/'filter'` crashes (covered by the session data view layer): the disposed accessor re-evaluation has nothing to do with data availability, so empty-safe data accessors cannot prevent it.

Two prior fixes chased this exact signature:

- `014be8f7b` made every timeline `Match` keyed and wrapped `TimelineDisplay` in an `ErrorBoundary`, eliminating the crash path.
- `57f8da845` reverted the keyed branches because streaming reconcile replaces display-item references on every tick, so keyed-by-item branches remounted the whole subtree per tick, resetting `CompactReasoningLine` scroll state, tool-card expansion, and Markdown state. The `ErrorBoundary` was kept so stale reads degrade to a local error card.

The remaining gap: the `ErrorBoundary` only wrapped the timeline item (`TimelineDisplay`); `SessionTurn`'s own guards (`shellModePart`, `specialUserMessageRenderer`, the `item()`/`boundary()` `Show` chain) were uncovered, so any residual disposed-owner re-evaluation there took down the whole page.

## Decision

Rewrite the timeline item dispatch around a **guard value snapshot** and move the `ErrorBoundary` up to the `SessionTurn` root:

- `TimelineDisplayInner` resolves its item through a single `parseTimelineDisplayItem` memo that returns a discriminated snapshot `{ kind, ...payload }` (kind string + already-destructured values). The seven per-branch guard memos collapse into one parser.
- Each `<Match>` becomes `keyed` on the **stable kind string** (`parsedKind() === "activity-group" ? "activity-group" : undefined`). Streaming ticks replace the item reference but keep the kind string stable, so the keyed branch does not remount — restoring the `57f8da845` non-keyed streaming behavior — while a genuine kind change (reasoning promotion/collapse, activity display mode switch) remounts the branch, which is semantically correct.
- Branch children receive the kind value and read the payload through a guard that short-circuits on `undefined` (`if (!p || p.kind !== kind || p.kind !== "…") return undefined`). A disposed owner turns `parsed()` into `undefined`, the `when` guard no longer matches, and no code path calls a destroyed accessor — the crash mechanism is removed at the source, not caught downstream.
- `SessionTurn`'s root return is wrapped in an `ErrorBoundary` whose fallback renders a turn-level `ErrorCard` (`data-slot="session-turn-error"`, localized via `SESSION_TURN_DESC.renderError`). The existing `TimelineDisplay` item-level `ErrorBoundary` stays as the inner defense layer. Guards that were previously uncovered (`shellModePart`, `specialUserMessageRenderer`, the `item()`/`boundary()` `Show` chain) now degrade to a local turn-level card instead of taking down the page.

Coverage: `session-turn-dispose-guard.dom.test.ts` mounts real Solid bundles in JSDOM and asserts (a) streaming ticks keep the inner node identity while content updates, (b) kind flips switch branches without an uncaught error, and (c) disposing the owner and then ticking surfaces no window error. The existing `session-turn-timeline-boundary.test.ts` identity and stale-read-after-dispose cases stay green.

## Alternatives considered

- **Restore fully keyed `Match` branches (the `014be8f7b` approach)** — rejected: `57f8da845` proved streaming reconcile remounts per tick, resetting scroll/expansion/Markdown state. Keying on the kind string instead of the item reference remounts only on genuine kind changes, keeping streaming stability.
- **Only move the `ErrorBoundary` up, without the guard snapshot** — rejected: a turn-level error card is still a visible functional failure (the whole turn disappears). Snapshotting removes the crash source; the boundary is the last-resort net, not the fix.
- **Rely on the session data view layer alone** — rejected: the view layer makes store reads empty-safe, but a disposed memo accessor re-evaluating to `undefined` is independent of data; the two mechanisms are complementary and both are required for the full fix.
- **Conversation-tree keyed rebuild** — rejected by the user: it breaks the row-level getter leak-prevention architecture and drops scroll state, and it only fixes the known crash while new components would still hit the disposed-guard trap.
- **Optional-chaining every accessor consumption** — rejected: point-fixing each call site leaves the mechanism intact and every future branch would re-introduce the bug.

## Consequences

- The `k(...) is not a function` class of crashes is eliminated at the source: disposed guards degrade to no-match/undefined rendering, and any residual renderer failure in `SessionTurn` is contained by the root `ErrorBoundary` as a localized error card.
- Streaming behavior is preserved: kind-keyed branches do not remount per tick, so `CompactReasoningLine` scroll state, tool-card expansion, and Markdown state survive streaming, verified by the identity assertions in both DOM tests.
- The parser memo adds a small indirection per timeline item; the payload is destructured once per item reference change, which is the same work the seven guards did collectively.
- The `develop-frontend` skill now documents the invariant: render-layer `<Switch>/<Match>/<Show>` guards must use stable value keys (kind strings) or short-circuit on undefined, must not re-evaluate accessors without a guard, and subtrees whose owner may be disposed must degrade explicitly (boundary or empty render).
