# Decision Record: Isolate native library fixture compilation

Status: implemented

## Problem

The native library selector regression bundles both the production loader and builder with their shared utility dependency. On Linux with Bun 1.3.14, loading that dependency into the test process before repeated `Bun.build` calls makes the first fixture compile successfully and the remaining six fail while reading the existing utility source. The same failure occurs without coverage. Running the test alone without the earlier production import conceals the batch-dependent failure.

## Decision

Each scenario compiles both production entrypoints through a fresh `bun build` subprocess, using the running Bun executable and the same output layout and libc definitions. The test drains compiler output, asserts success and reaps the compiler before using its artifacts. It explicitly loads the real native module in the parent so the regression retains the failing batch precondition when run alone.

All seven scenarios continue to execute the canonical utility, loader and builder. They preserve source detection, compiled overrides, explicit cross-build targets, non-Linux defaults, source-derived build receipts and selected artifact paths. Fixture artifacts validate selection and cache behavior; they do not establish actual musl execution.

## Alternatives considered

**Run the test in a separate coverage shard.** Rejected because that hides the earlier production import rather than making compilation independent of the test process. The failure can occur without coverage as well.

**Retry compilation or replace the shared utility in the fixture.** Rejected because retries keep the invalid process state, while replacing the dependency would stop exercising the production boundary being validated.

## Consequences

Each scenario starts an extra local compiler process. Runtime loading no longer shares the compiler's state, and failures retain compiler diagnostics separately from fixture execution. The change follows the existing [compiler isolation decision](2026-09-23-isolate-standalone-plugin-kit-compilation.md) without changing production selectors, package exports, deadlines or test assertions.
