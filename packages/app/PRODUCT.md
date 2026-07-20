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
When an agent successfully creates a Blueprint through `note_write`, the session should focus the Notes side panel on that Blueprint; replacing an existing Blueprint and ordinary note writes should stay in the message flow without opening the side panel.
When that Blueprint is created or replaced from an active Plan workflow, wait until the current turn is idle, then show a compact one-time composer control to equip the Blueprint in the current session. The control should not auto-start the BlueprintLoop, and dismissing or muting it must not close Plan by itself.
Starting a Blueprint run should keep the user on the Blueprint detail surface; the run status owns the feedback there, and session output is opened through an explicit session link.
Note and Blueprint detail document surfaces should stay stable while the user reads or edits: metadata refreshes, autosave responses, and BlueprintLoop state changes must not reset scroll position, selection, or the editor instance.
Sidebar session icons should preserve Blueprint identity while a BlueprintLoop is active: running, waiting, and auditing Blueprint sessions should remain visually distinct from ordinary running sessions and return to normal session treatment when the loop is terminal.
Note and Blueprint detail headers should use flat toolbar controls with compact rectangular hit targets; keep workflow metadata as text rows, and use divider-row popovers instead of bordered option cards inside bordered shells.
Keep dense surfaces quiet enough for repeated daily use.
Use one neutral surface system: light mode reads as a near-white canvas with white or transparent rows, hairline borders, and very light hover/selected fills; dark mode reads inward by getting brighter than its shell.
Treat that surface model as a hierarchy invariant, not a per-page decoration choice; if a page drifts blue-gray or slab-heavy, audit the token source first, then the component consumer.
Treat the semantic color palette as one complete theme contract. Every product color utility must resolve through that contract in light and dark mode; alternate themes change seeds or declared semantic overrides without bypassing the token graph. Generated boot fallbacks, runtime colors, utility mappings, and imperative renderers such as charts, terminals, editors, and embedded documents must stay synchronized from the same selected theme. Common text/background and status foreground/surface pairs meet WCAG AA contrast in every supported theme.
Paginated result sets are identified by their owning resource plus the normalized query. Same-query refresh or retry may preserve visible rows while pending. A different query is a different result set: old rows, pagination cursors, and interaction state must become invalid immediately and must never be combined with the new query.

## Interaction & Visual Principles

Treat the Holos agent as the Synergy account identity. Model subscriptions, API keys, quota windows, and provider logins belong to Providers and Usage, not Account.

User-visible high-risk operations that archive, delete, cancel, overwrite, or uninstall product data must use the shared confirmation dialog. Browser page dialogs, permission review surfaces, and runtime controls with dedicated gesture semantics may keep specialized interfaces when the domain requires it.

Holos agent profile is remote-owned identity data. Synergy may collect the initial name, description, and avatar URL when creating an agent, and may edit those fields from Account settings, but local storage should only retain the agent ID, agent secret, and timestamps. Importing an existing agent must fetch the remote profile instead of asking users to recreate or overwrite it.

Holos create and import agent dialogs should be compact identity forms: title, short prompt, fields, and actions. Do not use decorative icon blocks, alert-style cards, or local storage and verification details for ordinary explanatory text in these flows.

The Holos login callback page should behave as a transient bridge, not a destination page. On success it should confirm the agent connection, notify the opener with a strict target origin, attempt to close itself, and leave a calm fallback with a close action and Synergy return link. Desktop-originated login should open the external Holos page through the desktop shell and return through the `synergy://` app protocol instead of browser popup semantics. Failure states may include a short expandable detail, but must not show a client secret or offer dangerous fallback actions.

Account settings should present the remote Holos profile as identity first and expose identifiers as supporting metadata. Profile fields should not sit permanently on the page as an empty edit form; use an explicit edit state for name, description, and avatar URL. Log out belongs with the identity card because it acts on the current identity. Switching saved agents belongs in a focused chooser, not as a debug-style table inside the Account page. The lower-left account menu should echo the same hierarchy: profile as identity first, then switching agents.

Saved Holos agent lists should display each account's remote profile name, description, and avatar when available, including non-active accounts. Short agent IDs are supporting fallback metadata, not the primary label for agents with a reachable profile.

Keep navigation surfaces mentally aligned with where they live. Sidebar destinations such as Agenda, Library, Performance, and Plugins open in the main session-side canvas. Settings may be modal, and it should dim the whole app because it interrupts the current task.

