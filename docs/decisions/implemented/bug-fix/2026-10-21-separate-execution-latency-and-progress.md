# Decision Record: Separate execution latency and progress

Status: implemented

## Problem

Total execution duration measures latency, not whether work has stopped. Normal approval, capacity and child-result waits can exceed the slow-tool threshold. A compiling subprocess can remain silent while its owner is alive. Conversely, an observer heartbeat does not establish that the observed execution is making progress. Tool phase transitions alone omit streamed metadata and process output, and empty model deltas do not establish meaningful model content.

## Decision

The existing Session phases and Tool lifecycle supply observations to the existing trace. `Tool.Context.execution` separates progress, scoped waiting and owner-liveness probes. Changed tool metadata and committed process-output bytes report progress through the common Resolver context. Repeated identical metadata does not report progress. Process evidence registers a probe against its actual process owner. Child-output retrieval declares child waiting through this same interface rather than Resolver recognition of a tool name. Capacity handoff observes its existing pause/resume lifecycle, including resumed admission; concrete child or authorization waiting takes precedence over a nested capacity handoff. Detached work does not inherit the parent's capacity observer.

Trace attributes expose the execution phase, wait reason, owner liveness and activity state. The existing stalled threshold produces a diagnostic only when no expected wait is active, all registered owner probes confirm unresponsiveness, and no progress has been observed for the threshold interval. An absent or failing probe is unknown evidence, not a deadlock. Confirmed owner liveness prevents silence alone from producing a stalled diagnosis; it does not advance progress. Existing complete-duration metrics and slow-completion issues remain independent.

Span heartbeat and diagnosis writes preserve the last-progress timestamp. Closed spans reject late activity, heartbeat, diagnosis and duplicate completion. Tool observations are fenced by cancellation, root identity and the current loop lease. Processor execution-phase updates use the same ownership fence. No timeout, cancellation, permission, retry or safety policy changes.

`llm.stream.first_token` retains its historical first text-or-reasoning delta semantics, including empty deltas and its stream-opened clock. Labels make those semantics explicit. `llm.stream.first_content` measures the first non-whitespace text, reasoning, tool name or tool-input delta observed by the processor; `llm.stream.first_visible_text` measures only non-whitespace text. Pure tool output does not fabricate a legacy first token or visible-text observation. The new durations start at the corresponding recorded transport attempt's `timing.sentAt`, excluding queue admission and request preparation. Missing dispatch evidence produces an explicitly unavailable count, never a substituted clock. Measurements describe processor receipt, not browser paint or provider-internal token generation, and are flushed after stream disposal. Model-content trace checkpoints are sampled at one-second intervals and content-kind transitions; terminal spans retain the exact last observed progress timestamp.

## Alternatives considered

**Use total duration or output silence as stalled evidence.** Rejected because legitimate streaming, waiting and quiet execution would be misclassified.

**Count heartbeats as progress or recognize child waits by tool name.** Rejected because observer liveness is not work progress and a name-specific exception cannot serve other waiting tools.

**Redefine the historical first-token series or substitute queue-entry time for missing dispatch.** Rejected because those choices silently change existing measurements and misattribute queue latency to model response latency.

## Consequences

Unknown executions can remain unknown until an owner supplies stronger evidence; this intentionally avoids an unsupported stalled claim. Transport timing remains required for the new latency series. Raw inflight idle/stale projections and presentation do not become proof of deadlock. These observations neither cancel execution nor extend deadlines, and do not introduce another execution scheduler or persisted Session state.

Behavioral evidence lives in [execution observability tests](../../../../packages/harness/test/session/execution-observability.test.ts) and [span tests](../../../../packages/harness/test/observability/spans.test.ts): real temporary Runtime/SQLite storage, controlled model frames and dispatch evidence, a silent subprocess with confirmed ownership, committed process output, genuine owner loss, actual Cortex result waiting, and timeout/cancellation/root/lease fences. Existing processor retry and Tool settlement tests retain their original terminal behavior. The [Workbench timeline regression](../../../../packages/workbench/test/performance/store.test.ts) reads real stored observations for the legacy series, both dispatch-based durations and both unavailable counters through the authoritative metric catalog without substituting one clock for another.
