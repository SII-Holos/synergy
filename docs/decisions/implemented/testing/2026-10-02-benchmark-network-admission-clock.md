# Decision Record: Control the network admission clock in benchmark unit tests

Status: implemented

## Problem

The Docker recovery fixture sets a 100ms pressure deadline while persisting scheduling evidence and verifying cleanup through worker threads. Filesystem and executor contention can exhaust that deadline before the first retry, although the fixture intends to verify recovery and project ownership.

## Decision

[Network admission tests](../../../../benchmark/test/test_docker_admission.py) advance the environment's local monotonic clock explicitly. Recovery keeps its short logical deadline; a separate sustained-pressure case reaches the exact deadline and verifies rejection after owned cleanup, without starting services. Real scheduler storage and lease release remain exercised. Product clocks and timeout values are unchanged.

## Alternatives considered

**Increase the fixture deadline.** This reduces the likelihood of failure but leaves correctness dependent on runner speed and lengthens the retry wait.

**Rerun the failed job.** A rerun can pass without removing the scheduling dependency.

## Consequences

The unit tests distinguish recoverable pressure from deadline exhaustion without requiring evidence writes to finish within 100ms. These fixtures prove admission decisions and cleanup ordering; real timer and cancellation tests remain separate.