Settings should be a human-facing preference surface, not a raw config editor. Keep common settings in a left-aligned readable measure, use switches for binary choices, guided scales for ordered multi-step values, and direct option controls for unordered choices. Do not expose inline restore-to-default options for ordinary preference controls; defaults should be reachable through the same control when needed. Reserve raw domain-file syntax for import/export or advanced configuration views. Default primary agent model should live in Models, not General.
Interface language is a global user preference with a localized Follow System choice and stable English / 简体中文 self-names. The chosen catalog applies immediately across Web and Desktop without changing the active project Scope or the language of model replies. The language self-names must not follow the active catalog, so users can always recognize an escape path after choosing a language they do not read. Startup should activate the mirrored or system-resolved catalog before localized product chrome renders, so a Chinese startup does not flash English. Catalog failure must keep a usable previous or English interface rather than mixing locales or blanking the app.
Synergy-owned labels, actions, states, accessibility text, and error wrappers localize together. User, LLM, Note, code, terminal, browser-page, and plugin-author content remains verbatim; brand names, paths, identifiers, and raw diagnostics are not translated. Locale-sensitive dates, numbers, currency, and relative time follow the active interface locale through one formatting contract.
Personalize settings owns global Custom Instructions, distinct from Library Memory and project instructions. Show the effective global `AGENTS.md` content as the editable starting point, persist user changes only through the Synergy-managed `AGENTS.override.md`, and make reset explicitly restore the primary file without overwriting it.
Settings Import should present a guided config-import surface with source selection (file, URL, or pasted JSON/JSONC), scope selection (Global or Project with a project chooser), domain-level toggles with a re-review gate when the selection changes, value-level current-versus-imported comparison, diagnostic warnings, stale-plan detection with a refresh action, and a reload-result summary after apply. Keep the import flow sequential and grounded, not a raw diff viewer or debug table.
Internal and developer settings such as formatter, lsp, and observability should be hidden by default and surfaced only through local developer mode; the ordinary Settings surface remains human-facing.
Code Checks settings should present post-write diagnostic policy as a standard-visibility Settings page. The Include Diagnostics toggle is the master switch; Diagnostic Severity and Diagnostic Scope selectors disable when diagnostics are off.
Managed-local Desktop may show Open File because its shell and server share filesystem and desktop authority. Web and Desktop external-server surfaces must show only the canonical path and Copy Path; they must not offer an action that asks a remote or headless server to launch a desktop editor. Managed Desktop opener failures must retain the canonical path and direct the user to Copy Path.

Settings typography should use the global semantic UI type tokens, not local pixel sizes or historical `text-12-*` utility classes. Page titles, section titles, row titles, body copy, control text, and captions should map to fixed rem-based roles with regular, medium, and semibold weights only. Keep the density close to Manus: comfortable enough to read as product settings, still efficient enough for a daily developer tool.

Worktree settings should aggregate only Git projects, preserve readable project results when another repository fails, and keep main or external worktrees informational. Managed deletion is a confirmed lifecycle action: show dirty and bound-session consequences, refuse active use, and refresh the list after the backend has migrated idle bindings or cleaned a stale record.

Library settings should explain learning, memory recall, and experience reuse as product preferences. Use switch controls for binary learning behavior and discrete guided scales for recall or exploration thresholds; do not present cosine similarity, top-k, or epsilon choices as raw debug parameters.
Library settings should always identify the effective embedding model. A user-configured remote model takes precedence and should be labeled as configured; the bundled local model is the visible default fallback only when no remote embedding API key is configured. Keep local download-source and file-status controls subordinate to that effective-model row, and do not expose API keys or private connection details in the summary.

Model settings should keep role routing and quick-switcher visibility together in one Models page. Specialist model roles are the first section; connected models and their quick-switch toggles are the second section. Avoid reopening a separate Manage Models modal from inside Settings.

Provider settings should behave like a connection workspace, not a config editor. Keep provider discovery, selected-provider detail, and login flows together in the Providers page; provider quota, billing, and account-health details belong in Usage. The provider list should scroll inside its own column so the selected detail remains anchored. Do not expose raw provider allow/deny text lists in the primary settings UI.

