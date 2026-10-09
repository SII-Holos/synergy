# Decision Record: Select production model execution per Runtime

Status: proposed

## Problem

An embedding application may already isolate identities and workloads in separate processes. Requiring another inference process adds lifecycle and memory costs without improving that application's isolation. The test-only stream injection does not provide production admission, provider preparation or shutdown guarantees.

## Proposal

Allow Runtime composition to select worker or same-process production inference. Both use the same prepared provider request, retry, rollout and accounting path. The same-process executor bounds concurrent calls, queued requests and queued bytes; propagates cancellation before and during execution; and does not report shutdown until admitted work has stopped. Runtime-owned executors never share mutable state across Runtime instances. Retain the worker backend for applications that need its isolation.

## Alternatives considered

**Always use a worker process.** This preserves process isolation but duplicates it for applications that already own one process per identity.

**Use the test stream hook in production.** This bypasses production preparation and lifecycle semantics, so it cannot establish reliable cancellation or stopping.

**Remove worker execution globally.** Other applications still need independent inference-process memory and fault isolation.

## Acceptance criteria

Both production modes preserve provider preparation, tool metadata, rollout attribution, cancellation, accounting and retry behavior. Same-process admission rejects saturated queues without unbounded buffering, queued cancellation releases capacity, and stop waits for active work. Tests cover runtime separation and real streaming through a deterministic provider endpoint without spawning inference workers.

## Risks

Same-process inference shares an event loop and memory with the caller. The composition owner must select it knowingly; hard process termination remains the embedding application's responsibility when a provider cannot be interrupted.
