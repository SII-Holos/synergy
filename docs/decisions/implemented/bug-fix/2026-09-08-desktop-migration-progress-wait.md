# Decision Record: Desktop waits for advancing data migrations

Status: implemented

## Problem

Desktop starts its local server and waits for HTTP health before loading the application. Upgrade migrations run before the HTTP listener exists, so a startup deadline independent of migration work can terminate a valid upgrade. A hidden status label and a generic health error do not tell the user whether saved data is still being processed.

## Decision

Managed Desktop opts into a versioned, bounded startup record on the child process stdout stream. The CLI supplies the central migration runner with a reporter that announces each pending step before execution, reports aggregate processed/total counts, and announces ordinary startup after successful migration completion. The shared utility schema carries no paths, session identifiers, migration descriptions, or data contents. Multi-scan migrations explicitly advance a phase index before preparing the next scan. The central runner maps each advancing phase to a new reporter step and resets rendering throttling; stale phase reports are ignored. This lets independent counters restart without treating regressing transport records as useful work. Persisted migration formats and completion checkpoints are unchanged.

Desktop starts with a 30-second health deadline. A new migration step or an advancing count grants five minutes without further progress. Duplicate or regressing records and ordinary logs cannot extend the deadline. Successful migration completion restores a 30-second health deadline. Each health request is bounded to one second so an in-flight request cannot conceal a changed deadline; child errors and exit remain immediate failures on every platform. The progress listener is removed when startup settles.

The existing native startup overlay displays the current stage, a determinate progress bar and item counts when a total is known, and an indeterminate bar otherwise. Percentages describe the current migration step, not estimated total startup time. Theme values come from the existing Desktop theme snapshot, and reduced-motion preferences disable animation.

## Alternatives considered

**Raise one fixed startup timeout.** Any chosen duration remains dependent on the user's history size and delays discovery of a failed ordinary startup. A sliding deadline distinguishes actual work from silence.

**Wait indefinitely while the process is alive.** A deadlocked process remains alive, so it cannot be the only readiness signal.

**Extend the wait on every log line or timer heartbeat.** Unrelated background activity can continue while migration work is stuck. Only validated, advancing migration records renew the wait.

**Treat every counter decrease as a new phase.** Late or repeated records could keep a stalled upgrade alive. Explicit producer phases distinguish independent scans while preserving Desktop’s monotonic step checks.

**Serve the application before migrations finish.** This would admit requests against partially upgraded state and change the runtime's persistence guarantees. The server continues to complete migrations before admitting requests.

## Consequences

Large upgrades can finish without requiring repeated Desktop restarts. A single migration operation that reports no progress for five minutes still times out; long migration loops must report meaningful incremental work. Tests cover deadline renewal, stalled work, independent scan phases with smaller counters, malformed and split records, completed migration re-entry, health polling, failure/retry, and real Electron progress rendering. The managed startup path is also exercised with an isolated migration lasting longer than the ordinary deadline.

The Electron rendering fixture has a sixty-second process deadline and a seventy-five-second test budget, including cold startup and teardown. CI previously killed it twenty seconds after launch, with initialization only appearing around fifteen seconds. The fixture launches the resolved Electron executable directly so timeout signals reach the owned application, and reports readiness, page load and animation settlement stages on failure. These are correctness-test budgets; production startup deadlines and all rendered progress assertions remain unchanged.
