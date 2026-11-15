# Decision Record: Drain telemetry before source Home retirement

Status: implemented

## Problem

An offline data move can hold the source Home lock while its own Runtime still has queued telemetry writes and open logging resources. Those producers are independent of the transfer's storage readers. Copying or removing the source before they settle can omit selected mirror bytes and race source retirement.

## Decision

For `removeOriginal: true`, the move command drains its current Runtime's telemetry after the Library conflict choices and before entering the target-file transfer. With the original Home locks held, it awaits `ObservabilityWriter.stop()`, stops `ObservabilityMetrics`, awaits `ObservabilityStore.stop()` and awaits `Log.close()`. This follows the telemetry owner order in [Runtime shutdown](../../../../packages/harness/src/lifecycle/runtime.ts): finish queued mirror writes before stopping their metric sink, then close the telemetry Store and logging writer.

The [move implementation](../../../../packages/presets/src/cli/data/move.ts) retains the existing transfer, native claims, target Store lifecycle, copy error handling and source-removal condition. The `removeOriginal: false` path leaves telemetry available. Retirement does not disable observability configuration, add a retry or introduce a delay.

The real regression holds the original mirror append before its filesystem effect. The command's original writer stop releases that barrier and awaits the same flush before copying or removing the source. The removal observer records whether that flush had already settled, then releases and awaits it before passing through to the real removal; this lets the defective implementation fail the ordering assertion without leaving a suspended writer behind. The selected state copy must contain the exact original mirror bytes, and later original telemetry producers must not recreate the retired Home. A separate source-preserving control requires the same Runtime's writer to remain usable.

## Alternatives considered

**Stop telemetry for every move.** A source-preserving copy does not retire its Runtime's Home and must leave that writer available.

**Disable the mirror or skip telemetry files.** That avoids the real producer instead of draining it and can omit data selected for transfer.

**Sleep or retry source removal.** Elapsed time and a successful removal attempt do not establish that the original producer has ended or prevent a later write.

## Consequences

Retirement captures the original completed mirror bytes and closes the command Runtime's telemetry before the transfer crosses its destructive boundary. A requested retirement stops these owners before copying; a later copy failure still preserves the source according to existing error handling and does not automatically reopen the stopped telemetry. Ordinary source-preserving moves retain their previous lifecycle.

The [controlled regression](../../../../packages/presets/test/cli/data.test.ts) proves a missing producer-drain boundary. It does not establish that this defect uniquely caused an earlier CI source-removal residue; see the [incident record](../../../postmortem/0215-offline-home-retirement-left-telemetry-producers-active.md).

## Validation

The append-based control rejects the original implementation with an unfinished flush at source removal. The corrected complete owning file passes all 31 cases and 82 assertions, including the source-preserving writer control; the owning TypeScript check also passes. CI acceptance remains separate.
