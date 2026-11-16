# Decision Record: Drain native Bash abort before owner disposal

Status: implemented

## Problem

An aborted native Bash command could finish its output and release execution resources while its original cancellation still reconciled storage. Its fallback exit timer also remained scheduled after native completion. Either callback could outlive the captured Runtime and enter closed storage or a disposed context.

## Decision

The existing Bash process owner retains its original termination promise and drains it before reporting child completion. Its original 30-second abort fallback is registered before termination starts and belongs to the same timer cleanup as hard-ceiling and foreground timers. Native exit, successful closure and failed closure all retire that fallback. Repeated termination uses the same original operation.

The callback keeps its captured Runtime and original errors. Process authority, cancellation receipts, output drainage and execution saving remain with their existing owners. See the [incident](../../../postmortem/0208-native-bash-abort-outlived-command-completion.md).

## Alternatives considered

**Return when native execution and output finish.** The cancellation operation can still be reconciling its final durable receipt.

**Ignore callbacks after Runtime closure.** That conceals unfinished owner work and discards original failures.

**Shorten or remove the fallback deadline.** Its existing recovery behavior is independent of retiring the callback after completion.

## Consequences

Command completion now includes cancellation settlement, and an already completed command retains no abort fallback. A real native child is aborted after its readiness output; the test drains the command, closes its original Runtime, opens another and remains active beyond the unchanged fallback interval. The original code fails during late cancellation, and a cancellation-drain-only increment still fails at the original fallback. The complete fix passes both boundaries without suppressing closed-owner errors.
