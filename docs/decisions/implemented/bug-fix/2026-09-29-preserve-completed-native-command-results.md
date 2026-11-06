# Decision Record: Preserve completed native command results after control reset

Status: implemented

## Problem

A short native command can report complete tree and stream drainage, send its exit result, and then reset its control socket during shutdown. Treating that final reset as a new command failure replaces an already received result with `ECONNRESET`. Linux reproduction through the Workspace file routes identified the control channel, the drained stage and the received exit record; file metadata queries consequently returned an internal error despite successful Git execution.

## Decision

Ignore control-channel `ECONNRESET` after receiving the native exit record. An explicit stop also owns socket shutdown, so its reset does not replace the cancellation result. Other transport failures retain their error path. Receipt inspection, output drainage and physical ownership release still complete through the native observer; receiving an exit event alone does not release a claim.

The regression executes real native commands and injects the same socket error at two protocol boundaries. A reset at readiness must fail. A reset after the exit record must preserve the original nonzero exit code, exact stdout and stderr, and verified claim release.

If native ownership inspection itself fails, that failure is authoritative for completion and retains an earlier transport error as its cause. A supervisor killed before proving descendant completion must report uncertain ownership even when its disconnected socket reports first. The Linux regression forces that ordering and verifies exclusion both before and after the known escaped descendant exits.

## Alternatives considered

**Ignore all connection resets.** A reset before completion can hide a failed supervisor or incomplete output.

**Retry the command or file operation.** The command may have produced side effects. An acknowledged result is retained without repeating execution.

**Increase test deadlines.** The failure is an incorrect state transition, not insufficient execution time.

## Consequences

File services and native tools retain completed results when their control transport resets during shutdown. Missing completion evidence continues to fail; output-channel errors are not suppressed after ordinary completion. Deterministic failure injection supplements the Linux reproduction without relying on scheduler timing.
