# Decision Record: Session request recovery

Status: implemented

## Problem

Retryable model failures could leave the conversation showing context preparation while the provider admission gate waited. Terminal errors and transient recovery had different presentation, and repeated error rows would obscure the conversation. The ordinary Continue action does not re-execute an already terminal failed reply.

## Decision

The existing runtime retry status carries the request identity, phase, error evidence, attempt, optional deadline and immediate-retry eligibility. Session retry and provider admission retain their existing responsibilities and budgets. The provider gate reports waits; it does not acquire a second retry loop. Immediate wake respects server cooldowns and exclusive probe ownership. Generation and root checks reject obsolete status publication.

The shared `ErrorCard` supplies neutral presentation, raw detail disclosure and actions. Summary and disclosure share one compact row with the recovery action; only narrow cards wrap the controls. Expanded raw details keep the copy action in their heading. `SessionRecovery` owns the conversation projection and deadline display. One slot belongs to each logical task root; retries update it in place. Recovery persists through empty response setup and disappears after meaningful output or successful completion. Terminal failures remain visible. Only the Composer stops execution.

One generated `session.retryRequest` action covers active waits and terminal retryable failures. Local-runtime validates the current failed message under the session control lock and uses the existing Inbox/Drive pipeline. A hidden, deduplicated user-origin steer records the explicit retry request without replacing the failed assistant, copying the original prompt or creating another task root. Authentication and unavailable-model failures expose existing repair dialogs; invalid requests have no ineffective Retry action.

## Alternatives considered

**One error message per attempt.** Rejected because transient attempts become permanent transcript noise and their actions outlive request ownership. Rollout records already retain the detailed attempt history.

**A frontend retry timer and a new execution path.** Rejected because refresh, multiple clients, cancellation and provider admission would disagree. The frontend only displays authoritative deadlines and invokes the request-bound action.

**Use Continue for terminal errors or rewrite the failed assistant.** Continue's discovery gate can correctly report no pending work. Rewriting terminal evidence hides the failure. Explicit Inbox delivery makes new work discoverable while preserving history and the existing execution path.

## Consequences

The recovery UI is consistent with shared error rendering and remains bounded through repeated failures. SDK and runtime status contracts gain required recovery fields together; there is no legacy status interpretation. Existing stored messages need no migration. A manual retry records one hidden steering input and can request a new generation from the provider; it does not promise upstream exactly-once behavior. Server-directed cooldowns and another request's active probe can temporarily remove immediate retry. Original details remain available without a second explanatory error narrative.
