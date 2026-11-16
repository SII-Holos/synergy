# Decision Record: Serialize organization runtime integration tests

Status: implemented

## Problem

The organization runtime integration file opens several resident Runtimes, HTTPS listeners, SQLite workers, and WebSocket bridges. Bun's default test scheduling ran those fixtures concurrently, so the Cortex sync exporter could miss its service projection deadline under the combined process load even though the same test passed alone.

## Decision

Mark every test in `packages/organization-runtime/test/runtime.test.ts` as `test.serial`. The file remains a single test process, but its fixture-owning integration cases now create and dispose their homes, storage workers, listeners, and bridges in order.

## Alternatives considered

**Increase the projection polling deadline.** Rejected as the primary fix because the missed projection was caused by fixture contention, and a longer deadline would only hide the scheduling problem while making failures slower.

**Share one service fixture across the file.** Rejected because the cases intentionally verify independent enrollment, credentials, ports, storage, and reconnect behavior; sharing would weaken those boundaries.

**Skip the integration file in CI.** Rejected because the sync exporter and resident Runtime are part of the organization collaboration contract and require full integration coverage.

## Consequences

The organization runtime integration file takes the sum of its case durations instead of their concurrent peak, but it becomes deterministic under CI load. The Cortex projection check retains a bounded 25-second observation window and the file uses the existing 30-second CI test timeout.
