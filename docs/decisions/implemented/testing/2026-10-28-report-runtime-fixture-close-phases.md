# Decision Record: Distinguish Runtime shutdown from fixture disposal

Status: implemented

## Problem

A Bun module cleanup can time out as an unnamed test after its business assertions pass. The shared Runtime fixture's `close` waits for both the core Runtime and its temporary-home disposer, so the outer timeout alone does not identify which operation remained pending. Aggregate coverage from other completed Runtimes cannot supply the missing per-instance execution sequence.

## Decision

The [Harness Runtime test helper](../../../../packages/harness/test/support/runtime.ts) has an opt-in `traceClose` option. It writes only static `runtime` or `fixture` stages with `start` or `completed` states. Completion follows the actual awaited operation; fixture disposal remains in `finally`, and repeated close calls retain the same promise. The default path retains its existing close and disposal sequence without emitting diagnostics.

The [Boss service fixture](../../../../packages/boss/test/boss/service.test.ts) enables this option through its existing test helper. Its composition, service calls, assertions and hook deadline are unchanged. No product Runtime option, API, model request, native probe, identifier, path or user content is added to these records.

The [lifecycle regression](../../../../packages/harness/test/lifecycle/runtime-fixture-diagnostics.test.ts) holds a real core extension disposer behind a barrier. While held, only the runtime start event is present and the owned home remains readable. Releasing it must produce the remaining events, preserve close-promise identity and remove the real owned home. Fixture completion means its disposer returned; a caller-supplied borrowed home retains its existing preservation behavior.

## Alternatives considered

**Increase the hook deadline or retry the batch.** Rejected because a longer wait does not identify the unresolved operation and can conceal a lifecycle defect.

**Assume that an outer fixture timeout proves a core Runtime deadlock.** Rejected because the same promise also includes temporary-home disposal. A source-level possibility or a passing local replay cannot identify the failed CI operation.

**Add product shutdown APIs or speculative cleanup changes.** Rejected because the test fixture already owns the two operations that first need distinguishing. Detailed private phase observers remain investigation tools rather than production behavior changes.

## Consequences

An enabled fixture emits four small records on success and leaves the last reached stage available when shutdown stalls. This is diagnostic evidence, not a fix for the Boss timeout or proof of its cause. The original deadlines and assertions remain intact; future failures still require inspection of their actual run and artifacts rather than inference from an earlier passing control.
