# Decision Record: Honor explicit background execution

Status: implemented

## Problem

The public Bash tool declares that `background: true` returns a tracked process immediately. The native implementation waited for the normal automatic-yield deadline, leaving an interactive child waiting for input while its caller waited for the tool result needed to address that process.

## Decision

Explicit background execution resolves the existing foreground wait as soon as the actual command has started. It uses the same native process, registry entry, output, resource ownership and completion path as automatic backgrounding. A command that already exited keeps its normal completion result. Explicit and automatic results describe their actual timing accurately.

A real native regression starts a child that reaches an output barrier and waits for stdin. It verifies prompt tool return, the original tracked process identity and a still-running native operation, then terminates only that owned fixture process. Existing normal, UTF-8 streaming and paused-admission cases remain in the owning suite.

## Alternatives considered

**Require callers to substitute a small `yieldSeconds`.** This leaves a documented parameter ineffective and changes the caller's intended behavior.

**Create a separate detached launch path.** A detached command would lose the existing native process controls, output and resource lifecycle. The original tracked background branch already owns those responsibilities.

## Consequences

Callers can obtain the process identity before supplying interactive input. Default automatic yielding and normal completion remain on their established path. Backgrounding retains the process's native resources until actual completion or owned termination.
