# Test Design

Read only sections relevant to the current change. Search the headings and domain terms before loading unrelated cases.

- [Define the Invariant First](#define-the-invariant-first)
- [Choose the Lowest Useful Level](#choose-the-lowest-useful-level)

## Define the Invariant First

When a dedicated CI task activates opt-in tests, declare its mandatory scenario names in the verification catalog. Verify the actual JUnit report rejects skipped or missing scenarios; process exit status cannot prove that an external capability was exercised. Cover both source and test-only changes in affected planning.

1. State the observable contract and the failure that would violate it.
2. For a bug or new behavior, write the smallest failing test before the implementation. Skip a new test only for a pure refactor whose existing tests already cover unchanged behavior.
3. Assert public results, state transitions, emitted contracts, permissions, or recovery behavior. Avoid source-text assertions, private call counts, and snapshots of irrelevant structure.

Seed large SQLite fixtures inside a transaction so per-row durability flushes do not dominate correctness test deadlines. Preserve the dataset size and the migration, restart, and failure boundaries exercised by the test.

For usage capture changes, vary response media type independently of body framing, including byte-sized UTF-8 chunks, SSE newline forms, oversized events and cancellation. Compare live normalized usage with replay from the retained bytes. Historical recovery fixtures must begin with an advanced live checkpoint and an incomplete estimate, then cover repeated replay, explicit clears, missing artifacts, restart at a page boundary and concurrent requests. Warm the task-summary cache before background repair and verify it observes the repaired facts through normal usage events. Do not reconstruct historical transport timing or substitute current prices for saved evidence.

Compare directory snapshots as sorted paths or sets when asserting unchanged files; filesystem enumeration order is not a product invariant.

For independently loaded UI groups, wait for the observed group itself before asserting its result. Another group's rendered content cannot establish completion; retain checks for failure isolation and retry without imposing response ordering.

Prepare durable fixtures before starting a short runtime deadline; for Cortex timeout tests, enqueue follow-ups between `Cortex.prepare` and `Cortex.start` rather than racing their writes against the timer.

For persisted cooldowns and retry deadlines, advance a controlled clock at the failure-response boundary and verify both the recorded timestamp and the exact policy duration. Cover second boundaries explicitly; an upper bound derived before asynchronous work must not replace the time at which the policy applies. Restore the clock even when an assertion fails.

When compressing wall timers around a controlled monotonic clock, advance only the deliberately expired requests. Keep the simulated budget valid while a healthy native worker replies, and delay that reply beyond a compressed timer tick to verify re-arming without extra timeout evidence. Separate unrelated production-host acceptance scenarios into fresh fixtures with their own bounded deadlines; retain the original history size, throttling and assertions.

For worktree lifecycle changes, exercise concurrent name selection after admission, setup descendants, unregistered directory users, active-turn selection/removal, cancellation and deferred unlock. Verify concurrent tools in sibling and shared Workspaces while real unrestricted commands are still active. Test LSP continuity, exact formatter preconditions, save conflicts after response loss and stale checkpoint recovery without replay.

For automatic worktree cleanup, fail native admission and the final Git removal after eligibility succeeds with an idle bound Session. Assert original binding, registry membership, bytes and activity survive, and a later candidate still progresses. Separately fail binding persistence after successful deletion and verify the next sweep reconciles the retained registry entry.

For shared claim ledgers, exercise a legacy reader rewriting newer records. Missing observation fields must remain unknown and cannot restore exclusive authorship or authorize undo; preserve retained resource ownership.

For process-overlap changes, bind a real owned native tree before admitting a competing writer; a PID-only fixture does not exercise production tree ownership. Cover unavailable native inspection, unknown PID identity and verified PID reuse. After native drainage, validate retained checkpoint authority before and after a later isolated operation, then release explicitly after saving.

For retirement changes, overlap cleanup in independent repositories and include concrete Git/cache mutations outside the retired directory. Verify that broader ownership is reserved before directory exclusion, that nested writes cannot wait on their own lifecycle claim, and that undeclared expansion fails before queuing. Capture ownership state for an unexplained timeout; a green rerun alone does not identify its cause.

For process-backed write evidence, test the interval after native exit but before archive completion: an overlapping writer must remain excluded, disjoint roots must proceed, and finalizer failure or Runtime death must not leave a completed process permanently occupied.

Inject native control-socket resets both before and after the completion receipt. Preserve exact output and exit status after acknowledged completion; a lost supervisor must still report uncertain ownership and retain its claim, with any earlier transport failure preserved as a cause. Test dropped WebSocket output and terminal-status frames separately, including cursor replay after the connection closes.

Windows shell regressions must explicitly select `cmd` when testing its quoting contract; the runner's default can resolve to another interpreter. Cover a quoted executable with multiple quoted arguments, and report early command exit before waiting for a descendant readiness marker.

Await native-I/O rejection before applying a synchronous error matcher in Windows tests. Capture the rejection through `await promise.then(() => undefined, (error: unknown) => error)`, then assert its type and content; an unexpected resolution must still fail. Bun's asynchronous `toThrow` matcher can block database progress on Windows; see [Bun issue 19130](https://github.com/oven-sh/bun/issues/19130). Preserve the real operation and its deadlines when changing the assertion.

When a handler test exercises a nonzero `process.exitCode`, snapshot it as `process.exitCode ?? 0` and restore that numeric value in `finally`. Bun 1.3.14 ignores assignment of `undefined`, so verify the test process exit status even when all assertions pass.

For admission wrapped in execution-capacity waits, inject cancellation and a thrown resume error after the Host returns a lease. Verify cleanup for independently retained file pins as well as task-owned claims; a successful acquire does not imply the surrounding wait returns successfully.

For non-blocking and ordering contracts, hold the downstream operation behind an explicit promise and assert the upstream result while it remains pending. When asserting that an inbox item remains queued after an operation that schedules a wake, hold a real SessionManager loop lease on the worker; clean up its queued work before releasing the lease so a delayed wake cannot escape the fixture. Drive the public wake before queue assertions and after cleanup to cover both scheduling orders without sleeps. For cross-process lock tests, hold the first owner behind an explicit parent release message and retain readiness as a promise; do not poll for a transient exact log snapshot. Release the owner only after the contender reports actual acquisition contention, not merely startup or intent to call the lock API. Drain child stderr and register process cleanup before awaiting startup. Use a generous test-framework timeout only to detect deadlocks, release the barrier in cleanup, and avoid wall-clock performance thresholds in instrumented correctness suites. Do not wrap correctness-only completion signals in shorter `Promise.race` timers: filesystem and worktree startup contention can exceed those incidental budgets on CI.

A native readiness wait must also observe operation settlement: preserve early failures, report completion before readiness, and close its observer before cancelling and draining the owned operation. Publish readiness payloads atomically and validate positive PIDs before liveness checks: file existence can precede its write, and an empty payload coerces to process group zero. Test supervisor startup failure with a real early-exiting launcher; retain bounded stderr and exit identity, and prove that the target command did not run and its unactivated claim was released. Intentionally suspended native cancellation fixtures must reserve cleanup time within their existing test budget; the framework's hard timeout can kill the supervisor before its completion receipt is written.

Also inject a supervisor error after command activation and let the real root exit normally. A drainage promise and exit code zero cannot replace the process error channel; callers must preserve that error while still draining ownership before returning.

Separately exercise a real child closing stdin while unread input is queued, then emitting more stdout and stderr. Input rejection must reach the input stream without terminating the command; require its actual exit, complete output bytes and released claim. Keep output and control transport failures fatal.

When a public operation returns a typed in-progress outcome at its foreground budget, correctness tests must await its documented completion path before asserting durable results. Exercise that outcome with an explicit held-operation fixture; do not raise the product deadline or swallow unrelated failures.

## Choose the Lowest Useful Level

For byte-bounded queues, hold a worker busy and admit several individually valid requests across scheduling lanes. Verify aggregate rejection and exact byte release on dispatch, queued cancellation, startup failure, and shutdown; a single oversized request does not exercise aggregate admission.

- pure function/schema: inline data and direct calls
- tool/domain behavior: real implementation plus isolated temp directory and Scope context
- persistence/migration: real storage, fresh-install and upgrade fixtures, restart/readback where relevant
- route/SDK: call the route or generated client contract
- session/LLM loop: real session state with deterministic provider/model fixtures
- Web/UI: component/context behavior plus the smallest browser or integration check needed
- external agent adapters: execute a deterministic protocol fixture as a real child through the public Adapter interface; verify stdin, event framing, tool errors, usage, thread isolation/resume, credential filtering and shutdown rather than only private argument builders
- package/release: build, pack, and validate the published artifact rather than source layout alone. Core owns standalone tool execution and installed-package task completion; full owns the six result cases, the complete import/export check and component lifecycle described in [CI verification](../../../../docs/operations/ci.md). Help and health checks do not validate product lifecycle delegation.

After splitting a package, evaluate each new owner against aggregate coverage; the former combined percentage can hide an uncovered protocol or lifecycle branch. Exercise worker registrars in an isolated Runtime context as well as through real IPC. Keep process-only coverage exclusions limited to exact entry files with named executable tests; do not exclude reusable registrars or lower the new package floor.

Exercise a library's public package entry in its behavioral embedding tests, even when the same file also starts a CLI. Child-process bootstrap tests cannot establish the in-process import contract or contribute that entry's parent-process coverage.

Inspect two nearby tests and `packages/harness/test/support/preload.ts` before introducing a new harness pattern.

Importing an App `src/components/**` module directly from `bun:test` needs its module-load side effects satisfied first: `mock.module("@/locales/en/messages.po?lingui", () => ({ messages: {} }))` for the catalog, because the `.po?lingui` module is not Bun-loadable, and a stub for anything reaching `@ericsanchezok/synergy-ui/icon`, whose `lucide-solid` `Dynamic` chain throws "Client-only API called on the server side". Prefer extracting the logic under test into a plain module (a classifier, a resolver, a projection) and testing that directly; reach for the mocks only when the component's own wiring is the subject.

The Web runner's `browserOnly` list selects module conditions, not process isolation. Suites that replace shared router, server, SDK or theme modules must also appear in `isolated`, so their mocks cannot affect lazy imports in sibling suites. Check both lists when a suite passes alone but fails with missing exports in a CI batch.

Place every test under the owning package's `test/` directory, mirroring the relevant source domain when that helps navigation. Place repository-level script and policy tests under the root `test/` directory. Never cascade `*.test.*` or `*.spec.*` files beside implementation files in `src/`, `script/`, or another source directory. Run `bun run test-layout:check` when adding or moving tests.

For localized UI behavior, use a real Lingui `I18nProvider` with minimal English and Simplified Chinese messages. Assert visible text and accessibility labels after a reactive locale change; do not mock translation calls to return IDs because that hides missing catalogs and stale module-load translations. Keep plugin-author, user, LLM, path, identifier, and raw-error pass-through in the same boundary test as translated host chrome.
