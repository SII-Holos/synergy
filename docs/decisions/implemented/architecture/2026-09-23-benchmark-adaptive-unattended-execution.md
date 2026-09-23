# Decision Record: Schedule unattended benchmark stages by observed working set

Status: implemented

## Problem

An unattended local comparison could wait for an interactive question because both native launch paths lacked the session's unattended attribute. Reserving each task's container memory ceiling throughout solving, grading and archival also left substantial machine capacity idle. Fixed reservations confused a protective maximum with normal demand. Resource queues inside preparation deadlines could turn healthy waiting into failure, while upstream environment-start retries could repeat work. Routine algorithm comparisons need useful throughput while retaining the three-hour per-stage safety ceiling.

## Decision

Both supported Synergy adapters create a native unattended session and pass its ID to the native CLI. Native child creation inherits interaction semantics. Question tools are excluded by native session/configuration permissions, and unexpected unavailable tool calls remain errors rather than fabricated answers. The measured product sources and their native execution loops remain unchanged. The local-24 preset uses GLM 5.3 Flash, explicitly enabled thinking and low reasoning, with all model roles sharing the profile.

The direct queue from [direct execution](../simplification/2026-09-23-benchmark-direct-execution.md) schedules stage working sets separately from native container limits. Initial solver leases use up to 1 GiB and 0.25 CPU plus runtime overhead. Local Docker Engine samples refresh every second; memory reserves retain the larger of the initial estimate and stage peak plus 25%. New tasks retain initial reservations until a valid sample, and admissions pause on unknown/stale sampling. CPU demand, host/Docker/cgroup memory, fixed system reserves, disk pressure and available Docker subnets control new starts. Network admission accounts for native default/custom address pools, occupied subnets and host routes; restricted egress needs two networks. Exhaustion queues the next environment until capacity recovers. This avoids changing shared daemon settings or inventing a fixed concurrency cap. The automatic count can grow as resources recover; manual concurrency remains an upper bound.

Image preparation uses cache-key locks and two shared build slots. Waiting consumes neither a solver lease nor a preparation deadline. A separate verifier obtains a priority lease after removal of its solver container; an in-place verifier changes the existing lease without requesting duplicate capacity. Verified container removal releases resources before archival. Stage queues, live pressure reasons, observed peaks and actual starts are retained independently of the frozen priority order. The runner records live completion, active, queue and model-response-wait counts. Sampling records append to a stream rather than rewriting an ever-growing history every second.

The gateway persists the first streamed response timestamp before forwarding that data. In-flight reasoning and content streams therefore remain distinguishable from requests still awaiting their first data, without treating a partial response as completed or assigning usage before it arrives.

The release adapter's local HTTP observer disables its server's default connection-idle timer. A quiet interval within a valid model stream must not silently replace the frozen task deadline with a shorter transport deadline. User cancellation, the task deadline, an explicitly configured gateway read-idle limit and bounded observer cleanup remain independently enforced. This changes benchmark observation, not either measured product's source. The [incident record](../../../postmortem/0024-benchmark-session-relay-idle-timeout.md) documents the retained affected study and the real-socket regression.

The benchmark accepts only matrix configuration v2, plan v4 and attempt result v5. It removes configuration normalization, old result branches and automatic forwarding to an old evaluator. A fresh run freezes its evaluator; same-run recovery refuses mismatches and never replays an already started cell. Historical source/product adapters are unaffected. Historical reports, evidence and evaluator snapshots stay sealed. New reports reference prior cost summaries by digest and retain known lower bounds and missing usage, without importing old records or including old scores in the new population.

Solving and grading keep independent 10800-second ceilings. Approximate one-hour full-matrix turnaround is an observed throughput target, not a cancellation rule. Actual model latency, task work and machine contention can exceed that target. No paid preflight or reference-solution admission is introduced.

## Alternatives considered

**Reserve native hard limits for every cell.** This guards against simultaneous peak allocations but serializes mostly idle model-wait periods and holds unnecessary capacity through archival. Adaptive reservations retain headroom and react to measured pressure; native hard limits still contain individual tasks.

**Force all 48 cells to start regardless of pressure.** A numeric ceiling alone cannot protect a shared machine from actual memory peaks or lost telemetry. The same budget rules apply to automatic and manual concurrency.

**Treat non-interactive CLI flags as unattended semantics.** The legacy and current launchers handle flags differently, and flags do not create inheritable native session attributes. Native session construction plus actual tool-catalog checks provides the required behavior.

**Keep old benchmark readers and normalization.** Format inference adds paths that cannot be exercised by the current run and invites reinterpreting retained failures. Sealed summary references preserve historical spending without making old experiment formats an execution dependency.

## Consequences

Normal low-memory model waiting can overlap across both sides of a pair. Sampling may miss very short peaks; native hard limits and live admission headroom remain necessary, and resource measurements are observations rather than guarantees. More concurrency also exposes real provider and machine contention, so reports retain phase queues and response waits. Free regressions exercise native unattended parent/child state, actual tool catalogs, 48-cell scheduling, phase transitions, pressure recovery, cancellation, missing usage and explicit old-format refusal. The supported release adapter remains a separate tested product integration.
