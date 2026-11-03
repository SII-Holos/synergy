# Decision Record: Bounded TLA+ pilot for sync replay and message windows

Status: implemented

## Problem

Scope epoch replay and the session message window are where reconnect and history bugs concentrate, and the architecture page states their invariants in prose. Those rules are easy to break at the joins: a gap that advances the watermark, a pruned journal that still returns `ok`, a history prepend that drops the page just loaded, a stale cursor that extends the slice, or a tail gap cleared by an in-window update. Unit tests cover individual reducer steps. They do not enumerate the interleavings.

## Decision

`spec/tla/` holds two bounded TLA+ models and the cfg files TLC checks. `ScopeEpochReplay` is one Scope's epoch, contiguous seq, journal suffix, and reconnect recovery. `MessageWindow` is one session window: latest and history, `pendingLatest`, stale-cursor recovery, prepend, and cap. The message window is its own spec. Constants in the cfg files bound the state space. `bun run tla:check` checks that the specs, invariants, and README are present. `SYNERGY_TLC=1` runs TLC when `TLA2TOOLS_JAR` points at a local jar. Required CI runs that structural gate through `test/script/tla-check.test.ts` and does not install a JDK or TLC.

The checked message-window invariants match the reducer and the invariants list in [Frontend data sync](../../../architecture/frontend-data-sync.md#invariants). History cap keeps the newest ids of the combined slice, so a prepend cannot drop a tail newer than the messages that remain. That rule is [history cap keeps the newer tail](../bug-fix/2026-11-02-history-cap-keeps-newer-tail.md). Pending ids are newer than the window maximum, which [pending ids are newer than the window](../bug-fix/2026-11-03-pending-ids-newer-than-window.md) checks as `InvPendingIsNewer`.

## Alternatives considered

**Install TLC in required CI.** Rejected because a JDK and `tla2tools.jar` are a heavy gate for two small specs. The structural check runs in the existing root test task, and TLC stays a documented local command.

**One spec for every frontend sync candidate.** Rejected because the pilot is the epoch/replay path and the message window. Folding the rest into the same change would make the state space and the review unbounded.

**Vendor `tla2tools.jar`.** Rejected because the checker is an external JVM release. The README pins the download and the invocation; the jar stays outside the tree.

**Leave every unseen id pending.** The pilot first left that set unchecked. [Pending ids are newer than the window](../bug-fix/2026-11-03-pending-ids-newer-than-window.md) is the rule now, and `CandidatePendingIsNewer` is a checked invariant rather than a refuted candidate.

## Consequences

Local TLC can check both models. The commands and the invariant lists live in [spec/tla](../../../../spec/tla/README.md). Required CI fails if a checked invariant disappears from its cfg or is no longer defined. `InvHistoryCapKeepsNewerTail` is one of those checked invariants. The epoch model reports 4,353 distinct states and the window model reports the count in that README; neither checked invariant failed.
