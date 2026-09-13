# Decision Record: Benchmark resource admission and immutable cache ownership

Status: implemented

## Problem

A concurrency count alone does not account for task memory, an independent verifier, preparation or multiple evaluator processes. Cache reuse also becomes unsafe when publication is interrupted or collection races with an experiment's frozen inputs. Re-running preparation on every trial wastes time while reusing writable task state changes the experiment.

## Decision

The [scheduler](../../../../benchmark/src/synergy_bench/resources.py) admits native task and verifier resource declarations against Docker capacity after explicit CPU and memory reserves. It checks host pressure, rejects impossible requests, bounds light-task backfill and retains running work under pressure. Shared leases coordinate evaluator processes using the same cache. Kernel locks release after parent death; remaining owned containers retain their reservation until cleanup. Preparation, doctor and scored execution use the same admission mechanism. Per-attempt admission adds a 0.2 CPU and 128 MiB allowance for recording and proxy services without changing native task limits. Source and package preparation reserves 2 CPUs and 4 GiB; cross-process build slots default to two. These build reservations are admission estimates, with actual utilization retained separately. CPU/RSS peaks are sampled maxima. Local Unix Docker endpoints use a continuous Engine API OOM subscription; interrupted or retrospective-only event coverage cannot establish an exact zero OOM count. Closing the subscription merges and deduplicates a final event window so buffered terminal events survive cancellation. Recovery returns private log ownership through the retained container image before reading native terminal records; the helper has no network, retains file modes and bytes, and also works when the original container has stopped.

The [cache](../../../../benchmark/src/synergy_bench/cache.py) owns only objects and images with benchmark receipts. It addresses immutable source, package locks, platform and recipe inputs, serializes identical builders, publishes atomically and verifies retained bytes. Run references protect frozen inputs; temporary reservations protect explicitly supplied artifacts before initialization can collect unused objects. Collection never claims shared images and never performs global Docker prune. Image sizes are reported as logical bytes, with shared-layer over-counting disclosed. Source bundles register their inventory before atomic publication; missing publication remains invalid rather than becoming unowned data. Intermediate source/package images are counted only when owned artifact receipts identify the exact image ID; bundles remain usable after collecting an unused intermediate image. Read-only harness bundles share the same image prerequisites; prewarming deduplicates task images and checks capacity in batches. Long-lived execution relies on frozen-input references, allowing unrelated unreferenced cache collection.

Preparation, agent execution, artifact collection, verifier preparation and execution, export and cleanup have distinct retained stages. Agent timing uses the native task deadline after the benchmark gateway dispatches the first model request; unresolved startup has its own deadline. Native oracle execution uses Pier's resolved native deadline. Oracle audits execute isolated native solutions and verifiers, and preserve every selected task in their reports.

[Result reporting](../../../../benchmark/src/synergy_bench/report.py) preserves all attempts and separates primary native reward from auxiliary verifier metrics. Missing wire evidence yields unknown byte coverage. Missing experiment conditions prevent paired comparisons. Historical oracle records can be imported through a read-only report without repeating grading or rewriting the original records.

## Alternatives considered

**Use a fixed worker count for every task.** Mixed small tasks and 8 GiB tasks can exceed Docker memory even when CPU utilization is low.

**Collect every unused Docker object.** The Docker daemon is shared with unrelated projects. Absence of a running container does not establish benchmark ownership.

**Regenerate missing evidence during resume.** A rerun changes the attempted execution, cost and sampling policy. Recovery must first reconcile retained evidence and give any further execution a separate identity.

**Treat a numeric reward or archive checksum as sufficient validation.** Rewards do not prove functional tests started. A checksum only identifies bytes; native archive contents also need structural validation.

## Consequences

Conservative memory reservations and cache protection can defer new work. Pressure and capacity failures remain explicit. Frozen experimental inputs may require an explicit larger budget or smaller preparation batch. Concurrent legacy evaluators require a retained resource reservation until they finish because they do not publish shared leases. Independent native oracle audits distinguish task/environment problems from model performance without exposing oracle state to agent runs.
