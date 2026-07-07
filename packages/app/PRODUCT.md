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
When an agent successfully creates or replaces a Blueprint through `note_write`, the session should focus the Notes side panel on that Blueprint; ordinary note writes should stay in the message flow without opening the side panel.
When that Blueprint is created or replaced from an active Plan workflow, wait until the current turn is idle, then show a compact one-time composer control to equip the Blueprint in the current session. The control should not auto-start the BlueprintLoop, and dismissing or muting it must not close Plan by itself.
Starting a Blueprint run should keep the user on the Blueprint detail surface; the run status owns the feedback there, and session output is opened through an explicit session link.
Sidebar session icons should preserve Blueprint identity while a BlueprintLoop is active: running, waiting, and auditing Blueprint sessions should remain visually distinct from ordinary running sessions and return to normal session treatment when the loop is terminal.
Note and Blueprint detail headers should use flat toolbar controls with compact rectangular hit targets; keep workflow metadata as text rows, and use divider-row popovers instead of bordered option cards inside bordered shells.
Keep dense surfaces quiet enough for repeated daily use.
Use one neutral surface system: light mode reads as a near-white canvas with white or transparent rows, hairline borders, and very light hover/selected fills; dark mode reads inward by getting brighter than its shell.
Treat that surface model as a hierarchy invariant, not a per-page decoration choice; if a page drifts blue-gray or slab-heavy, audit the token source first, then the component consumer.

## Interaction & Visual Principles

Treat the Holos agent as the Synergy account identity. Model subscriptions, API keys, quota windows, and provider logins belong to Providers and Usage, not Account.

User-visible high-risk operations that archive, delete, cancel, overwrite, or uninstall product data must use the shared confirmation dialog. Browser page dialogs, permission review surfaces, and runtime controls with dedicated gesture semantics may keep specialized interfaces when the domain requires it.

Holos agent profile is remote-owned identity data. Synergy may collect the initial name, description, and avatar URL when creating an agent, and may edit those fields from Account settings, but local storage should only retain the agent ID, agent secret, and timestamps. Importing an existing agent must fetch the remote profile instead of asking users to recreate or overwrite it.

Holos create and import agent dialogs should be compact identity forms: title, short prompt, fields, and actions. Do not use decorative icon blocks, alert-style cards, or local storage and verification details for ordinary explanatory text in these flows.

The Holos login callback page should behave as a transient bridge, not a destination page. On success it should confirm the agent connection, notify the opener with a strict target origin, attempt to close itself, and leave a calm fallback with a close action and Synergy return link. Desktop-originated login should open the external Holos page through the desktop shell and return through the `synergy://` app protocol instead of browser popup semantics. Failure states may include a short expandable detail, but the primary copy should stay human-facing and recoverable rather than debug-style.

Account settings should present the remote Holos profile as identity first and expose identifiers as supporting metadata. Profile fields should not sit permanently on the page as an empty edit form; use an explicit edit state for name, description, and avatar URL. Log out belongs with the identity card because it acts on the current identity. Switching saved agents belongs in a focused chooser, not as a debug-style table inside the Account page. The lower-left account menu should echo the same hierarchy: profile name, profile description or connection state, then a short agent ID only as secondary context; the selected agent needs a single selected affordance, not redundant status text.

Saved Holos agent lists should display each account's remote profile name, description, and avatar when available, including non-active accounts. Short agent IDs are supporting fallback metadata, not the primary label for agents with a reachable profile.

Keep navigation surfaces mentally aligned with where they live. Sidebar destinations such as Agenda, Library, Performance, and Plugins open in the main session-side canvas. Settings may be modal, and it should dim the whole app because it interrupts the current task.

Settings should be a human-facing preference surface, not a raw config editor. Keep common settings in a left-aligned readable measure, use switches for binary choices, guided scales for ordered multi-step values, and direct option controls for unordered choices. Do not expose inline restore-to-default options for ordinary preference controls; defaults should be reachable through the same control when needed. Reserve raw domain-file syntax for import/export or advanced configuration views. Agent, command, and instruction authoring are advanced Synergy configuration workflows; keep them out of first-class Settings navigation and let users handle them through conversation-assisted setup or Config Files.
Internal and developer settings such as formatter, lsp, and observability should be hidden by default and surfaced only through local developer mode; the ordinary Settings surface remains human-facing.

