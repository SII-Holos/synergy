# Decision Record: Reveal the conversation column grip on demand

Status: implemented

## Problem

The transcript's column-resize grip painted a permanent three-pixel bar down the reading edge. It is a rarely used control sitting inside the text column, so it read as content: a stray mark next to paragraphs, present in every screenshot and every scroll position, while carrying no meaning for a reader who is not currently resizing.

The grip is also the only pointer affordance for a real capability — dragging changes the column width, and the width persists — so hiding it must not remove the ability to find it.

## Decision

The [application stylesheet](../../../../apps/web/src/index.css) keeps the grip element in place with its 16px pointer target, and fades only its painted pseudo-element: `opacity: 0` at rest, `opacity: 1` on `:hover`, `:active` and `:focus-visible`. `:active` keeps the bar visible for the whole drag, so releasing outside the handle does not make it vanish mid-gesture. The transition runs 150ms and is declared only inside `prefers-reduced-motion: no-preference`.

Two reveal paths exist beyond the pointer:

- `:focus-visible` covers keyboard users, who reach the separator through Tab and can size it with Arrow keys, Home and End.
- `@media (hover: none)` keeps the grip permanently visible, because a pointer that cannot hover can never trigger the reveal and would otherwise lose the affordance entirely.

The resting colour also changes from `--border-base` to `--border-strong-base`, because a bar that appears only on intent should arrive at readable weight rather than fading in at 14% alpha.

## Alternatives considered

**Hide the element with `display: none` or `visibility: hidden` and restore it on hover.** A hidden element cannot be hovered, so the reveal would depend on hovering a parent, and `visibility` would also remove it from the tab order — losing the keyboard path that the separator already supports.

**Shrink the bar to zero width at rest.** Animating width changes layout and would jitter the text column at the exact boundary being dragged. Opacity leaves geometry untouched at every step.

**Reveal only while dragging.** The user would have to find an invisible 16px target before any feedback appeared. Revealing on hover and on keyboard focus keeps discovery attached to intent rather than to an already-committed gesture.

**Keep the bar always visible but lighter.** That is close to the current state and does not address the complaint: the issue is a permanent mark inside the reading column, not its shade.

## Consequences

The reading edge is clean until the pointer arrives, and the grip stays discoverable for both pointer and keyboard users, including on hover-less devices.

The disclosure depends on the media query matching the device truthfully: a touch device that reports `hover: hover` would show nothing until tapped. Browsers report `hover: none` for touch-first input, and the grip also appears on `:active`, so a tap still reveals it.

`apps/web/test/components/session/workbench-layout.dom.test.tsx` asserts the whole contract: hidden at rest, visible after a real pointer move, hidden again when the pointer leaves, and visible after walking the actual Tab order — not programmatic focus, which does not set the keyboard modality and would make the assertion pass for the wrong reason.