Provider authentication uses one product-facing health model across Sidebar, Providers, Usage, GitHub, and model availability. A refreshable OAuth access-token expiry remains connected; only a confirmed rejection that cannot recover becomes action required. Rate limits remain temporary availability state, and transient network or server failures offer retry without changing authentication health. Needs attention is mutually exclusive with Recommended, Connected, and Available to connect, and raw failure codes stay in diagnostics rather than primary copy.

Usage settings should read as compact account summaries, not a wide report. Keep refresh controls inside the content flow, derive quota-window names from provider semantics, use a duration only when the provider contract supplies it, show provider reset timing inline with each quota row when available, and avoid stretching quota rows across the full modal width.

The Sidebar footer contains one non-dismissible Attention rail above the account hub. Product updates retain their own state machine, while a pure selector combines update presentation with provider-auth health. Active download, install, or restart work wins; provider action-required state follows; update failures and ready updates follow after that. Multiple rejected providers aggregate into one stable notice, and resolving the underlying state removes it without a toast or dismissal preference.

Integration settings such as MCP and Email should present connection management, not protocol debugging. Use compact status rows, plain task labels, and grouped connection fields that explain what Synergy will do with the connection. Keep local command, remote endpoint, SMTP, and IMAP details secondary to the user's intent: add tools, send mail, or read mail.

Product updates are owned by the installation surface, not global server config. Desktop Settings can expose desktop-local update mode and installer progress because the Electron shell owns the app bundle and managed server process. Web Settings should show app/server version state and refresh actions only when the server reports a newer released Web client; source development and local server versions rely on Vite reload/HMR instead of persistent update prompts. Web Settings may offer server update control only when the runtime exposes a supported update path.

The desktop app should read as a native Synergy product shell, not a browser wrapper. Windows and Linux use a compact custom window chrome with the Synergy product icon, a quiet drag region, and standard window controls; closing the window hides the shell to a Synergy system tray icon with reopen and quit actions so the managed local server is not stranded. macOS keeps its native traffic-light convention with a narrow top titlebar row for the system buttons and window dragging. Keep the HOLOS sidebar header as the primary shell identity.

Desktop cold start should show a native Synergy shell immediately instead of a blank window while the managed local server and Web renderer become ready. Desktop startup UI should stay outside the main Web renderer navigation path so loading the app URL never exposes a black or white gap. The startup surface and HTML boot shell should use the same resolved desktop theme as the app: saved Light and Dark choices apply before renderer mount, System follows the OS effective mode, and a missing saved source defaults to System.
Desktop managed-local project selection should use native OS folder picking for Add/Open Project because the Electron shell and managed server share local filesystem authority. Web, remote-server, and desktop external-server project selection must browse the server filesystem instead of exposing local desktop paths; that server browser should use an explicit search action, clear base/query state, and bounded server-side browse rather than keystroke-driven recursive scanning.

Session, Agenda, Library, Performance, and Plugins should feel like one continuous workbench canvas in both light and dark modes. Their root backgrounds should align with the session message-flow background; inner surfaces can step up or down for hierarchy, but should not look like separate apps.
Session import and export are session-level portability actions. Keep them available for every open session regardless of Scope type, while Scope-specific workspace and lifecycle actions may remain limited to project sessions.
Performance and Diagnostics are developer diagnostic workbench surfaces. Organize them around evidence, current health, inflight or stale work, and recovery actions; keep raw trace IDs, span IDs, correlation IDs, and debug tables in detail or copy areas instead of making them default primary labels.

Performance should separate server process resources from registered tool child process resources. Main RSS, heap, CPU, and event-loop signals belong in the primary resource cards and charts; tool child process count, aggregate RSS, and top child memory contributors should be visible as support-oriented diagnostics without crowding the main time-series model.

Performance support cards should surface runtime retention counters plainly: session runtimes, retained Cortex tasks, pending sessions, trace evidence, and recent errors belong together as operational signals rather than as decorative dashboard metrics.

Performance is a user-controlled snapshot. Load it when the panel opens or the user changes the selected range, then keep it stable until the user selects Refresh; do not poll, refresh on visibility changes, subscribe the panel to live Performance events, or refetch charts as they enter the viewport.

Performance AI analysis should be an explicit action over the selected time window, not a continuous background opinion. Send only a bounded, redacted telemetry read model to a hidden tool-free Cortex child, show its lifecycle and Markdown conclusion in the Performance surface, and keep cancel plus durable session navigation available for control and auditability.

