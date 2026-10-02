# Decision Record: Preserve execution after a child closes stdin

Status: implemented

## Problem

A command may close stdin with unread bytes while continuing to produce output. The native input forwarder closes its transport when the child's input closes; a resulting connection reset or broken pipe must not terminate an otherwise healthy command or discard its remaining output.

## Decision

After activation, a reset or broken pipe on the identified stdin transport destroys the public input stream with the original error. It does not fail process supervision. Output and control transport errors retain their existing failure semantics, and process completion still requires the native tree and both output streams to drain before releasing ownership.

A real child regression closes its input behind an observable barrier while input is queued, writes distinct later stdout and stderr, and exits normally. The observer checks both complete byte sequences, exit identity and the independent claim ledger. The original implementation fails this regression on macOS and Linux ARM64.

## Alternatives considered

**Ignore every connection reset.** Rejected: loss of an output or control channel can conceal missing bytes or an uncertain execution result.

**Treat input rejection as command failure.** Rejected: stdin is independently closable; commands that stop consuming input can still complete valid work and output.

## Consequences

Input writers can observe the rejected stream without replacing the command's eventual result. The change does not infer successful execution from a socket error, retry a command, or relax native completion receipts.
