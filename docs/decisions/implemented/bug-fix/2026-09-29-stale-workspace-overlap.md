# Decision Record: Keep exited Workspace claims out of overlap

Status: implemented

## Problem

A durable Workspace process claim remains until its saved output and native descendants are verified. The coordinator treated that retained claim as another active writer. Independent language-server and command claims in the same Workspace therefore recorded `overlappingWrites`, even after the earlier process had exited. File evidence refused its final snapshot and remained permanently incomplete.

## Decision

Durable claims remain recoverable through native drainage and checkpoint saving, until the executor explicitly releases them. Drainage ends participation in new overlap without dropping the retained reservation or its existing evidence.

Overlap reuses the coordinator's conservative native-liveness check without its positive PID cache. A native tree is authoritative when present; otherwise the bound process must have exited or have a positively different identity to be excluded. Unavailable native inspection and unknown PID identity preserve uncertainty. Unrelated roots are filtered before liveness inspection. Active and uncertain resource-only process claims use their selected directories when checking overlap, including after a native tree has been bound.

## Alternatives considered

**Reap every durable claim when its PID disappears.** This would release ownership before saved output and descendant drainage were verified, allowing rebinding or removal while recovery was still required.

**Treat every empty process-mutation root as non-overlapping.** Resource-only commands intentionally represent their selected directories. Ignoring those roots would hide genuinely concurrent writers and authorize unsafe undo.

**Recover incomplete evidence after the turn ends.** A missing final snapshot cannot prove which bytes belonged to the operation. Historical records remain incomplete; only later operations benefit from the corrected observation.

## Consequences

Completed commands no longer make later isolated work permanently unrestorable, while uncertain native ownership still blocks resource retirement within its covered roots. Unknown inspection does not block unrelated Workspace admission. The ledger retains drained claims until saving completes, so inspection must not equate claim presence with an active writer. Historical incomplete patch records are not rewritten.

Coordinator regressions cover exited, recycled and unknown process identities and failed native inspection with overlapping and disjoint roots. The executor regression verifies retained claims after drainage, later isolated admission and explicit release after restart. The file-attribution suite exercises a real owned native process overlapping another session's edit and refuses restoration of that incomplete evidence.
