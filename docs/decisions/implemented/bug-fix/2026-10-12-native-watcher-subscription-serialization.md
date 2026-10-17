# Decision Record: Serialize macOS native watcher subscriptions

Status: implemented

## Problem

Concurrent rejected `@parcel/watcher` subscriptions on macOS arm64 can escape their awaiting callers, crash Bun, or reach a JavaScriptCore exception-extraction assertion. A reduced experiment needs only four concurrent subscribers to missing temporary directories. It reproduces with normal JIT settings on Bun 1.4.2 and also fails on 1.4.3; model traffic, databases, forced collection and Shell failures are unnecessary for the native-only case. One caller completes the equivalent rejected work.

The mixed-load experiment also reached the same native fault offset recorded in the managed backend incident. This establishes a matching failure site, not the original backend's complete JavaScript call path or a general engine repair.

## Decision

macOS native subscriptions use a process-wide serial queue. Linux retains its shared inotify capacity protection, now using the same queue. Windows keeps its existing behavior. The queued factory checks its generation immediately before native work, so disposed owners do not start a delayed subscription.

The queue owns the original native Promise separately from the caller's observation. A timeout can reject the caller and arrange late-success cleanup without releasing the native slot. Waiting jobs start their timeout only after admission. Linux's stall observer also starts at native admission; its capacity guard runs before each scan. Real native settlement, including rejection, releases the next job.

This complements [missing-root recovery](2026-10-12-missing-watcher-root.md). Missing roots stop retrying. Serialization alone is not a substitute for that terminal policy: an intentionally unlimited mixed error load still produced an escaped stream rejection after serialized watcher errors. The product uses both protections; the Bun engine issue remains separate.

## Alternatives considered

**Upgrade Bun alone.** Rejected as a fix because the reduced concurrent-native experiment also fails on 1.4.3.

**Release the queue at the caller timeout.** Rejected because the native scan is uncancellable and another subscription would overlap it.

**Disable JIT or suppress unhandled errors globally.** Rejected because neither establishes correct exception ownership and both affect unrelated runtime behavior.

## Consequences

Concurrent Scope startup queues native scans on macOS. An unresolved native scan blocks later subscriptions, while its caller still receives the existing timeout. Polling and authoritative file reads retain correctness. The existing Linux capacity breaker and stall behavior remain covered.

The [isolated native fixture](../../../../packages/local-runtime/test/fixtures/watcher-subscription-queue.ts) completes 400 rejected subscriptions with one native operation in flight. Its explicit unsafe mode reproduces the unqueued failure for diagnosis; the macOS native Workspace CI task explicitly selects the safe-mode regression, with a batch-inventory test preventing omission. Queue tests cover rejected tasks, capacity trips, timeout admission, a still-pending native call and late-success cleanup. These are bounded regression checks, not proof that every Bun native crash has been eliminated.
