# Decision Record: Task details controls and dialog containment

Status: implemented

## Problem

Unstyled native round menus and filter choices make execution controls inconsistent with the rest of the workbench. Expanding Task details can give the inner content a wider size than the shared modal container, placing the right edge and close control outside the viewport. Opening an activity explorer can discard the task-detail dialog that owns its return path.

## Decision

Round selection uses the shared MenuField. Its neutral trigger and bounded rounded popup provide padded rows, a reserved trailing selection check and named listbox semantics. Escape is consumed at the active menu before document-level dismissal and returns focus to its trigger. Type and state filters use the shared Checkbox; executor choices retain a styled native radio group and arrow-key selection.

The filter scrolls its visible choice row into its own reading area on focus. Visually hidden checkbox inputs are positioned within their own rows, keeping their layout inside that scroller. Native input focus alone does not establish that a choice remains visible, and an uncontained absolute input can scroll the outer popup instead. Only the menu's scroller moves; the containing task view stays anchored.

Task details and activity dialogs declare viewport-bounded width and height through the shared outer shell's sizing variables. Inner content follows that shell and scrolls inside its body. The activity explorer is pushed onto the existing dialog stack so dismissal restores the task-detail state and connected chart trigger. These changes preserve the query, evidence and accounting decisions in [task details and execution trajectory](../feature/2026-10-01-task-details-execution-trajectory.md).

Regression fixtures compile the actual components, public DialogProvider and CSS layers. They check the panel and close control against narrow, short and zoom-equivalent viewport budgets after entrance animations settle, and exercise nested menu dismissal, selection and focus return.

## Alternatives considered

**Keep native selects with local styling.** The platform popup does not share the product's option spacing and selection treatment, and leaves task details inconsistent with existing shared choice menus.

**Restrict only the inner content width.** This can hide the overflow at one size while preserving competing parent and child geometry. The shared shell remains the owner of modal placement and size.

**Replace the parent dialog when opening the activity explorer.** This removes the connected return-focus target and loses the containing task-detail view. The existing dialog stack preserves both without a second navigation store.

## Consequences

Choice menus have consistent selection feedback and keyboard behavior across their existing consumers. Task details and its activity explorer fit the viewport with reachable close controls, while long trajectories and wide graphs keep internal scrolling. The shared MenuField gains roomier rows, so compact consumers must retain intentional sizing through their existing custom trigger and surface classes. Compiled browser coverage supplements focused layout tests because raw unlayered CSS does not reproduce the production cascade.
