# Decision Record: Recover paused native Run identity for controls

Status: implemented

## Problem

Organization status inferred the current Run only from a live execution lease, a busy activity or a queued Continue. After restart, a paused Session retained its original task but exposed no Run identity for cancellation. A later context message could not safely supply that identity.

## Decision

The Runtime status adapter reuses `SessionInbox.latestRootID()`, the native effective-root selection already used by explicit Continue, when no live or queued identity exists and the Session is paused. Native history semantics preserve rollback visibility and distinguish task roots from ordinary context messages. The adapter checks the corresponding native Run owner and omits terminal Runs. A canonical root whose Run has not opened remains cancellable through the existing native cancellation entry.

Live lease, busy activity, retry and queued recovery identities retain precedence. Shared status reconciliation awaits the same selection rather than retaining an old projection after the lease disappears. Observation neither opens a Run nor changes the pause. Control version, binding and native cancellation admission continue to decide whether an actual command can execute.

## Alternatives considered

**Persist a second current-Run pointer in organization storage.** It would need independent synchronization with native history, rollback, recovery and execution leases. Reusing native task-root selection keeps one owner.

**Use the newest message.** Context messages and assistant output do not identify a new task; their arrival cannot change the cancellation target.

## Consequences

Cold paused observations perform native metadata reads instead of depending only on memory. Missing Run records retain the native unopened-root cancellation behavior; malformed or foreign evidence and storage failures remain errors. Status can be stale by the time a user acts, so the existing signed control admission still validates the requested target and version.

## Verification

`packages/organization-runtime/test/session-status.test.ts` reopens an actual temporary Home, observes an interrupted paused Run without an execution owner, and cancels it through native lifecycle. Separate cases cover unopened roots, later context messages, terminal cancellation, a live older root and retry identity. Existing command-intake and sync-exporter suites retain admission and delivery coverage.

See the [incident analysis](../../../postmortem/0101-paused-runtime-lost-cancellation-target.md).
