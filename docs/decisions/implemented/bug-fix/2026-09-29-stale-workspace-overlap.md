# Decision Record: Keep exited Workspace claims out of overlap

Status: implemented

## Problem

A durable Workspace process claim remains until its saved output and native descendants are verified. The coordinator treated that retained claim as another active writer. Independent language-server and command claims in the same Workspace therefore recorded `overlappingWrites`, even after the earlier process had exited. File evidence refused its final snapshot and remained permanently incomplete.

## Decision

Durable claims remain recoverable until explicit drainage. Participation in overlap requires a claim that is not drained and whose native process tree and bound process identity are still active. A retained claim with empty managed-mutation roots does not borrow its selected-directory use roots after its process tree has exited. Concurrent processes whose trees are still active continue to overlap across shared selected directories.

## Alternatives considered

**Reap every durable claim when its PID disappears.** This would release ownership before saved output and descendant drainage were verified, allowing rebinding or removal while recovery was still required.

**Treat every empty process-mutation root as non-overlapping.** Resource-only commands intentionally represent their selected directories. Ignoring those roots would hide genuinely concurrent writers and authorize unsafe undo.

**Recover incomplete evidence after the turn ends.** A missing final snapshot cannot prove which bytes belonged to the operation. Historical records remain incomplete; only later operations benefit from the corrected observation.

## Consequences

Completed commands no longer make later isolated work permanently unrestorable, while uncertain native ownership still blocks resource retirement. The ledger can retain drained-pending claims, so inspection must not equate claim presence with an active writer. Historical incomplete patch records are not rewritten.
