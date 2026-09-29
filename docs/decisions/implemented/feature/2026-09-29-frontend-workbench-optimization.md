# Decision Record: Frontend workbench optimization

Status: implemented

## Problem

The workbench mixes cold neutral surfaces, low-contrast supporting text and inconsistent navigation density. Floating controls use unrelated timing and some secondary actions require hover, making the same interface feel different across input methods.

## Decision

The default theme defines neutral light and dark surface families in the existing structured theme source. Generated Web and Desktop startup colors follow that source. Necessary supporting text meets 4.5:1 contrast on the canvas, navigation, input, menu and selection surfaces. An input may share the raised surface color while remaining brighter than the dark canvas; extra nested surface steps are not required.

The default Sidebar width is 260px. The existing resized flag retains explicit user widths and needs no persistence migration. Rows and shared floating controls use the existing typography and motion roles. Keyboard and touch reveal the same actions as hover. Reduced motion removes overlay spatial animations.

The greeting, conversation and Composer share one column. The greeting occupies the empty conversation region, while the Composer retains its bottom position and reserves the status footer. Editor and attachment growth is bounded separately. The existing domain controllers retain drafts, IME and submission semantics; presentation changes do not add another message or draft store.

The durable presentation requirements live in the [Web product rules](../../../../apps/web/PRODUCT.md); palette ownership remains in [Frontend themes and color](../../../reference/frontend-theming.md).

Narrow chat panes reposition the floating inbox above the input rather than outside the viewport. Visible message timestamps use the caption text role at full opacity. The isolated acceptance fixtures keep the real server and SDK path, classify foreground and auxiliary inference separately, and isolate Electron userData before acquiring its single-instance lock.

Theme and color-scheme selection retain their existing immediate behavior. Staged preferences such as fonts and language still use Save/Cancel; the product documentation distinguishes these boundaries explicitly.

Plain-text insertion participates in the browser's edit history. Clipboard text becomes escaped text nodes and normalized line breaks before a native editing command inserts it; clipboard markup remains literal text. Browser tests cover selection replacement, long input, blank lines, deletion, undo and redo through the existing draft owner.

Composer selectors use the shared owned Popover with a menu variant, one row-padding owner, compact rows and the same entrance/exit timing. Menu and Tooltip shadows derive from existing surface tokens without weakening modal backdrops. Compact controls hide the entire optional icon box, not only its SVG, and retain a centered square hit area. Acceptance exercises the real Add and start selectors, including geometry, focus return and open-state Tooltip suppression.

## Alternatives considered

**Component-local palettes.** They would diverge from user themes, plugin surfaces and startup fallbacks, so the structured theme remains the only color source.

**Reset every saved Sidebar width.** This would erase a deliberate user preference. Only widths that were never explicitly resized adopt the new default.

**Additional animation libraries.** These changes need interruptible CSS feedback and the existing overlay lifecycle, not another motion owner.

**Center the new-task Composer and move it after sending.** The travel breaks the user's input reference point. A stable bottom position makes the first send the same interaction as subsequent sends.

**Rotating greetings and examples.** They add visual changes unrelated to the user's task. A stable prompt leaves attention available for drafting and reading.

**Direct DOM insertion for plain-text paste.** It bypasses native undo. The existing contenteditable editor retains a tested native editing command rather than adding a second custom history owner.

## Consequences

Shared colors change dependent pages as well as the main workbench, requiring both theme regression and real-surface inspection. Supporting text is deliberately stronger, while borders and decorative emphasis remain quiet. Custom themes and user font choices retain their ownership.

The static startup surface shows the product name before locale activation; transient English copy must not precede a saved Chinese interface. The workbench provider fixture recognizes scenario markers across user messages so appended runtime reminders do not silently downgrade a long-response acceptance run.
