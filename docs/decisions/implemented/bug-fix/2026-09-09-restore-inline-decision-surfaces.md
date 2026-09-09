# Decision Record: Restore inline session decision surfaces

Status: implemented

## Problem

The UI API 5 session-page rework moved `PermissionDock` and `QuestionPrompt` out of the prompt dock column and into a single non-dismissible modal dialog pushed by a new `SessionDecisionSurface`. Every pending question or permission became a full-screen fixed overlay: a blurred backdrop covered the conversation, Kobalte's modal focus trap prevented interacting with anything else, and the question prompt's collapse control (designed for an inline dock) collapsed into a stranded pill inside the modal. When a permission and a question were pending together, both rendered inside one dialog and had to be resolved in forced serial order behind the overlay. No decision record backed the modal presentation, and it regressed the previously shipped inline dock behavior that session review flows depend on.

## Decision

Decision surfaces render inline in the native prompt dock. `SessionDecisionHost` owns them above the replaceable session page and portals them into a private native outlet. Existing custom pages without an outlet retain a protected, viewport-bounded host surface automatically. No public Plugin API changes are required. `SessionDecisionSurface` renders `PermissionDock` followed by the first pending `QuestionPrompt`, without a modal dialog. The combined stack scrolls within half the viewport, keeping both response controls reachable.

Question and permission queues keep their existing ordering — permission first, then the question — so multiple pending decisions stack vertically above the composer exactly as they did before the modal detour.

## Alternatives considered

**Keep the modal for permissions only and inline questions.** This preserves the "permission review is blocking" reading of the UI API 5 composition, but creates a modal-and-inline coexistence state machine: while the permission dialog is open, its focus trap and overlay cover the inline question, so the user must resolve the permission before seeing the question anyway, and the code carries two presentation paths plus their interaction rules. The added conditional complexity outweighs the behavior it preserves.

**Keep the modal decision surface and fix its ergonomics** (dismissible, smaller placement, restyle the collapse control). This keeps the full-screen decision model that regressed review flows and still leaves the question prompt's collapse semantics broken inside a portal; it also contradicts the documented product rule that permission and question surfaces are decision layers beside the composer rather than page-blocking dialogs.

## Consequences

Pending questions and permissions no longer block the page: users can scroll, read, and copy conversation content while a decision waits, and the status bar waiting indicator remains the ambient signal. The question prompt's collapse/expand control regains its inline meaning, and typing-into-composer focus behavior (which suppresses number-key option shortcuts while the composer is focused) matches the historical inline design. The public plugin render-part union and UI API version remain unchanged. The regression is pinned by a browser fixture that asserts both a pending question and a pending permission render inline with zero dialog nodes, and that an idle session renders no decision surface at all.
