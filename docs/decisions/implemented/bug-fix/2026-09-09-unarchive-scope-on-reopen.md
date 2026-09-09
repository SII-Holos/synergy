# Decision Record: Unarchive a project scope when its directory is re-opened

Status: implemented

## Problem

Archiving a project scope hides it from every active list (sidebar, global session nav, scope index). If a user later re-adds the same directory — a natural "I want to keep working on this" signal — `Scope.fromDirectory` detects the existing persisted record but returns it unchanged, leaving `time.archived` in place. The scope stays invisible to the user despite fresh activity under that worktree, producing a zombie state where new sessions are created and used but never surface in the recent list. The worktree-dedup path (`findByWorktree`) also skips archived scopes, so re-opening can even create a duplicate scope record under a different ID.

## Decision

Re-opening a directory whose scope is currently archived implicitly unarchives it:

1. `findByWorktree` accepts an `includeArchived` option; `fromDirectory` uses it so that a re-opened archived directory reuses the same record instead of fragmenting into a new scope.
2. When `fromDirectory` finds an existing record whose `time.archived` is set, it clears that timestamp, refreshes `time.updated`, and falls through to the normal create/update path so the unarchived record is persisted and a `scope.updated` event is broadcast.
3. The `recordChanged` guard treats the archived→active transition as a change so the write and event always fire, even when no other metadata changed.

No new UI surface, menu item, or API is added — re-opening the directory is the only affordance, which matches user intent and keeps the product surface minimal. The existing frontend event route already maps a non-archived `scope.updated` to `scopeIndexRefresh`, so the project reappears in the sidebar without any frontend change.

## Alternatives considered

**Add an explicit Unarchive button in the sidebar or command palette.** An archived project is deliberately hidden from the sidebar, so any in-sidebar affordance would require a new "Archived projects" section just to host the button. The user's natural recovery path (open the directory again) already exists; adding a parallel UI duplicates that path and introduces questions about ordering, search, and cleanup of the archived section.

**Unarchive only through the CLI or an "Add Project" picker.** Requiring users to remember a separate command or special picker option adds friction; the plain directory-open gesture is already the universal way to bring a project into Synergy and should mean "make this active."

**Leave the archived state and create a fresh scope on re-open.** That fragments session history across two scope IDs for the same worktree, breaks sandbox tracking across worktrees, and makes old sessions permanently unreachable from the new scope.

## Consequences

Archiving a project still removes it from all active lists immediately. The only way to restore it is to open the directory again (via Add Project, CLI, deep link, or any other path that calls `Scope.fromDirectory`), at which point it reappears in the sidebar with its full session history intact under the same scope ID. A regression test archives a project, re-opens the directory, and asserts that `time.archived` is cleared and `Scope.list()` includes the project again; existing worktree-id-dedup and event-storm tests continue to pass.
