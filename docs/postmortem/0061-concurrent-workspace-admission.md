# Concurrent Workspace admission

## Executive summary

Two child tasks could start execution against the same object Workspace concurrently. The first task persisted a preparing mount while transferring files; resource admission rejected the second task before it reached the mount owner's existing serialization. Sequential tests missed the interval between persistence and materialization. Admission now waits for an attachment owned by the current Runtime and revalidates the resulting authority, without treating a persisted preparing record as permission to recover it.

## Summary

The rejected task received `WorkspaceUnavailable` while its sibling successfully attached and executed. The Environment and Workspace identities were valid; the failure depended on the first tool still materializing the Workspace.

## Timeline

- Concurrent child execution exposed a preparing mount rejected by resource admission.
- A deterministic blob-transfer barrier reproduced the rejection before the fix.
- The corrected admission passed execution, file access, cancellation and attachment-failure cases against a real local Executor.

## Root cause

`WorkspaceMounts.attach` serializes attachment within a Runtime, but `EnvironmentResources` rejected non-active mounts before calling it. A second admission therefore mistook an owned in-flight transition for unavailable authority. Removing the state check or implicitly remounting would instead risk accepting an orphaned or failed transition.

## Guardrails added

[Resource admission](../../packages/harness/src/environment/resources.ts) waits only for the existing Runtime-owned attachment, then rereads and validates the Workspace binding and Environment target. Cancelling a waiter leaves the writer running. The [concurrency regression](../../packages/local-runtime/test/environment/resources-concurrency.test.ts) holds materialization pending, proves shared exact file content, rejects another Environment without allocating it, preserves cancellation reasons, propagates writer failure and prevents implicit retry after failure. The [Environment contract](../architecture/environments.md) documents these boundaries.

## Lessons

Admission checks must distinguish transitions owned by the current operation coordinator from persisted transitions needing explicit recovery. Tests need a barrier at that boundary, not timing-dependent concurrent launches alone.