Session turns should render as one persisted message-part timeline. Text, reasoning while running, tool calls, media results, attachments, and render previews must stay anchored to their original part order rather than being regrouped into separate steps or response summaries.

Streaming text and reasoning should follow the model's actual deltas through frame-bounded incremental rendering; do not add an independent character-rate playback backlog that falls behind long responses.
When a text or reasoning part is superseded by later visible work in the same running turn, its presentation motion should settle immediately instead of competing with the current work. Supersession and coarse session status must not route a part that can still receive deltas through terminal Markdown. A completed Markdown render may settle once per content identity; sibling tool-state updates must not restart its transition or enhancements.

When the current running assistant step has no visible message part yet, the timeline may show a transient provider-waiting status using the backend session status text verbatim. Its current turn runtime may appear as quiet inline elapsed-time metadata after a middle dot, updating once per second without badge, chip, capsule, or button chrome. Once any real text, reasoning, tool, media, or attachment part appears for that step, the persisted part timeline takes over and the transient status disappears.

Automatic context compaction should enter the persisted turn timeline as one running compaction card as soon as the attempt starts, then update that same card in place when the continuation summary commits. Raw summary tokens must never render as ordinary assistant text. Failed or empty attempts should leave no stale running card, and manual compaction must not show a duplicate request card once the assistant-owned card exists.

Tool audit icons are a quiet exception rail, not a status badge on every tool card. Show them for pending user approval, user decisions, denials, sandbox blocks, and notable autonomous or smart auto-approvals. Hide ordinary low-risk and Guarded baseline auto-approvals so read/search/tool plumbing does not compete with the work itself. The server approval metadata is the source of truth for audit visibility; the UI should not infer visibility from risk or mode.

First-party tool-card titles should lead with a concise action phrase that tells the user what Synergy is doing, such as Read file, Search web, or Execute command. Use state phrases only for actual results or lifecycle states; do not expose a bare medium or object category such as Web, Shell, Session, or Blueprint as an action title. Preserve canonical product and technical names inside the action phrase.

Message-flow errors should remain compact by default: show a single-line error preview in a neutral workbench row with a restrained critical marker, and place the complete error text, tool input, and copy action in the shared grounded details dialog. Raw diagnostics should not expand inline and dominate the surrounding session work.

User prompts inside a turn may render as a compact right-aligned bubble with matching prompt attachments, but the turn header, tool/result timeline, media results, and diffs must keep their workbench-width timeline structure and original part order.
Turn-level file changes summarize in the message flow; detailed file diff inspection belongs in the session Review workbench surface.

### Turn diff panel states

The turn diff panel appears below each completed turn and follows the `diffState` lifecycle from the message summary:

- **pending**: The panel shows a quiet "Calculating file changes…" label with a pulsing icon. The state is hidden for the first 150 ms to avoid flashing on fast completions. The server owns timeout and restart recovery and publishes the terminal **error** state; the client does not compare `deadlineAt` with its local clock.
- **ready**: The panel displays the file list with per-file add/delete bars and a "Review changes" button. The panel enters with a subtle slide-and-fade animation (`turn-change-summary-entering`). Empty diffs (`summary.diffs` with zero length) render as hidden — only non-empty diff sets are visible.
- **error**: The panel shows "Couldn't calculate file changes" with a weak icon. No inline error details or retry action; the error state is informational only.
- **legacy (no diffState)**: A message without `diffState` but with non-empty `summary.diffs` inherits `ready` treatment to preserve backward compatibility with older histories.

Motion under `prefers-reduced-motion: reduce` disables all panel entrance transitions and the pulsing pending icon animation.

Special user-message renderers should keep workflow prompts lightweight in the message stream. Plan, Lattice, Light Loop, BlueprintLoop starts, and workflow continuation controls may use the same compact right-aligned prompt-bubble treatment with a small source badge; control messages should show a short human-readable summary by default rather than raw loop IDs, internal prompt text, or heavy centered event cards.

Turn titles are navigation metadata, not conversation content; keep them in the session timeline or session-level chrome, and place user-prompt timestamps and copy controls outside the prompt bubble as low-emphasis metadata. Collapsed user-prompt expansion belongs inside the prompt bubble at the truncation edge, not in the external metadata row.

