# Decision Record: Preserve Workspace HTTP request origins

Status: implemented

## Problem

Workspace-file HTTP requests resolved resource requirements without their mandatory native origin. Valid local and stored-file reads failed before reaching their file owner. Supplying a Host label at each request would lose an existing Session or resource invocation's provenance.

## Decision

The selected Server HTTP composition registers a Runtime-owned Workspace-request Host capability before startup. Workspace-file middleware captures its Scope, selectors, original signal and read/write mode before asynchronous resolution. It inherits a present resource frame's original opaque origin; an incomplete frame fails before reading file bytes. Only requests with no resource frame use the registered HTTP Host.

The original Workspace generation and Scope still select file authority. Browsing requests require Workspace files without requesting execution, so dormant stored content remains available without allocating compute. Read startup remains independent of unrelated Scope recovery; writes retain their existing startup barrier.

## Alternatives considered

**Create a Host for every request.** This would replace an inherited native task or resource origin and could admit work after that original authority closed.

**Register the Host on the first request.** The Runtime seals native owner registration before startup. First-use registration would make request order determine composition and bypass that lifecycle.

## Consequences

Minimal HTTP fixtures explicitly select the HTTP composition before opening their Runtime. This change adds no request fields, schemas, routes or generated SDK methods. Plugin and VCS origin consumers remain separate work.

## Verification

Server `test/server/workspace-context.test.ts` observes the actual original origin inside the canonical storage-backed blob reader. It covers a fresh HTTP Host, inherited origin identity, rejection before byte reads when a frame lacks provenance, and zero allocations while browsing dormant files. Workspace-file, Environment, selection and startup suites preserve native file behavior and write barriers. See [the postmortem](../../../postmortem/0128-workspace-http-request-lost-its-resource-origin.md).
