# Decision Record: Preserve native filesystem identity during fault injection

Status: implemented

## Problem

The delete-pending lock fixture replaces `node:fs/promises` with a module proxy. Registering a previously captured namespace during cleanup does not restore the object identity used by cached default imports. A later retry fixture can observe zero calls to its read spy and bypass its injected errors. Whether the production lock module was already imported also changes which implementation receives the replacement.

## Decision

The fixture uses a test-scoped spy on the native default object's `open` method, delegating unaffected calls to the original function. The production module is imported normally. Existing exclusive-open, write and close failure injections and their original error assertions remain. Cleanup explicitly closes handles whose simulated close failed and removes only directories created by that fixture.

Validation exercises the failure-injection file before the retry file, then separately preloads the production lock through its real filesystem tests before running both. The observed runner order is part of the evidence; command-line file order alone is not a scheduling guarantee.

## Alternatives considered

**Re-register the native module namespace.** This is the failing approach: it does not undo references already retained by dependent modules.

**Change production imports to match the mock.** That adapts product code to a test-runner artifact and still couples correctness to import order.

**Move these small tests into separate processes.** Process isolation would contain the replacement but retain an unnecessary whole-module mock and hide the preloaded-consumer case.

## Consequences

The same-process Linux ordering rejects the module replacement with three retry failures and passes all ten original tests with the scoped spy. Preloading the lock's real filesystem suite also preserves all twenty-one tests. Retry counts, error classes, timeouts and coverage policy are unchanged. Filesystem fault injection remains limited to the operations that cannot be produced deterministically on every host platform.
