# Host suspend pinned a session in recovering and left tool parts running

## Executive summary

A host laptop slept for roughly 500 seconds. On wake the Runtime killed a healthy SQLite worker over a wall-clock deadline, then kept serving HTTP against a closed store, and one session stayed pinned in `recovering` with two `bash` tool calls rendered as permanently running. The pin had nothing to do with the interrupted turn: a persisted BlueprintLoop record that no runtime was driving kept `SessionWorking.resolve()` returning `recovering`, and because the client derives that same status from the same record, no ordinary control could clear it. Seven aborts returned HTTP 200 and changed nothing; the only interaction that worked was an undocumented two-second long-press. Tests proved that each mechanism worked in isolation and never asked whether the status described something that could make progress.

## Summary

The backend's last activity before the sleep was an assistant turn on one session that dispatched two `bash` tool calls, both read-only `grep` commands against `script/coverage-exempt.json`. The host then suspended. The backend log jumps `+497249ms` with no entries across that window, and two independent observers agree on the duration: `agent worker heartbeat timed out ageMs=502131` and `Snapshot git command timed out`.

On wake, the SQLite worker was reported as having exceeded its request deadline and was killed, even though it had only been suspended with the host. Every in-flight write then failed with `The authoritative store is closed`. The log records `failed to settle tracked tool execution` for the two `bash` calls, `Unable to persist rollout evidence Caused by: SQLite worker exceeded its request deadline`, a `process` failure, and `rollout run reconcile failed after release` across several sessions; LSP servers received `SIGTERM`. Nothing escalated to a managed restart, so the Runtime continued accepting requests with no working write path until a `SIGTERM` arrived.

The restart produced a second, independent failure. Startup logged `service=session.working sessionID=… detected recovering session (workflow)` three times for the affected session and never `(incomplete)`. The automatic repair then did exactly what it promises: it terminalized the interrupted assistant as `finish=error` with an `AbortedError`. That removed the incomplete-turn half of the problem and left the other half untouched, because the session was not held by a turn at all. A BlueprintLoop record left `running` by the dead process was reported as active work by `SessionExecutionContributions.isActive`, and startup reconciliation had restored the loop's session and note bindings without ever asking whether anything would resume it.

The user's experience followed directly. The session showed as working and could not be moved; no button produced an effect; two tool calls showed as running with no way to tell whether they still were. `POST /session/:value/abort` was pressed seven times between `00:40:43` and `00:41:37` and returned HTTP 200 every time. The session unblocked at `00:41:41`, one millisecond after an abort that was immediately followed by `POST /blueprint/loop/:value/cancel` — the exact pair the frontend sends on a two-second long-press of the Blueprint slot icon. Abort did not free the session; an undiscoverable gesture did.

## Timeline

Times follow the incident record; backend log entries are UTC and the host ran at UTC+08:00.

- `00:29:34` — last backend activity: an assistant turn dispatches two `bash` tool calls on the affected session.
- `00:29:32 → 00:37:52` — host suspended. The backend log jumps `+497249ms` with no entries. `agent worker heartbeat timed out ageMs=502131` and `Snapshot git command timed out` corroborate the same window from independent subsystems.
- `00:37:51` — on wake, the SQLite worker is declared past its request deadline and killed. In-flight writes fail with `The authoritative store is closed`; the log records `failed to settle tracked tool execution`, `Unable to persist rollout evidence Caused by: SQLite worker exceeded its request deadline`, a `process` failure, and `rollout run reconcile failed after release`. LSP servers receive `SIGTERM`.
- `00:39:58` — `server-runtime signal=SIGTERM shutting down`.
- `00:40:21` — a new Runtime starts on the same port.
- `00:40:27 → 00:40:58` — three `detected recovering session (workflow)` lines for the affected session. None reports `(incomplete)`.
- `00:40:43 → 00:41:37` — the user presses abort seven times. Every `POST /session/:value/abort` returns HTTP 200 and has no effect.
- `00:40:58` — automatic repair terminalizes the interrupted assistant message as `finish=error` with an `AbortedError`.
- `00:41:41` — the session unblocks, but not through abort: `POST /session/:value/abort` is followed one millisecond later by `POST /blueprint/loop/:value/cancel`, the request pair produced by a two-second long-press on the Blueprint slot icon.
- After the incident, the two tool parts remained `running` in persisted message records.

