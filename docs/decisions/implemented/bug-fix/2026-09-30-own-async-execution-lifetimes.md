# Decision Record: Preserve execution ownership across asynchronous boundaries

Status: implemented

## Problem

Cold CI exposed two execution lifetime defects. A Windows LSP output test reached its incidental ten-second signal timer; the detached abort callback attempted cancellation without its Runtime and reported `StorageClosedError`. Plugin shell input rejection intermittently became an unhandled error while its enclosing asynchronous resource disposal was still running.

## Decision

Bind `EnvironmentProcess` abort callbacks to the composing Runtime before subscribing to the signal. Cancellation still records its durable request and waits for physical completion; detached event delivery cannot borrow a caller's Runtime or lose its own owner.

Await Host Service work inside the `await using` resource scope before returning. The selected Environment admission remains acquired until the invocation settles, and rejected work is observed before asynchronous cleanup begins. Public shell validation, permissions, execution and error contracts stay unchanged.

The existing LSP cancellation test aborts outside every Runtime context and verifies owned process drainage, temporary-data removal and subsequent writer admission. Binary output and nonzero exit tests use an owned controller rather than a second ten-second timer; the test runner still bounds execution. The existing plugin input test delays real resource disposal and requires the original specific validation errors, exposing premature return deterministically.

## Alternatives considered

**Retry failed native or plugin tests.** Both failures depend on real scheduling boundaries; a successful retry cannot establish correct lifetime ownership.

**Suppress storage or unhandled rejection errors.** This would discard cancellation and validation failures and could release resources while work remains active.

## Consequences

Real detached cancellation and delayed resource cleanup fail before their respective fixes and pass afterward. Focused Skills now require these boundaries to be exercised. No protocol, capability, persisted schema or product API changes are introduced.