Copy controls should use the shared clipboard capability and shared copied/failed feedback. Success is shown in the triggering control, while failures use the global error toast; do not add local `navigator.clipboard` or `execCommand` implementations in product UI.

Markdown code blocks in the message stream are document content surfaces, not form controls. In light mode they should stay close to the white workbench surface with a hairline border and low-emphasis copy control; in dark mode they may keep the inward-brighter relationship.

Session timeline spacing should follow semantic rhythm: compact spacing for consecutive text, tighter grouping for consecutive tool events, and more breathing room when moving between prose and tool/media blocks. Once adjacent timeline items mount, Markdown settlement and item entrance effects must preserve their measured gap. Avoid stacking narrow one-off adjacent selectors that make reasoning, text, and tools feel randomly packed.

Conversation attachment display should be owned by each attachment's presentation policy. Tool metadata may hide or show the tool card, but must not choose primary attachments, promote media results, or override attachment sizing outside the persisted part order. Media such as memes should render as message content at a bounded conversational size, while screenshots and documents can opt into larger or file-style presentation through attachment-level fields.
Image preview is a grounded modal viewer for previewable image attachments, with quiet metadata, separated viewer controls, zoom/pan/rotate, load failure fallback, and gallery navigation that preserves the owning attachment scope and order. Composer image attachments share one prompt-local gallery before send; sent attachment galleries keep their message-local scope.

Child sessions are normally session-local context and should be reachable from the current session's StatusBar rather than the global sidebar. Keep the child-session button persistent, but load children lazily only when the user opens its StatusBar panel. Show them as a compact paginated recent-activity switcher ordered by each child session's latest update time, with search, previous/next paging, and running or waiting state visible in the row. The panel content should fill the Popover body's scoped width instead of introducing a narrower nested fixed-width shell. GitHub-triggered automation is the explicit exception: when both GitHub App environment credentials are configured, its provenance-marked parent and child sessions appear together in a dedicated cross-Scope GitHub Sidebar section between Background and Projects.
Opening a related session may create an in-app Back target, but returning to a parent session is hierarchical navigation: restore a verified parent history entry when available, otherwise replace the child route with the canonical parent route, and never make the child the parent's Back target.
Sidebar completion dots are quiet workflow-state reminders backed by persisted session completion state. Show them as restrained critical-color dots on session icons only after a run finishes, clear them when the session is opened, and never infer them from timestamps, category, source names, or local runtime status. Sidebar session and project ordering should advance once when a reply starts and once when it completes, but remain stable during in-flight updates so parallel active sessions do not make navigation targets jump.
Desktop unread indicators mirror the same persisted completion-notice state across the complete global root-session index, not only the currently loaded sidebar page. macOS uses a numeric Dock badge, Windows uses a taskbar overlay with an exact accessible count, and Linux uses launcher integration plus a tray fallback. Window focus or hide-to-tray must not clear this state; opening the owning session does.

Opening a workbench panel should not force the session message stream or prompt composer into a separate narrow fixed measure. Keep the session column at its normal readable working measure and let it shrink only when the actual pane width requires it. The normal session measure should feel like a broad workbench column for coding and tool-rich conversations, not a narrow chat lane. In constrained panes, preserve a minimum horizontal gutter around the message stream and tool cards so they do not visually stretch.

Plugin-contributed navigation, settings, workbench, message, and composer surfaces should use the same visual and interaction contracts as first-party Synergy surfaces. Plugin sidebar destinations appear as peer workbench entries after Agenda, Library, Performance, and Plugins; plugin workbench panels remain session-scoped side or bottom workspace surfaces and should not replace the global sidebar navigation model.

Schema-driven plugin settings use the same SettingRow, Switch, field controls, typography, optimistic save, and rollback notification as first-party settings. Resource-aware plugin panels behave like document tabs: the same panel/resource identity reuses a tab, distinct resources open distinct tabs, and opaque resource state reaches the plugin surface without route inference.

Side Workspace and BottomSpace are symmetric extensible session workbench surfaces. Each surface opens from top-bar controls, starts with a compact launcher list, and hosts registered panel tabs with one shared density, resize, keyboard, and neutral-surface contract. Interactive resizing should update the occupied surface size immediately; open and close transitions may animate, but drag-driven size changes should not lag behind the content. Terminal is one BottomSpace panel with multi-tab behavior, not the bottom surface itself.

