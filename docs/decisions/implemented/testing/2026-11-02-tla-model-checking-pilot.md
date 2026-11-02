# Decision Record: Bounded TLA+ pilot for sync replay and message windows

Status: implemented

## Problem

Scope epoch replay and the session message window are where reconnect and history bugs concentrate, and the architecture page states their invariants in prose. Those rules are easy to break at the joins: a gap that advances the watermark, a pruned journal that still returns `ok`, a history prepend that drops the page just loaded, a stale cursor that extends the slice, or a tail gap cleared by an in-window update. Unit tests cover individual reducer steps. They do not enumerate the interleavings.

## Decision

`spec/tla/` holds two bounded TLA+ models and the cfg files TLC checks. `ScopeEpochReplay` is one Scope's epoch, contiguous seq, journal suffix, and reconnect recovery. `MessageWindow` is one session window: latest and history, `pendingLatest`, stale-cursor recovery, prepend, and cap. The message window is its own spec. Constants in the cfg files bound the state space. `bun run tla:check` checks that the specs, invariants, and README are present. `SYNERGY_TLC=1` runs TLC when `TLA2TOOLS_JAR` points at a local jar. Required CI runs that structural gate through `test/script/tla-check.test.ts` and does not install a JDK or TLC.

The checked message-window invariants match the reducer and the invariants list in [Frontend data sync](../../../architecture/frontend-data-sync.md#invariants). History cap keeps the oldest ids of the combined slice, including a turn prefix that the cap cuts through, and the history-mode paragraph states that same rule as `capHistoryMessages`. `CandidatePendingIsNewer` is not a checked invariant: TLC's shortest trace parks unseen id `1` after a capped prepend, and the reducer test replays those steps. The architecture page defines pending as any id that is not in the window, so the pilot does not change the reducer.

## Alternatives considered

**Install TLC in required CI.** Rejected because a JDK and `tla2tools.jar` are a heavy gate for two small specs. The structural check runs in the existing root test task, and TLC stays a documented local command.

**One spec for every frontend sync candidate.** Rejected because the pilot is the epoch/replay path and the message window. Folding the rest into the same change would make the state space and the review unbounded.

**Vendor `tla2tools.jar`.** Rejected because the checker is an external JVM release. The README pins the download and the invocation; the jar stays outside the tree.

**Change history reconcile so pending ids are only newer than the window.** Rejected because the written rule parks every unseen id, and inbox materialization treats that set as canonical arrivals. The refuted candidate is recorded with its trace and a reducer replay. It is not a runtime edit in this pilot.

## Consequences

Local TLC can check both models. The commands and the invariant lists live in [spec/tla](../../../../spec/tla/README.md). Required CI fails if a checked invariant disappears from its cfg or is no longer defined. `MessageWindow.candidate.cfg` stays a known refutation and is not executed by `tla:check`. The reducer is unchanged. The new window test replays the refuted trace. The epoch model reports 4,353 distinct states and the window model 3,183; neither checked invariant failed.
