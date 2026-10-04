# Paused output blocked process activation

## Executive summary

A cold Linux CI run timed out in native cancellation acceptance. Investigation reproduced an activation deadlock when an accepted status response arrived after the executor had produced enough output to fill a paused readable buffer. Existing tests covered paused-output completion but did not force the status/output observation order. Activation must remain independent of consumer drainage.

## Summary

The four-phase cancellation test exceeded its 120-second framework deadline, while the same revision passed ordinary CI and a later cold retry. Other tests on the runner continued making progress. Coverage reached the output-draining activation call but did not enter its physical-exit predicate or output consumer, which is consistent with an activation stall. The CI artifacts did not record the exact native status sequence.

A separate probe delayed a real native executor's accepted status response until the command had exited and both native streams had drained. The process facade then buffered 65,536 bytes and waited for readable consumption while its activation promise remained pending. Resuming stdout released that promise. This establishes the defect without claiming that the historical CI run captured the same interleaving directly.

## Timeline

- On 2026-10-04, cold CI failed the native cancellation test after ordinary CI passed on the same source revision.
- An isolated macOS run completed quickly, excluding the existing test duration as an explanation for the reproduced defect.
- The native probe reproduced pending activation after physical exit and released it by resuming paused output.
- A regression retained the real executor and asserted activation before reader resumption; the original stream ordering failed and the corrected ordering passed.

## Root cause

`EnvironmentProcess` reconciled status, resolved activation only for running or terminal execution, and then independently fetched output. An accepted status did not prevent fetching bytes produced later. Once the paused stream reached its high-water mark, the loop awaited drainage before its next reconciliation. The caller awaited activation before resuming stdout, completing a circular wait.

The existing paused-output tests produced less than each stream's high-water mark and did not delay a status response across native execution. The acceptance test produced larger output, but its natural scheduling did not reliably establish this interleaving. Its hard timeout also hid the last successful internal observation.

## Guardrails added

- The [process facade](../../packages/harness/src/environment/process.ts) waits for running or terminal status before consuming output.
- The [native regression](../../packages/local-runtime/test/environment/process.test.ts) delays the accepted response, preserves real output backpressure, checks activation independently, verifies exact Unicode bytes and completed execution, and releases ownership during cleanup.
- The [testing workflow](../../.synergy/skill/testing-guide/SKILL.md) explicitly exercises status/output observation skew and reserves cleanup time for paused native fixtures.
- The [decision record](../decisions/implemented/bug-fix/2026-10-04-observe-process-activation-before-output.md) documents why retrying, changing timeouts or inferring readiness from output do not address the defect.

## Lessons

Independent protocol reads can describe different moments even within one host. Backpressure must not block the observation that tells the consumer it may start. A successful retry does not explain a prior lifecycle timeout; reproduce the suspected ordering and retain uncertainty about unrecorded historical details.
