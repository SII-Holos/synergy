# Browser fixtures

Use standards-mode fixture documents for composed interaction tests. Include the workbench's root overflow and scroll ancestors when testing keyboard menus; a trigger that passes on an unconstrained document can fail in the real panel. Cover Enter, Space, opening arrow keys, disabled items, selection and focus return.

For Virtua row measurements, collect resize notifications before publishing reactive size changes on an animation frame. The owning process viewport commits following and edge chrome during its own ResizeObserver delivery, before the next paint. Read geometry before writes, skip unchanged size styles and cancel pending work on disposal. Capture `window` error events as well as Playwright `pageerror`: ResizeObserver delivery errors can bypass `pageerror`. Exercise disclosure, late hydration, viewport resize, reading anchors and rapid unmounts against both dependency entrypoints when patching a virtualizer. Record pinned patch provenance and upgrade removal criteria in [Dependency patches](../../../../patches/README.md).

Measure disclosure height only when a height transition will actually run. Large nested virtualized windows use stable-size opacity transitions; retain height motion for individual rows. Compare forced layout time as well as observer errors against the same production fixture: removing delivery errors alone does not establish a performance improvement.

Wait for virtualized controls to become visible before focusing them and sending keys after deferred measurement. Assert the actual focused element so activation cannot silently reach the preceding control.

Cover hiding and restoring virtualized lists between resize delivery and deferred publication. Reject notifications from targets without layout boxes during delivery, while retaining valid zero-size measurements. Read a virtual line's geometry in the same locator evaluation that resolves it; a separate element handle can be detached by renderer reflow before its box is read.

Audit opened dropdowns as well as their triggers. Feature-page choices reuse `MenuField`; verify the selection check independently of hover, themed portals, long labels and short/narrow viewports. Listbox Escape must dismiss its owning popup without clearing a multi-selection or reaching the parent Dialog. Wait for popup removal and settled trigger focus before asserting restoration.

When a shared component gains a provider dependency, update every direct DOM fixture that mounts it and run those suites together. Mount the real shared UI provider and use getter-based children so Solid constructs descendants within its owner; file preview and menu fixtures must exercise the same navigation dependencies as the product page.

When a menu suppresses its trigger Tooltip, preserve the trigger element, focus listeners and flex-item wrapper geometry. Verify suppression inside a dialog as well as the Composer; long names must not push adjacent labels onto another line. Exercise focus → open → Escape → focus return with the real composed controls. A menu action that opens a Dialog must hand off a connected return-focus target; an unmounted menu item is not one. Distinguish a visible path Tooltip consuming Escape from a parent dialog failing to close.

When a nested Solid control must consume Escape before a document-level workspace listener, use a native `on:keydown` handler at the active control boundary; delegated `onKeyDown` runs after document listeners. Test that Escape closes only the nested control and returns focus without navigating or closing its parent surface.
