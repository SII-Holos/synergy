# Decision Record: Share the context fixture completion budget

Status: implemented

## Problem

The context-continuity fixture owns a twenty-second test deadline but returns a still-running child after a separate ten-second Cortex wait. PostgreSQL CI twice reached the shorter wait while the same seven scenarios completed against isolated PostgreSQL 16. The assertion then reports a context regression before the fixture's completion budget expires.

## Decision

Use the remaining portion of the existing twenty-second fixture deadline for child completion. Preserve the terminal status, exact prompt count, root and child context, committed injections and compaction assertions. No product timeout, storage behavior or overall test deadline changes. This test verifies context continuity; latency remains a separate benchmark responsibility.

## Alternatives considered

**Retry until green.** A consistently shorter nested deadline remains sensitive to CI load.

**Increase the overall deadline or accept a running child.** Either weakens an existing bound or omits the terminal-state guarantee.

## Consequences

Setup, parent execution and child completion share one bounded budget. A child that does not finish within that budget still fails. CI remains necessary evidence for the PostgreSQL path.