## Root cause

Six defects contributed. Only the first made the freeze permanent.

**A persisted workflow record was treated as a runtime.** `SessionExecutionContributions.isActive` decided whether a session was still working by reading the persisted status of its bound BlueprintLoop. A loop left `running` by a process that died mid-flight is indistinguishable, by that test, from a loop being actively driven. Startup reconciliation (`WorkflowRecovery.reconcileRuntimeScope`) restored loop, session, and note bindings but never adjudicated whether the loop was still alive, and the startup re-drive discovery set did not include active BlueprintLoops, so nothing would ever resume it. The pin was self-sealing: `SessionWorking.resolve()` computes the derived status from that same record, so every recomputation returned `recovering`, and no user-facing control could clear it.

**Storage destroyed itself over a suspended clock.** `SqliteDriver.request` armed a wall-clock `setTimeout` for its 30-second request deadline. A host suspend consumes wall-clock time for the suspended process, and the child SQLite worker was suspended with it, so the timer fired on wake for a request whose worker had never had a chance to answer. The callback set `closed = true`, killed the worker, and rejected. The worker was healthy; the driver misread its own suspended clock as worker unresponsiveness. Because the kill permanently closed the driver, the process became a zombie: HTTP stayed up and every write failed with `StorageClosedError` indefinitely. Nothing escalated to the managed restart path.

**Abort reported success unconditionally.** The route returned `c.json(true)` without inspecting anything. `SessionManager.signalAbort` returns `not_found` when no runtime exists, and `repairAfterAbort` deliberately refused to publish idle while `SessionWorking.resolve()` was truthy — which the phantom workflow kept true. The response therefore said "aborted" for a call that stopped nothing, seven times in a row, while the actual remedy sat behind a long-press.

**Repair terminalized messages and forgot their tool parts.** `repairIncompleteAssistant` set the assistant message's `finish` and error but never touched its tool parts, and it returned early when the message was already terminal. Automatic startup repair had already terminalized the message, so the early return was the branch production executed. The parts stayed `running` forever, contradicting the rollout ledger, which had correctly recorded the same calls as `interrupted` with the note "Runtime ended; external side-effect completion is unknown. Recovery does not replay this tool."

**The status erased its own cause.** `recovering` collapsed three unrelated conditions into one opaque state: a workflow holding the session, an incomplete assistant turn, and a pending reply. A precise string existed in the code but was unreachable for a bound session, and `toStatus` dropped even the description field that existed, so the UI showed the same hardcoded explanation regardless of which condition applied. The one reason that cannot clear itself was the one the user could not see.

**The only working control was undiscoverable.** The composer's stop affordance vanished as soon as the input box contained text, because the submit-intent resolver computed `abort` only when `working && !hasText`. The long-press was the only control that cleared the state, and it was never surfaced.

Every safety net missed a different part of this. The automatic repair hid the surviving defect: it did its job, so the log looked like a handled interruption while the session stayed stuck. Tests asserted that each mechanism worked — the status registry, the abort route's status code, the storage deadline, the repair's message fields — and none asserted that a reported status corresponded to something that could make progress, that abort had an effect, that a terminal message carried no non-terminal tool parts, or that a wall-clock deadline firing in a process that never blocked meant anything. The storage tests could not have caught the suspend case, because a test process that never suspends cannot distinguish a suspended clock from a slow worker.

## Guardrails added

