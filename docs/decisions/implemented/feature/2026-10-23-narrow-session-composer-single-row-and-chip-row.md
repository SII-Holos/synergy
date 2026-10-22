# Decision Record: Keep every Composer capability on a narrow viewport without a second toolbar row

Status: implemented

## Problem

At 375×812 the Composer card measured 343×241 pixels and exposed ten visible controls. The toolbar wrapped into two rows worth 110 pixels, because both `.prompt-input-toolbar` and its main group are `flex-wrap: wrap` and the project, agent and permission controls plus the three trailing actions cannot share 343 pixels. The work-context line added another 65 pixels as a bordered, rounded overlay. Together they left little conversation visible on the smallest supported width, which is the shape that matters most on a phone.

Reachability, not density, was the constraint: an agent and a permission mode are states a user must see before sending, so the fix could not be "move everything into the add menu".

## Decision

Below 768 pixels the card holds at most four controls — expand, add, voice and send. Agent, permission mode, workflow chips and the project/work context move into one horizontally scrolling line wrapped in `.composer-chips-row` above the editor. The toolbar and its main group stop wrapping and the toolbar padding tightens.

Prediction does not take a chip slot: it is assistance rather than send-time state, so it becomes an item in the add menu and its component mounts from the trailing slot without rendering a button of its own.

The resize separator keeps its pointer and keyboard gesture on touch. Its desktop hit area is 80×24, too small for a finger, so coarse pointers and narrow widths move the same control into the card's top control band at 44×44 beside the expand control. It carries `role="separator"` on a separator element rather than wrapping a button, which keeps the card's toolbar to its action controls.

`.composer-chips-row` is `display: contents` by default, so the desktop DOM gains a wrapper without changing layout, and only the narrow media query turns the same slot into a scrolling line. The project, agent, permission, prediction and workflow controls are extracted into named nodes inside the controller and rendered from both surfaces, so desktop and narrow layouts cannot drift apart. The `composer.above` plugin slot keeps its own rendering path.

Measured on an isolated instance at 375×812 after the change: the card content is 160 pixels (44 chip row plus 116 shell) against the 241-pixel baseline, four visible controls inside the shell, one toolbar row, a 44-pixel context line, no horizontal overflow (`scrollWidth == innerWidth == 375`), and all ten previous controls still reachable — the four on the card, four in the chip row and two through the corner and editor controls. The same page at 1440×900 keeps eight shell controls, its original 191-pixel card and an unrendered chip row.

## Alternatives considered

**Move agent, permission and prediction into the add menu.** It is the Tencent Yuanbao pattern and the cheapest way to reach four controls, but agent and permission are send-time state; hiding them costs one open-and-close before every send in a coding session. Only prediction, which is optional assistance rather than state, moved there.

**Shrink the controls instead of moving them.** Ten controls in 343 pixels needs roughly 20-pixel targets, which breaks the 44-pixel touch floor the project already enforces for this toolbar.

**Wrap the chip row into two lines.** Two wrapped lines recreate the height problem the change exists to remove, and horizontal scrolling keeps one row while leaving every chip reachable.

**Keep the resize grip and enlarge it on touch.** Two competing sizing actions on one card — a grip and a corner control — with the grip needing a 44-pixel hit area inside an already crowded row.

## Consequences

The desktop layout is unchanged by construction: the chip wrapper is `display: contents` at that width and every extracted control renders into its original container. Narrow layouts trade a second toolbar row for one scrolling line, so at 320 pixels the chip line scrolls rather than truncating or wrapping, and a user who wants the project or permission state swipes that line instead of reading the toolbar.

Prediction, workflow chips and the work context are now one swipe away rather than always visible; the composer's own state text still reports the active workflow. Card height, the single toolbar row, the 44-pixel touch floor, the drag-resize path and the desktop baseline are pinned by `apps/web/test/components/session/mobile-composer.dom.test.tsx`. That suite mounts the real `createPromptInputController` inside the real `DefaultComposer` and loads the real stylesheet in Chromium, so it asserts shipped components at 375, 320 and 1440 pixels rather than a copy of their markup: it counts the reachable card controls, opens every extracted control from its shipped surface, drags the separator and observes the editor grow, renders a registered `composer.above` contribution, and compares the desktop control set and grip geometry.
