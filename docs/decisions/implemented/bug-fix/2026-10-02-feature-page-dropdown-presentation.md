# Decision Record: Consistent feature-page dropdown presentation

Status: implemented

## Problem

Agenda Scope filters, Kanban dimensions and declarative plugin enums use browser-native option popups whose appearance differs from the surrounding theme. Existing themed choices omit visible selection checks and use inconsistent typography. The shared listbox consumes Escape before the popup can dismiss, and an unguarded multiple-selection list can clear its value during dismissal.

A Settings-only selected-row override also makes shared consumers retain a second filled row while another option is hovered. Plain toolbar and dialog choices duplicate the same interactions, but their disabled placeholders, deferred permission confirmation and explicit submit actions prevent a purely cosmetic component replacement.

## Decision

Feature-page dropdown choices reuse the existing [MenuField](../../../../packages/ui/src/components/menu-field.tsx). It composes Kobalte Popover and Listbox, retains the overlay layer and portal style owner, and provides a native button trigger. Optional icon and ID props support board controls and label association without introducing product state into shared UI. The [product specification](../../../../apps/web/PRODUCT.md#feature-pages) owns visual sizes and interaction rules.

Single selection reports changes once and closes by default; multiple selection remains open. Controlled owners can defer changed-value dismissal until confirmation and saving succeed. Repeating the accepted single value closes without submitting another change. Disabled state blocks both the trigger and options of an already-open menu. The existing owner continues to control Scope, grid dimensions, draft agent, permissions, workflow and plugin settings; a staged choice never substitutes for its form's submit action.

A reserved trailing check distinguishes selection from hover without moving option labels or counts. Selection has no persistent background, and the default trigger has no inset stroke. Settings density and compact toolbar triggers remain local presentation choices. Native simple fields and plain toolbar lists reuse MenuField, including fork locations, file Workspace origins, transfer destinations, workers, thinking levels, agents and permission modes. Searchable model selection, date/time pickers and repeat-to-exit workflow actions retain their specialized interactions. Notes and working-location mixed menus keep their actions and independent state, share the menu surface, and synchronize pointer focus without activating a choice.

The list aligns with its trigger and retains its width in form fields; viewport padding constrains the popup without shifting its anchor alignment. Opening focuses an enabled selected option, otherwise the first enabled option or the list itself, without rewriting a disabled or unknown saved value. Initial focus is owned by the popover, with synchronous focus handlers untracked so list changes cannot rerun mounting and steal subsequent input. Keyboard browsing does not commit a choice. Listbox Escape explicitly closes its popup, preserves selection and stops propagation to an enclosing Dialog.

The file toolbar's Workspace-origin selector uses the same component, preserving complete paths in the menu and a short trigger within its panel. Nested menu Escape closes only the menu before returning focus to its trigger. File entry commands use the dedicated [contextual-action interaction](../feature/2026-10-26-file-workbench-toolbar-and-context-actions.md).

## Alternatives considered

**Style native selects.** The closed control can inherit the theme, but the operating system still owns the opened popup and cannot provide the shared selection and hover presentation.

**Create separate page-specific dropdowns.** This would duplicate keyboard handling, overlay ownership, visual rules and focus recovery across the five pages. The shared component already supplies the required single- and multiple-selection behavior.

**Use immediate radio selection inside every popup.** Radio groups remain appropriate for visible exclusive controls. Dropdown browsing must allow navigation through choices before activation, especially when selecting invokes a permission or workflow operation.

**Keep page-specific selected-background overrides.** Rejected because the shared default would continue producing different states outside Settings. The common component owns check-only selection; mixed menus apply the same rule without discarding their action semantics.

## Consequences

The feature pages share an opened-menu presentation and dismissal behavior. Existing MenuField consumers also receive visible selection checks and viewport constraints. Native option-popup behavior is replaced by the existing toolkit's listbox behavior, so composed browser regressions cover keyboard activation, unchanged values during browsing, focus return, nested dismissal, multiple selection, theme changes and responsive geometry. Additional regressions cover disabled/unknown current values, immediate typing after selection, real permission confirmation cancellation and acceptance, pending requests, hidden retained views and mixed-menu pointer focus. Backend operations, persisted preferences and plugin schemas retain their existing ownership and formats.
