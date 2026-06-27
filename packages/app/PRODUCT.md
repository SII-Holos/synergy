# Product

## Register

product

## Users

Synergy Web is used by developers and agent operators who are switching between sessions, scopes, notes, blueprints, and automation state while actively working.

## Product Purpose

The app gives users a calm command surface for running agents, preserving context, turning rough notes into executable plans, and returning to prior work without losing orientation.

## Brand Personality

Quiet, capable, precise. The interface should feel like a focused workbench.

## Anti-references

Avoid nested-card chrome, border-within-border form shells, decorative gradients, unclear icon-only mode switches, mismatched note and blueprint actions, and blueprint lists that look like generic note cards.

## Design Principles

Use one visual source of truth for shared document editing.
Make reciprocal actions visibly reciprocal.
Reserve emphasis for workflow state and current selection.
Let blueprints read as plans with status, activity, and next action, not as passive notes.
Keep dense surfaces quiet enough for repeated daily use.
Use mode-aware polarity: in dark mode, the active or inner thing is brighter than its shell; in light mode, the active or inner thing is darker than its shell.
Treat that polarity as a surface hierarchy invariant, not a per-page decoration choice; if light mode feels reversed, audit the token source first, then the component consumer.

## Interaction & Visual Principles

Treat the Holos agent as the Synergy account identity. Model subscriptions, API keys, quota windows, and provider logins belong to Providers and Usage, not Account.

Keep navigation surfaces mentally aligned with where they live. Sidebar destinations such as Agenda, Library, and Plugins open in the main session-side canvas. Settings may be modal, and it should dim the whole app because it interrupts the current task.

Session, Agenda, Library, and Plugins should feel like one continuous workbench canvas in both light and dark modes. Their root backgrounds should align with the session message-flow background; inner surfaces can step up or down for hierarchy, but should not look like separate apps.

Library modes are peer views inside the main workbench, not a settings-style secondary sidebar. Put Overview, Memories, Experiences, and Skills in a top tab control aligned with Agenda's Schedule/History pattern, and keep those Library tabs text-only unless an icon adds necessary meaning.

The Browser workspace should feel like a browser window inside the workbench. Desktop mode uses the local native browser view; Web mode uses a remote WebRTC browser stream with data-channel input. An empty Browser workspace is a valid state; the first address-bar navigation or new-tab action creates a tab. Both modes should preserve normal browser expectations: click focus, visible text caret from the page, IME composition, paste, wheel scrolling, shortcuts, reload, tab switching, downloads, file chooser, dialogs, and diagnostics. Host pending/ready/loading states are connection states, not fatal product errors.

Content Polarity Rule: dark mode reads inward by getting brighter; light mode reads inward by getting darker. Content, controls, and selected items should usually be slightly brighter than their container in dark mode, and slightly darker than their container in light mode. Treat selected rows, active tabs, chips, tool cards, form fields, popovers, calendar cells, scheduled items, and provider/account rows as content surfaces; they should follow the same polarity rule unless a semantic status color is doing real state work. This is especially strict inside the main workbench canvas and must be reflected in global theme tokens, scoped workbench tokens, and component-level fallbacks. Verify the actual outer-to-inner lightness relationship for generic "raised" tokens. White raised surfaces are appropriate for deliberate paper-like or modal surfaces. Session, Agenda, Library, Plugins, and Settings use the workbench polarity model for inner content layers. Pages outside shared workbench classes should define scoped surface tokens with the same outer-to-inner lightness order. This rule governs perceived layer direction, not material choice; subtle translucency is allowed when it still reads grounded and preserves the same lightness relationship.

When a surface violates polarity, first identify whether the theme source or the consuming component is wrong. Prefer fixing the relevant scoped token graph or component class mapping at the source.

Favor grounded, pragmatic surfaces over obvious glassmorphism. A little translucency or floating quality is acceptable for transient overlays, but heavy transparency, blur, glow, and decorative shadows make the product feel less grounded. Do not remove all translucency reflexively; keep it subtle enough that the surface still feels solid.

Use black, white, and neutral ramps as the primary visual language. Blue is a state color for active or running work, not a default accent for selection or decoration.

Avoid border-on-border clutter. Joined panels should join cleanly, with no double rounded corners at seams and no unnecessary nested-card outlines.

For item detail popovers, let the popover itself be the outer card. Use section labels, row rhythm, and light dividers inside; do not put large bordered Task, metadata, or history boxes inside another bordered container.

Form controls should have filled surfaces. In dark mode, controls should be slightly brighter than their container; in light mode, controls should be slightly darker. Required-action buttons stay disabled until the required inputs are valid.

Use icons sparingly. Icons should clarify primary navigation or compact controls, not decorate every row of a form.

Clarifying question prompts are decision surfaces, not tool-output cards. They should use a solid outer shell, filled option rows, quiet step chips, clear disabled primary actions, and only the minimum icons needed to show disclosure or selection state.

## Accessibility & Inclusion

Target WCAG AA contrast, visible keyboard focus, reduced-motion-safe transitions, and controls whose text labels or titles explain their action.
