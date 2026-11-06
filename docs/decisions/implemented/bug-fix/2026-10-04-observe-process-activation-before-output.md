# Decision Record: Observe process activation before consuming output

Status: implemented

## Problem

Executor status and output are separate observations. A process stream can receive an accepted status snapshot, then fetch output produced after that snapshot. Filling a paused readable buffer blocks the stream loop before it can observe execution readiness. A caller awaiting activation before consuming output then waits on the same loop indefinitely.

## Decision

`EnvironmentProcess` observes running or terminal execution status before consuming output. An accepted status keeps the existing polling interval without reading newer output. Activation is established by executor status, never inferred from available bytes. Durable saving, exact output drainage and cancellation retain their existing completion requirements.

The regression delays a real native executor's accepted response until physical execution and output have finished, leaves stdout paused, and requires activation to settle before the reader resumes. Its deadline reserves time to resume output and stop the owned operation even when the assertion fails.

## Alternatives considered

**Retry the test or increase its timeout.** A circular wait has no eventual completion; a different schedule can hide it without correcting execution behavior.

**Treat output as activation evidence.** Available bytes do not replace the executor's running or terminal status and its failure semantics.

**Remove output backpressure.** This would weaken paused-consumer behavior and allow unbounded buffering instead of fixing the state ordering.

## Consequences

Activation does not depend on a consumer draining its output. Accepted operations continue to poll at the existing cadence; no additional status request is added to each output batch. The [postmortem](../../../postmortem/0039-paused-output-blocked-process-activation.md) records the observed failure and reproduction limits.
