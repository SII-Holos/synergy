# Decision Record: One explicit save for project settings

Status: implemented

## Problem

Project settings present one dialog but expose separate Save buttons for the project name, folders and new-task starting point. Cancel therefore does not describe one editing boundary. The main-folder/Worktree control also fails to distinguish selection clearly from pointer hover.

## Decision

The dialog owns all three drafts and exposes one Save beside Cancel in its outer footer. Local validation blocks blank names and a known non-Git main folder paired with a Worktree starting point before any write. Selecting the starting point preserves `aria-pressed`, adds a persistent check and uses a selected surface distinct from hover; keyboard focus retains the shared neutral theme treatment.

Save reuses the existing generated SDK operations in dependency order: project folders, task defaults, then project name. Folder changes must precede defaults because the defaults owner validates against the persisted main folder. Each successful response advances only its own saved snapshot. A later failure keeps the dialog open, names the completed sections and retains failed or unattempted drafts. Retrying skips successful sections. Pending writes block dismissal and repeated submissions. The existing revision checks and directory ownership remain authoritative.

After a folder write, the dialog validates the starting point against the returned main folder even when task defaults were not edited. A newly added non-Git main folder leaves the completed folder write visible as partial success and requires Main folder or a Git main folder before completing the remaining changes; an unchanged Worktree preference cannot bypass validation.

Save remains pending until both the existing Scope configuration projection and the caller's directory snapshot refresh have settled, including when one rejects or the callback throws synchronously. The settings response alone does not make event-driven configuration refresh synchronous. A refresh failure retains successful writes across dialog reloads, explains that the updated settings could not be loaded, and retries synchronization without rewriting saved sections. Explicit task-location drafts retain their precedence over project defaults.

The [project-entry product rules](../../../../apps/web/PRODUCT.md#project-first-task-entry) define the interaction. Behavioral coverage lives in `apps/web/test/components/dialog/project-settings.dom.test.ts`; the real service path is exercised by `apps/web/test/fixtures/workbench/verify-project-entry.ts`.

## Alternatives considered

**Keep section-level Save actions.** This makes every draft independently publishable but leaves several competing confirmation actions in one dialog and contradicts the requested single Save/Cancel boundary.

**Write all sections concurrently.** Defaults can be validated against the previous main folder and fail or accept the wrong combination. Ordered writes retain the existing owner checks.

**Introduce a cross-domain transaction.** The name, folder bindings and project configuration have different owners and concurrency tokens. A new transactional API is unnecessary for this UI simplification; explicit partial-success feedback is required instead.

**Use only a subtle text-color change for selection.** Hover and selected states remain hard to distinguish. A check plus selected surface makes the choice observable without relying on color alone.

## Consequences

One action confirms the edited settings and successful sections are not rewritten on retry. This is not an all-or-nothing transaction: an earlier section can remain saved when a later section fails. The UI reports that condition and Cancel discards only the remaining drafts. Unverified or concurrently changed filesystem state is still validated by the server rather than guessed by the client.
