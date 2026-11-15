# Decision Record: Observe owned native preview after foreground unknown

Status: implemented

## Problem

A Handoff foreground observer can end while the original Target callback is still preparing its native preview. Racing an acquired-claim event against that foreground rejection confuses an ended response observer with a failed native operation. Ignoring the rejection without observing the original callback would hide actual authorization, preparation or native failures.

## Decision

The enrolled return-adopt late-preview control observes the original Target preview callback and gates its original Workspace preview entry after machine authorization, package receipt verification and native reservation. The original five-second foreground observer reports canonical unknown before that gate is released. The fixture then races the actual acquired native claim against the original callback's completion or failure. Unexpected callback completion and nonmatching foreground errors still fail; an unknown with no observed native callback rethrows the same original error. Callback entry alone never establishes authorization or successful native work.

After the real claim enters, the fixture retains its original source cancellation, Target retirement, lost cleanup acknowledgement, native release and data assertions. Both test gates release in cleanup, and any started original callback settles before its observer is disposed. The same preview is dispatched once. The ninety-second framework guard, five-second foreground and acquired-claim rescue, finite signed plans and thirty-second Workspace source proof remain unchanged. No product deadline, request, retry or permit is added.

Two bounded records retain fixed operation and canonical outcome labels plus callback, gate and claim booleans. They contain no identity, directory, body, hash or signature. The foreground record distinguishes a callback actually held before the observer ended from a naturally later entry. See the [existing transport observation contract](2026-11-15-observe-original-transport-phases-in-acceptance-tests.md) and [native destination ownership](../architecture/2026-11-12-prepare-and-adopt-native-handoff-destinations.md).

## Alternatives considered

**Extend the foreground deadline.** That would change the product observation window and avoid exercising the uncertain response this control must cover.

**Ignore unknown and wait only for claim entry.** Missing native intake or a callback failure could remain hidden until the framework guard. The fixture instead preserves the original error when no callback exists and observes that callback's actual settlement.

**Dispatch preview again.** A second mutation would not establish what happened to the original operation and could change native ownership.

## Consequences

The control deliberately crosses the original foreground boundary while retaining real enrolled authorization, original native execution and cancellation. It does not establish a delivery latency target, identify the cause of an earlier preparation delay or loosen signed terminal-fact verification. Other preview, preparation and activation scenarios retain their existing execution paths.

## Validation

The same [real enrolled fixture](../../../../packages/organization-runtime/test/handoff-cloud-workspace.test.ts) fails with the old race while its actual callback is gated, started and unfinished. With the callback-aware race, it observes the real acquired claim and completes the original cancellation assertions. Both runs retain the original budgets and native owners. Focused local evidence does not replace whole-file, type, CI or cross-platform verification.
