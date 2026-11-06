# Decision Record: Frontend workbench optimization

Status: implemented

## Problem

The workbench mixes cold neutral surfaces, low-contrast supporting text and inconsistent navigation density. Floating controls use unrelated timing and some secondary actions require hover, making the same interface feel different across input methods.

## Decision

The default theme defines neutral light and dark surface families in the existing structured theme source. Generated Web and Desktop startup colors follow that source. Necessary supporting text meets 4.5:1 contrast on the canvas, navigation, input, menu and selection surfaces. An input may share the raised surface color while remaining brighter than the dark canvas; extra nested surface steps are not required.

The default Sidebar width is 260px. The existing resized flag retains explicit user widths and needs no persistence migration. Rows and shared floating controls use the existing typography and motion roles. Keyboard and touch reveal the same actions as hover. Reduced motion removes overlay spatial animations.

The greeting, conversation and Composer share one column. The greeting occupies the empty conversation region, while the Composer retains its bottom position and renders applicable status information for both new and existing tasks. A content-driven footer replaces empty reserved space. Editor and attachment growth is bounded separately. The existing domain controllers retain drafts, IME and submission semantics; presentation changes do not add another message or draft store.

The durable presentation requirements live in the [Web product rules](../../../../apps/web/PRODUCT.md); palette ownership remains in [Frontend themes and color](../../../reference/frontend-theming.md).

Narrow chat panes reposition the floating inbox above the input rather than outside the viewport. Visible message timestamps use the caption text role at full opacity. The isolated acceptance fixtures keep the real server and SDK path, classify foreground and auxiliary inference separately, and isolate Electron userData before acquiring its single-instance lock.

Theme and color-scheme selection retain their existing immediate behavior. Staged preferences such as fonts and language still use Save/Cancel; the product documentation distinguishes these boundaries explicitly.

Plain-text insertion participates in the browser's edit history. Clipboard text becomes escaped text nodes and normalized line breaks before a native editing command inserts it; clipboard markup remains literal text. Browser tests cover selection replacement, long input, blank lines, deletion, undo and redo through the existing draft owner.

Composer selectors use the shared owned Popover with a menu variant, one row-padding owner, compact rows and the same entrance/exit timing. Menu and Tooltip shadows derive from existing surface tokens without weakening modal backdrops. Compact controls hide the entire optional icon box, not only its SVG, and retain a centered square hit area. Acceptance exercises the real Add and start selectors, including geometry, focus return and open-state Tooltip suppression.

The working location strip owns project, Environment and Workspace entry points above the editor. Existing binding selectors retain their restrictions, and pending new-task choices remain distinct from bound resources. Runtime and service details remain visible below the editor even before a session exists.

The built-in macOS Shell shares the native control row with its own header. The host keeps native traffic lights and third-party Shell protection; only the built-in layout opts into integration. The native View menu retains a fullscreen action so exiting fullscreen remains reachable when traffic lights auto-hide. This avoids a new Plugin UI API or macOS window-state broadcast. Web and other desktop platforms retain their own chrome.

The built-in Shell now fully hides its sidebar and relocates restore, Search and New into one horizontal row. A retained inert body preserves scroll and disclosure identity; the App reports actual navigation occupancy for split sizing. The Shell registration boundary opts into this behavior by the built-in loader identity, including fallback rendering, rather than comparing registry entry objects (registration copies those objects). Other Shells retain their navigation behavior and host protection.

