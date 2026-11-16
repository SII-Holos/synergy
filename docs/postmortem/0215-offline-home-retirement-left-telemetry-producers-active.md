# Offline Home retirement left telemetry producers active

## Executive summary

The offline move command could copy and remove its source Home while its own telemetry writer still had an unfinished append. Home and transfer storage locks did not drain that independent producer. Drain the current Runtime's telemetry owners before transferring a Home requested for retirement, while keeping a source-preserving move's writer available.

## Summary

The defect was reproduced with a real queued JSONL mirror write and the original move command. The regression holds the writer's original append, rather than replacing it with a fabricated failure. Its ordering assertion rejects source removal reached before that flush settles. This demonstrates an omitted retirement boundary; it does not identify the unique cause of an earlier CI removal failure or prove that every leftover source directory came from telemetry.

## Timeline

- Source tracing found that the move held offline Home locks and managed its transfer readers, but left the command Runtime's telemetry owners active before copying and removal.
- The controlled regression entered and held the original mirror append. Without the drain, the command reached source removal while the original flush was unfinished; `drainedBeforeRemoval` was false.
- The removal observer recorded that original state, then released and awaited the writer before performing the real removal. This kept the defective execution finite without converting it into a successful ordering result.
- The implementation added the existing telemetry owner shutdown sequence before the target-file transfer, only for a requested source retirement. The regression also requires exact selected mirror bytes and checks that subsequent original producers do not recreate the retired Home. A separate control preserves writing after a move that retains its source.
- The final append-based version passed the complete owning file: 31 cases and 82 assertions, including the source-preserving control. The owning TypeScript check passed. This is local validation, not a CI result.

## Root cause

The command treated offline Home and transfer storage ownership as sufficient evidence that all source writers had ended. The observability mirror has its own Runtime-scoped queue, flush promise and scheduled work; Metrics, its Store and logging also have separate lifecycle owners. Closing transfer readers or deleting the directory cannot substitute for stopping those producers.

The fix uses their existing lifecycle methods in the same relative order as Runtime shutdown: await the mirror writer, stop Metrics, await its Store and close logging. It runs after user choices with the original Home locks held and before the transfer copies source files. The existing successful-copy requirement still controls actual source removal.

## Guardrails

- [x] Real producer regression: `packages/presets/test/cli/data.test.ts` — hold the original mirror append, observe early operation settlement as well as barrier entry, require the flush to settle before removal, preserve exact copied state bytes and reject source recreation by subsequent original telemetry producers.
- [x] Source-preserving control in the same file: `removeOriginal: false` leaves the Runtime's original mirror writer able to append and flush real bytes.
- The [retirement decision](../decisions/implemented/bug-fix/2026-11-15-drain-telemetry-before-source-home-retirement.md) records lifecycle order and the choice to drain rather than disable, sleep or retry. Complete-file local success does not establish CI acceptance or attribute the earlier filesystem failure.

## Lessons

Enumerate every producer of a directory before retiring it, including telemetry owned by the maintenance command itself. Prove the actual producer reached its held operation and inspect its state before cleanup releases it. Keep cleanup passthrough so a missing production drain fails a meaningful assertion instead of hanging the fixture. Preserve the distinction between demonstrating a lifecycle defect and attributing an earlier filesystem failure to that defect.
