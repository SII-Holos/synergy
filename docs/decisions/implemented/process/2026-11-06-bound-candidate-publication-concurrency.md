# Decision Record: Bound candidate publication concurrency

Status: implemented

## Problem

Candidate publication waits for each npm package to become visible before starting the next package. Registry scanning delays therefore accumulate even when packages have no dependency on one another. Increasing concurrency must preserve immutable uploads and prevent consumers from becoming available before their dependencies.

## Decision

The module phase and the subsequent platform/wrapper phase each run at most four complete publication tasks. A task finishes after upload or reuse, version visibility and requested-tag verification. Required and optional first-party dependencies finish before their consumers start; the Desktop application descriptor retains its explicit deferral until signed artifacts and final upgrade evidence exist.

The scheduler validates the entire phase's graph, selected version and archive budgets before registry writes. It publishes the prepared archives unchanged. The first failed task stops further scheduling; active tasks finish before the original error is returned. Ready consumers can fill a free slot while unrelated tasks remain active. Registry polling budgets, signing, notarization, upgrade acceptance and stable promotion remain owned by their existing checks.

## Alternatives considered

**Serial publication.** It simplifies sequencing but adds every independent registry visibility delay to the release duration.

**Unbounded publication.** Starting every package together increases concurrent writes and cannot preserve dependency completion without additional scheduling.

**Fixed batches of four.** A slow unrelated package would prevent the next batch from using an available slot.

**The CI task queue.** That queue deliberately continues scheduling after a task failure to collect diagnostics; publication must stop starting irreversible writes after failure.

## Consequences

Independent registry waits overlap while concurrent uploads remain bounded. Up to four started tasks may still finish after a failure, so failure reporting waits for their outcomes and recovery continues to inspect accepted versions. Actual savings depend on registry scanning, network throughput and the dependency graph; controlled scheduling tests and historical timing models do not establish production speedups.

Behavioral tests retain graph validation and real archive packing, and cover the concurrency bound, required and optional dependency completion, immediate slot reuse, preflight before any write, and draining multiple failures without replacing the first error.
