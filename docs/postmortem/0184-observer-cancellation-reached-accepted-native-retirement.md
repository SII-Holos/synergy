# Observer cancellation reached accepted native retirement

## Executive summary

An observer could cancel after a permanent retirement reservation and prevent the original native fence from completing. The accepted operation still inherited the observer's artifact and Storage queue admission. Native completion needs its own original lifetime after a verified commit.

## Summary

The real pending-retirement regression held the first native fence effect, committed the original reservation, cancelled its observer and started Source closure. Releasing the held effect produced the observer error before a physical receipt existed. Cleanup failed and contaminated the following case. The same failure without the later archive-reopening changes excluded that separate feature as its cause.

## Timeline

Tracing found that writer preflight installed the observer signal in artifact admission, which ordinary Runtime entry preserved. The first retirement completion read inherited that cancelled queue scope. A dedicated original-lease commit owner separated native completion only after canonical reservation verification. The original regression and adjacent cold-retry, unknown-commit, native-failure and queue cases passed together.

## Root cause

Pending retirement reused one signal through validation, reservation and native completion. Its completion-aware catch required an actual physical receipt, so it correctly refused to turn the earlier cancellation into success. The missing ownership transition belonged at the real reservation commit boundary.

## Guardrails

The owning matrix verifies unknown commits with and without a real canonical row, original opaque lease/reference matching, unchanged parent observer cancellation, escaped owned scopes, actual native failure and same-reference cold retry. Source closure waits for the original native result. Ordinary queue semantics remain covered. No arbitrary cancellation reset or additional persisted ledger is exposed.

## Lessons

Commit acknowledgement and observer lifetime are different facts. Retain accepted native work under its original capability, and report completion only after its genuine physical receipt.
