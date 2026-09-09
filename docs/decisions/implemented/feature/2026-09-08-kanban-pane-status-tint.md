# Decision Record: Kanban pane headers tint by session status

Status: implemented

## Problem

The Kanban board shows many sessions at once, but each pane's header is a uniform neutral surface with only a small leading dot conveying state. On a multi-session board that dot is easy to miss, so "which sessions are still working, waiting on me, or finished" cannot be read at a glance — the board's whole purpose. Dark mode compounds this: the status `base` tokens (`surface-success-base`, `surface-warning-base`) are very dark in dark mode (near-black green/orange), so any attempt to fill the header with a raw status token would blur into the pane surface instead of distinguishing it.

## Decision

Kanban pane headers tint by the session's resolved visual state. The pane derives the status through the same resolution the sidebar rows use (`resolveSessionVisualState`) plus the raw session status, and maps it to one of three tints in `apps/web/src/components/kanban/model/head-status.ts`:

- **working** — warning-toned header: status `busy`, `retry`, or `recovering`, or the `active` / `blueprint-running` / pulsing `blueprint-audit` visual tones (a running Blueprint or child task).
- **waiting** — info-toned header: the `waiting` / `blueprint-waiting` tones (a permission or question is pending on the user). Waiting outranks working because it demands attention.
- **completed** — success-toned header: an idle session whose persisted completion notice is unread, reusing the exact same signal as the sidebar completion dot so "finished" never means different things in the two surfaces.

Working and waiting outrank completed when a session is both active and finished, so a pane that is running (and may have an unread result from a previous run) reads as what it is doing now. No other idle tone (worktree, child, channel, background, GitHub, Blueprint-parked) tints.

The CSS applies the tint as a single `color-mix(in srgb, var(--surface-*-strong) 16%, var(--surface-base-hover))` formula plus a matching status border tone. Using the `*-strong` seed (vivid `#f59e0b` / `#22c55e` / `#3b82f6`-family in both modes, unlike the dark `base` tokens) keeps the tint clearly visible in dark mode while a low mix percentage keeps light mode restrained; text stays on the neutral header tokens, so contrast is unchanged. The leading dot is re-tinted to follow the header semantic (`*-strong`) so the dot and bar never contradict the legacy per-tone dot colors (e.g. a green dot on an orange working header).

The change is confined to `apps/web`: a new model function plus tests, the pane header `data-status` attribute, and scoped CSS. No server, SDK, protocol, storage, or theme-token change was made — the status strong seeds and border tokens already exist.

## Alternatives considered

- **Raw status `base` tokens as header fill** — rejected: in dark mode `surface-success-base` is `#02220b` and `surface-warning-base` is `#291600`, both nearly indistinguishable from the pane surface; a real tint needs the vivid `strong` ramp.
- **Component-local light/dark palettes or literal colors** — rejected: the theme contract forbids consumer-local hue maps, and the color-mix-on-token formula already adapts to every theme and mode.
- **A new semantic "board status" token set** — rejected: the status role already exists in the token graph; adding tokens would duplicate semantics for a single consumer. The board reuses `surface-*-strong` and `border-*-*`.
- **Deriving "completed" from timestamps, activity, or coarse status** — rejected: PRODUCT.md and the sidebar completion-dot rule require persisted completion-notice state; timestamps would mislabel never-run sessions as finished.
- **Making the whole pane (not just the header) tint** — rejected: message streams and composers must stay on the neutral surface contract; the header is the read-at-a-glance chrome.

## Consequences

- A multi-session board now reads at a glance which sessions are working (orange), waiting on the user (blue), or finished with an unread result (green), with a single formula that stays legible in both light and dark modes and in every selectable theme.
- The status meaning is shared with the sidebar: the completed tint uses the same persisted completion-notice signal, and the working/waiting tints reuse the same visual-state resolution, so the two surfaces never disagree about what a session is doing.
- Cost: a new pure function and behavioral tests in the Kanban model, plus a `data-status` attribute and scoped CSS in the pane; the legacy per-tone dot colors remain defined but are overridden inside tinted headers, so the dot and the bar stay on one semantic. See the [board feature record](../../implemented/feature/2026-08-18-session-kanban.md) for the board's overall design.

Recovering Blueprint audit sessions retain the working tint even without an audit pulse; the raw recovery status takes precedence over an unread completion notice.
