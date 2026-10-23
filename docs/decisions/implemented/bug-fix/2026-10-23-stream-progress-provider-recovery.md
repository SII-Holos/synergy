# Decision Record: Provider recovery admission follows stream progress

Status: implemented

## Problem

A recovery probe held the connection group's exclusive admission until its entire model stream and local disposal completed. A healthy long response could therefore exhaust another caller's five-minute admission budget. Existing coordinator tests covered explicit lease success and stalled probes, but did not consume meaningful output while holding the stream open. [The postmortem](../../../postmortem/0089-provider-recovery-stream-lifetime.md) records that missing safeguard.

## Decision

[ProviderRetryCoordinator](../../../../packages/harness/src/provider/retry-coordinator.ts) separates the recovery permit from the request's outcome observation. The first nonempty text, reasoning or tool-input delta, or complete tool-call proposal, releases the permit and schedules the next probe at least one second later. Only one probe without meaningful progress is admitted at a time. Repeated deltas do not renew the pacing deadline. Start markers, empty deltas and local tool results cannot establish progress.

Progress does not report final success. The original request retains error observation, so a subsequent eligible body error restores shared cooldown. Full stream completion clears the connection group only when its captured failure revision still matches; a later failure or replacement entry cannot be erased by an older request. A valid server Retry-After remains a minimum wait, and explicit retry cannot bypass either that minimum or recovery pacing.

Failure, abort signals, abort events and disposal release the probe before local cleanup settles. AgentTurn acquires admission before creating the Rollout call, then observes the executor stream inside the recorder. This ordering exposes provider completion and thrown body errors before recorder settlement waits for disposal; a recording startup failure releases admission explicitly. Cleanup still runs once, remains owned by the executor and recorder, and propagates its errors to the caller. Releasing admission does not free a worker, discard Rollout evidence, complete an unfinished model call or replay tools. Exceptions and cancellation in the admission observer also release the newly acquired permit.

This retains the connection grouping, bounded entry cache, five-minute waiter deadline and caller-owned retry counts from [network retry boundaries](2026-09-15-network-retry-boundaries.md). Provider first-byte, idle and wall watchdogs continue to own request timeouts. No separate synthetic inference probe, provider configuration field, persistence format or API schema is introduced.

The design adopts limited recovery traffic from [Azure's circuit-breaker guidance](https://learn.microsoft.com/en-us/azure/architecture/patterns/circuit-breaker) and preserves the possibility of errors after streaming begins, documented in [Claude's API error guidance](https://platform.claude.com/docs/en/api/errors). Treating meaningful output as permission for one paced successor is Synergy's streaming adaptation, not a claim that partial output proves final success. [Envoy's timeout guidance](https://www.envoyproxy.io/docs/envoy/latest/faq/configuration/timeouts) supports distinguishing stream activity from total response duration; Synergy retains its existing provider watchdogs.

## Alternatives considered

**Increase the five-minute admission limit.** This delays the same failure and still couples independent callers to an unrelated stream's duration or local disposal.

**Treat HTTP headers, first bytes or lifecycle markers as success.** These can precede an overload event or carry only heartbeat traffic. The worker's semantic output provides stronger evidence without adding another transport protocol.

**Clear the entire group at the first content event.** This can release every waiting caller at once while the service is still recovering. Progress instead grants paced admission; full completion supplies the stronger evidence for ordinary concurrency.

**Call the existing release operation on first output.** That operation also stops failure observation. It would discard a later overload and permit an incorrect healthy state. The permit and the outcome observation have separate lifetimes.

**Change the grouping to model-only recovery.** Provider quotas can be shared across models. Changing the failure domain requires provider-specific capacity evidence; this repair preserves connection isolation and addresses the demonstrated stream-lifetime defect independently.

## Consequences

Healthy long responses can overlap new calls during recovery, while later stream failures still constrain future admission. The one-second interval is a conservative local recovery cadence, not a provider rate-limit guarantee; the executor continues to enforce resource capacity. Requests already admitted are not cancelled when another stream fails.

Calls with no meaningful progress still have bounded admission waits, and this change does not establish that the upstream service has recovered. A provider that emits only metadata or heartbeats supplies no early recovery evidence. Full completion remains sufficient for responses without content.

Deterministic coordinator tests retain existing cooldown, isolation, bounded-wait and permanent-error coverage and add long streams, output variants, paced admission, late failures, newer Retry-After, cancellation and slow or failed cleanup. Temporary-storage AgentTurn tests hold both generation and executor cleanup, verifying overlapping recorded calls retain separate completed and failed outcomes without cancellation opening admission. Session retry and worker protocol suites protect the existing attempt and tool-effect semantics.
