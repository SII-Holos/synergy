# Isolated runtime containment gaps

## Executive summary

A large-history reproduction could serve the UI while failing native commands. The fixture nested two macOS sandboxes and restricted supervisor cleanup; after correcting those fixture errors, real writes exposed a product metadata matcher that rejected workspaces beneath protected-name ancestors. Readiness and read-only smoke checks did not exercise these behaviors.

## Summary

The copied database was only part of the runtime fixture. Package-manager caches and native allocation descriptors also required explicit isolation. Missing descriptors correctly retained Environment uncertainty; an external Bun cache caused a source-file diagnostic operation to exit. Full-access command checks did not cover guarded containment.

## Timeline

- Large-history startup and conversation checks established HTTP readiness and readable sessions.
- A source-file write exposed an external dependency-cache path; a global command exposed a missing native allocation descriptor.
- Guarded execution reproduced a nested Seatbelt application failure.
- Command-level containment and cancellation probes exposed supervisor signal restrictions, then real guarded writes exposed the metadata-ancestor defect.
- Worktree creation exposed a separate initialization error: inheriting direct sharing invoked an exclusive update after publishing the new Workspace and was blocked by a source-directory resource pin.
- Real Git commands then exposed an ancestor read deny covering the shared Git store; a successful working-directory print had not exercised repository access.

## Root cause

The fixture sandbox wrapped a native worker that later applied the product command sandbox. macOS rejected the second sandbox application. The fixture also prevented the coordinator from signaling its verified independently launched workers. Separately, the product compiler's unanchored metadata expressions matched protected names in workspace ancestors, denying ordinary files. A compound shell command could end successfully after a failed write.

## Guardrails added

- [Metadata compiler regression](../../packages/local-runtime/test/sandbox/macos-policy.test.ts) checks real file effects and protected-file preservation; [the decision](../decisions/implemented/bug-fix/2026-10-10-scope-sandbox-metadata-to-writable-roots.md) scopes the fix.
- [Isolated development](../../.synergy/skill/develop-synergy/SKILL.md) requires explicit caches, exact native allocation identity, single command containment and cancellation checks.
- [Execution guidance](../../.synergy/skill/change-execution-boundaries/SKILL.md) requires ancestor, additional-root and path-escaping cases.
- [Atomic worktree sharing](../decisions/implemented/bug-fix/2026-10-10-initialize-worktree-sharing-atomically.md) keeps initial grants in registration while preserving existing sharing-update exclusion and retained execution evidence.
- [Worktree Git reads](../decisions/implemented/bug-fix/2026-10-11-preserve-worktree-git-reads-under-ancestor-denies.md) validates enumerated metadata grants beneath ancestor denies without exposing siblings or shared writes.

## Lessons

Treat successful startup, successful execution and successful effects as separate observations. Exercise global and project sessions under both control profiles, plus cancellation and worktree creation. Preserve unknown operation evidence instead of clearing it to make a copied fixture appear ready.
