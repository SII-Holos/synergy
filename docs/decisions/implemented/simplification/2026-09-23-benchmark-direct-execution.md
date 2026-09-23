# Decision Record: Run benchmark cells directly with resource-based concurrency

Status: implemented

## Problem

Local algorithm comparisons spent provider calls and wall time on duplicated connectivity tasks before collecting any scored work. Strict serial admission then stopped an entire study on a cleanup warning even though the native tool roundtrip had completed. Per-pair serialization also prevented independent variants from using otherwise available capacity. The retained outcome is documented in the [stopped local-24 study](../../../research/context-efficiency/2026-09-22-local24-v7-stopped-study.md).

## Decision

The benchmark has one execution path: freeze inputs, prepare each task image on demand, execute its actual instruction, preserve native grading and evidence, and update the paired report. The CLI removes doctor and standalone prewarming; it makes no paid connectivity calls. Native reference audits remain explicit task-maintenance operations. The retired timeout, admission-policy and duplicate concurrency fields are rejected rather than translated into a second path. Product doctor commands are unrelated.

`concurrency` accepts `auto` or a positive integer. Automatic scheduling is limited by pending work and resource reservations, with no fixed count ceiling. Manual values such as 48 limit simultaneous cells, subject to the same resource budgets. All cells enter one queue; pair identities are for analysis rather than mutual exclusion. The seeded schedule defines priority, bounded light-task backfill preserves progress, and each dispatch records its actual sequence. Docker and visible cgroup limits, current available host memory, system reserves and per-task runtime overhead determine capacity. Each execution owns its workspace, container project, endpoint and records; cached immutable images remain shared under build locks.

A cell executes once. Build, solving, grading, archive and usage failures remain observations and do not stop other cells. Recovery reconciles durable terminal evidence and never replays any dispatched cell, including a missing terminal or an attempt whose state write was interrupted. Unavailable shared execution prerequisites, rejected credentials, failed persistence or unresolved owned resources stop dispatch. Operator cancellation drains owned work and retains interrupted costs. A blocked study is preserved for diagnosis and a fresh run, not silently retried.

Attempt format v4 records cleanup independently. The original timeout or failed cleanup marker remains evidence; confirmed resource removal yields a warning without invalidating an otherwise valid native result. Unresolved cleanup blocks further dispatch. Old results retain their original meaning. Usage reconciliation and recording completeness govern report eligibility, not permission to execute the next cell. Unreadable request records remain unknown observations alongside intact requests' known lower bounds, without rewriting source evidence. Reports include every planned pair, missing entries, failures, known usage bounds and historical costs; report-generation failure cannot erase native results or stop dispatch.

This supersedes [strict serial admission](../../archived/architecture/2026-09-22-benchmark-serial-admission.md). The fixed three-hour solving and verification policy remains unchanged. No measured harness loop or product algorithm is replaced.

## Alternatives considered

**Keep optional strict and fast paths.** Two execution policies invite the slow prerequisite path to become the default again and make routine comparisons harder to interpret. A single scheduler collects results; report eligibility communicates evidence limitations.

**Use a universal four- or eight-cell cap.** A fixed number ignores both larger user machines and the memory difference between tasks. The resource queue and the user's single concurrency setting express those constraints directly.

**Automatically retry only apparent startup failures.** Missing or interrupted evidence can make delivery ambiguous, and retries change the cost and sampling population. A retained failed cell is more useful than a replacement whose selection rules require another admission system.

## Consequences

An authorized local comparison begins collecting scored work without a paid prerequisite phase. Some cells may fail for shared or task-specific environment reasons; the report must disclose those failures and cannot claim complete scores or precise token savings when evidence is insufficient. Parallel wall times include real contention and are not a controlled single-task latency measurement. Deterministic tests cover concurrency, failure continuation, cleanup, interruption and recovery; native Docker fixtures exercise actual tools, grading and request reconciliation without live credentials.
