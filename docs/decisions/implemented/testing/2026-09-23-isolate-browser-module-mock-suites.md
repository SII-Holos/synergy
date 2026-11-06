# Decision Record: Isolate Web suites with process-global module mocks

Status: implemented

## Problem

Bun shares `mock.module` registrations across test files in a single process. The Web browser batch runs multiple plugin tests together, so a partial mock of the server context or router from one file can replace exports needed by another file. The affected tests pass on their own but fail according to batch order, hiding their actual behavior behind missing-export errors.

## Decision

Run `builtin-navigation.test.ts`, `global-themes-registrar-lifecycle.test.tsx`, and `theme-config-bridge.test.ts` as separate browser-conditioned processes using the existing App test runner's isolated list. Preserve each suite's assertions and leave the rest of the browser batch intact.

## Alternatives considered

- **Add missing exports to each partial mock:** rejected because it does not prevent another suite from replacing the same module or router export later in the shared process; the mocks are scoped by test file but Bun's module registry is not.
- **Isolate the entire browser batch:** rejected because serializing every browser-conditioned file adds process startup overhead without an observed cross-file mock collision in the other suites.

## Consequences

The three plugin suites can use their existing mocks without changing the modules imported by other test files. CI incurs three additional Bun processes, while the unaffected browser-conditioned suites remain batched. A new browser test that installs process-global mocks must still be assessed for isolation rather than relying on this fixed list to cover future suites.
