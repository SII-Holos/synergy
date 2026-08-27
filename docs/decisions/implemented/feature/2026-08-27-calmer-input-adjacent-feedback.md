# Decision Record: Calmer feedback on input-adjacent surfaces

Status: implemented

## Problem

The prompt input area and the session transition card carried feedback density that read as "flickering" and "heavy" against the otherwise quiet workbench surfaces. Hovering the prompt shell lit up the whole container (background swap on `:hover`), every toolbar control had its own 150 ms hover transition, and the Worktree session transition card used modal language — 34 px header icon, 58 px step rows, 8 px radius, solid raised-stronger surface — in a place that sits inside the message flow, not as a modal.

## Decision

Keep container-level hover feedback off the prompt input shell: `.prompt-input-shell` no longer changes background on `:hover`; focus-within owns the visible frame (border + ring), and discrete interactive controls (toolbar buttons, chips, icon buttons) keep their own small hover affordance. With the hover rule gone, `background-color` was dropped from the shell's transition list — nothing changes the shell background anymore. The transition card now speaks the product card language: `workbench-card-bg` surface, 14 px radius (shared with dialogs/cards), 28 px header icon, 22 px step icons, 44 px step row min-height. The card surface moves from `surface-raised-stronger-non-alpha` (an opacity-guaranteed token shared with popovers) to `--workbench-card-bg`/`surface-raised-base`, matching the `session-inbox.css` inline-card precedent: custom themes may feed alpha through `surface-raised-base`, accepted because the card follows the inline card language rather than the popover opacity contract. No color tokens were added or changed; all values resolve through existing semantic tokens and `color-mix`.

Move and measure guards stay untouched: the card keeps its 44rem max width, step status grid, reduced-motion overrides, and lifecycle timings.

## Alternatives considered

**Remove hover feedback entirely from toolbar controls too.** Rejected: controls still need an affordance; only the container-level feedback was redundant. Tests pin the split: shell hover produces no change, control hover must still change.

**Scale down values further (24 px icons, 40 px rows, 12 px radius).** Rejected as over-tightening: 44 px row min-height keeps the existing touch/keyboard target comfortable, and 14 px matches the dialog contract already used elsewhere; smaller sizes would compress the kicker/title/detail stack the card needs.

**Keep the shell hover but slow the transition.** Rejected: the problem is the feedback happening at all on a container that has no action on hover; slowing it would still turn the whole box lighter each pass.

**Rewrite the card as a different component (reuse `card.css`).** Rejected: the card carries its own lifecycle, step list, and status semantics; reuse of surface tokens plus adjusted metrics gives the alignment with the product language without merging orthogonal behaviors.

## Consequences

Hovering across the input area no longer produces a whole-box light-up; the only shell-level feedback is focus. Toolbar controls remain individually discoverable. The generic `.workbench-input-surface` class still brightens on `:hover`/`:focus-within` by design, so non-composer inputs (e.g. the agenda view input) intentionally keep their hover feedback — the calm applies to the composer shell only, and this split is deliberate rather than an oversight. The transition card reads as a lightweight inline summary rather than a dialog, while retaining its existing radii, token usage, and behavior. Two new Playwright CSS-contract tests (`session-transition-card-style.test.ts`, `prompt-input-hover-style.test.ts`) pin these values; no snapshot or theme changes follow.
