# Product

## Register

product

## Users

Synergy Web is used by developers and agent operators who are switching between sessions, scopes, notes, blueprints, and automation state while actively working.

## Product Purpose

The app gives users a calm command surface for running agents, preserving context, turning rough notes into executable plans, and returning to prior work without losing orientation.

## Brand Personality

Quiet, capable, precise. The interface should feel like a focused workbench rather than a marketing surface.

## Anti-references

Avoid nested-card chrome, border-within-border form shells, decorative gradients, unclear icon-only mode switches, mismatched note and blueprint actions, and blueprint lists that look like generic note cards.

## Design Principles

Use one visual source of truth for shared document editing.
Make reciprocal actions visibly reciprocal.
Reserve emphasis for workflow state and current selection.
Let blueprints read as plans with status, activity, and next action, not as passive notes.
Keep dense surfaces quiet enough for repeated daily use.

## Interaction & Visual Principles

Treat the Holos agent as the Synergy account identity. Model subscriptions, API keys, quota windows, and provider logins belong to Providers and Usage, not Account.

Keep navigation surfaces mentally aligned with where they live. Sidebar destinations such as Agenda, Library, and Plugins should open in the main session-side canvas, not as floating modals. Settings may be modal, but it should dim the whole app because it interrupts the current task.

Session, Agenda, Library, and Plugins should feel like one continuous workbench canvas in both light and dark modes. Their root backgrounds should align with the session message-flow background; inner surfaces can step up or down for hierarchy, but should not look like separate apps.

Respect theme polarity when building hierarchy. In dark mode, content, controls, and selected items should usually be slightly brighter than the container that holds them. In light mode, content, controls, and selected items should usually be slightly darker than the container that holds them. Treat selected rows, active tabs, chips, tool cards, and form fields as content surfaces; they should follow the same polarity rule unless a semantic status color is doing real state work. White raised surfaces are appropriate for deliberate paper-like or modal surfaces, not as the default inner content layer on the main workbench canvas.

Favor grounded, pragmatic surfaces over obvious glassmorphism. A little translucency or floating quality is acceptable for transient overlays, but heavy transparency, blur, glow, and decorative shadows make the product feel less grounded.

Use black, white, and neutral ramps as the primary visual language. Blue is a state color for active or running work, not a default accent for selection or decoration.

Avoid border-on-border clutter. Joined panels should join cleanly, with no double rounded corners at seams and no unnecessary nested-card outlines.

Form controls should have filled surfaces, not border-only fields. In dark mode, controls should be slightly brighter than their container; in light mode, controls should be slightly darker. Required-action buttons stay disabled until the required inputs are valid.

Use icons sparingly. Icons should clarify primary navigation or compact controls, not decorate every row of a form.

## Accessibility & Inclusion

Target WCAG AA contrast, visible keyboard focus, reduced-motion-safe transitions, and controls whose text labels or titles explain their action.
