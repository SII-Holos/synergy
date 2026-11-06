# Decision Record: Preserve builtin filesystem bindings during fault injection

Status: implemented

## Problem

The delete-pending file-lock tests need to inject Windows-style `EPERM` errors on exclusive creation, handle writes and handle closure. Replacing the complete `node:fs/promises` module with a default-export proxy also changes what unrelated importers observe. Re-registering the original module does not rebind every cached default import or its `fs/promises` alias. A later retry test can therefore read the real file while its spy records zero calls; matching file bytes alone conceal the missed injection, and exhausted or permanent failures resolve instead of rejecting.

## Decision

The [file-lock tests](../../../../packages/util/test/fs-lock-delete-pending.test.ts) use a test-scoped, disposable spy on the real filesystem object's `open` method. The original open operation remains available for real handles, and handle proxies inject only the requested write or close failure. Each case restores the method before fixture cleanup; failed-close handles are retained for actual closure before their owned directories are removed.

The four file-lock scenarios retain their existing errors, deadlines and assertions. An additional regression dynamically imports the actual [I/O retry helper](../../../../packages/util/src/io-retry.ts), injects one transient read failure and requires two observed reads. Its real file deliberately contains the same bytes as the injected result, so reading the file without using the spy cannot pass the call-count assertion. The existing retry tests continue to cover exhausted transient and permanent errors.

## Alternatives considered

**Restore the builtin module in `afterAll`.** Rejected because module registration and existing default-import object identity are different concerns. The regression fails with zero observed reads while the returned bytes appear correct, and the shared-batch failure depends on import order.

**Run the file-lock suite in a separate process.** Rejected here because only a single method needs fault injection. A scoped spy preserves real filesystem operations and avoids another isolated process without leaking a module replacement into siblings. Suites that genuinely require process-global module or DOM replacements retain their existing isolation requirements.

**Change production retry imports or assertions.** Rejected because the retry algorithm behaves correctly without the polluted test module. Changing an import spelling, accepting zero calls, removing rejection checks or adding retries would conceal the fixture error rather than preserve filesystem behavior.

## Consequences

The package keeps its shared-process test execution and gains one small regression without a subprocess or production API change. Verification must cover both importer orders; command-line file filters alone do not establish the order Bun actually executed. The injected Windows error remains a filesystem-level simulation, not evidence that macOS or Linux reproduced the Windows kernel state.
