# Benchmark release observer imposed a hidden stream idle timeout

## Executive summary

The release-version observer used Bun's default HTTP idle timeout, which could disconnect a healthy model stream after ten seconds without data even though the task retained a three-hour budget. Long responses and cancellation tests passed because they did not include a sufficiently long quiet interval. A real-socket regression reproduced the early disconnect, and the observer now leaves cancellation to the declared execution and cleanup clocks. The affected experiment remains frozen and its failures are not replaced.

## Summary

Local24-v9 recorded baseline native API connection resets. The retained Doom and FEAL observer logs explicitly reported a ten-second Bun server timeout. Native verification still ran: FEAL's required plaintext output was absent, while Doom's verifier also encountered a dependency DNS failure. Their original rewards and costs remain retained; these results cannot establish a pure model-solving failure or a candidate quality improvement.

The observer deliberately keeps an independent recording branch alive when a native client exits, so an upstream HTTP 200 response or completed usage record does not prove successful delivery to that client. The native error, observer diagnostics and retained upstream response must be inspected separately. Other connection resets without equivalent diagnostics remain unresolved rather than being attributed automatically to this defect.

## Timeline

- 2026-09-23: the study launched with immutable product versions and a frozen evaluator after free unattended and transport controls passed.
- Native baseline executions reported connection resets; two retained observer logs explicitly identified Bun's ten-second idle timeout.
- A deterministic local provider emitted a first SSE frame, paused for sixteen seconds, then completed. The original observer disconnected before completion and printed the same timeout diagnostic. A separate delayed-header control passed.
- Disabling the observer's idle timer allows both quiet-response controls to complete. The existing cancellation and bounded-drain checks remain in the same test suite.
- The repair applies to future evaluator snapshots. No active observer was changed, no failed task or grading was repeated, and the original evidence remains available for the study report.

## Root cause

The local release adapter starts a Bun HTTP server but did not override its default idle timer. The timer applies to response streams as well as unused connections. A provider can legitimately pause between reasoning or content chunks for longer than that default. This transport restriction was unrelated to the frozen solving deadline and could affect the release adapter differently from the candidate's native rollout path.

The tests covered large continuous streams, inherited worker requests, native exit, interrupted responses and cleanup. None left a real observer socket quiet past the runtime default. A large output fixture therefore gave no evidence about sparse or bursty streaming. Live first-byte metadata also remained stale until request completion; that separate display defect was repaired without changing the affected experiment.

## Guardrails added

- The [release observer](../../benchmark/runtime/session-relay.mjs) sets `idleTimeout: 0` and cites the runtime's documented timeout behavior. Task cancellation and bounded observer drain still remove owned resources.
- [Native transport tests](../../benchmark/test/capture.test.ts) use real local sockets and sixteen-second pauses before headers and after an initial reasoning frame, then require exact response bytes and final usage.
- The observer file already participates in the frozen runtime digest, so its repair creates a new evaluator/runtime identity rather than silently changing an existing run.
- The [development Skill](../../.synergy/skill/develop-benchmark/SKILL.md) requires idle-gap controls and separate inspection of client delivery and observer accounting.

## Lessons

A long task deadline is ineffective when an intermediary silently imposes a shorter idle deadline. Stream tests need quiet intervals as well as large payloads. Complete upstream accounting cannot substitute for native execution evidence, and an evaluator repair cannot retroactively validate an affected paired comparison.