Settings typography should use the global semantic UI type tokens, not local pixel sizes or historical `text-12-*` utility classes. Page titles, section titles, row titles, body copy, control text, and captions should map to fixed rem-based roles with regular, medium, and semibold weights only. Keep the density close to Manus: comfortable enough to read as product settings, still efficient enough for a daily developer tool.

Library settings should explain learning, memory recall, and experience reuse as product preferences. Use switch controls for binary learning behavior and discrete guided scales for recall or exploration thresholds; do not present cosine similarity, top-k, or epsilon choices as raw debug parameters.

Model settings should keep role routing and quick-switcher visibility together in one Models page. Specialist model roles are the first section; connected models and their quick-switch toggles are the second section. Avoid reopening a separate Manage Models modal from inside Settings.

Provider settings should behave like a connection workspace, not a config editor. Keep provider discovery, selected-provider detail, and login flows together in the Providers page; provider quota, billing, and account-health details belong in Usage. The provider list should scroll inside its own column so the selected detail remains anchored. Do not expose raw provider allow/deny text lists in the primary settings UI.

Usage settings should read as compact account summaries, not a wide report. Keep refresh controls inside the content flow, label quota windows with user-facing durations such as a 5-hour window, show provider reset timing inline with each quota row when available, and avoid stretching quota rows across the full modal width.

Integration settings such as MCP and Email should present connection management, not protocol debugging. Use compact status rows, plain task labels, and grouped connection fields that explain what Synergy will do with the connection. Keep local command, remote endpoint, SMTP, and IMAP details secondary to the user's intent: add tools, send mail, or read mail.

Product updates are owned by the installation surface, not global server config. Desktop Settings can expose desktop-local update mode and installer progress because the Electron shell owns the app bundle and managed server process. Web Settings should show app/server version state and refresh actions only when the server reports a newer released Web client; source development and local server versions rely on Vite reload/HMR instead of persistent update prompts. Web Settings may offer server update controls only when connected to a localhost Synergy managed daemon. Update prompts should be persistent status/actions, not blocking modals; the primary persistent prompt lives at the bottom of the sidebar with a single current action and inline progress when progress is known.

The desktop app should read as a native Synergy product shell, not a browser wrapper. Windows and Linux use a compact custom window chrome with the Synergy product icon, a quiet drag region, and standard window controls; closing the window hides the shell to a Synergy system tray icon with reopen and quit actions so the managed local server is not stranded. macOS keeps its native traffic-light convention with a narrow top titlebar row for the system buttons and window dragging. Keep the HOLOS sidebar header and session top-bar controls in their own surfaces below that macOS titlebar row instead of moving them into an overlay. Do not expose development-style File/Edit/View/Window/Help menu bars inside Windows or Linux desktop windows. The custom chrome is part of the outer shell and should not compete with session, sidebar, or workbench controls.

Desktop cold start should show a native Synergy shell immediately instead of a blank window while the managed local server and Web renderer become ready. Desktop startup UI should stay outside the main Web renderer navigation path so loading the app URL never exposes a black or white gap. The startup surface and HTML boot shell should use the same resolved desktop theme as the app: saved Light and Dark choices apply before renderer mount, System follows the OS effective mode, and a missing saved source defaults to System. The startup surface should use the same desktop chrome height and product icon as the main app, but it should behave as a compact splash state rather than a mock copy of the sidebar, workbench, or prompt composer. The Web app HTML should carry a matching static icon splash as a fallback and remove it only when the app surface is ready, after which desktop may dismiss its native overlay. Before the app surface is ready, window chrome, splash background, and boot controls should remain visually continuous with the resolved theme.
Desktop managed-local project selection should use native OS folder picking for Add/Open Project because the Electron shell and managed server share local filesystem authority. Web, remote-server, and desktop external-server project selection must browse the server filesystem instead of exposing local desktop paths; that server browser should use an explicit search action, clear base/query state, and bounded server-side browse rather than keystroke-driven recursive scanning.

Session, Agenda, Library, Performance, and Plugins should feel like one continuous workbench canvas in both light and dark modes. Their root backgrounds should align with the session message-flow background; inner surfaces can step up or down for hierarchy, but should not look like separate apps.

Session turns should render as one persisted message-part timeline. Text, reasoning while running, tool calls, media results, attachments, and render previews must stay anchored to their original part order rather than being regrouped into separate steps or response summaries.

When a text or reasoning part is superseded by later visible work in the same running turn, its typewriter playback should settle immediately instead of continuing as a second active stream above the current work.

