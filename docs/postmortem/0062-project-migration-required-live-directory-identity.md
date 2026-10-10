# Project migration required live directory identity

## Executive summary

A retained Workspace identity caused project-directory conversion to abort server startup. Earlier fixes handled missing directories and introduced persistent volume identities, but the conversion still called live directory registration before the identity upgrade. A changed mount number also prevented the exact-match upgrade. Historical metadata conversion must preserve existing bindings independently of whether those bindings currently authorize filesystem access.

## Summary

Desktop displayed a child-exit failure followed by `fetch failed`. The child had exited with `WorkspaceUnavailable` while converting the first historical project; the health-request error was a consequence. All earlier relevant fixes were present in the failing source revision. Increasing a startup deadline would not change the result.

## Timeline

On 2026-10-09, the current launch log identified project conversion as the failing operation. Read-only inspection found legacy directory identities with unchanged inode and birth time but different device numbers. Synthetic upgrade fixtures reproduced failure both with exact legacy identities and with changed mount numbers.

On 2026-10-10, the original source reproduced the same error on an isolated snapshot. The repaired source completed startup and served the production Web app. The snapshot preserved the migration ledgers and catalog records; only copy-local storage ownership was relocated, and credentials were excluded. The original dataset remained untouched.

Expanded release fixtures then exposed the same live-registration assumption in embedded Session Workspace migration: a directory replaced by a file prevented older histories from upgrading. Combined catalog tests also found that persistent-identity migration did not classify looping symlinks as unavailable, project conversion recreated foreign Worktrees as local bindings, and sharing conversion rejected duplicate owners or retained grants to retired directories. Each failure received a behavioral regression before its correction.

## Root cause

`ProjectDirectories.migrateProject()` called `WorkspaceCatalog.register()` for existing main folders and historical Worktrees. Registration correctly rejected a different physical identity. That check belongs to live directory admission, but the migration used it merely to retain project references.

The central graph orders qualified migration IDs, so Workbench conversion ran before the Workspace identity upgrade. Reordering alone would only repair exact legacy matches: the identity upgrade intentionally retains ambiguous mount changes for explicit recovery. The earlier missing-directory test also expected a non-directory replacement to block startup, embedding live admission into the metadata-conversion expectation.

## Guardrails added

- [The owning decision](../decisions/implemented/bug-fix/2026-10-10-historical-project-binding-migration.md) separates retained metadata from live filesystem admission.
- [Workbench migration tests](../../packages/workbench/test/project/migration.test.ts) cover the combined migration graph, mount changes, replacement, canonical aliases, unknown driver errors, retained bindings and restart.
- [Workspace history tests](../../packages/harness/test/workspace/history-binding.test.ts) cover unavailable paths, permissions, strict live admission and read-only descriptor lookup.
- [Released product upgrades](../../packages/presets/test/storage/released-project-upgrade.test.ts) cover 2.0.0, 2.4.4, 3.0.21 and 3.0.22 with their frozen migration ledgers, unavailable project folders, retained transcripts, health readiness and repeated startup.
- [Persistence workflow](../../.synergy/skill/change-persistence/SKILL.md) requires historical-path fixtures and preserves strict file-access validation.

## Lessons

A common startup error screen can represent different failures. Check the child error and the active migration before treating it as a timeout regression. Test migrations together against released history, including unavailable identities; a fresh home and isolated migration tests cannot establish upgrade safety.
