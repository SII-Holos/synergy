# Decision Record: Restore inline session decision surfaces

Status: implemented

## Problem

The UI API 5 session-page rework moved `PermissionDock` and `QuestionPrompt` out of the prompt dock column and into a single non-dismissible modal dialog pushed by a new `SessionDecisionSurface`. Every pending question or permission became a full-screen fixed overlay: a blurred backdrop covered the conversation, Kobalte's modal focus trap prevented interacting with anything else, and the question prompt's collapse control (designed for an inline dock) collapsed into a stranded pill inside the modal. When a permission and a question were pending together, both rendered inside one dialog and had to be resolved in forced serial order behind the overlay. No decision record backed the modal presentation, and it regressed the previously shipped inline dock behavior that session review flows depend on.

## Decision

Decision surfaces render inline in the prompt dock column again, restoring the pre-UI-API-5 layout. `SessionDecisionSurface` is a plain component that renders `PermissionDock` followed by the first pending `QuestionPrompt` for the session, with no `Dialog` involved. The prompt dock renders it at the top of the active-input branch through the composer layout service, so host-owned decision views flow through the same UI API 5 presentation contract as the other dock parts: `PluginComposerLayoutService.render` gains a host-owned `"decision"` part, and the session page implements it. Plugins consume the part union through `render()` and are unaffected; the binding layer already forwards parts opaquely.

Question and permission queues keep their existing ordering — permission first, then the question — so multiple pending decisions stack vertically above the composer exactly as they did before the modal detour.

## Alternatives considered

**Keep the modal for permissions only and inline questions.** This preserves the "permission review is blocking" reading of the UI API 5 composition, but creates a modal-and-inline coexistence state machine: while the permission dialog is open, its focus trap and overlay cover the inline question, so the user must resolve the permission before seeing the question anyway, and the code carries two presentation paths plus their interaction rules. The added conditional complexity outweighs the behavior it preserves.

**Keep the modal decision surface and fix its ergonomics** (dismissible, smaller placement, restyle the collapse control). This keeps the full-screen decision model that regressed review flows and still leaves the question prompt's collapse semantics broken inside a portal; it also contradicts the documented product rule that permission and question surfaces are decision layers beside the composer rather than page-blocking dialogs.

## Consequences

Pending questions and permissions no longer block the page: users can scroll, read, and copy conversation content while a decision waits, and the status bar waiting indicator remains the ambient signal. The question prompt's collapse/expand control regains its inline meaning, and typing-into-composer focus behavior (which suppresses number-key option shortcuts while the composer is focused) matches the historical inline design. The plugin render-part union grows by one host-owned member; the UI API major version is unchanged because existing plugins only call `render()` and never implement it. The regression is pinned by a browser fixture that asserts both a pending question and a pending permission render inline with zero dialog nodes, and that an idle session renders no decision surface at all.