Workbench panel tabs should behave like compact document tabs: close affordances appear on hover or keyboard focus without reserving label width, use a solid masked background over text, the add control sits directly after the current tab run rather than at the far edge, and its portalled menu must remain visible outside the horizontally scrolling tab strip. Launcher/add menus hide singleton panels that are already open. Singleton panels such as Notes, Context, Review, and Browser can coexist as separate side-workspace tabs, while Files opens resource tabs keyed by Scope-relative file path.

Optional workbench panels should load their implementation only when opened. Notes, Context, Files, Browser, Terminal, and Review may register lightweight metadata in the session shell, but their editors, renderers, engines, diagnostics, and other feature resources must remain behind the workbench loader boundary. The default session route should not preload a panel the user has not opened.

Context is a session-scoped Side Workspace singleton. The status-bar context ring is a compact usage indicator and opens the Context panel instead of expanding inline. The panel shows exact latest-call input usage when available, a category breakdown from backend `AssistantMessage.contextUsage` snapshots after the next response, progressive usage and developer details, a Compact action when usage is high, inline system-instruction disclosure with copy, and a separate entry point to Raw Messages.

Raw Messages is a secondary dedicated dialog launched from Context. It uses the existing raw session-message API, warns that prompts, tool inputs, file excerpts, and model output may be sensitive, supports loading more records, selecting loaded messages, previewing JSON, and copying only the current or selected records. Present it as a compact inspector: use flat joined list and preview panes, show only exceptional message flags, let identifiers use available width while preserving their stable tail, reveal batch actions only after selection, and give JSON an explicit soft-wrap toggle alongside independent scrolling. Raw message inspection should not become the primary Context panel surface.

Files belong to the Side Workspace as resource tabs, not to Context. Choosing Files from the launcher or add menu creates an empty file tab and opens its Explorer immediately; file selection happens in that persistent Explorer, never in a separate search dialog. The first selected file replaces the empty tab in place. A canonical Scope-relative path identifies a populated file tab, so reopening the same path activates the existing tab; duplicate basenames gain only the shortest parent suffix needed for disambiguation. File tabs use the shared colored file-icon sprite, support horizontal scrolling, keyboard traversal, middle-click close, and drag ordering. Session state owns open files, active file, source/preview mode, selections, scroll positions, and Explorer width/visibility. Scope state owns expanded folders and the hidden/ignored preference.

The File workbench is a read-only inspection surface. Markdown and SVG offer Source and Preview; text/code offers Source; common raster images offer Preview; unsupported binary formats show a clear reason and metadata. Source uses a lazy Monaco instance without edit, save, suggestions, or minimap, and derives both light and dark editor colors from the active workbench surface tokens. The 40 px file toolbar keeps the breadcrumb visually primary, exposes Source/Preview only when both are meaningful, and uses a dedicated file-tree semantic icon for the Explorer toggle. Files reach the Composer context only through an explicit user action such as Add to context; opening or activating a file never includes it implicitly. Narrow panes present Explorer as an internal drawer without changing the saved open preference.

File navigation must stay server-authoritative in Web and every Desktop mode. The Explorer uses paged lazy directory reads, a virtual flat row model, bounded caches, background stale refresh, and watcher updates. It preserves usable stale content during disconnects, keeps deleted open files visible with an explicit state, updates paths in place on rename, and never exposes absolute client paths in tab identity or user-facing errors. Hidden and ignored files are one explicit preference; showing them permits manual browsing but does not make ignored trees candidates for recursive watching or global indexing.

Library modes are peer views inside the main workbench, not a settings-style secondary sidebar. Put Overview, Memories, Experiences, and Skills in a top tab control aligned with Agenda's Schedule/History pattern, and keep those Library tabs text-only unless an icon adds necessary meaning.

Library content should not expand just because the viewport is wide. Use a centered working measure for Library dashboards and item grids, and let only genuinely tabular or timeline surfaces earn full width. Keep tab-level controls in one predictable toolbar: filter on the left, search or secondary actions on the right, with refresh/recompute/reload actions presented in that toolbar instead of scattered inside each section.

Library tab controls should share the same visual contract as Agenda tab controls. Descriptive labels such as Snapshot or Usage stats are not actions; do not style them as pills or buttons unless they can be clicked. Detail dialogs for library items should use the same grounded modal language as Agenda forms: one solid shell, section labels, light row dividers, and no debug-style boxes nested inside boxes.

