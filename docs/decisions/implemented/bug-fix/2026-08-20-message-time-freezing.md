# Decision Record: Freeze message time formatting instead of recomputing per render

Status: implemented

## Problem

A runtime profile of the desktop renderer during a long, multi-session run showed `temporal_rs_PlainDateTime_hour` as the single largest main-thread consumer among busy samples. Every Intl date/time format call routes through V8's internal Rust calendar code, and the renderer calls it repeatedly for identical values: streaming deltas replace message objects and re-run their owning memos, so each `message.updated` re-formatted every visible message-row timestamp, and `turnCompletionStats` rebuilt `Intl.NumberFormat` instances on every recomputation. At 500-message window scale with several parallel sessions this background cost saturates the renderer's per-frame budget during streaming.

## Decision

Freeze formatted results instead of recomputing them:

- `packages/app/src/context/locale/formatter.ts` adds result-level caches to `date`, `dateTime`, and `time` keyed by `(locale, options, timestamp)`, and to `relative` keyed by `(locale, rounded unit, rounded value)`. The cache is capped at 4096 entries per map and clears entirely on locale change. The relative-unit table moved to module scope so the unit scan no longer allocates per call.
- New shared helper `packages/ui/src/components/message-time.ts` exposes `messageCreatedTime(ms)`: a single module-level `Intl.DateTimeFormat` instance plus a 64-entry cache keyed by minute bucket. Message-row timestamps only depend on the minute the message was created, so the label is computed once per minute and reused.
- `MailboxMessage`, `CommandResultOutput`, and `CompactionCard` switch their timestamp memos to `messageCreatedTime`, so streaming object replacement re-runs the memo into a map lookup instead of fresh Intl formatting.
- `formatTurnCost` in `session-turn.tsx` hoists its `Intl.NumberFormat` to a module-level instance instead of constructing one per call.

## Alternatives considered

- **Per-component `createMemo`-only freezing** — rejected: the memo is invalidated by message-object replacement, which is exactly the streaming path that dominates; a memo alone still recomputes. The shared minute-bucket cache survives memo invalidation.
- **Format once at message arrival into a store** — rejected: would add a denormalized display field to the message model and a new reconcile path; the minute-bucket cache provides the same deduplication without touching store ownership.
- **Frozen absolute formatting with exact-millisecond keys** — rejected: exact timestamps defeat the cache across distinct messages; minute bucketing matches what the UI actually displays (`hour: "2-digit", minute: "2-digit"`).
- **Temporal API in the renderer** — rejected: the app has no direct Temporal usage and the Intl path is the app-owned formatter contract; swapping engines would churn all locale formatting for one hot path.

## Consequences

Message-row timestamp formatting runs once per minute per locale instead of once per memo re-run, and the App formatter's absolute-time paths deduplicate repeated formatting of the same timestamp. Locale switches clear the result caches and re-format correctly. The caches add bounded memory (4096 string entries per formatter map, 64 per minute-bucket map) and a small map-lookup cost that replaces the Intl call it deduplicates. A minor semantic trade-off: `relative` results are shared across call sites with identical rounded unit/value, which is visually identical output.
