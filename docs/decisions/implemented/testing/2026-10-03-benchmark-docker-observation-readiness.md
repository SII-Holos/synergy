# Decision Record: Wait for complete Docker observations in topology fixtures

Status: implemented

## Problem

Daemon-wide resource sampling lists running containers before requesting each container's statistics. A container that stops between those calls can return an empty memory observation. Compose startup readiness for one project cannot guarantee that a single daemon-wide snapshot is complete while another project changes lifecycle state.

## Decision

The [network topology fixture](../../../../benchmark/test/test_docker.py) uses a [bounded observation helper](../../../../benchmark/test/fixtures/resources.py) to wait for a healthy snapshot at the sampler's one-second cadence within the existing 15-second pressure budget. The production sampler and admission checks retain their behavior: unknown memory blocks admission, every observed container contributes to the daemon-wide check, and a missing initial CPU delta is permitted when memory is complete.

[Unix API regressions](../../../../benchmark/test/test_docker_resources.py) supply complete owned-container memory alongside an incomplete unrelated observation. They require recovery after that observation becomes complete or the container leaves the running inventory, and require a deadline failure when memory stays unknown. The real Docker fixture continues to verify ordinary, disabled and internal/egress network settings and project-owned cleanup.

## Alternatives considered

Replacing missing memory with zero or filtering unrelated containers would permit admission without accounting for the daemon's observed workload. Serializing all Docker checks would hide a valid lifecycle overlap and reduce CI throughput. Enlarging the production pressure deadline would change scheduling policy without addressing the fixture's immediate-sample assumption.

## Consequences

A topology check can spend part of its existing pressure budget waiting for an observation. Persistent unknown memory still fails the fixture, and production scheduling, resource limits and health semantics remain unchanged.
