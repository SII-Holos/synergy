# Decision Record: Preserve unavailable projects during directory migration

Status: implemented

## Problem

Project directory conversion runs before server admission and inspects historical filesystem paths. A deleted project directory must remain visible as unavailable, but a Git probe can fail before the migration reaches its missing-directory handling. The failure mechanism and missed fixture are recorded in the [postmortem](../../../postmortem/0043-historical-data-blocked-startup.md).

## Decision

Workbench encloses optional Git probe construction and execution in `try`/`catch`. A failed worktree discovery contributes no Git-discovered entries; existing catalogued Worktrees still participate with their original identity, binding and source metadata. The folder Git-status probe returns false when the command cannot start.

The existing domain migration and central ledger remain authoritative. Missing paths use the established location reader and retain unavailable catalog entries. Required identity validation, storage reads and transactional writes remain outside the optional probe's error handling. Completed migrations do not replay because this change repairs execution without changing the stored format.

## Alternatives considered

**Delete or skip unavailable projects.** This loses historical project references or leaves their directory conversion incomplete.

**Catch the whole project migration.** This could mark conversion complete after storage or identity validation failed.

**Check directory existence before launching Git.** The directory can disappear between checking and launching, and other synchronous launch failures remain possible.

## Consequences

Startup tolerates missing historical directories while execution still rejects unavailable bindings. Tests use real temporary directories and storage, covering a fresh home, deleted project roots, preserved historical Worktrees, restart idempotence and a non-directory replacement that keeps the migration pending. Git metadata unavailable at conversion cannot enrich discovery; existing catalog evidence is retained.
