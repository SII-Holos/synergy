# Decision Record: Preserve acknowledged native exit on control pipe closure

Status: implemented

## Problem

Full CI intermittently reported `write EPIPE` in short Workspace Git and file operations. The native process parent preserved acknowledged exit on `ECONNRESET` but treated the equivalent control-channel write failure as a new execution failure. A deterministic transport fault at the acknowledged exit replaced exit code 7 with the injected error.

## Decision

Treat control-channel `EPIPE` like `ECONNRESET` after the worker reports exit or during owned stopping. Preserve the actual exit, stdout, stderr and physical cleanup. Both errors before acknowledgement remain failures; ordinary stdin closure retains its separate handling. Product APIs and the native protocol stay unchanged.

## Alternatives considered

**Retry failed Git commands or entire tests.** Repeating a successful mutation can duplicate side effects and leaves the ownership race unresolved.

**Ignore every pipe failure.** An early control failure cannot establish completion and must retain uncertain execution ownership.

## Consequences

The existing real-child regression covers both error codes before and after acknowledgement, exact nonzero exit, retained output and released Workspace claims. The CI behavior change is limited to preserving an already reported result, with output drainage and native ownership retained.
