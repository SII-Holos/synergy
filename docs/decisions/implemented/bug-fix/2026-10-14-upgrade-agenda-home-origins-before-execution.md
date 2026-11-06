# Decision Record: Upgrade Agenda Home origins before execution

Status: implemented

## Problem

Historical Agenda items retain embedded Home Scope values without `local: null`. The released Agenda Home migration changed the former bucket and identity but did not adopt the current Scope shape. Once Session publication validated current metadata strictly, these retained items failed during execution Session creation before model dispatch. The already-completed Home migration receipt meant editing that older migration alone would not repair affected installations. Current-item tests did not cover either a normal timer or restart recovery against that released record shape; see [the incident](../../../postmortem/0074-agenda-home-origin-blocked-session-creation.md).

## Decision

Agenda registers `20261014-agenda-origin-home-scope` as an independent `execution: record` migration after its existing Home upgrade. The [pure transform](../../../../packages/agenda/src/agenda/scope-migration.ts) applies only to Agenda item origins identified as Home. It uses the public `Scope.home()` constructor, removes retired top-level filesystem fields and retains unknown metadata. It does not reinterpret a project origin or change an explicit Workspace reference.

The [Agenda Store](../../../../packages/agenda/src/agenda/store.ts) applies registered record upgrades at its single-item reader, batch reader and mutation boundary. Get, list, find, startup loading and activity hydration consume the same current projection; ordinary writes upgrade within their existing transaction. A read does not persist changes, scan historical owners or alter failure state. Import uses the same registered pure transform. No Session schema, reactor, clock, model invocation or Anima-specific path is weakened or patched. Old migration receipts, task instructions, schedules, control profiles, owner requirements, run history and pause state retain their meaning.

## Alternatives considered

**Change the completed Home migration.** Installations with its recorded receipt would still read untouched old origins. The new record version repairs access independently without replaying a completed bucket migration.

**Normalize only in the reactor or only for Anima.** Other readers, mutation results and imports would continue returning an incompatible Scope. The bug belongs to the Agenda record boundary, not one agent or trigger.

**Relax Session validation or add a runtime fallback.** Accepting missing local metadata hides an incorrect stored-state upgrade and risks implicit filesystem authority. Home remains explicitly workspace-free unless the item separately references a Workspace.

**Scan and rewrite every Agenda record at startup.** This conversion needs no cross-record decisions or index rebuild. Pure access upgrades avoid adding a history scan to readiness and preserve raw records until ordinary mutation.

## Consequences

Existing active Home tasks can create a valid execution Session during normal timers and overdue startup recovery. Successful execution updates the existing run state and commits the normalized origin; it does not recreate the task or reset failures before execution. An already-paused task remains paused and still requires explicit activation under existing rules. Project selections and owner-unavailable task visibility are unchanged.

[Owner migration tests](../../../../packages/agenda/test/migration/owner-scope.test.ts) cover an already-completed old receipt, every public item-reading path, import idempotence, unknown fields, project selections and mutation persistence. [Timer regressions](../../../../packages/agenda/test/agenda/workspace.test.ts) use real isolated storage, close and reopen the same Home, create actual Sessions under the unchanged strict schema, substitute only the model invocation boundary, and verify successful run history, a reset failure streak and a rearmed next occurrence. These tests do not establish an external provider's response or repair the live installation before the source change is deployed.
