# Decision Record: Page-bound Browser presentation

Status: implemented

## Problem

Retained Browser panels share a page catalog but represent different resource tabs. A catalog-wide selected page makes every retained panel observe the same mutable target, so selecting one tab can redirect another panel's controls and native attachment. Treating refreshed tab metadata as a new route also replaces controls during ordinary title or URL updates.

Native presentation has separate ownership requirements. The first layout measurement can be zero, and a later resize must be able to establish the attachment rather than only resize a view that never attached. A renderer-generated minimum viewport and an independent native bounds path can disagree about the available space. Treating every error as an overlapping blocker hides usable pages, including after a failed popup operation. Popup adoption also needs its navigation policy in place while asynchronous setup is pending, not only after the child has begun loading.

## Decision

The shared `createBrowserStore` owns page data and transport state, not human selection. Each retained panel uses `forPage` with its tab's `resourceId`, keeping its controls local and its command target stable. The workbench owns selection. Route equality ignores metadata replacements that leave the route unchanged, preserving the input instance and draft without remounting the panel. Sequenced events and snapshots are authoritative for existing page metadata; HTTP command results only acknowledge execution. Their embedded page state can precede later title, load or close events even when the HTTP response arrives last.

Open replies identify the new page but do not write historical metadata. The initiating panel receives the canonical catalog row, using one guarded snapshot when events have not delivered it. HTTP snapshot watermarks apply only to metadata, not the consumed-event or replay cursor. Both open confirmation and catalog refresh preserve pending dialogs, file choosers and errors while suppressing stale metadata writes; an old error cannot reset a newer loading state. Closed or suspended pages cannot be resurrected by a late open reply. Profile copies register a new peer tab instead of changing the source panel's target. Activation depends on whether that panel is still active; both the reply and workbench commit check the captured Session. Catalog membership can outlive the initiating selection without granting a late reply authority over another Session's layout.

`NativeBrowserSurface` measures the content region and uses its owner/page lease to serialize attachment, resize and detachment. The first finite positive measurement attaches the page, including after reactivation. `BrowserSurface` does not send automatic HTTP viewport commands or invent minimum fit dimensions. The native manager owns displayed bounds and host-zoom conversion. Desktop uses a default or last viewport and drawable surface size while detached, and releases that override on attachment. Metrics requested while attached specify `dontSetVisibleSize: true` so they do not lock Electron's visible surface to the default dimensions. Explicit fixed viewport commands remain independent of attachment; fit clears fixed emulation and restores the native size appropriate to the attachment state.

Electron 42.5.0 does not propagate detached bounds to the document viewport, the defect addressed upstream by [Electron PR #53031](https://github.com/electron/electron/pull/53031). A detached default is therefore still needed for Agent observation and screenshots. The adapter's attach/detach handoff preserves that capability without introducing a CDP resize loop. Its serialized transitions preserve ordering with immediate page commands and disposal.

Cross-platform native acceptance also demonstrated that viewport dimensions alone do not ensure a drawable compositor surface: screenshots can stall before a page's first presentation or after detachment. A screenshot therefore holds a temporary hidden attachment to the existing Desktop window. Concurrent captures share the lease; its final release removes only the capture attachment, preserving a human selection made in the meantime. Failures release it as well. This keeps the existing page and profile alive without a second window, focus changes or a replacement rendering engine. Native regression fixtures cover both first capture and fixed/fit capture after repeated detachments on macOS and Linux.

Errors occupy an inline row above native content bounds. Error presence is not a visibility blocker; actual overlapping menus, dialogs and other controls retain the final-blocker rule. Popup adoption installs the child's initial navigation policy before the first asynchronous setup step, retaining Electron's supplied browsing context and limiting the grant to the initial navigation and its main-frame redirects.

This refines retained-panel presentation alongside [Session Browser Workspace tabs](2026-10-12-session-browser-workspace-tabs.md) and [Workspace menus over native Browser](2026-10-12-workspace-native-browser-menus.md). Their tab-membership and menu-ownership decisions remain in force. Current implementation invariants live in [Browser runtime](../../../architecture/browser-runtime.md#renderer-presentation).

## Alternatives considered

**Keep a shared `selectedPageId` and synchronize it on activation.** Rejected because inactive panels remain mounted and continue observing that field. A correct foreground selection cannot make one mutable catalog target represent several retained resources, and asynchronous replies can arrive after selection changes.

**Remount panels or refresh the catalog to repair selection and attachment.** Rejected because it conceals the ownership error by discarding local state. It interrupts address edits, repeats preparation and makes presentation depend on metadata timing rather than resource identity.

**Clamp fit dimensions and keep both HTTP viewport updates and native bounds writes.** Rejected because a synthetic minimum does not establish that the renderer has measurable space. Two layout-driven writers can apply different dimensions and confuse viewport emulation with native presentation; a resize-only path still cannot recover a missed initial attachment.

**Hide native content whenever any error is present.** Rejected because an error reports an operation outcome, not necessarily an unusable page or overlapping control. Global suppression turns a local failure into lost browsing access and makes dismissal a prerequisite for using unaffected content.

## Consequences

Page data remains shared while panel controls and selection retain their own owners. Per-panel controls add renderer-local state whose lifetime follows the retained panel; they are not synchronized through the catalog. Explicitly shared pages still share navigation and closure across Sessions. A late copy may exist in the catalog without being selected, and a Session change prevents its UI completion from adding a tab to the new layout.

Native presentation depends on actual positive layout measurements instead of guessed dimensions. Inline errors consume vertical space, so the measured webpage region must respond to their appearance and dismissal. Fixed emulation and fit have distinct command behavior, including an optional viewport mode in the strict schema. Popup setup owns an initial-navigation grant that must be cleared on commit, stopped loading, rejection or superseding navigation rather than reused as general navigation authority.

These choices preserve page and profile identities without a persistence migration. Regression procedure belongs in [change-browser-runtime](../../../../.synergy/skill/change-browser-runtime/SKILL.md#verification).
