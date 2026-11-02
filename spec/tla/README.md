# TLA+ pilot

Bounded models of two frontend sync rules. The specs are the models. They do not run the server or the Web app.

| Path | What it checks |
| --- | --- |
| `ScopeEpochReplay.tla` | One Scope's epoch, contiguous seq, journal prune, and reconnect replay/resync |
| `MessageWindow.tla` | One session window: latest/history, `pendingLatest`, stale cursor, prepend, and the history cap that keeps the newer tail |

`ScopeEpochReplay.cfg` and `MessageWindow.cfg` are the checked models. Constants in those files are the state-space bounds. Raising them is a local experiment.

The message window is a primary model, not an appendix of the epoch spec. Message ids `1..MsgCount` are canonical order. Dependency-root retention is outside the model: a real latest window may keep referenced roots above the primary cap.

## Install TLC

TLC needs a JDK (11 or newer) and `tla2tools.jar`. The jar is not vendored.

```bash
java -version
curl -fsSL -o /tmp/tla2tools.jar \
  https://github.com/tlaplus/tlaplus/releases/download/v1.8.0/tla2tools.jar
export TLA2TOOLS_JAR=/tmp/tla2tools.jar
```

The pilot was checked with TLC `2026.11.02.143702` from that asset. Any current jar that provides `tlc2.TLC` is enough.

## Run

From the repository root:

```bash
bun run tla:check
SYNERGY_TLC=1 bun run tla:check
```

`bun run tla:check` is the structural gate: both specs exist, each checked cfg names its invariants, and those operators are defined. It does not download Java or the jar.

`SYNERGY_TLC=1` also runs TLC on `ScopeEpochReplay.cfg` and `MessageWindow.cfg`. It reads `TLA2TOOLS_JAR`. `InvHistoryCapKeepsNewerTail` is one of the checked message-window invariants.

One spec from this directory:

```bash
java -XX:+UseParallelGC -cp "$TLA2TOOLS_JAR" tlc2.TLC \
  -workers 2 -cleanup -metadir /tmp/tlc-message-window \
  -config MessageWindow.cfg MessageWindow.tla
```

Replace the config and module name to check `ScopeEpochReplay`. `-cleanup` removes TLC's states directory. Do not commit `states/`, `*.dump`, or `*_TTrace_*`.

## CI

Required CI does not install TLC. `test/script/tla-check.test.ts` runs in the existing root test task and calls the same structural gate as `bun run tla:check`. Model checking stays local because a JDK plus the tools jar is a heavy required check for two small specs.

## Checked invariants

`ScopeEpochReplay` (`MaxSeq = 3`, `JournalCap = 2`, `MaxEpoch = 2`):

- `InvJournal` — retained seqs are empty or a suffix no longer than the journal cap.
- `InvSameEpochNotAhead` — a client on the server epoch is not past the server seq.
- `InvHoldFreezesWatermark` — a gap or epoch change keeps the pre-recovery watermark, including if the server recycles before recovery.
- `InvWatermarkStep` — seed, contiguous delivery, duplicates, gaps, epoch changes, and one retired-epoch drop do what `observeWatermark` specifies. A gap or epoch change does not apply the triggering event.
- `InvRecoverKind`, `InvOkCovered`, `InvResetJustified` — recovery catches the client up to the server head. `ok` is used only when the journal covers the watermark. `reset` is used for a missing epoch, a foreign epoch, a client that is ahead, or a pruned prefix.
- `CaughtUp` — under weak fairness of recovery, a disconnected or held client eventually shares the server epoch and seq.

A live client with no watermark seeds the first state event and does not replay the prefix below it. That matches `observeWatermark`. Streaming events are not in the model.

`MessageWindow` (`Cap = 2`, `MsgCount = 4`, `Page = 1`):

- `InvPendingFlag` — `pendingLatest` is true exactly when the pending set is non-empty.
- `InvPendingDisjoint` — pending ids are not visible.
- `InvCap` — the modeled window never exceeds `Cap`.
- `InvSubset` — visible and pending ids were published and not removed.
- `InvTailOnlyInHistory` — a tail gap exists only in history mode.
- `InvLatestClean` — latest mode has no pending ids, no tail gap, and no stale cursor.
- `InvUnloaded` — an event does not create a window before a latest page load.
- `InvCursorOnlyHistory` — a stale cursor is a loaded history window.
- `InvLatestPageIsSuffix` — a latest load, return to latest, or stale-cursor recovery replaces the window with the newest `Cap` published ids and clears pending, the tail gap, and the stale cursor.
- `InvHistoryCapKeepsNewerTail` — a history page keeps the newest ids of the combined slice, within `Cap` and the page bound. Every dropped id is older than every id that remains, and the window's maximum id is at least the pre-cap maximum. Evicted and newly visible ids leave `pending`. The tail flag is preserved, not set by the drop.
- `InvPendingStep` — an id that is not in a history window is recorded once and is not inserted. The tail flag stays.
- `InvHistoryTouchPreserves` — an in-window history update does not evict, does not clear pending, and does not clear the tail flag.
- `InvRemovePreserves` — removal keeps mode and the tail flag. A pending-only id leaves pending and does not change the visible window.
- `InvIgnoreUnloaded` — an event or removal before the first load leaves the bucket empty.

The model has a quiescent state once every id is published and the window is idle, so `MessageWindow.cfg` sets `CHECK_DEADLOCK FALSE`. The epoch model does not: disconnect and recovery remain enabled.

## Result

TLC found no violation of the checked invariants.

- `ScopeEpochReplay`: 4,353 distinct states, search depth 17. `CaughtUp` holds.
- `MessageWindow`: 2,492 distinct states, search depth 14. `InvHistoryCapKeepsNewerTail` holds.

The reducer test covers the trace publish `m1`–`m4`, latest cap `{m3, m4}`, prepend `m2`: the window stays `{m3, m4}`. An unseen older id such as `m1` is still recorded in `pendingLatestIds`. That pending rule is separate from the history cap.

## Sources

The epoch model follows [State event sequencing](../../docs/architecture/frontend-data-sync.md#state-event-sequencing) and [Replay and resync](../../docs/architecture/frontend-data-sync.md#replay-and-resync), `packages/harness/src/bus/sequencer.ts`, and `apps/web/src/context/sync-watermark.ts`.

The window model follows [Message window and cursor pagination](../../docs/architecture/frontend-data-sync.md#message-window-and-cursor-pagination) and the invariants on that page, `apps/web/src/context/session-message-window.ts`, and `apps/web/src/context/session-message-page-recovery.ts`.

The method is TLA+ and TLC (Leslie Lamport, *Specifying Systems*; the [TLA+ tools](https://github.com/tlaplus/tlaplus)).
