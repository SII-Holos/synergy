# Decision Record: Use Docker-owned resources for benchmark admission

Status: implemented

## Problem

The [adaptive scheduler](2026-09-23-benchmark-adaptive-unattended-execution.md) needs an admission decision that remains meaningful on Linux, macOS and WSL. A host route inventory describes a different network namespace from Docker Desktop and cannot reserve addresses between checking and creation. Subtracting host memory usage from Docker VM capacity also combines different accounting domains. Counting both a running project's memory and its existing reservation would reject work that fits the daemon budget.

## Decision

[Environment creation](../../../../benchmark/src/synergy_bench/environment.py) prepares missing image-only services, acquires a stage reservation, and invokes Docker Compose create with build and pull disabled before the original up command. Compose and the daemon allocate the actual networks and unstarted containers, preserving native driver, IPAM, disabled-network and internal/egress settings. The evaluator contains no route parser, subnet count or second network-definition compiler. The implementation cites the upstream Compose lifecycle.

Only the daemon's explicit address-pool exhaustion messages are queued. A partial creation is removed through the same project-scoped Compose definition; container, network and volume inventories must confirm removal before releasing the reservation. Queue waits do not consume task deadlines. Other creation errors terminate the attempt, cancellation preserves its outcome, and debug mode keeps failed resources for inspection without retry. Cleanup never prunes other projects or deletes shared images. Admission and actual container starts are separate scheduling events.

[Docker observations](../../../../benchmark/src/synergy_bench/docker_resources.py) share a one-second snapshot within each pool. The existing cgroup working-set and CPU-delta calculations serve both scheduling and per-trial recording. Docker memory admission counts the larger of each project's reservation and observed working set, plus unleased containers and new reservations. Host memory, CPU and disk pressure remain separate gates. Docker's total memory minus configured reserves is a scheduling ceiling, not a measurement of VM free memory. Missing or stale observations stop new admissions; running tasks are not killed to reclaim capacity.

Sampling supports the local Unix Docker endpoint on the supported POSIX hosts, including Docker Desktop contexts. An unsupported endpoint is a permanent configuration error: the shared sampler raises `DockerEndpointError` before waiting or acquiring a lease, and dispatch preserves that typed failure and stops subsequent cells. The same classification point reads local exceptions and Pier's native exception records without rewriting either persisted result; resource-pressure and recording failures retain their global stopping behavior through both paths. The diagnostic omits the endpoint address. Transient connection failures and stale samples retain the pressure queue and can recover. This check belongs to ordinary resource sampling and introduces no separate preflight or remote-daemon compatibility path. Blocked runs retain the existing [fresh-run recovery contract](../simplification/2026-09-23-benchmark-direct-execution.md); this change does not automatically replay or unblock an experiment.

Shared reservations use version 2 and exact Compose project identity. Every acquisition rechecks current lease health under the shared budget lock. An unknown version stops admission and remains available to its original evaluator. A dead owner's reservation is released only after its resources are verified absent; retained orphans do not count as progressing owners for the idle pressure deadline. Cold artifact builds use the same resource pool. Oracle audits use the same phase scheduler as model trials, including separate verifier admission; unresolved cleanup is recorded before retaining the reservation and stopping dispatch. Oracle global resource failures use the same dispatch classifier after evidence and lease finalization, and retained global failures prevent new work on re-entry; ordinary task failures continue without replay or result conversion. YAML, CLI and scored-result formats remain unchanged; evaluator identity freezes the new implementation for new experiments instead of converting historical evidence.

## Alternatives considered

**Platform-specific route commands.** Supporting Linux ip and host-specific route formats would retain a race and query the wrong namespace on VM-backed Docker installations.

**Precreate external networks through the Engine API.** This could reserve addresses, but would require translating arbitrary native Compose driver/IPAM/internal definitions and owning their replacement and cleanup. Compose create already owns those semantics and preserves custom task recipes.

**Infer VM free memory from the host or double-count all container usage.** The first compares different machines; the second charges an owned project's working set twice. Shared project reservations and daemon observations express the actual budget without inventing a free-memory metric.

## Consequences

New environments require a successful creation phase before starting services. Docker resource exhaustion can delay work, and unknown daemon state fails closed. Sampling and reserves reduce oversubscription but do not promise protection from every short peak or unobserved daemon/kernel allocation. The lifecycle tests cover partial creation, cancellation, debug retention, unknown failures and scoped cleanup; resource tests cover VM/host separation, shared project accounting, stale observations and old/orphan leases. Free Docker controls verify ordinary, disabled and internal/egress networks through actual create/up/down operations. No live-provider call is required for these checks.
