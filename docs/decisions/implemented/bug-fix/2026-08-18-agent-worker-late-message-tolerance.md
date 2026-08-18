# Decision Record: Tolerate late agent worker messages instead of killing the worker

Status: implemented

## Problem

Two production incidents in one day showed a BlueprintLoop failing with `Error: Agent worker exited (SIGTERM)`. In both cases an agent worker had just released a turn and then received a message referencing that already-released turn's request ID. The pool treated any message whose request ID did not match the current task as a protocol violation and killed the worker with SIGTERM. The kill happened after `drain()` had already assigned the worker its next turn — the BlueprintLoop start prompt — so the innocent next turn failed too, and the turn was not retried because `SessionRetry.retryable` did not classify a worker crash as retryable.

Late messages are legal: the worker's `collect-memory` response heartbeat carries the request ID of the turn that triggered the probe and can arrive after `released`/`finishTask` because of GC and IPC timing. The pool kept no memory of recently released request IDs, so it could not distinguish this benign case from a genuinely unowned request ID.

## Decision

Add a bounded released-request grace window in the pool and make worker crashes retryable:

- Each `PoolWorker` keeps a ring of the two most recently released request IDs with a 30-second TTL. A message whose request ID matches a recently released turn is dropped with a debug log and an `agent.worker.late_message` metric instead of killing the worker.
- The ownership check is now three-way: recently released → drop; matches the current task → existing state machine unchanged; anything else (including a never-owned request ID) → kill, preserving the protocol-violation defense.
- `terminateForProtocol` now records an `agent.worker.recycle` metric with reason `protocol_violation`, matching the observability of memory and recycle terminations.
- `SessionRetry.retryable` classifies `Agent worker exited (…)` errors as retryable (`"Agent worker restarted"`), so the existing processor retry loop with bounded backoff covers worker crashes.

## Alternatives considered

- **Change the worker protocol so `collect-memory` responses carry no request ID (or bump the protocol version)** — rejected: it patches only one known late-message path while the incident hit the generic ownership branch, and a wire-format change forces a protocol version bump with bidirectional compatibility work. A pool-side grace window covers every message type without protocol churn.
- **Ignore every heartbeat whose request ID does not match** — rejected: heartbeats carry liveness and memory signals, and a never-owned request ID remains a genuine corruption signal worth killing on; the ring keeps that defense while tolerating only the benign case.
- **Retry the first prompt at the BlueprintLoop layer** — rejected: the delivery failure already propagates to loop `failed` correctly, and retrying mail delivery would duplicate inbox messages; retrying at the turn layer reuses the existing provider retry machinery.

## Consequences

Workers survive legal late messages and keep executing their next assigned turn; genuinely unowned request IDs still terminate the worker. Worker crashes now retry through the standard session retry loop (up to 10 attempts with exponential backoff), so a transient worker death no longer fails a BlueprintLoop turn outright. Protocol-violation kills are observable through the shared `agent.worker.recycle` metric, and late-message drops are counted under `agent.worker.late_message`.
