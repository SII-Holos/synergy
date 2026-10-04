# Decision Record: Consistent feature-page dropdown presentation

Status: implemented

## Problem

Agenda Scope filters, Kanban dimensions and declarative plugin enums use browser-native option popups whose appearance differs from the surrounding theme. Existing themed choices omit visible selection checks and use inconsistent typography. The shared listbox consumes Escape before the popup can dismiss, and an unguarded multiple-selection list can clear its value during dismissal.

## Decision

Feature-page dropdown choices reuse the existing [MenuField](../../../../packages/ui/src/components/menu-field.tsx). It composes Kobalte Popover and Listbox, retains the overlay layer and portal style owner, and provides a native button trigger. Optional icon and ID props support board controls and label association without introducing product state into shared UI. The [product specification](../../../../apps/web/PRODUCT.md#feature-pages) owns visual sizes and interaction rules.

Single selection reports changes once and closes; multiple selection remains open. A reserved trailing check distinguishes selection from hover without moving option labels or counts. The list aligns with its trigger and retains its width in form fields; viewport padding constrains the popup without shifting its anchor alignment. Keyboard browsing does not commit a choice. Listbox Escape explicitly closes its popup, preserves selection and stops propagation to an enclosing Dialog. The existing controlled page state continues to own Scope, grid dimensions, draft agent, permissions, workflow and plugin settings.

## Alternatives considered

**Style native selects.** The closed control can inherit the theme, but the operating system still owns the opened popup and cannot provide the shared selection and hover presentation.

**Create separate page-specific dropdowns.** This would duplicate keyboard handling, overlay ownership, visual rules and focus recovery across the five pages. The shared component already supplies the required single- and multiple-selection behavior.

**Use immediate radio selection inside every popup.** Radio groups remain appropriate for visible exclusive controls. Dropdown browsing must allow navigation through choices before activation, especially when selecting invokes a permission or workflow operation.

## Consequences

The feature pages share an opened-menu presentation and dismissal behavior. Existing MenuField consumers also receive visible selection checks and viewport constraints. Native option-popup behavior is replaced by the existing toolkit's listbox behavior, so composed browser regressions cover keyboard activation, unchanged values during browsing, focus return, nested dismissal, multiple selection, theme changes and responsive geometry. Backend operations, persisted preferences and plugin schemas retain their existing ownership and formats.
