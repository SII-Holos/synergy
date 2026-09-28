# Decision Record: Preserve resource selection scope and observation order

Status: implemented

## Problem

A Session resource mutation must not use a caller's foreign Scope. Millisecond timestamps can tie across consecutive Environment transitions, allowing an older snapshot to overwrite a newer event. Omitting execution providers must also preserve independent Workspace storage.

## Decision

The Environment selection route checks the Session's owning Scope before entering its mutation. Environment updates use a strictly increasing per-resource timestamp, including use release. Resource profile discovery reflects registered execution providers. Local Runtime always registers Workspace blob factories while its Environment option controls execution providers and their default selection separately.

## Alternatives considered

Relying on the resource identifier alone would bypass the route's Scope selection. Treating equal wall-clock timestamps as ordered would leave snapshot/event races ambiguous. Disabling storage with execution would make API-only embedding depend on compute configuration.

## Consequences

Foreign requests fail before mutation, catalog observers can reject older state, and API-only compositions retain dormant file operations without allocating an Environment. Focused API, lifecycle and composition tests cover these cases.
