# Decision Record: Close the external runtime after native process exit

Status: implemented

## Problem

The external benchmark wrapper can finish its native child before the independent session observer finishes recording an already dispatched request. A cancellation signal during this drain correctly interrupted the observer, but also restarted the native child's forced-termination timer after the wrapper had cleared it. The wrapper wrote its `finished` marker and cancellation evidence, then remained alive until the unnecessary timer expired. Later container removal could conceal the retained timer.

## Decision

The wrapper records when its native child settles. Cancellation still closes the observer immediately, including an observer already draining. Once the child has ended, cancellation no longer signals that process group or creates another native cleanup timer. The existing process-group cleanup after native exit, independent observer and archive deadlines, and cancellation evidence remain intact.

A real-process regression holds provider response headers until the native child has exited and the observer stops accepting new connections. It covers normal drain, `SIGTERM` and `SIGINT`, then checks terminal evidence and natural wrapper exit. Its cleanup budget exceeds the test framework's deadlock budget so an accidentally retained grace timer cannot satisfy the exit assertion. It uses no shorter readiness timer or elapsed-time performance threshold, and registers cleanup for every owned process and provider.

## Alternatives considered

**Unreference or shorten the forced-termination timer.** Rejected because cancellation while the native process remains alive still requires an owned escalation timer. Changing that timer's duration or ability to keep its owner alive would weaken a different lifecycle boundary.

**Rely on container removal after the finished marker.** Rejected because direct wrapper execution must also finish and its declared completion must not depend on an unrelated parent teardown.

## Consequences

Cancellation during observation cleanup retains `cancelled` execution status, interrupted requests and unknown usage without delaying wrapper exit for an already ended child. Normal observation drain still retains completed request usage. The regression executes deterministic local processes and HTTP responses; it does not execute a historical model run or change historical experiment evidence.
