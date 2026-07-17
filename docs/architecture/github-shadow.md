# GitHub Shadow Integration

The GitHub Shadow integration receives GitHub App webhooks and processes them through a read-only pipeline that produces diagnostic proposals. It never performs GitHub API writes. It is a shadow: it observes, classifies, and proposes — it does not comment, label, close, or modify.

## Route and Authentication

`POST /integrations/github/webhook` is a global route (no Scope required) and is listed in the CORS bypass set.

The route verifies the `x-hub-signature-256` header against the exact raw request body using `SYNERGY_GITHUB_WEBHOOK_SECRET` (env-only, never a config field). It requires `x-github-event` and `x-github-delivery` headers and rejects bodies larger than 256 KiB before parsing or persistence. Malformed or missing values return 400; an invalid signature returns 401; an oversized payload returns 413; an absent secret returns 503.

## Webhook Acceptance

A parsed delivery is deduplicated by `x-github-delivery` using a durable write lock. A duplicate returns `{ accepted: true, duplicate: true }` (202). A new delivery is persisted as `received` and the worker is notified.

## Storage

Three durable collections under `data/github/`:

- `data/github/deliveries/<deliveryGuid>` — per-webhook records with full lifecycle state
- `data/github/ci/<repository>/<workflowName>` — per-workflow CI failure timestamps within the configured window
- `data/github/runtime.json` — persistent anchor (parent session/message) for proposal Cortex tasks

## Worker Lifecycle

The worker is a single global promise-based loop started by `GlobalRuntime.start()` and stopped by `GlobalRuntime.stop()`. It only runs when `github.enabled` is true.

At startup, `GitHubStore.recoverInFlight()` resets any deliveries left in `processing` state (from a prior crash or restart) to `retryable_failure` so they are re-claimed.

The worker FIFO-claims the next `received` or `retryable_failure` delivery, processes it, and repeats until no work remains. A failed delivery is excluded from the remainder of the current drain so a retryable error cannot create a tight loop; a later `notify()` or runtime restart can claim it again. A `notify()` call after webhook acceptance sets a flag and spawns the worker if one is not already running. The worker re-checks the flag after each batch to avoid missing deliveries that arrived during processing.

## Processing Pipeline

For each claimed delivery, the worker runs `processDelivery()`:

### L0 Gate

`evaluateGitHubDelivery()` applies three deterministic filters in order:

1. **Bot check**: sender login matching `/\[bot\]$/i` → `ignored_bot`
2. **Repository allowlist**: when `watchedRepositories` is set, non-matching repositories → `ignored_type`
3. **Event type**: non-configured event types → `ignored_type`

For `issues.opened`, a regex signal check (`/\b(bug|crash|crashes|crashed|error|exception|broken|failure|fails|failed|regression|reproducible|reproduce)\b/i`) over the combined title and body produces:

- match → `gated_issue` (proposal triggered if `proposalEnabled`)
- no match → `ambiguous_issue` (classifier triggered if `classifierEnabled`; proposal not triggered)

For `workflow_run.completed`, the worker first registers the conclusion with `GitHubStore.registerWorkflowConclusion()`, which maintains a sliding-window count of failure timestamps. The gate then checks:

- `conclusion === "failure"` and `priorFailures + 1 >= ciFailureThreshold` → `gated_ci` (proposal triggered if `proposalEnabled`)
- otherwise → `ignored_type`

All other event types → `ignored_type`.

Terminal ignored and gated deliveries without classifier/proposal are immediately marked `completed` or `ignored`.

### L1 Classifier (optional)

When `classifierEnabled` and the decision is `ambiguous_issue`, the worker calls `classifyGitHubObservation()`. This uses the hidden `github-shadow-classifier` agent (nano model role, temperature 0, permission `*: deny`) sessionlessly through `LLM.stream()` — no session is created and no transcript is persisted. The call has a 10-second abort timeout. The model budget cap (`modelBudgetNano.maxTokens`) is passed as `maxOutputTokens`. After the call, actual token usage and cost are measured against both limits; exceeding either discards the result.

A successful classification returns `{ relevant, category, confidence, reason }`. When `relevant` is true and `category === "bug"` and `proposalEnabled` is true, a proposal is launched.

### L2 Proposal (optional)

When `proposalEnabled` and the gate or classifier decides a proposal is warranted, the worker calls `launchGitHubProposal()`. This uses the hidden `github-shadow-proposer` agent (mid model role, temperature 0, permission `*: deny`) through a Cortex child session.

The proposal Cortex task is launched with:

- `visibility: "hidden"` — not shown in the session list
- `notifyParentOnComplete: false` — silent completion
- `tools: {}` — no tool access
- `executionRole: "delegated_subagent"`
- `category: "background"`
- `output.mode: "structured"` with the `GitHubActionProposal` JSON Schema
- `maxRepairTurns: 1`
- `timeoutMs: 120_000`
- `maxOutputTokens` from `modelBudgetProposal.maxTokens`
- `maxCost` from `modelBudgetProposal.maxCost`, checked against final Cortex task usage before output publication

The parent session (`"GitHub Shadow Proposals"`) is created lazily once and reused across all proposals through the `github/runtime.json` anchor.

## Agents

Both agents are hidden, native, and deny all tools:

| Agent                      | Model Role | Temperature | Purpose                                              |
| -------------------------- | ---------- | ----------- | ---------------------------------------------------- |
| `github-shadow-classifier` | nano       | 0           | Classify ambiguous issues as bug/feature/question    |
| `github-shadow-proposer`   | mid        | 0           | Produce structured `GitHubActionProposal` via Cortex |

## Delivery Status Lifecycle

```
received → processing → completed | ignored | permanent_failure | retryable_failure
```

- `received`: persisted by the webhook route
- `processing`: claimed by the worker
- `completed`: gated and proposal-launched (or classified bug with proposal)
- `ignored`: filtered out by gate or non-bug classification
- `retryable_failure`: processing error; increment `retryCount`; re-claimed on next notify
- `permanent_failure`: not currently produced by the worker; reserved for future non-retryable errors

## Invariants

- The integration is read-only shadow: no GitHub API writes, no comments, no label changes.
- The webhook secret is env-only (`SYNERGY_GITHUB_WEBHOOK_SECRET`) and never appears in config or config examples.
- The route is global (no Scope) and uses the CORS bypass list.
- Deduplication is durable and lock-protected per delivery GUID.
- The worker processes one delivery at a time, FIFO by received timestamp.
- Classifier calls are sessionless and produce no durable transcript.
- Proposal calls produce child Cortex sessions under a single persistent parent session.
- Both agents are hidden, native, deny all tools, and use temperature 0.
- Budget overages (tokens or cost) discard results silently.
- The worker recovers in-flight deliveries to retryable state on restart.
- Global `github` config reloads stop and restart the worker with the newly resolved settings.
