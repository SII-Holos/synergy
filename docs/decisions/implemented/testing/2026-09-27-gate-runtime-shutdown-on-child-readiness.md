# Decision Record: Gate Runtime shutdown on child readiness

Status: implemented

## Problem

The Runtime shutdown fixture used a child that exited after a fixed delay. A successful test did not establish that the actual command had started and was still alive when its process history entry was removed. A Windows timeout provided no startup or cleanup phase, so the test title alone could not identify Runtime closure as the blocked operation.

## Decision

The real child publishes its PID through Bash output and stays alive until Runtime shutdown. The fixture observes readiness or early native completion, verifies liveness, removes the process history entry, and then closes the Runtime. It verifies the reported PID is gone, native completion has settled, and both output streams are destroyed. The shell is explicit through the existing Runtime environment setting, and this process lifecycle fixture uses a plain temporary Scope without unrelated Git initialization.

The native CI test retains its thirty-second budget. A twenty-second cancellation checkpoint records the current phase and prepared, activated, background and stream states before aborting the fixture. Cleanup drains any pending Bash execution and closes the Runtime before returning. This checkpoint reserves cleanup time for the deliberately persistent child; it does not change product startup or shutdown limits.

## Alternatives considered

**Keep a longer-lived timer child.** Increasing its duration still makes the tested lifetime depend on scheduling and can hide whether shutdown terminated an active command.

**Increase the CI timeout or change production process ownership.** The original Windows report does not identify the suspended operation. Neither a larger budget nor an unproven ownership change addresses that evidence gap.

**Infer the blocked phase from the test name.** The failing report contains zero assertions, while the first assertion follows Bash execution. A separate Bun timeout probe confirms that already executed assertions remain in its JUnit report. The original failure therefore precedes the shutdown assertion path, but does not distinguish Runtime opening, Scope resolution, admission or native activation.

## Consequences

The readiness regression fails with the original finite child: it exits successfully with its final output before reporting readiness. The persistent fixture proves actual child liveness and drainage through the real Runtime and native process owner. The original Windows timeout remains unexplained until an actual Windows run provides either successful acceptance or phase evidence. Local macOS and Linux checks do not substitute for Windows Job Object validation. Production execution, registry removal and Workspace ownership are unchanged.
