# Decision Record: Drain member services when their child exits

Status: implemented

## Problem

A member child can exit while Desktop remains open. Its native Browser broker then has no usable server, but ordinary service cleanup only runs on explicit stop or restart. An asynchronous attachment can also finish after child exit and return a false running result. Saving ready-port metadata creates another interval in which child failure can be overwritten by final startup acceptance.

## Decision

The existing server manager notifies its main-process owner after invalidating an exited child's private credentials and recording failure. The member registry immediately begins service cleanup. Exit, explicit restart and application shutdown share one cleanup promise for the attached services, including cleanup failures. A replacement cannot start before the previous cleanup completes.

The registry checks the private connection again after service attachment. If the child has exited, the late-returned service is closed and startup fails. The server manager checks the actual child after ready-port persistence before publishing running state. Neither path automatically restarts the member or replays work.

## Alternatives considered

**Wait for an explicit member restart or application quit.** This leaves broker reconnect timers and native resources alive after their server has exited.

**Poll member status from the renderer.** Main owns the child and its services, and must clean them up even when no renderer is open. A renderer poll also adds delay and another lifecycle owner.

**Close services separately for each lifecycle event.** An exit racing a restart or shutdown can invoke the same native cleanup twice. A shared completion promise preserves ordering and reports the original cleanup failure.

## Consequences

Real child-process tests cover exit during normal operation, delayed native attachment and final port persistence. They hold cleanup across restart, verify another member remains usable, and assert failed status instead of false readiness. The callback and private connection stay in main; renderer schemas and persisted member identities are unchanged.
