# Decision Record: Select production model execution per Runtime

Status: implemented

## Problem

An embedding application may already isolate identities and workloads in separate processes. Requiring another inference process adds lifecycle and memory costs without improving that application's isolation. The test-only stream injection does not provide production admission, provider preparation or shutdown guarantees.

## Decision

Runtime composition selects worker or same-process production inference through `ModelExecution.register`. Both use the prepared provider request, retry, rollout and accounting path. The same-process executor bounds concurrent calls, queued requests and queued bytes; propagates cancellation before and during execution; and waits for provider disposal before successful shutdown. Runtime-owned executors never share mutable state across Runtime instances. The worker backend remains the default for applications that need its isolation.

Prepared same-process calls use request-local SDK instances, preserving Invocation credentials and timeouts without mutating the shared catalog or caching per-request secrets. Stream usage is collected only after consumption so the SDK cannot open an eager parallel reader that defeats backpressure. Failed disposal closes admission and remains a shutdown failure. A terminal provider stream error retains its original failure while releasing the slot; cancellation of an already errored stream is not a second disposal failure. Independent queued requests remain admissible after that terminal stream error.

Session title generation is admitted after the first model step. A detached job still consumes the executor's bounded capacity; starting a title before the conversation can make a single-slot Runtime wait for an auxiliary provider response before sending its main request. Deferring the title preserves capacity limits and existing detached cancellation, recovery, and rename protection without reserving another model slot.

The Agent embedding entry imports the public Local Runtime client and Host adapters directly. It does not evaluate the unselected native composition merely to access those adapters. Explicitly selecting that composition retains its normal registration and worker behavior. A subprocess import test rejects an eager load of the unselected registrar.

Server compositions may set `execution.policyWorkerPrewarm` to `false` when most requests do not need isolated classification. The default still prewarms the Policy pool. The first classification creates the same bounded subprocess pool; this selection does not inline the parser, bypass permission checks, or change cancellation, fallback and shutdown behavior. The [startup tests](../../../../packages/agent-runtime/test/policy-startup.test.ts) exercise both choices through a real Runtime and subprocess classification, including rejection after shutdown.

## Alternatives considered

**Always use a worker process.** This preserves process isolation but duplicates it for applications that already own one process per identity.

**Use the test stream hook in production.** This bypasses production preparation and lifecycle semantics, so it cannot establish reliable cancellation or stopping.

**Remove worker execution globally.** Other applications still need independent inference-process memory and fault isolation.

## Consequences

Same-process inference shares an event loop and memory with the caller. The composition owner must select it knowingly; hard process termination remains the embedding application's responsibility when a provider cannot be interrupted.

The [executor tests](../../../../packages/harness/test/session/model-executor.test.ts) cover queue limits, cancellation, disposal and backpressure. The [Runtime test](../../../../packages/harness/test/session/model-execution-runtime.test.ts) exercises preparation, HTTP transport, concurrent request credentials and persisted rollout accounting with zero inference workers. These tests do not establish application startup latency or cross-Host recovery.

The [title tests](../../../../packages/harness/test/session/title.test.ts) exercise provider ordering through loop-job dispatch and verify that title settlement survives release of the conversation lease.