Native safe space comes from Electron Window Controls Overlay, not fixed offsets or application window-state events. Electron 42.5.0 [computes the native button rectangle and clears it in fullscreen](https://github.com/electron/electron/blob/v42.5.0/shell/browser/native_window_mac.mm#L1870-L1896); its [custom titlebar contract](https://www.electronjs.org/docs/latest/tutorial/custom-title-bar) exposes that geometry to CSS. The 48px row retains native traffic lights, while `env(titlebar-area-x)` drives the left inset. Narrow headers use the existing action menu for Search and the bottom workspace; the side-workspace toggle remains directly reachable at the outer corner.

The session header marks only its empty flex span as draggable. Its padding and full-width container stay outside native drag hit testing, leaving relocated navigation and the portaled workspace toggle clickable. Electron [excludes pointer events inside draggable rectangles](https://www.electronjs.org/docs/latest/tutorial/custom-window-interactions#custom-draggable-regions); control geometry must therefore avoid overlapping independent drag regions, regardless of visual stacking order.

Configuration remains directly reachable with differentiated emphasis: model name and one chevron, secondary thinking text, Agent name, and permission icon with its current state. Work location removes redundant chevrons. Add becomes the first circular control, and its existing section data now drives a grouped list. Model popovers use natural content height with a bounded, independently scrolling result area. These are presentation changes over existing domain controllers, without new persistence, HTTP or Plugin UI contracts.

The side-workspace toggle belongs to the full built-in session rather than the resizing conversation pane. A private App context provides its stable DOM mount; a Portal preserves the existing controller and focus while both header and tab row reserve the same corner. Custom session layouts keep their local controls, without extending the Plugin UI API. Thinking displays only the current level, with its purpose retained in Tooltip and accessible text. Working-location labels inherit one type role, and quick-switch rows reserve a trailing selection column so choosing a model cannot displace its metadata badge. Session quick switching and Settings model management pass reactive arrays to List so recent entries and newly loaded catalog models refresh without search input. Shared List selection uses its existing key contract instead of object identity, keeping the check visible when catalog entries are rebuilt after a selection or search.

## Alternatives considered

**Component-local palettes.** They would diverge from user themes, plugin surfaces and startup fallbacks, so the structured theme remains the only color source.

**Reset every saved Sidebar width.** This would erase a deliberate user preference. Only widths that were never explicitly resized adopt the new default.

**Additional animation libraries.** These changes need interruptible CSS feedback and the existing overlay lifecycle, not another motion owner.

**Center the new-task Composer and move it after sending.** The travel breaks the user's input reference point. A stable bottom position makes the first send the same interaction as subsequent sends.

The introduction content is refined by [interactive task introductions](2026-10-02-interactive-task-welcome.md), with explicit-new selection and stable local interaction.

**Rotating greetings and examples.** They add visual changes unrelated to the user's task. Stable task starters provide useful drafting and project/file actions without timed changes. They reuse revision-checked input edits, require confirmation before replacing text, and preserve attachments and working location.

**Direct DOM insertion for plain-text paste.** It bypasses native undo. The existing contenteditable editor retains a tested native editing command rather than adding a second custom history owner.

**Keep a collapsed icon rail.** It retains an otherwise unused column and separates restore/New from the session header. The built-in Shell uses zero occupancy; custom Shells retain their prior contract.

**Broadcast macOS fullscreen or infer it from size.** Native transitions across Spaces are asynchronous. Overlay geometry already owns native control exclusion and avoids restoring the unsafe broadcast path.

**Give every selector a chevron.** Identical emphasis obscures the primary choice. Accessible names, expanded state, focus and selected surfaces preserve discoverability while visual forms differ.

**Pass model memos as List loaders.** Function-valued items load when the search filter changes and do not subscribe to later catalog publication. Reactive arrays preserve the shared loader API while keeping model management current after its initial partial catalog.

**Make the full header draggable and layer independent controls above it.** Native hit testing can still consume clicks on controls outside that header's subtree. A dedicated empty flex span preserves window dragging without duplicating navigation widths or depending on z-index to resolve native input.

## Consequences

Shared colors change dependent pages as well as the main workbench, requiring both theme regression and real-surface inspection. Supporting text is deliberately stronger, while borders and decorative emphasis remain quiet. Custom themes and user font choices retain their ownership.

The static startup surface shows the product name before locale activation; transient English copy must not precede a saved Chinese interface. The workbench provider fixture recognizes scenario markers across user messages so appended runtime reminders do not silently downgrade a long-response acceptance run.