Plugin Marketplace should share Agenda and Library's compact workbench language: a text title in the upper-left, fixed-height source tabs, a centered readable measure, and list rows that open grounded detail dialogs. Plugin detail should present install, update, uninstall, repository, version, permission, and trust information as human-facing controls and sections, not as raw registry/debug data.

The Browser workspace should feel like a browser window inside the workbench. Desktop mode uses the local native browser view; Web and remote Desktop use WebRTC video with data-channel input. A Synergy session has one Browser page, and an empty or suspended Browser workspace is a valid state. Opening the workspace only reads state; an existing active tool page resumes into the selected presentation once, while empty and suspended state remains passive. The first address-bar or browser-tool navigation activates a missing page, and later commands reuse it. If navigation creates a page while the workspace is already open, the live page surface should replace the waiting state immediately; a canonical URL without a visible surface is not a connected state. The server-provided owner key is the only identity used for tickets and native attachment. Closing the workspace detaches presentation without destroying a page still used by tools. Both presentation modes should preserve click focus, the page's visible text caret, IME composition, paste, wheel, and keyboard shortcuts. Treat Host installing/pending/ready/loading as connection state; show structured failures only when an operation actually fails.

Browser controls should read as a compact product menu, not a debug drawer: use standard switch, segmented, selected-row, and local-navigation affordances with workbench spacing and surface tokens.

Session MCP controls should read as connection management, not raw runtime status. Use settings-style search, summary, status rows, and switches; keep error details secondary and avoid debug-list styling in the session modal.

Surface Rule: light mode uses a near-white workbench canvas, white or translucent row surfaces, neutral hairline borders, and restrained hover/selected fills instead of stacked blue-gray slabs. Dark mode keeps the established inward-brighter relationship. Treat selected rows, active tabs, chips, tool cards, form fields, popovers, calendar cells, scheduled items, and provider/account rows as content surfaces; they should follow the same token graph unless a semantic status color is doing real state work. This is a unified visual rule, not a per-page decoration choice.

When a surface violates the neutral workbench model, first identify whether the theme source or the consuming component is wrong. Prefer fixing the relevant scoped token graph or component class mapping at the source.

Favor grounded, pragmatic surfaces over obvious glassmorphism. A little translucency or floating quality is acceptable for transient overlays, but heavy transparency, blur, glow, and decorative shadows make the product feel less grounded. Do not remove all translucency reflexively; keep it subtle enough that the surface still feels solid.

Use black, white, and neutral ramps as the primary visual language. Blue is a state color for active or running work, not a default accent for selection or decoration.

Avoid border-on-border clutter. Joined panels should join cleanly, with no double rounded corners at seams and no unnecessary nested-card outlines.

For item detail popovers, let the popover itself be the outer card. Use section labels, row rhythm, and light dividers inside; do not put large bordered Task, metadata, or history boxes inside another bordered container.

Form controls should have quiet filled surfaces. In dark mode, controls should be slightly brighter than their container; in light mode, controls should sit on the shared neutral input fill rather than a blue-gray slab. Required-action buttons stay disabled until the required inputs are valid.
Dialogs should share a grounded modal language and behavior without sharing one forced size. Use semantic dimensions such as compact, form, list, wide, command, and content to express the dialog's job, then let specialized panels such as Settings, Agenda, Plugin, Library, Worktree, Confirm, MCP, and image preview surfaces keep their domain-specific layouts when those layouts are intentionally designed. Dialog actions should use the shared button rhythm and a clear footer edge; avoid tiny debug-style buttons, non-uniform footers, and double-wrapped action rows.
Timeline rewind confirmation should read as a consequence summary with one optional file action, not as rollback debug output. Collapse message and reply counts into plain outcome copy, hide file restore controls when no files are affected, and avoid per-row decorative icons or file chips unless the user explicitly expands file details.

