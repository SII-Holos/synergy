# Decision Record: Measure the SQLite request deadline on a monotonic clock and escalate a dead store

Status: implemented

## Problem

A frozen Synergy backend left the host laptop asleep for roughly 500 seconds. Every storage request after wake failed with `The authoritative store is closed`, the process was terminated and restarted, and the log recorded `SQLite worker exceeded its request deadline` from `service=tool.resolver` while the Agent worker pool reported `agent worker heartbeat timed out ageMs=502131`.

`SqliteDriver.request` armed a wall-clock `setTimeout` for the request deadline (30 s by default, a size-scaled budget for maintenance). `setTimeout` is measured on wall-clock time, and a host suspend consumes wall-clock time for the suspended process while its child SQLite worker is suspended with it. The timer therefore fired on wake for a request whose worker had never had the chance to answer, and the callback immediately set `closed = true`, killed the worker, and rejected. The worker was healthy; the driver misread its own suspended clock as worker unresponsiveness.

Because killing the worker permanently set `closed`, the process became a zombie: HTTP stayed up and every storage write failed with `StorageClosedError` indefinitely. Nothing recovered, and nothing escalated to the managed restart path — the process was only restarted because an operator or supervisor sent `SIGTERM`. Two distinct defects are present: a false-positive kill, and no terminal-failure escalation when storage is genuinely dead.

## Decision

The deadline is now a monotonic budget. Each pending request records `performance.now()` when it is dispatched, and `review` only treats the request as expired when `performance.now() - dispatchedAt >= deadline`. The wall-clock `setTimeout` continues to schedule that review, but a fire that outruns the budget is a suspension rather than an expiry: the request is re-armed for the remaining budget and keeps waiting, so a suspended host cannot kill a worker it merely parked. `Date.now()` remains available for human-readable observability, but the decision uses only the monotonic value. `deadline` semantics, the 30 s default, the size-scaled maintenance formula, `onMaintenanceBudget`, `queuedBytes` accounting, and the byte-queue `StorageBusyError` guard are unchanged; re-arming updates the existing pending entry in place, so no request is double-counted or leaked.

Before any teardown, an expired request is now corroborated by a liveness probe. The worker answers a new `ping` action directly from its event loop without touching SQLite, so it succeeds whenever the worker can serve any request at all. The probe has its own finite monotonic budget of 30 s and is retried up to three times. The values mirror the ordinary request deadline and are deliberately generous: a probe is answered only after whatever statement is occupying the worker's event loop returns, so a healthy worker running a long statement is indistinguishable from a hung one until that statement finishes, and a false kill costs a whole-process restart. Only when every attempt fails does the driver treat the worker as dead.

A genuinely unrecoverable worker now terminates the process instead of leaving it serving. `failTerminal` marks the store terminally failed once, rejects every in-flight request with `StorageUnavailableError`, and notifies listeners. `TransactionalStore` records the error and rejects new work through its existing `check()` gate; `Storage.onUnavailable` exposes a narrow, well-named hook on the installed Handle, and `registerShutdown` in `packages/product-runtime/src/server/runtime.ts` subscribes to it and calls the same `gracefulShutdown` used for `SIGTERM`, exiting non-zero so a supervisor restarts the Runtime. An `onExit` the driver did not request — the worker crashing or being killed externally — takes the same terminal path, so a dead worker is no longer silent.

Escalation is one-shot. `registerShutdown` guards it with `escalated`, and `failTerminal` returns early once `unavailableError` is set, so neither a repeated listener call nor a second failure can request shutdown twice or loop. Ordering is unchanged from the existing invariant: `handle.close()` stops admission, execution and transport first, then `RolloutRecovery.settle()`, and closes storage last, so committed data is preferred over exit speed.

## Alternatives considered

**Use `setTimeout` with a shorter or suspend-aware delay.** Wall-clock timers cannot distinguish a suspension from a slow worker, which is exactly the ambiguity that caused the incident. No delay value fixes a false positive that is caused by the clock rather than the duration.

**Detect the sleep/wake boundary and rebuild storage on resume.** This was rejected by the scoped decision for this change. Sleep/wake event detection is platform-specific, and rebuilding storage on wake would touch the ownership lock, WAL and recovery paths — far more surface than the two defects require. The monotonic budget plus a liveness probe closes the actual failure with no lifecycle machinery.

**Treat every expired request as fatal immediately.** Killing the worker on the first late request is what produced the zombie, and it would also kill healthy workers under legitimate load. A corroborated kill is strictly safer.

**Kill the worker but restart it in place.** The driver cannot re-establish a SQLite connection, namespace ownership and the `synchronous=FULL` WAL state on its own, and partial re-establishment could serve reads over a store whose write path is gone. Escalating to the existing managed restart reuses a path that already reconciles committed data.

**Import product-runtime shutdown into the harness.** Dependency direction forbids it: the harness must not depend on product-runtime. The narrow `Storage.onUnavailable` hook lets the host subscribe without inverting the dependency.

**Exit immediately with `process.exit(1)` from the driver.** This would skip execution and transport drain, terminal persistence and `RolloutRecovery.settle()`, risking lost committed work to gain exit speed.

## Consequences

A host suspend no longer kills a healthy worker, and no longer turns the Runtime into a zombie serving a dead store. The process either keeps working or it fails fast into the managed restart path, which is what the supervisor contracts already expect: systemd uses `Restart=on-failure` with `SuccessExitStatus=0 143`, launchd uses `KeepAlive`, and the Desktop server manager reacts to process exit.

The cost is a bounded delay to genuine failure detection. A truly dead worker is now identified after the request deadline plus up to three 30 s probes rather than after one deadline, so a hard worker death is reported later than before in exchange for never misclassifying a slow one. The terminal path also now applies to an unexpected worker exit, which previously surfaced only as a per-request rejection.

`packages/harness/test/storage/storage-worker-suspend.test.ts` covers the four behavioral invariants: a wall-clock fire with a standing monotonic budget does not kill the worker, a worker that never answers any request — probes included — escalates exactly once and rejects subsequent work with the explicit error, a worker that answers the probe survives while the original request still expires on its own budget, and an ordinary open/query/transaction/close path is unchanged. The first three fail against the previous driver. The suite injects the monotonic clock and compresses the wall-clock delays, so it proves the deadline arithmetic and the escalation state machine; it does not reproduce a real OS suspend, which no test in this repository performs.
