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
Use one neutral surface system: light mode reads as a near-white canvas with white or transparent rows, hairline borders, and very light hover/selected fills; dark mode reads inward by getting brighter than its shell.
Treat that surface model as a hierarchy invariant, not a per-page decoration choice; if a page drifts blue-gray or slab-heavy, audit the token source first, then the component consumer.

## Interaction & Visual Principles

Treat the Holos agent as the Synergy account identity. Model subscriptions, API keys, quota windows, and provider logins belong to Providers and Usage, not Account.

Holos agent profile is remote-owned identity data. Synergy may collect the initial name, description, and avatar URL when creating an agent, and may edit those fields from Account settings, but local storage should only retain the agent ID, agent secret, and timestamps. Importing an existing agent must fetch the remote profile instead of asking users to recreate or overwrite it.

Holos create and import agent dialogs should be compact identity forms: title, short prompt, fields, and actions. Do not use decorative icon blocks, alert-style cards, or local storage and verification details for ordinary explanatory text in these flows.

The Holos login callback page should behave as a transient bridge, not a destination page. On success it should confirm the agent connection, notify the opener with a strict target origin, attempt to close itself, and leave a calm fallback with a close action and Synergy return link. Failure states may include a short expandable detail, but the primary copy should stay human-facing and recoverable rather than debug-style.

Account settings should present the remote Holos profile as identity first and expose identifiers as supporting metadata. Profile fields should not sit permanently on the page as an empty edit form; use an explicit edit state for name, description, and avatar URL. Log out belongs with the identity card because it acts on the current identity. Switching saved agents belongs in a focused chooser, not as a debug-style table inside the Account page. The lower-left account menu should echo the same hierarchy: profile name, profile description or connection state, then a short agent ID only as secondary context; the selected agent needs a single selected affordance, not redundant status text.

Saved Holos agent lists should display each account's remote profile name, description, and avatar when available, including non-active accounts. Short agent IDs are supporting fallback metadata, not the primary label for agents with a reachable profile.

Keep navigation surfaces mentally aligned with where they live. Sidebar destinations such as Agenda, Library, and Plugins open in the main session-side canvas. Settings may be modal, and it should dim the whole app because it interrupts the current task.

Settings should be a human-facing preference surface, not a raw config editor. Keep common settings in a left-aligned readable measure, use switches for binary choices, guided scales for ordered multi-step values, and direct option controls for unordered choices. Do not expose inline restore-to-default options for ordinary preference controls; defaults should be reachable through the same control when needed. Reserve raw domain-file syntax for import/export or advanced configuration views.

Settings typography should use the global semantic UI type tokens, not local pixel sizes or historical `text-12-*` utility classes. Page titles, section titles, row titles, body copy, control text, and captions should map to fixed rem-based roles with regular, medium, and semibold weights only. Keep the density close to Manus: comfortable enough to read as product settings, still efficient enough for a daily developer tool.

Library settings should explain learning, memory recall, and experience reuse as product preferences. Use switch controls for binary learning behavior and discrete guided scales for recall or exploration thresholds; do not present cosine similarity, top-k, or epsilon choices as raw debug parameters.

Model settings should keep role routing and quick-switcher visibility together in one Models page. Specialist model roles are the first section; connected models and their quick-switch toggles are the second section. Avoid reopening a separate Manage Models modal from inside Settings.

Provider settings should behave like a connection workspace, not a config editor. Keep provider discovery, selected-provider detail, and login flows together in the Providers page; provider quota, billing, and account-health details belong in Usage. The provider list should scroll inside its own column so the selected detail remains anchored. Do not expose raw provider allow/deny text lists in the primary settings UI.

Usage settings should read as compact account summaries, not a wide report. Keep refresh controls inside the content flow, label quota windows with user-facing durations such as a 5-hour window, and avoid stretching quota rows across the full modal width.

Product updates are owned by the installation surface, not global server config. Desktop Settings can expose desktop-local update mode and installer progress because the Electron shell owns the app bundle and managed server process. Web Settings should show app/server version state and refresh actions; it may offer server update controls only when connected to a localhost Synergy managed daemon. Update prompts should be persistent status/actions, not blocking modals; the primary persistent prompt lives at the bottom of the sidebar with a single current action and inline progress when progress is known.

Session, Agenda, Library, and Plugins should feel like one continuous workbench canvas in both light and dark modes. Their root backgrounds should align with the session message-flow background; inner surfaces can step up or down for hierarchy, but should not look like separate apps.

Opening a workspace panel should not force the session message stream or prompt composer into a separate narrow fixed measure. Keep the session column at its normal readable working measure and let it shrink only when the actual pane width requires it. The normal session measure should feel like a broad workbench column for coding and tool-rich conversations, not a narrow chat lane. In constrained panes, preserve a minimum horizontal gutter around the message stream and tool cards so they do not visually stick to the sidebar or workspace boundary. Auto-opened workspace panels should occupy about half the viewport; user-resized workspace widths can remain sticky.

Library modes are peer views inside the main workbench, not a settings-style secondary sidebar. Put Overview, Memories, Experiences, and Skills in a top tab control aligned with Agenda's Schedule/History pattern, and keep those Library tabs text-only unless an icon adds necessary meaning.