When the current running assistant step has no visible message part yet, the timeline may show a transient provider-waiting status using the backend session status text verbatim. Its current turn runtime may appear as quiet inline elapsed-time metadata after a middle dot, updating once per second without badge, chip, capsule, or button chrome. Once any real text, reasoning, tool, media, or attachment part appears for that step, the persisted part timeline takes over and the transient status disappears.

Tool audit icons are a quiet exception rail, not a status badge on every tool card. Show them for pending user approval, user decisions, denials, sandbox blocks, and notable autonomous or smart auto-approvals. Hide ordinary low-risk and Guarded baseline auto-approvals so read/search/tool plumbing does not compete with the work itself. The server approval metadata is the source of truth for audit visibility; the UI should not infer visibility from risk or mode.

User prompts inside a turn may render as a compact right-aligned bubble with matching prompt attachments, but the turn header, tool/result timeline, media results, and diffs must keep their workbench-width timeline structure and original part order.

Special user-message renderers must preserve authorship semantics. Plan workflow user requests are user-authored prompts and should keep the right-aligned bubble treatment, while Blueprint control messages are orchestration events and should render as quiet centered event cards instead of pretending to be user speech.

Turn titles are navigation metadata, not conversation content; keep them in the session timeline or session-level chrome, and place user-prompt timestamps and copy controls outside the prompt bubble as low-emphasis metadata. Collapsed user-prompt expansion belongs inside the prompt bubble at the truncation edge, not in the external metadata row.

Copy controls should use the shared clipboard capability and shared copied/failed feedback. Success is shown in the triggering control, while failures use the global error toast; do not add local `navigator.clipboard` or `execCommand` implementations in product UI.

Markdown code blocks in the message stream are document content surfaces, not form controls. In light mode they should stay close to the white workbench surface with a hairline border and low-emphasis copy control; in dark mode they may keep the inward-brighter relationship.

Session timeline spacing should follow semantic rhythm: compact spacing for consecutive text, tighter grouping for consecutive tool events, and more breathing room when moving between prose and tool/media blocks. Avoid stacking narrow one-off adjacent selectors that make reasoning, text, and tools feel randomly packed.

Conversation attachment display should be owned by each attachment's presentation policy. Tool metadata may hide or show the tool card, but must not choose primary attachments, promote media results, or override attachment sizing outside the persisted part order. Media such as memes should render as message content at a bounded conversational size, while screenshots and documents can opt into larger or file-style presentation through attachment-level fields.
Image preview is a grounded modal viewer for previewable image attachments, with quiet metadata, separated viewer controls, zoom/pan/rotate, load failure fallback, and gallery navigation that preserves the owning attachment scope and order. Composer image attachments share one prompt-local gallery before send; sent attachment galleries keep their message-local scope.

Child sessions are session-local context and should be reachable from the current session's StatusBar rather than the global sidebar. Keep the child-session button persistent, but load children lazily only when the user opens its StatusBar panel. Show them as a compact paginated recent-activity switcher ordered by each child session's latest update time, with search, previous/next paging, and running or waiting state visible in the row.
Sidebar completion dots are quiet workflow-state reminders backed by persisted session completion state. Show them as restrained critical-color dots on session icons only after a run finishes, clear them when the session is opened, and never infer them from timestamps, category, source names, or local runtime status. Sidebar session and project ordering should advance once when a reply starts and once when it completes, but remain stable during in-flight updates so parallel active sessions do not make navigation jump.

Opening a workbench panel should not force the session message stream or prompt composer into a separate narrow fixed measure. Keep the session column at its normal readable working measure and let it shrink only when the actual pane width requires it. The normal session measure should feel like a broad workbench column for coding and tool-rich conversations, not a narrow chat lane. In constrained panes, preserve a minimum horizontal gutter around the message stream and tool cards so they do not visually stick to the sidebar or workbench boundary. Auto-opened workbench panels should occupy about half the viewport; user-resized workbench widths can remain sticky.

Plugin app panels are app-level workbench destinations and appear as top-level sidebar entries after Agenda, Library, Performance, and Plugins. They should feel like peer product areas, not nested plugin settings or marketplace pages. Plugin workbench panels remain session-scoped side or bottom workspace surfaces and should not replace the global sidebar navigation model.

Side Workspace and BottomSpace are symmetric extensible session workbench surfaces. Each surface opens from top-bar controls, starts with a compact launcher list, and hosts registered panel tabs with one shared density, resize, keyboard, and neutral-surface contract. Interactive resizing should update the occupied surface size immediately; open and close transitions may animate, but drag-driven size changes should not lag behind the content. Terminal is one BottomSpace panel with multi-tab behavior, not the definition of the bottom surface. Notes and Browser are Side Workspace panels; Browser appears only inside a concrete session and agent browser metadata should focus it through the shared surface controller.