- [Loop liveness adjudication tests](../../packages/presets/test/session/loop-liveness-adjudication.test.ts) terminalize an orphaned loop and clear its references, cancel an orphaned `armed` loop, and preserve a user-paused loop, a loop with a durable stop intent, a loop whose session has runnable inbox work, and a Lattice-owned loop.
- [Abort escape-hatch tests](../../packages/presets/test/session/abort-escape-hatch.test.ts) distinguish an abort that freed a pinned session from one that found nothing to stop, and reject abandoning a loop that still has a real driver.
- [Tool-part settlement tests](../../packages/harness/test/session/orphaned-tool-parts.test.ts) and [migration tests](../../packages/harness/test/session/orphaned-tool-parts-migration.test.ts) cover a running part on an already-terminal message, idempotent repair, and a fresh install with no parts.
- [Suspend-resilience tests](../../packages/harness/test/storage/storage-worker-suspend.test.ts) prove that a wall-clock fire with a standing monotonic budget does not kill a worker, that an unreachable worker escalates exactly once, and that a worker answering the liveness probe survives.
- [Escalation tests](../../packages/harness/test/storage/storage-unavailable-escalation.test.ts) cover the store-level terminal-failure path.
- [Working-status tests](../../packages/presets/test/session/working.test.ts) and [status-bar tests](../../apps/web/test/components/status-bar/runtime.test.ts) cover each recovery reason and the fallback when neither reason nor description is present.
- [Stop-control tests](../../apps/web/test/components/prompt-input/submit-intent.test.ts) keep a dedicated stop control available while working with a draft present.
- [Workflow liveness adjudication](../decisions/implemented/architecture/2026-09-19-persisted-workflow-liveness-adjudication.md), [abort outcome fidelity](../decisions/implemented/bug-fix/2026-09-19-abort-outcome-fidelity-and-driverless-workflow-release.md), [interrupted-turn tool-part settlement](../decisions/implemented/bug-fix/2026-09-19-interrupted-turn-tool-part-settlement.md), and [monotonic storage deadlines](../decisions/implemented/bug-fix/2026-09-19-sqlite-worker-suspend-resilience.md) record the four decisions and their rejected alternatives.
- [Workflow Runtime](../architecture/workflows.md) documents startup liveness adjudication, and [Sessions and Messages](../architecture/session-and-messages.md) documents the pause latch, its reasons, and the tool-part half of interrupted-turn repair.
- **Forward reference.** This narrative uses the vocabulary that was accurate when the incident was written. The behavior it describes has since changed: the interim `recovering` status and automatic restart recovery were replaced by the persisted `paused` state, and the escape from a stopped session is now an explicit Continue or Abandon rather than an incidental abort or an undocumented long-press. Read [session paused state authority](../decisions/implemented/architecture/2026-09-20-session-paused-state-authority.md), [session continue and abandon controls](../decisions/implemented/feature/2026-09-20-session-continue-and-abandon-controls.md), and [delete automatic restart recovery](../decisions/implemented/bug-fix/2026-09-20-delete-automatic-restart-recovery.md) for the current model. The history in this file is deliberately not rewritten.

## Lessons

A derived status must be computed from evidence that something will make progress. When a status is derived from a record that the status itself keeps alive, the state is self-sealing: every recomputation confirms the last one, and no user-facing control can clear it because the clearing authority and the obstruction are the same field. Ask what would resume this work, and treat "nothing" as a terminal answer.

A control must report whether it did anything. Returning success for a call that stopped nothing is worse than returning an error: it consumes the user's attempts and conceals the real remedy. Repair must also be symmetric — terminalizing a message while leaving its tool parts running creates a contradiction that no later pass revisits, because the guard that triggers repair already looks satisfied.

Wall-clock time cannot measure the health of a suspended process, and a fatal response to an ambiguous signal must be corroborated before it is taken. When a dependency is dead, the correct outcome is a fast, managed restart rather than a process that keeps answering requests it cannot serve.

Finally, an escape hatch reachable only through an undocumented gesture is not an escape hatch. If one interaction clears a stuck state, it belongs on the surface as a labeled control, and the reason a session is stuck belongs on screen with it.