Prompt composers should read as one grounded input surface with a quiet bottom toolbar. Ordinary mode, agent, permission, and add controls should behave like toolbar buttons rather than separate bordered pills; reserve filled chips for active modes, pending state, or meaningful workflow status. Composer add and initialization menus should use the shared toolbar selector and list primitives rather than bespoke popover themes. Composer controls that are secondary to sending should compact to icon-only controls, and the composer should keep a stable toolbar density so mode chips do not shift the input area or toolbar height during composing.
Workflow modes in the composer should stay symmetric: menu actions arm a mode, configured modes may open a focused dialog before arming, active modes render persistent toolbar chips, and those chips are the cancellation affordance. While a session is running, workflow-mode cancellation chips should stay visible, visually dimmed, and guarded with a direct wait message.
Light Loop is armed from the composer menu without a dialog; the next non-empty normal user message or backend prompt command becomes the task description, with attachments and references included only as compact context. Frontend UI commands and backend action commands do not start Light Loop. Ordinary composer submit requires text, except stopping a running session or starting an equipped BlueprintLoop.
An active Light Loop also owns a compact task control beside Submit while its toolbar chip remains visible. Clicking the control opens the current task: idle sessions may edit it, while running, completion-review, or remotely exited states show it read-only. Holding the control for two seconds is the dedicated safe-exit gesture; it stops active session work, cancels completion review, and clears Light Loop.
Equipping a user Blueprint while idle exits Plan or Light Loop before occupying the Blueprint slot; while the session is running, Blueprint equip/bind actions should be rejected with a direct wait message.
The floating area above the composer is a two-layer prompt dock: subagent activity lives above and never competes for the control slot; the lower slot is exclusive and prioritizes workflow offers over session progress. Permission and question surfaces remain blocking/decision layers outside this slot.
Loaded file context in the composer should appear as quiet removable chips inside the grounded input surface, and undo-restored context should be visible before re-send.

New-session initialization controls should sit in the composer toolbar next to the Add control as a quiet start-mode selector, not as a second row inside the typing area. Keep the selector menu data-driven so workspace mode, templates, cloud execution, and future start parameters can expand in one place while preserving the composer as a single grounded surface.

Ordinary and worktree-backed new sessions should publish compact transition progress into the target session conversation before navigation exposes that route. A half-initialized session must never appear as an actionable empty page: preparation and first-message dispatch stay visible in the conversation, successful transitions remain for three seconds and then fade out, and errors remain until retry or dismissal. The session transition card is distinct from the composer’s DAG/Todo progress island and the two product layers must not be merged.

Session Inbox should read as a transient queue surface, not a debug overlay. Use explicit text actions for queue promotion, keep destructive actions behind secondary menus plus confirmation, make after-turn batching visible as one reply cycle, and let inbox items fill the popover width with quiet row rhythm instead of nested icon-heavy cards.

Use icons sparingly. Icons should clarify primary navigation or compact controls, not decorate every row of a form.
Product UI icons must use semantic tokens rather than raw Lucide literals. Each built-in glyph should express one user-facing concept; raw icon literals belong only inside base controls, tool-card/icon registry plumbing, file-type icons, or plugin-provided icon paths.

Treat brand assets as a hierarchy, not interchangeable decoration. SII is the institutional parent, Holos is the organization and platform behind Synergy, and Synergy is the product. The Synergy product icon is the canonical app, favicon, notification, social, and external-attribution icon; Holos wordmarks may identify the backing organization/platform layer in the app shell and account surfaces, and SII marks should only identify the institute layer.

Provider discovery should use provider profile metadata for explanatory copy and external sign-up CTAs. Settings may curate a short Recommended provider set for product guidance; custom providers remain standard alphabetical entries unless they declare metadata.

Online account model discovery accepts future model slugs without a client allowlist. When live discovery cannot be verified because of a transient failure, stable fallback models may remain visible but must be labeled as a fallback catalog; authentication rejection instead makes the provider unavailable and routes to recovery.

Clarifying question prompts are decision surfaces, not tool-output cards. Answer options are the primary visual anchor: use a solid outer shell, generous filled option rows, visible keyboard focus and number shortcuts, quiet question context and step chips, clear disabled primary actions, and only the minimum icons needed to show disclosure or selection state. Progress, timeout, and low-frequency actions remain secondary chrome; conversational custom-answer copy should invite the user to tell Synergy how to proceed.

## Accessibility & Inclusion

Target WCAG AA contrast, visible keyboard focus, reduced-motion-safe transitions, and controls whose text labels or titles explain their action.

Mobile drawers and overlay workspaces are modal interaction surfaces: give them an accessible name, move focus inside when opened, contain keyboard traversal, close on Escape, and return focus to the opener. At narrow widths, toolbars reflow inside their surface; controls must not become unreachable through clipping or hidden horizontal overflow.