Workbench panel tabs should behave like compact document tabs: close affordances appear on hover or keyboard focus without reserving label width, use a solid masked background over text, the add control sits directly after the current tab run rather than at the far edge, and launcher/add menus hide singleton panels that are already open. Singleton panels such as Notes and Browser can coexist as separate side-workspace tabs, but each should appear only once per session workspace.

Library modes are peer views inside the main workbench, not a settings-style secondary sidebar. Put Overview, Memories, Experiences, and Skills in a top tab control aligned with Agenda's Schedule/History pattern, and keep those Library tabs text-only unless an icon adds necessary meaning.

Library content should not expand just because the viewport is wide. Use a centered working measure for Library dashboards and item grids, and let only genuinely tabular or timeline surfaces earn full width. Keep tab-level controls in one predictable toolbar: filter on the left, search or secondary actions on the right, with refresh/recompute/reload actions presented in that toolbar instead of scattered inside each section.

Library tab controls should share the same visual contract as Agenda tab controls. Descriptive labels such as Snapshot or Usage stats are not actions; do not style them as pills or buttons unless they can be clicked. Detail dialogs for library items should use the same grounded modal language as Agenda forms: one solid shell, section labels, light row dividers, and no debug-style boxes nested inside boxes.

Plugin Marketplace should share Agenda and Library's compact workbench language: a text title in the upper-left, fixed-height source tabs, a centered readable measure, and list rows that open grounded detail dialogs. Plugin detail should present install, update, uninstall, repository, version, permission, and trust information as human-facing controls and sections, not as raw registry/debug data.

The Browser workspace should feel like a browser window inside the workbench. Desktop mode uses the local native browser view; Web mode uses a remote WebRTC browser stream with data-channel input. A Synergy session has one Browser page, and an empty Browser workspace is a valid state. The first address-bar navigation or browser tool navigation creates that page; later navigation reuses it. Both modes should preserve normal browser expectations: click focus, visible text caret from the page, IME composition, paste, wheel scrolling, shortcuts, reload, downloads, file chooser, dialogs, and diagnostics. Host pending/ready/loading states are connection states, not fatal product errors.

Browser controls should read as a compact product menu, not a debug drawer: use standard switch, segmented, selected-row, and local-navigation affordances with workbench spacing and surface tokens.

Session MCP controls should read as connection management, not raw runtime status. Use settings-style search, summary, status rows, and switches; keep error details secondary and avoid debug-list styling in the session modal.

Surface Rule: light mode uses a near-white workbench canvas, white or translucent row surfaces, neutral hairline borders, and restrained hover/selected fills instead of stacked blue-gray slabs. Dark mode keeps the established inward-brighter relationship. Treat selected rows, active tabs, chips, tool cards, form fields, popovers, calendar cells, scheduled items, and provider/account rows as content surfaces; they should follow the same token graph unless a semantic status color is doing real state work. This is especially strict inside the main workbench canvas and must be reflected in global theme tokens, scoped workbench tokens, and component-level fallbacks. Verify the actual source token before fixing individual components. Session, Agenda, Library, Plugins, Notes, Settings, and the message flow should feel like one continuous workbench rather than separate themed apps. Pages outside shared workbench classes should define scoped surface tokens from the same neutral source. This rule governs perceived layer direction, not material choice; subtle translucency is allowed when it still reads grounded.

When a surface violates the neutral workbench model, first identify whether the theme source or the consuming component is wrong. Prefer fixing the relevant scoped token graph or component class mapping at the source.

Favor grounded, pragmatic surfaces over obvious glassmorphism. A little translucency or floating quality is acceptable for transient overlays, but heavy transparency, blur, glow, and decorative shadows make the product feel less grounded. Do not remove all translucency reflexively; keep it subtle enough that the surface still feels solid.

Use black, white, and neutral ramps as the primary visual language. Blue is a state color for active or running work, not a default accent for selection or decoration.

Avoid border-on-border clutter. Joined panels should join cleanly, with no double rounded corners at seams and no unnecessary nested-card outlines.

For item detail popovers, let the popover itself be the outer card. Use section labels, row rhythm, and light dividers inside; do not put large bordered Task, metadata, or history boxes inside another bordered container.

