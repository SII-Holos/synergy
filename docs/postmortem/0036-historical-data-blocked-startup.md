# Historical data blocked startup

## Executive summary

A project-directory migration stopped server startup when a historical project root no longer existed. Bun's shell launch raised a synchronous error before the chained Promise rejection handler could handle it. Upgrade coverage used available directories and missed this state.

After directory migration completed, recovery encountered a second incompatibility: recorded executor limits referenced a retired executor, but their reader used the current live configuration enum. Both failures were absent on a fresh home.

## Summary

The startup migration optionally discovers Git worktrees before converting project folder references. A missing working directory aborted discovery and prevented the server from reaching admission, despite the location reader already supporting missing historical paths.

The next startup stage reads retained run journals. Their runtime configuration snapshots contained an executor removed from the active taxonomy. Validation rejected that historical evidence, and cleanup encountered the same record again.

## Timeline

On 2026-10-01, startup logs identified the project-directory migration as the first failure. A real-directory deletion fixture reproduced the same failure through the central migration runner. Enclosing the Git probe in `try`/`catch` allowed conversion to finish and survive a storage reopen.

Applying that repair completed the affected home's project migration. Inspecting the nested startup error identified recorded executor limits as the next blocker. A journal fixture reproduced the failure; a separate recorded runtime schema preserved the evidence while allowing recovery.

## Root cause

The probe combined `.nothrow()` and `.catch()` as if they covered every launch failure. `.nothrow()` addresses command exit status; shell initialization can throw synchronously while attaching the rejection handler. Existing tests exercised successful Git discovery but did not remove a historical project root before migration.

The executor retirement migrated live configuration and obsolete storage but did not distinguish execution snapshots from new configuration input. A current-schema fixture could not reproduce the historical journal failure.

## Guardrails added

[Workbench migration tests](../../packages/workbench/test/project/migration.test.ts) cover fresh state, missing roots, preserved Worktree bindings, restart and fatal directory-identity errors. [Folder tests](../../packages/workbench/test/project/directories.test.ts) cover the adjacent Git-status probe. The [decision](../decisions/implemented/bug-fix/2026-10-01-unavailable-project-migration.md) limits recovery to optional discovery; the [persistence Skill](../../.synergy/skill/change-persistence/SKILL.md) requires real missing-path fixtures and complete shell-launch error handling.

[Recovery tests](../../packages/harness/test/session/rollout-recovery.test.ts) retain historical executor keys and fingerprints through journal recovery. [Experiment tests](../../packages/harness/test/config/experiment.test.ts) keep active inputs strict and live resource settings authoritative. The [snapshot decision](../decisions/implemented/bug-fix/2026-10-01-retain-recorded-executor-limits.md) defines that separation.

## Lessons

Historical references outlive their filesystem paths. Startup migrations must preserve that history, and optional command probes must handle failure before a process starts as well as after it exits.

Retained execution evidence also outlives active configuration taxonomies. Recovery readers must preserve that evidence without re-enabling retired execution settings.
