# Decision Record: Bounded startup rollout recovery scan

Status: implemented

## Problem

Every runtime open replays startup recovery across every historical session and operation owner: one journal-head probe per owner plus a full journal replay for each owner that ever wrote rollout evidence. The scan is strictly serial and runs before HTTP admission, so startup wait grows linearly with total history even when the previous run ended cleanly and nothing needs recovery. Because probing a missing journal head is indistinguishable from a failed read to telemetry, the same enumeration also publishes a storage issue per owner without a journal, amplifying observability writes on every startup.

## Decision

Rollout journal writes record their owner in a durable pending-set ledger at `data/meta/rollout/recovery-pending.json` before mutating any journal state. Startup recovery trusts a well-formed ledger and recovers only its listed owners, then re-arms an empty ledger; a missing, malformed, or unreadable ledger falls back to the exhaustive owner scan and re-arms after it completes. An empty trusted ledger skips the scan entirely, making a clean restart constant-time. Journal-head probing declares the missing file expected control flow so enumeration no longer publishes storage issues. An unreadable ledger fails journal recording with `RolloutRecordingError` instead of being silently reset, preserving the recording-failure-stops-execution contract while the next exhaustive recovery re-arms. A fully drained runtime settles its listed owners and re-arms the ledger during shutdown, so the ledger never accumulates across sessions; `data merge` and `data move` invalidate the target ledger because copied owner trees can hold journals the target ledger never listed.

## Verification

Behavioral tests cover ledger tracking on first write, clean-ledger startup that checks no owners, bounded recovery of a tracked owner with re-arm, exhaustive fallback on a missing and on a malformed ledger, silent head probing without storage issues, shutdown settle that interrupts listed owners and re-arms (and no-ops on missing or untrusted ledgers), merge and move invalidation of the target ledger, and the managed runtime failure path that still refuses completion and home ownership.

## Alternatives considered

**Keep the fixed health timeout.** Terminates legitimate recovery on large homes; #1359 already replaced it with progress-based grace and does not shorten the wait itself.

**Skip recovery or open HTTP admission before it.** Breaks the single-writer guarantee that keeps interrupted settlement free of concurrent journal writes; rejected in #1359 and still required.

**Persist a clean-shutdown marker.** Covers only orderly exits: desktop termination deadlines, crashes, and power loss miss the marker and fall back to the full scan. The pending ledger subsumes it — an empty trusted ledger is exactly the clean-state signal — and additionally bounds crash recovery to owners touched since the last verified pass.

**Parallelize the exhaustive scan.** Removes only a constant factor; cost still grows with history on every startup, and owner-level concurrency must preserve per-owner journal ordering that recovery currently gets for free.

## Consequences

Normal restarts skip recovery entirely through shutdown settle, and crash restarts scan only owners touched since the last verified recovery, so the ledger stays bounded to the current session. The exhaustive scan remains the trusted fallback — including after a data merge or move imports owner trees — and still defines worst-case startup cost; replay for a dirty owner remains linear in that owner's journal history until journal compaction lands. Crash-window over-inclusion in the ledger is benign because per-owner recovery is idempotent.
