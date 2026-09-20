# Decision Record: Independent diagnostic budget for preflight probes

Status: implemented

## Problem

Every preflight probe reused a hard-coded 120-second agent budget while scoring cells keep the native task deadline. On an emulated `linux/amd64` host a Synergy probe spent 56-63 seconds from startup to the first model request, then needed multiple 26,000-token system-prompt rounds for its mandatory tool roundtrip; healthy harness/endpoint combinations hit the probe budget after three or four rounds and were misreported as connectivity failures, blocking the run even though the same combination had already passed other probes under the same doctor. This is the same reporting failure shape recorded in [postmortem 0013](../../../postmortem/0013-short-native-probes-missed-opencode-rosetta-stalls.md): a short probe cannot represent the execution conditions it is meant to certify.

## Decision

[runner.py](../../../../benchmark/src/synergy_bench/runner.py) gives preflight probes the named `PROBE_DIAGNOSTIC_SECONDS = 300` budget, separate from every scoring deadline. Scoring cells keep `timeout_seconds` or the native task deadline unchanged, the native startup budget stays at `startup_timeout_seconds`, and startup-only timeout retries are unaffected because an agent-stage timeout still fails `startup_retryable`. The [preset contract](../../../../benchmark/test/test_experiment_presets.py) pins the probe budget, the disabled probe verifier, and the untouched scoring deadline in one test.

## Alternatives considered

**Scale the probe budget from the task deadline.** Rejected: it would make connectivity checks proportional to the longest research presets and re-introduce long blocking preflights for every harness.

**Exempt Synergy probes from the deadline.** Rejected: an uncapped diagnostic attempt is exactly the condition doctor exists to bound.

## Consequences

Doctor takes longer on slow or emulated hosts but reports connectivity, not host speed. Probe timeouts under the diagnostic budget remain retained terminal evidence and never enter scoring; they still block the run until analyzed, which is the intended acceptance gate.
