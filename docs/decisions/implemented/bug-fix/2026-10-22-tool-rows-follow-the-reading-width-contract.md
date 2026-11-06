# Decision Record: Tool rows follow the reading-width contract

Status: implemented

## Problem

Widening the conversation column made tool steps drift inward while the summary row above them and the prose beside them stayed flush left. The drift grew with the column: measured against a real stylesheet, tool steps sat at 40px from the column edge at 940px wide, then 43px at 950, 68px at 1000, 168px at 1200 and 288px at 1440. The offset is exactly `(columnWidth - 80 - 864) / 2`, where 864px is 54rem.

The cause is a width contract applied to only part of the surface. [session-turn.css](../../../../packages/ui/src/components/session-turn.css) reads `--conversation-reading-max-width` for prose and reasoning, and the host sets that variable to `100%` on `.session-conversation-content` so the reading column follows the resized column. Three components kept the literal `54rem` cap with `margin-inline: auto`:

- [activity-trace.css](../../../../packages/ui/src/components/activity-trace.css), which paints every tool step and receipt
- [special-user-message.css](../../../../packages/ui/src/components/special-user-message.css), the guided-user bubble
- [turn-change-summary-panel.css](../../../../packages/ui/src/components/turn-change-summary-panel.css)

Below 944px — 864px of cap plus the 80px of horizontal padding — the cap never binds, so the surfaces agree and nothing looks wrong. That is why the default 800px column hid the defect. Above it, the capped rows form a second centered column inside the real one, and the extra width is split evenly into a left and right indent. The summary row and the reasoning row are not capped, which is why some rows indented and others did not.

`4ad8c504a` introduced the variable and migrated `session-turn.css`, but did not migrate the three files above, so the contract has been half-applied since then.

## Decision

All three components now read the same variable, with `54rem` retained as the fallback for hosts that never set it:

```css
max-width: min(var(--conversation-reading-max-width, 54rem), 100%);
```

The cap is not deleted. A host that does not opt into the contract still gets the compact reading width, which is the shared component's documented default; only hosts that set the variable — the built-in session layout — expand it.

## Alternatives considered

**Remove the cap entirely and let these rows fill.** That fixes the built-in layout but changes the component default for every other host, and it would make an unwrapped tool title stretch the full pane on wide displays. The variable already expresses "the host decides"; keeping the fallback preserves both behaviours.

**Set the variable only where the tool rows render.** The rows sit inside the host's reading column, so a local override would duplicate the host's width decision in three places and drift again on the next host change.

**Align the summary and reasoning rows down to the capped width instead.** That would make the whole surface consistently narrow, but it contradicts the resize feature itself: the user widened the column to read longer text, so the tool rows should follow the column rather than pin the column back to a fixed cap.

## Consequences

Tool steps, receipts, guided-user bubbles and change-summary panels now share one left edge with prose and summary rows at every column width; measured offsets are 40px at 940, 1000, 1200 and 1440. The compact default is unchanged for hosts that do not set the variable.

The failure was invisible below 944px, which is why it needed a width sweep rather than a visual check. [activity-flow-layout.browser.test.ts](../../../../packages/ui/test/components/activity-flow-layout.browser.test.ts) now asserts the shared left edge at 940, 1000, 1200 and 1440 with the host contract applied, so a future component that hard-codes a width cap fails on the wide widths instead of only showing up when a user drags.