Library content should not expand just because the viewport is wide. Use a centered working measure for Library dashboards and item grids, and let only genuinely tabular or timeline surfaces earn full width. Keep tab-level controls in one predictable toolbar: filter on the left, search or secondary actions on the right, with refresh/recompute/reload actions presented in that toolbar instead of scattered inside each section.

Library tab controls should share the same visual contract as Agenda tab controls. Descriptive labels such as Snapshot or Usage stats are not actions; do not style them as pills or buttons unless they can be clicked. Detail dialogs for library items should use the same grounded modal language as Agenda forms: one solid shell, section labels, light row dividers, and no debug-style boxes nested inside boxes.

Plugin Marketplace should share Agenda and Library's compact workbench language: a text title in the upper-left, fixed-height source tabs, a centered readable measure, and list rows that open grounded detail dialogs. Plugin detail should present install, update, uninstall, repository, version, permission, and trust information as human-facing controls and sections, not as raw registry/debug data.

The Browser workspace should feel like a browser window inside the workbench. Desktop mode uses the local native browser view; Web mode uses a remote WebRTC browser stream with data-channel input. A Synergy session has one Browser page, and an empty Browser workspace is a valid state. The first address-bar navigation or browser tool navigation creates that page; later navigation reuses it. Both modes should preserve normal browser expectations: click focus, visible text caret from the page, IME composition, paste, wheel scrolling, shortcuts, reload, downloads, file chooser, dialogs, and diagnostics. Host pending/ready/loading states are connection states, not fatal product errors.

Surface Rule: light mode uses a near-white workbench canvas, white or translucent row surfaces, neutral hairline borders, and restrained hover/selected fills instead of stacked blue-gray slabs. Dark mode keeps the established inward-brighter relationship. Treat selected rows, active tabs, chips, tool cards, form fields, popovers, calendar cells, scheduled items, and provider/account rows as content surfaces; they should follow the same token graph unless a semantic status color is doing real state work. This is especially strict inside the main workbench canvas and must be reflected in global theme tokens, scoped workbench tokens, and component-level fallbacks. Verify the actual source token before fixing individual components. Session, Agenda, Library, Plugins, Notes, Settings, and the message flow should feel like one continuous workbench rather than separate themed apps. Pages outside shared workbench classes should define scoped surface tokens from the same neutral source. This rule governs perceived layer direction, not material choice; subtle translucency is allowed when it still reads grounded.

When a surface violates the neutral workbench model, first identify whether the theme source or the consuming component is wrong. Prefer fixing the relevant scoped token graph or component class mapping at the source.

Favor grounded, pragmatic surfaces over obvious glassmorphism. A little translucency or floating quality is acceptable for transient overlays, but heavy transparency, blur, glow, and decorative shadows make the product feel less grounded. Do not remove all translucency reflexively; keep it subtle enough that the surface still feels solid.

Use black, white, and neutral ramps as the primary visual language. Blue is a state color for active or running work, not a default accent for selection or decoration.

Avoid border-on-border clutter. Joined panels should join cleanly, with no double rounded corners at seams and no unnecessary nested-card outlines.

For item detail popovers, let the popover itself be the outer card. Use section labels, row rhythm, and light dividers inside; do not put large bordered Task, metadata, or history boxes inside another bordered container.

Form controls should have quiet filled surfaces. In dark mode, controls should be slightly brighter than their container; in light mode, controls should sit on the shared neutral input fill rather than a blue-gray slab. Required-action buttons stay disabled until the required inputs are valid.

Prompt composers should read as one grounded input surface with a quiet bottom toolbar. Ordinary mode, agent, permission, and add controls should behave like toolbar buttons rather than separate bordered pills; reserve filled chips for active modes, pending state, or meaningful workflow status. Composer add and initialization menus should use the shared toolbar selector and list primitives rather than bespoke popover themes. Composer controls that are secondary to sending should compact to icon-only controls at constrained widths instead of forcing toolbar wrapping or cramped labels.

New-session initialization controls should sit in the composer toolbar next to the Add control as a quiet start-mode selector, not as a second row inside the typing area. Keep the selector menu data-driven so workspace mode, templates, cloud execution, and future start parameters can expand in one place while preserving the composer as a single grounded surface.

Use icons sparingly. Icons should clarify primary navigation or compact controls, not decorate every row of a form.

Treat brand assets as a hierarchy, not interchangeable decoration. SII is the institutional parent, Holos is the platform and account identity, and Synergy is the product. The Synergy product icon is the canonical app, favicon, notification, social, and external-attribution icon; Holos wordmarks should only identify the platform/account layer, and SII marks should only identify the institute layer.

Provider discovery should use provider profile metadata for explanatory copy and external sign-up CTAs. Settings may curate a short Recommended provider set for product guidance; custom providers remain standard alphabetical entries unless they declare metadata.

Clarifying question prompts are decision surfaces, not tool-output cards. They should use a solid outer shell, filled option rows, quiet step chips, clear disabled primary actions, and only the minimum icons needed to show disclosure or selection state.

## Accessibility & Inclusion

Target WCAG AA contrast, visible keyboard focus, reduced-motion-safe transitions, and controls whose text labels or titles explain their action.
