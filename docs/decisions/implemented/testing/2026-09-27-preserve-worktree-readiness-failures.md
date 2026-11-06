# Decision Record: Preserve Worktree readiness failures

Status: implemented

## Problem

Checkout cancellation fixtures waited for a marker without observing the creation result. If a real Git hook failed first, the fixture replaced its structured creation error with a generic marker deadline. The timeout could not distinguish a pending creation from an operation that had already failed.

## Decision

Checkout readiness observes both the persistent marker and Worktree creation settlement. A directory observer detects the marker, including one already present when observation begins. An early failure propagates unchanged, and successful creation without readiness fails explicitly. The existing ten-second readiness deadline remains a catchable rejection within the unchanged twenty-second outer test budget, leaving time for cancellation and drainage. Every path clears that timer and closes the observer before the fixture cancels and drains creation. Production Workspace ownership is untouched.

## Alternatives considered

**Increase the marker timeout or rerun until green.** Neither preserves an already available creation failure, and a passing rerun does not establish why the earlier operation stopped.

**Mock the hook or native process owner.** This would omit the Git stderr, cancellation and native cleanup that the fixture needs to verify.

**Rely only on the test runner deadline.** A deliberately unready native hook demonstrated that Bun kills its supervisor before fixture cleanup, leaving an incomplete Linux completion receipt and host-wide ownership. This matches [Bun's documented timeout behavior](https://bun.com/docs/test/writing-tests#timeouts). A catchable fixture deadline is needed before the framework's hard stop.

## Consequences

Native process fixtures publish complete PID receipts by atomic rename and validate positive identities before checking liveness. An explicit publication barrier keeps an incomplete receipt invisible to the readiness observer; file creation alone cannot establish that its payload is ready. Cancellation must still drain the actual process before another writer is admitted.

A real failing checkout hook reproduces the lost error with the original wait. Regressions check the original structured error, cancellation of a hook that never becomes ready, native process exit, removal of the unfinished worktree and admission of a subsequent writer. Existing cancellation tests retain their foreign-lock and local-commit preservation assertions. The original CI logs identify the marker timeout and later blocked writers but contain neither the preceding Git result nor a native ownership snapshot; that underlying CI trigger remains unproven. Linux x64 CI remains necessary even when the corresponding native Linux ARM64 batch passes.
