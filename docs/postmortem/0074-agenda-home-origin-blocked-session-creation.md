# Agenda Home origin blocked Session creation

## Executive summary

The built-in nightly Anima task remained active but failed before model dispatch because its saved Agenda origin used an older Home Scope shape. Strict Session publication required `local: null`, while Agenda read the embedded value directly from storage. The completed Home bucket migration did not normalize that field. Tests used current writers and missed the interaction between retained Agenda metadata and Session creation. The fix applies an owner-registered pure record upgrade consistently before item use, without weakening validation or scanning history at startup.

## Summary

Two consecutive nightly-task recovery attempts failed in tens of milliseconds with `Invalid input: expected null, received undefined` at `scope.local` and no execution Session. A separately created afternoon task using the same Agent succeeded. Read-only item inspection distinguished their origins: the older task had retired `directory` and `worktree` fields but no `local`; the later item used the current Home shape. The schedule itself was not missing, and the failure occurred before the Agent could act.

## Timeline

- The released Home bucket upgrade changed retained Agenda identities to Home without adding the current nullable-local field.
- A later Session publication change routed metadata through strict current-schema validation.
- October 13 and 14: the retained nightly task failed during execution Session creation; the separate afternoon task succeeded.
- Investigation verified run history and both stored origin shapes through read-only product interfaces.
- Isolated old-record regressions failed for both a normal timer and reopening the same Home with an overdue occurrence; the model boundary was never reached.
- The new pure record upgrade made both paths create valid Sessions, record successful runs and rearm their next occurrences under the unchanged strict schema.

## Root cause

[Agenda Store](../../packages/agenda/src/agenda/store.ts) returned item origins through direct Storage reads. [The reactor](../../packages/agenda/src/agenda/reactor.ts) supplied the embedded Scope to Session creation. [Session publication](../../packages/harness/src/session/index.ts) strictly parsed current metadata, whose Home variant requires `local: null`. Session's own historical read normalization cannot repair a not-yet-created Session's input.

The existing Home migration had already been recorded complete and only converted the bucket and identity. Changing that migration would not repair the installation that had already run it. Tests covering the migration and Session creation separately did not assert that the migrated origin was valid for the current Session boundary, nor recover an overdue task from that saved shape.

## Guardrails

- [The registered Agenda record migration](../../packages/agenda/src/agenda/migration.ts) converts embedded Home origins using a pure, owner-scoped transform. Reads, imports and ordinary writes cross the same boundary.
- [Owner upgrade tests](../../packages/agenda/test/migration/owner-scope.test.ts) exercise completed historical receipts, read projections without storage rewrites, import idempotence and preservation of unrelated state.
- [Timer tests](../../packages/agenda/test/agenda/workspace.test.ts) exercise actual Session creation for normal and restart-recovered timers, preserve explicit Workspace absence and control profiles, and assert run history and rearming. Strict Session validation still rejects an unconverted Scope.
- [The decision record](../decisions/implemented/bug-fix/2026-10-14-upgrade-agenda-home-origins-before-execution.md) explains why the repair is not a new schedule, a relaxed schema or a startup backfill.

## Lessons

An embedded Scope is persisted state, not a permanently valid runtime value. Each owning reader must apply its registered upgrades before a stricter downstream boundary consumes it. A completed migration receipt proves that migration ran, not that a later shape change has reached every embedded record. Upgraded-state tests must include actual downstream creation and already-completed installations, not only fresh records or helper output.
