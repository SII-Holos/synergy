# Decision Record: Validate the source Bun runtime

Status: implemented

## Problem

The root package manager pin does not select a version manager's executable. Source preparation and managed Desktop startup could succeed using a different Bun than local verification, including an incompatible child runtime selected through `BUN_BIN`.

## Decision

The development orchestrator shares the verification entry point's Bun check and runs it before any preparation, build or startup work. Both its own runtime and the selected child executable must match the root manifest. Help remains available without running development commands. A mismatch explains version-manager selection and a one-invocation command; preparation retains ownership of project dependencies and build artifacts.

## Alternatives considered

**Upgrade the global runtime during preparation.** Changing an unrelated version manager's global configuration would affect other projects and does not replace already running processes. Runtime selection remains explicit.

**Validate only during verification or installation.** Managed startup can reuse installed dependencies and never reach either check. The development entry point must reject the mismatch before spawning work.

## Consequences

Incorrectly selected runtimes fail early with actionable instructions. Explicit child overrides incur one version probe. [Entry point tests](../../../../test/script/dev-entrypoints.test.ts) verify that a mismatch cannot execute build or install work and that matching overrides are accepted.
