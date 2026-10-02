# Decision Record: Drain readable process output before close

Status: implemented

## Problem

Ending a process facade's PassThrough writers does not consume their readable buffers. Publishing process close immediately lets a backpressured evidence recorder finalize before receiving the remaining stdout or stderr bytes, even though the Executor saved the complete output.

## Decision

EnvironmentProcess waits for both readable streams to end or be explicitly destroyed after durable saving, then publishes close and resolves completion. Empty streams advance without consuming buffered data. Stop and abort retain their existing explicit drainage behavior. Executor identity, saved receipts and output replay remain unchanged.

## Alternatives considered

**Await writable finish or another event-loop turn.** Neither establishes that a paused reader consumed the final buffer.

**Resume the readers when the process exits.** This overrides recorder backpressure and can enqueue additional evidence writes while the consumer is deliberately paused.

## Consequences

Close reflects consumer drainage as well as durable execution completion. A consumer that leaves nonempty output paused must resume, destroy it or stop the facade. Real native regressions hold both streams after writable finish, then independently exercise resume, stop and abort while verifying exact bytes. Existing shell regressions continue to assert complete archived output before the bounded preview settles.
