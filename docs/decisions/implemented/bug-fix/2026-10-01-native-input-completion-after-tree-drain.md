# Decision Record: Stop input controls after native tree drainage

Status: implemented

## Problem

A short Git command can finish and drain its native process tree before a queued parent stdin EOF runs. Sending that redundant input control races the worker's final completion record and can produce `EPIPE`, replacing a successful command result with a transport failure. The dirty-worktree regression exposed this during Linux CI.

## Decision

The parent stops forwarding stdin EOF once the worker reports whole-tree or stream drainage, publishes its exit record, or enters shutdown. A drained process tree has no remaining input reader. The worker's completion acknowledgement and output-drain protocol remain authoritative; dropping a redundant input notification does not release ownership earlier.

Live readers still receive the byte-counted stdin EOF. Transport failures before completion remain observable and cannot be converted into successful dispatch. Existing native ownership and cancellation boundaries are unchanged.

## Alternatives considered

**Ignore every broken-pipe error.** Rejected because a control failure during execution must retain its uncertainty and failure semantics.

**Retry the Git command.** Rejected because execution may have had side effects and a retry cannot establish the first command's result.

**Increase timeouts.** Rejected because a late control write is a state-ordering defect rather than slow execution.

## Consequences

Fast native commands preserve their output and formal completion without issuing input controls to a completed tree. The regression uses a real worker, delays the final drain acknowledgement, delivers a queued stdin EOF and injects a broken pipe if the obsolete notification is sent. It verifies output bytes, exit status and released coordination claims. Existing tests retain early control errors and unread-input/output drainage coverage.
