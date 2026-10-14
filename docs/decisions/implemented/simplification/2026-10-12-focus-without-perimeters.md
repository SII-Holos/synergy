# Decision Record: Focus without perimeter highlights

Status: implemented

## Problem

Search inputs, the Composer and shared controls draw competing focus borders through native outlines, component shadows and page-specific border colors. Changing one color leaves other perimeter highlights visible and allows new controls to reintroduce them.

## Decision

Synergy-owned controls do not add or recolor borders, outlines, rings or shadows in response to focus. The shared [focus stylesheet](../../../../packages/ui/src/styles/focus.css) suppresses native outlines. Text inputs and their containers retain their resting appearance on hover, pointer press and focus, with editing indicated only by the caret. Other controls use a flat neutral surface or text treatment for keyboard focus, including the visible proxies of composite choices. Forced-color mode uses system foreground and background colors for those non-text controls. Boot, recovery and embedded control styles follow the same presentation. Resting borders, validation and selection semantics remain independently owned.

The shared fill selects native and ARIA action controls explicitly. Focusable structural surfaces such as dialogs, scroll viewports, trees, grids, file previews and Canvas retain their background; accepting focus does not make a container an action. Composite items still receive their own cue, and Canvas identifies keyboard ownership through its status control. This applies in forced-color mode as well.

The [browser regression](../../../../apps/web/test/testing/focus-presentation.browser.test.ts) checks authored CSS, compiled utility classes and computed perimeters before and after focus, plus the complete input surface during hover, press, click and keyboard focus. It discovers stylesheet files instead of maintaining a page allowlist, and proves that newly introduced outline, shadow and border rules fail regardless of color. Shared buttons, text inputs, composite choices, menus, native controls and the Agenda/Composer surfaces receive light/dark interaction coverage.

Computed-surface checks cover structural containers and semantic actions in both themes and forced colors. Project settings also exercise focus return from the nested folder picker.

Settings, permission, directory, activity-row and Desktop startup regressions retain keyboard selection, focus return and geometry checks, asserting the current surface or text cue instead of retired perimeter highlights. CSS fixtures preserve production cascade layers, and animated cues are measured after their actual transition settles.

## Alternatives considered

**Change the focus color.** Rejected because a neutral or translucent perimeter still introduces the unwanted frame.

**Override every focused ancestor's shadow.** Rejected because this also removes normal floating-surface shadows and resting borders. Remove the focus-specific declarations at their source instead.

**Give text inputs a focus background.** Rejected because nested editor and container overlays create uneven gray blocks. Inputs keep their resting appearance. Non-text controls retain a surface or text cue for keyboard navigation.

## Consequences

Non-text controls retain a focus cue without perimeter emphasis. Text inputs rely on the caret, and all controls keep their normal geometry. Custom controls must expose a visible focus surface when their native input is hidden. Browser style-policy checks cover new selectors and utilities; representative interaction checks protect focus behavior without opening every product route. User-authored documents and external web pages retain their own content styling.
