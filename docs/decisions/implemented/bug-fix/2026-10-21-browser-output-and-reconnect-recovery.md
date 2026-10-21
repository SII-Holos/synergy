# Decision Record: Browser output and reconnect recovery

Status: implemented

## Problem

Desktop inherits its launcher’s output streams. A disconnected reader makes a later log or process warning emit an unhandled EPIPE error and open a main-process exception dialog, interrupting native Browser recovery. Broker disconnection also publishes page suspension before the replacement Host becomes ready. Applying that readiness only to active pages leaves suspended pages labeled restarting and their recovery controls unavailable. Navigation Retry then attempts a command that the backend correctly rejects during recovery.

## Decision

Desktop installs error handlers on stdout and stderr before startup work. Only EPIPE is consumed; other output errors propagate. Logging and runtime warnings share this protection without a global uncaught-exception handler.

The renderer maps global Host readiness to detached presentation for suspended pages still marked restarting. The canonical descriptor remains suspended until explicit resume creates its native page again. Existing detached pages and unrelated page errors remain unchanged. Navigation Retry uses the same resume path when its page is suspended.

Regression tests close real process output pipes and repeat logging and warnings, retain unrelated output failures, deliver the broker disconnect/reconnect event sequence through the renderer transport, and click Retry in the rendered Browser panel. Native acceptance uses a separate Home, Electron profile and ports.

Native presentation cleanup retains the original WebContents event emitter and avoids accessing a destroyed BrowserWindow. Closing the parent still releases page subscriptions and marks the pooled view detached. Regression fixtures destroy the parent before teardown and repeat teardown to verify cleanup remains idempotent.

## Alternatives considered

**Catch errors only around Browser broker logging.** Process warnings and other Electron logging use the same disconnected streams and would still interrupt the main process.

**Consume every uncaught exception.** This would conceal unrelated application failures and leave their state uncertain.

**Mark every page ready on broker registration.** A replacement Host has no native page for a suspended descriptor. Advertising readiness would authorize controls before explicit page recreation.

**Replay navigation automatically after reconnect.** A prior website operation can have an uncertain outcome; explicit resume preserves the distinction between reconstructing a page and repeating an action.

## Consequences

Losing the launcher’s output reader loses that output destination without taking down Desktop. Recovery preserves page and profile identity and requires explicit user intent for suspended pages. Backend output files remain independent. This change does not establish the original cause of a particular broker disconnection or guarantee that every external website is reachable.
