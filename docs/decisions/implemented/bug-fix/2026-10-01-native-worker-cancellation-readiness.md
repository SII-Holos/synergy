# Decision Record: Acknowledge native worker cancellation readiness before binding

Status: implemented

## Problem

Native stream greetings could reach the parent before the Linux worker installed its termination handler. A process-binding failure in that interval killed the worker without its descendant-completion receipt, replaced the binding error with uncertain ownership and prevented reliable cleanup even though the command had never activated.

## Decision

The private native process protocol acknowledges preparation after the worker installs its cancellation and activation handlers. The parent waits for that acknowledgement and all four authenticated streams before capturing and binding ownership. Command activation remains a separate acknowledgement after binding succeeds. Linux descendant-completion verification remains mandatory.

## Alternatives considered

**Delay binding by a fixed interval.** Scheduler stalls can exceed any chosen delay; elapsed time does not establish cancellation readiness.

**Ignore missing completion evidence before activation.** This weakens the process ownership boundary and leaves no explicit proof that the worker finished cleanup.

## Consequences

Preparation adds one bounded protocol event without starting command effects. Parent and worker must use the same current protocol. A real Linux worker regression pauses after stream greetings and verifies that binding failure preserves its cause, never runs the command and releases the unactivated claim. Existing activation, cancellation, descendant and output-drain tests retain their completion requirements.
