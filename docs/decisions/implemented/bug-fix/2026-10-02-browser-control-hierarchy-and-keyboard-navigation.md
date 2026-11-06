# Decision Record: Browser control hierarchy and keyboard navigation

Status: implemented

## Problem

Browser navigation controls inherit filled disabled backgrounds because the toolbar does not attach its specialized quiet-control styles. Its actions use a titled popover containing another painted menu, which creates redundant chrome and inconsistent spacing. The new-tab import action has the visual weight of a primary operation. Address suggestions support pointer clicks but lack keyboard selection and dismissal that preserves Workspace focus.

Address focus is also used during blank-page mounting and focus restoration. Treating every focus event as a suggestion request expands recent history without user input, including when the history arrives asynchronously.

Native page panels also clear the shared catalog's presentation when mounting. If metadata or the WebSocket has already delivered its native state, switching a resource leaves the page waiting indefinitely despite a healthy native page.

## Decision

Attach Browser navigation styling to the shared icon buttons, keep their bounds stable across states, and place external opening inside the rounded address field. Use the shared Popover menu variant as the single painted actions surface, with muted unavailable rows, shortcut hints and compact zoom controls. The native trigger preserves Popover events, ref and accessible label. Toolbar tooltip behavior follows [quiet Browser toolbar icons](../simplification/2026-10-27-browser-toolbar-without-tooltips.md).

Move keyboard focus through visible enabled menu controls and exclude collapsed disclosure descendants explicitly: Chromium can still report their layout rectangles. Address suggestions expose a combobox and listbox, retain input focus during selection, and navigate only on explicit submission. Editing focus and a suggestion request are independent: mounting focuses a blank address without requesting history, while a field click, typing, directional selection or the address shortcut requests suggestions. Blur and Escape clear the request so focus restoration cannot reopen it. Composing Enter cannot navigate, and Escape dismisses suggestions without collapsing the Workspace. Blank pages keep print and zoom shortcuts inactive, matching the available menu actions.

The new-tab search and import footer live in a small shared view so rendered interaction tests cover the shipped entry. Its import button uses a quiet secondary affordance while the source-picker dialog retains the explicit Import operation.

Initialize presentation from metadata in the shared catalog before opening its transport. Native page panels consume that state without resetting it; subsequent WebSocket updates remain authoritative. Reading metadata does not attach or allocate a native view. Mounting a page or switching peer resources attaches the existing page and preserves the catalog's current presentation.

## Alternatives considered

**Changing every shared disabled icon button** would broaden this fix into unrelated surfaces. The Browser-specific control class provides the intended states using existing workbench tokens.

**Keeping the default titled popover and painting an inner menu** retains duplicate surfaces and unnecessary dismissal controls. The existing menu variant already supplies portal ownership, dismissal, motion and focus restoration.

**Checking layout rectangles alone for keyboard targets** fails for collapsed details. Explicit disclosure visibility preserves access to expanded diagnostics without sending focus to hidden controls.

**Removing address autofocus** avoids an unsolicited list but also prevents immediate typing after opening a blank tab. Independent suggestion intent preserves both behaviors.

**Suppressing suggestions only during the mount call** leaves delayed history and later focus restoration able to reopen them. The request remains false until an explicit interaction and resets on blur.

## Consequences

The Browser retains its existing native page, command and overlay ownership. Action menus and suggestions hide native content while needed and restore it after the last blocker closes. Tab focus alone keeps recent history hidden, so keyboard users request it through typing, Up/Down or the address shortcut rather than Tab focus. Desktop DOM regressions cover disabled and hover styles, stable bounds, directional focus, cached and delayed history after autofocus, remounting, blur/focus restoration, suggestion selection, composition, narrow geometry, reduced motion, import entry and overlapping native blockers. Catalog regressions cover metadata-only initialization and presentation delivered before peer panels mount. Real Desktop inspection remains necessary for native page rendering and visual acceptance.