Form controls should have quiet filled surfaces. In dark mode, controls should be slightly brighter than their container; in light mode, controls should sit on the shared neutral input fill rather than a blue-gray slab. Required-action buttons stay disabled until the required inputs are valid.
Dialogs should share a grounded modal language and behavior without sharing one forced size. Use semantic dimensions such as compact, form, list, wide, command, and content to express the dialog's job, then let specialized panels such as Settings, Agenda, Plugin, Library, Worktree, Confirm, MCP, and image preview surfaces keep their domain-specific layouts when those layouts are intentionally designed. Dialog actions should use the shared button rhythm and a clear footer edge; avoid tiny debug-style buttons, double body padding, and nested-card shells inside already-framed modal surfaces.
Timeline rewind confirmation should read as a consequence summary with one optional file action, not as rollback debug output. Collapse message and reply counts into plain outcome copy, hide file restore controls when no files are affected, and avoid per-row decorative icons or file chips unless the user explicitly expands file details.

Prompt composers should read as one grounded input surface with a quiet bottom toolbar. Ordinary mode, agent, permission, and add controls should behave like toolbar buttons rather than separate bordered pills; reserve filled chips for active modes, pending state, or meaningful workflow status. Composer add and initialization menus should use the shared toolbar selector and list primitives rather than bespoke popover themes. Composer controls that are secondary to sending should compact to icon-only controls at constrained widths instead of forcing toolbar wrapping or cramped labels.
Workflow modes in the composer should stay symmetric: menu actions arm a mode, configured modes may open a focused dialog before arming, active modes render persistent toolbar chips, and those chips are the cancellation affordance. While a session is running, workflow-mode cancellation chips should stay visible but disabled.
Light Loop is armed from the composer menu without a dialog; the next non-empty normal user message becomes the task description, with attachments and references included only as compact context. Ordinary composer submit requires text, except stopping a running session or starting an equipped BlueprintLoop.
Equipping a user Blueprint while idle exits Plan or Light Loop before occupying the Blueprint slot; while the session is running, Blueprint equip/bind actions should be rejected with a direct wait message.
The floating area above the composer is a two-layer prompt dock: subagent activity lives above and never competes for the control slot; the lower slot is exclusive and prioritizes workflow offers over session progress. Permission and question surfaces remain blocking/decision layers outside this slot.
Loaded file context in the composer should appear as quiet removable chips inside the grounded input surface, and undo-restored context should be visible before re-send.

New-session initialization controls should sit in the composer toolbar next to the Add control as a quiet start-mode selector, not as a second row inside the typing area. Keep the selector menu data-driven so workspace mode, templates, cloud execution, and future start parameters can expand in one place while preserving the composer as a single grounded surface.

New-session initialization must use a blocking workbench progress surface whenever workspace or session setup can take visible time. The user should see compact step progress for worktree creation, session preparation, and prompt dispatch, and should not be able to operate the half-initialized session until setup completes or fails cleanly.

Session Inbox should read as a transient queue surface, not a debug overlay. Use explicit text actions for queue promotion, keep destructive actions behind secondary menus plus confirmation, make after-turn batching visible as one reply cycle, and let inbox items fill the popover width with quiet row rhythm instead of nested icon-heavy cards.

Use icons sparingly. Icons should clarify primary navigation or compact controls, not decorate every row of a form.
Product UI icons must use semantic tokens rather than raw Lucide literals. Each built-in glyph should express one user-facing concept; raw icon literals belong only inside base controls, tool-card/icon registry plumbing, file-type icons, or plugin-provided icon paths.

Treat brand assets as a hierarchy, not interchangeable decoration. SII is the institutional parent, Holos is the organization and platform behind Synergy, and Synergy is the product. The Synergy product icon is the canonical app, favicon, notification, social, and external-attribution icon; Holos wordmarks may identify the backing organization/platform layer in the app shell and account surfaces, and SII marks should only identify the institute layer.

Provider discovery should use provider profile metadata for explanatory copy and external sign-up CTAs. Settings may curate a short Recommended provider set for product guidance; custom providers remain standard alphabetical entries unless they declare metadata.

Clarifying question prompts are decision surfaces, not tool-output cards. They should use a solid outer shell, filled option rows, quiet step chips, clear disabled primary actions, and only the minimum icons needed to show disclosure or selection state.

## Accessibility & Inclusion

Target WCAG AA contrast, visible keyboard focus, reduced-motion-safe transitions, and controls whose text labels or titles explain their action.
