# Decision Record: Recover runtime services only from confirmed state

Status: implemented

## Problem

Provider catalog failures triggered redundant reloads through a Home context that had no Workspace. Concurrent reload targets could repeat failed prerequisites. MCP discovery called optional methods absent from the server's capabilities, while persistent connection failures restarted the same short retry cycle. File watcher compensation ran before a replacement subscription existed and could report success despite failed reconciliation. These failures amplified routine interaction delays and obscured their causes.

## Decision

A catalog refresh invokes the global provider reload only after a successful change to its active or retained model projection. Automatic configuration scope resolution treats Home without a Workspace as global. File-change classification resolves global roots independently and only inspects project paths when a Workspace exists. One reload operation shares prerequisite promises, stops dependent targets on prerequisite failure and drains independent targets before scheduling cascades.

MCP discovery checks negotiated prompts and resources capabilities. A server that advertises an optional method but rejects it with method-not-found is queried once per connection, retains a warning, and is probed again after reconnection. Exhausted connection attempts retain their failure count across automatic retries and double the cooldown up to fifteen minutes, preserving larger explicitly configured cooldowns. Success and explicit user reconnection reset the budget. Provider spending-limit refusal is a terminal retry classification even when an adapter marks HTTP 429 retryable.

Watcher recovery first establishes the replacement subscription and then reconciles changes made during the gap. It becomes active only after reconciliation succeeds for the current generation. A drain exposes failed reconciliation to its idle waiter; recovery retries instead of declaring completion. Configuration reconciliation checks the reload result instead of treating a resolved failure response as success.

A failed event batch also leaves the drain requiring a full resync, even when its native subscription remains healthy. Failure rejects current idle waiters, discards incomplete incremental work, and schedules reconciliation after at least one second. Failed resyncs retain that requirement and retry at the same bounded frequency without needing another native event. Events arriving during reconciliation remain queued; disposal cancels pending retries.

Registry tool schemas use Zod input projection so input transforms remain available to the model while runtime parsers continue to validate and transform execution arguments. HTTP duration metrics preserve numerical HTTP status separately from span outcome, keeping failed requests in error-rate buckets.

Buffered browser metrics use validated per-sample attribution before batch page defaults. This preserves the completed navigation when the batch flush occurs on a later page. The trigger allowlist includes the finite values emitted by navigation entry points; it does not accept arbitrary text. Real-store tests cover page changes, missing batch identifiers and secret rejection.

Desktop skin persistence serializes writes per resolved target path. Each request validates its own snapshot before queueing and atomically replaces the file in invocation order. Failed writes still reject their caller, clean their temporary file and release the queue for later requests. This prevents concurrent startup IPC updates from renaming the same temporary file twice.

## Alternatives considered

**Disable failing providers or MCP servers.** This changes user configuration and prevents automatic recovery. Capability-aware discovery and bounded backoff preserve the configured service.

**Run compensation immediately on watcher failure.** A scan before resubscription leaves another unobserved gap. Subscription first, followed by checked reconciliation, closes that gap.

**Ignore schema conversion failures.** Dropping a tool or advertising an empty schema hides the failure and weakens input validation. Input projection matches what the model must supply.

## Consequences

Remote availability, authentication and operating-system watcher delivery remain external facts; the runtime reports them without claiming a repair. Historical HTTP metrics whose numerical status was overwritten remain incomplete. Real temporary runtimes, a recovering stdio MCP process, failed prerequisite injection, filesystem reconciliation and tool catalog tests verify the recovery behavior.
