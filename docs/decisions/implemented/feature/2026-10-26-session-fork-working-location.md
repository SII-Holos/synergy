# Decision Record: One session-fork dialog with explicit working location

Status: implemented

## Problem

Forking copied history but opened a generically named session, and both Web entry points forced the inherited Workspace. The reply action asked for confirmation while the whole-conversation command created immediately. A persistent source-navigation row occupied Composer space even though provenance is not part of composing a new request.

## Decision

Fork remains a session-history operation. It does not restore historical code, copy dirty files, or change the source session. The existing Workspace selection API independently chooses the target binding. Worktree creation remains owned by the native Workspace runtime.

Without an explicit title, `Session.fork` assigns `source title(1)`, `source title(2)` and so on before its first publication. Allocation uses the complete Scope navigation index and the existing publication transaction, not a second counter or an LLM. The first unused positive suffix is selected, including archived and manually named collisions. A single optional `forkedFrom.generatedTitle` records an automatically assigned name. Only an unchanged matching name permits removal of its last generated suffix on a nested fork; an actual rename clears the marker. Explicit titles, authored parentheses and historical forks without a marker are preserved. No historical migration guesses whether a title was authored. Allocation costs O(N) time and temporary space in Scope navigation entries, without reading other conversations' messages.

The reply action and the whole-conversation command call the same dialog and submission handler. They retain their distinct history positions: inclusive `through` for a reply and `current` for the command. The dialog shows the source title, history summary and a shared single-selection control for working location. It defaults to the source binding. Main directory resolves the project's canonical main Workspace ID and generation; `current` means retain the source, not select main. New worktree uses the project's main folder as its existing worktree-creation source. The source worktree is a separate choice only when it differs from main. Non-Git, unavailable and unsupported destinations are not offered. No selection changes a binding or allocates a worktree before confirmation.

Location reads are captured for the originating client and Scope. Failure shows Retry and prevents an implicit fallback. Pending creation blocks duplicate submission and dismissal. Dialog cleanup uses its own ID, and a late success cannot navigate an unrelated active session. Successful creation opens the regular session view. `forkedFrom` remains canonical provenance; the Composer has no persistent fork-source link.

This extends the [per-message entry decision](2026-08-19-per-message-fork-entry.md) without changing its inclusive-history guarantee or semantic icon. Its source lineage remains distinct from runtime child ownership.

## Alternatives considered

**Keep separate command and reply creation paths.** Rejected because one bypasses the destination choice and the two paths would accumulate different error, loading and navigation behavior.

**Create first, then open a separate worktree dialog.** Rejected because cancellation would leave a partially configured session and a second modal would obscure the single creation decision.

**Treat `current` as the main directory.** Rejected because fork first inherits the source Workspace, so this would silently keep a source worktree instead of honoring the requested main directory.

**Make fork reproduce historical code.** Rejected because conversation provenance does not identify a complete code snapshot. The user independently selects files through the existing Workspace API.

**Keep the source badge above the Composer.** Rejected because it is persistent navigation chrome unrelated to the next message; lineage metadata is retained without imposing that row on every fork.

**Generate a title after the first new message, or infer automatic numbering from text alone.** Rejected because the new session needs its inherited name immediately and a parent's authored parentheses must not be stripped. The optional lineage marker keeps that distinction portable through export/import without maintaining a separate title system.

## Consequences

Both entry points have one explicit creation step and one request path. The dialog uses shared controls, theme tokens and localized labels, with no parallel worktree service. Returning to main carries a versioned Workspace reference and therefore rejects stale bindings instead of quietly choosing another location. Native location discovery adds a read before confirmation; errors remain visible and retryable.

Concurrent automatic forks receive distinct names atomically. Deleted or renamed sessions release their suffixes for reuse; the numbering is a readable available name, not an immutable sequence identifier. Explicit caller-selected names can still duplicate another name. The additive lineage field requires generated API/SDK updates but no backfill. General recovery of default titles remains unchanged; automatically named forks are not eligible for that recovery.

Model tests cover destination semantics and full-history counting. The real-browser dialog fixture covers selection, cancel without allocation, pending dismissal, loading, retry and successful closure. Full-stack acceptance separately checks the resulting session and actual Workspace binding; a component callback alone does not establish that a worktree was created.

Exact whole-conversation counts require a loaded beginning and latest tail; a historical window uses the generic summary rather than treating its local counts as the entire conversation. Inclusive reply forks only need the beginning through their selected boundary. Both entry points use a neutral success description without implying an exclusive message cut.

Isolated full-stack acceptance used the production Web build, real server, storage and native Git worktree runtime with a local inference fixture. UI-created forks bound to main, the source worktree and a distinct new worktree; inclusive reply copying retained two messages and whole-conversation copying retained four. Reload preserved titles and bindings. Source history and dirty files stayed unchanged, the new tree did not copy those dirty files, cancellation allocated nothing, location retry recovered, and creation added no inference calls. A subsequent UI message completed in the new worktree without changing the source conversation. Light/dark screenshots, a 375-pixel viewport and a short-window reachable-action check covered the final presentation; this does not claim native Desktop composition or external-model validation.
