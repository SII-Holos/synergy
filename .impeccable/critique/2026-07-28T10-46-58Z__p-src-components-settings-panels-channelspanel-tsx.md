---
timestamp: 2026-07-28T10-46-58Z
slug: p-src-components-settings-panels-channelspanel-tsx
---

# Channels settings critique

Target: `packages/app/src/components/settings/panels/ChannelsPanel.tsx` and its Clarus account surface in `BasicAccountToggleCard.tsx`.

Evidence: two independent assessments, deterministic detector output, the supplied desktop screenshot, source inspection, and a live narrow-width rendering of the local application.

## Executive assessment

The surface is not classic visual AI slop: its restrained palette, typography, and controls fit Synergy's quiet workbench. The problem is semantic composition. Account identity, runtime status, maintenance actions, and enablement were presented as peers in one wide trailing cluster. That made the switch appear to control “Download diagnostics,” left a large unresolved gap on desktop, and created a collision risk at narrow widths.

Pre-fix Nielsen score: **22/40 — acceptable, significant improvement needed.**

| Heuristic                           | Score | Finding                                                                                    |
| ----------------------------------- | ----: | ------------------------------------------------------------------------------------------ |
| Visibility of system status         |   2/4 | Runtime status existed as ordinary description text; pending actions only became disabled. |
| Match between system and real world |   3/4 | Actions were plainly named, but the Clarus description assumed domain knowledge.           |
| User control and freedom            |   3/4 | The toggle was reversible and the dialog had normal exits.                                 |
| Consistency and standards           |   2/4 | Status was not rendered as the specified compact badge; the switch had no label.           |
| Error prevention                    |   2/4 | Proximity made the switch look like a diagnostics option.                                  |
| Recognition rather than recall      |   2/4 | Users had to remember the section description to understand the switch.                    |
| Flexibility and efficiency          |   2/4 | Buttons were keyboard-reachable, but focus order elevated maintenance above configuration. |
| Aesthetic and minimalist design     |   2/4 | The surface was calm but spatially unresolved and over-carded.                             |
| Error recognition and recovery      |   2/4 | Errors appeared remotely and action progress lacked explicit text.                         |
| Help and documentation              |   2/4 | Disabling consequences and the role of diagnostics were not locally explained.             |

## Cognitive load

Three of eight checks failed, producing moderate load:

- Grouping: refresh, diagnostics, and enablement shared one `gap-2` cluster despite representing different tasks.
- Visual hierarchy: identity/status, routine refresh, support diagnostics, and the primary configuration control had equal weight.
- Working memory: the switch had no local label, so users had to recall “Clarus task execution” from the paragraph above.

The issue was not the number of choices; it was the lack of semantic grouping.

## Strengths

- “Refresh projects” and “Download diagnostics” were explicit native button actions.
- Async action state was scoped per account and per action.
- The runtime model already exposed useful states such as connected, waiting, syncing, failed, disconnected, and disabled.
- The visual register avoided gradients, decorative effects, and invented controls.

## Priority issues

### P1 — The switch was visually and programmatically unlabeled

It sat immediately after Download diagnostics and supplied neither visible label content nor an accessible name to the shared Switch. A screen reader could announce only an unnamed switch.

Recommended resolution: place enablement in its own group, display “Clarus task execution,” and give the switch an account-specific accessible label.

### P1 — Runtime status lacked compact status treatment

“Disabled” appeared as generic supporting copy under the account name, weakening scanability and conflating runtime state with the saved enablement preference.

Recommended resolution: display textual status as a compact badge beside the account identity and keep it separate from the switch.

### P2 — Maintenance action states were incomplete

Pending work only disabled the button, which can resemble unavailability rather than progress.

Recommended resolution: use explicit labels such as “Refreshing…” and “Preparing diagnostics…” with `aria-busy`, retaining existing error reporting.

### P2 — The row was spatially weak and narrow-width unsafe

The original `.ds-setting-row` and trailing action cluster did not wrap. Long localized labels plus two buttons and a switch could compress or overflow at narrow widths or high zoom.

Recommended resolution: use a two-part account card and stack identity, enablement, and maintenance at the existing 840px breakpoint.

### P2 — Copy described implementation rather than consequence

“Enable or disable Clarus task execution for Holos Agent accounts” was accurate but indirect.

Recommended resolution: explain the result: each Holos Agent account can receive and run Clarus tasks.

## Persona red flags

- Alex, power user: direct buttons were efficient, but Refresh → Diagnostics → unnamed switch gave maintenance actions higher priority than configuration and offered no explicit progress language.
- Jordan, first-time user: the nearest-label effect made the switch look like a diagnostics setting; “Disabled” did not clearly separate runtime status from configuration.
- Sam, accessibility-dependent user: the switch had no accessible name, the small control lacked a labeled hit target, status changes were not announced, and the fixed horizontal layout was risky at 200% zoom.

## Minor observations

- Feishu still uses nested subsection/card treatment, which makes the overall Channels page heavier than necessary.
- The fixed diagnostics filename does not identify the account or capture time.
- The old page description, “External messaging channel accounts,” undersold Clarus as a task channel.
- Download diagnostics had almost the same prominence as routine project refresh.

## Questions

- Should “Disabled” represent a saved preference, a live runtime state, or both?
- Are diagnostics common enough to remain permanently visible, or should they become a quieter support action later?
- What completion reassurance should project refresh provide beyond the refreshed runtime status?
