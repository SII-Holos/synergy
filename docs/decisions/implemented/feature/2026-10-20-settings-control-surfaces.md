# Decision Record: Share borderless inset control surfaces across Settings

Status: implemented

## Problem

Settings combines shared buttons and text fields with native fields, search wrappers, preference choices and portalled child dialogs. Dropdown triggers already use a quiet neutral inset fill, but the other control families retain different borders, inset strokes or filled primary styling. Fixing individual fields would leave newly added controls and child dialogs free to reintroduce the same inconsistency.

## Decision

`apps/web/src/components/settings/settings-controls.css` owns Settings control surfaces. It applies the existing public inset theme roles to semantic button and field families inside the Settings frame and the explicit `settings-control-scope` child-dialog marker. Shared primary, secondary and ghost buttons, native actions, text and numeric fields, search wrappers and custom MenuField triggers inherit this styling without requiring a panel-specific class. Panel CSS owns layout, while ordered and unordered preference choices preserve their selection cues without outline-based emphasis.

Settings callers pass the marker through the optional `useConfirm` presentation class. Browser data dialogs opened from Settings declare it directly. Dialogs opened elsewhere retain their existing appearance; neither source-document position nor the currently focused element determines ownership. Native fields in declarative plugin forms inherit the same control styling. Arbitrary third-party plugin styles outside these supported controls are not rewritten.

Selection uses neutral surface contrast or a checkmark. Keyboard actions retain the shared surface-based focus cue. Inputs retain their resting appearance while editing; invalid fields keep their error semantics and explanatory text. Disabled actions remain disabled and visibly muted. Switches, sliders, navigation, menu option rows, popup elevation and non-interactive entity boundaries remain separate roles. Text-field label and input geometry uses the same control measures as dropdowns, without reserving pixels for removed borders.

Rows that only structure an entity card are not actions. A control whose enclosing card already owns the surface declares `data-settings-surface="plain"`, and the central rule leaves its background, hover and focus layers to the owning panel CSS. Marked rows keep the surrounding card fill at rest, and the owning panel keeps deciding any hover or focus treatment. This covers the MCP server summary row and the inline model-role details trigger; the marker is available to any later structural row instead of adding a second exclusion selector.

## Alternatives considered

**Change the global Button and TextField defaults.** Rejected because the requested visual decision is specific to Settings and must not recolor the Composer, document toolbars or unrelated confirmation dialogs.

**Remove borders one panel at a time.** Rejected because new native fields, primary buttons, plugin forms and portalled dialogs would continue to choose their own resting appearance. The shared scoped rule covers control families, and existing one-off borders are removed rather than retained as competing style declarations.

**Apply a blanket reset to every descendant.** Rejected because menu selection, navigation, switches, sliders and entity boundaries have different meanings. The control rules explicitly preserve those roles and avoid styling a menu row as an action button.

**Let panels override the fill with a more specific selector.** Rejected because a specificity race decides appearance: the panel declaration silently loses whenever the central rule gains a nested selector, which is how the entity-card rows acquired an inset fill they never declared. An explicit marker states the intent at the element instead of relying on cascade order.

## Consequences

New ordinary controls inherit the Settings appearance automatically. New Settings-owned child dialogs must declare the explicit scope marker, and new custom control families must extend the central rule and rendered browser coverage. Primary actions depend on labels, placement and state rather than an unrelated dark fill. Theme changes continue to resolve through the public semantic tokens without a Settings-only palette.

Structural rows that wrap an entity need the marker, and a new row family that forgets it inherits the inset fill. The rendered regression for these rows asserts a transparent resting background in both themes next to an unmarked action that must stay filled, and keeps the panel-owned hover of the inline details trigger working.

The browser regressions compare rendered controls with the existing MenuField, rather than hard-coded color values or CSS source strings. Coverage includes primary, secondary, ghost and native actions, text and numeric fields, choices, plugin fields and independently portalled confirmations and browser data forms. It also verifies keyboard and disabled behavior, invalid-field explanations, narrow geometry and an unchanged outside-Settings control. Existing interaction and geometry scenarios remain in their owning suites rather than being duplicated in a new test harness.
