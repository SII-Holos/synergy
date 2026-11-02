# Decision Record: Gate sequential runtime memory against a baseline

Status: implemented

## Problem

`perf:memory:runtime --scenario sequential` already records idle-relative memory after each deletion and at 5, 30, and 120 seconds. Nothing turns a larger candidate into a non-zero exit, so an agent can print JSON and still treat retained growth as success. Running that standard replay on the CI main loop would add a multi-minute server soak to every change.

## Decision

`bun run perf:memory:runtime:compare` reads two JSON artifacts from the session-runtime memory harness. A suite result contributes its sequential scenario. Both sides must use the sequential scenario, the same workload contract version, and the same workload fingerprint. The command compares idle-relative `deltaFromIdle` on the final `run-N-after-delete` sample and on `release-plus-5s`, `release-plus-30s`, and `release-plus-120s`. The metrics are server RSS, process-tree RSS, descendant RSS, heap, external memory, and ArrayBuffers. Candidate minus baseline above the limit fails the process. The initial allowances are 64 MiB, 96 MiB, 64 MiB, 32 MiB, 32 MiB, and 16 MiB. Each allowance is replaceable with a `--max-*-mib` flag. The command prints a JSON report and does not start a server. It is not a CI task. The [operations page](../../../operations/performance-observability.md#cross-version-comparison) owns the command.

## Alternatives considered

**Fail one benchmark run when absolute RSS crosses a fixed ceiling.** Absolute RSS depends on the machine and the Bun build. The harness already stores idle-relative deltas so a paired baseline can absorb that host noise. A ceiling inside a single run cannot separate a regression from a larger machine.

**Add the standard sequential soak to the CI main loop.** The standard release trajectory waits 120 seconds after deletion, and the replay itself is longer. The gate stays an explicit local command so an agent can run it after producing two artifacts, without making every pull request wait for that soak.

**Compare only the 120-second sample.** The final deletion checkpoint and the 5-second and 30-second samples show retention before worker retirement. Dropping them would let a late collection hide memory that was still retained after deletion.

## Consequences

An agent can run the existing sequential harness twice and get a non-zero exit when retained growth exceeds the allowances. A fingerprint mismatch stops before sample comparison. A missing 5/30/120-second sample fails closed. The allowances are fixed byte bars for one paired run, not a measured noise floor or a statistical release bar. Release decisions still use repeated runs and medians. Changing an allowance updates this record, the operations page, and the default assertion together.
