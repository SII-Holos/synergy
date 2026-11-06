# Decision Record: Cover Local Runtime entrypoints in package suites

Status: implemented

## Problem

Frontend changes select Local Runtime package suites as part of their associated platform checks. The package's tests pass, but the final coverage gate finds five unmeasured source modules: CLI Scope helpers, the component factory, worker registration, skill summaries and Git Workspace relocation. Consumer or child-process checks do not establish measured behavior for these source entrypoints in the owning package.

## Decision

Add focused behavioral tests under Local Runtime's existing test runner and isolated fixtures. Load the worker declared by the component and verify that selection registers configuration and bundled SDKs. Open the real component composition and exercise both Home reload executors. Verify explicit CLI contexts, rejected selection and resource disposal after successful and failed runtime callbacks.

Discover real filesystem and built-in skills and validate their summary origin, invocation restrictions and vendor diagnostics. Create and copy a real linked Git repository, reject a foreign destination before rewriting metadata, repair the copied links without modifying the source, then use the destination after removing the source fixture.

Coverage thresholds, source ownership and exclusions remain unchanged. Tests use the owning source modules and public Harness contracts; no import-only coverage fixtures or synthetic production adapters are introduced.

## Alternatives considered

**Exempt the missing modules or lower the threshold.** These entrypoints contain runtime behavior that can be exercised in process, so exclusions would conceal a real verification gap.

**Run unrelated consumer suites for every frontend change.** This expands CI work while leaving package-level guarantees dependent on consumer implementation and build paths.

## Consequences

The existing package suites now produce coverage evidence for all five modules. Four focused files share the normal isolated runtime and temporary-directory fixtures, with no additional CI job or preparation stage. The Git fixture uses actual process ownership and switches to the copied Scope before probing a destination whose source has disappeared.
