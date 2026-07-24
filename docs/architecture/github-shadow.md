# GitHub Integration

The GitHub integration polls the GitHub REST API outbound using GitHub App installation tokens. It requires no public inbound listener and never accepts incoming HTTP requests. Events are synthesized from API responses and processed through three independent pipelines: a shadow diagnostic pipeline, an opt-in autonomous fix delivery pipeline, and an opt-in automatic PR review and test pipeline. All three are disabled by default.

## Polling Architecture

The `GitHubPollRuntime` is started and stopped by the global runtime alongside the delivery worker. When `github.enabled` and `polling.enabled` are both true and at least one repository is known (via `watchedRepositories` or a `repositoryMapping` in fix/review workflows), one polling loop runs per repository.

### Poll Loop

Each repository loop awakens on the configured `polling.intervalMs`, calls the GitHub REST API with an ephemeral installation token, synthesizes deliveries from new or changed entities, writes them to durable storage, notifies the delivery worker, and sleeps until the next cycle. Rate-limit errors (403/429) extend the sleep to the longer of the configured interval or GitHub's requested delay, using `Retry-After` first and `x-ratelimit-reset` as a fallback.

### Credentials

The poll runtime reads `SYNERGY_GITHUB_APP_ID` and `SYNERGY_GITHUB_APP_PRIVATE_KEY` from the process environment. It signs a JWT for the App, resolves the repository installation ID, and obtains a short-lived installation access token via `POST /app/installations/{id}/access_tokens`. Installation tokens are cached with a 5-minute refresh window; the cache is cleared when the GitHub runtime stops or reloads.

### Poll State

Each repository maintains a poll-state file at:

```text
data/github/poll-state/<encoded repository>
```

The state tracks:

- `baselineTimestampMs` — set once on first poll; issues and PRs created before this timestamp are never synthesized
- `lastUpdatedAt` — the maximum `updated_at` across processed issues and PRs; the next poll queries with `since` offset backwards by `overlapWindowMs`
- `lastWorkflowRunCreatedAt` — the maximum `created_at` across processed workflow runs; used independently for the workflow-run query window
- `seenPRs` — transition state for every open PR and at most the 5,000 most recently updated closed PRs
- `seenWorkflowRunIds` — pending workflow runs only; completed runs are removed immediately

### First Baseline

When a repository has no poll state, the first poll creates a baseline at `Date.now()`. Historical issues and PRs are suppressed by their creation time, while current PR transition state and pending workflow runs are initialized for later changes. Completed historical workflow runs do not produce deliveries.

### Query Windows

Each poll cycle makes two paginated list queries per repository, plus detail requests when needed:

1. **List repository issues** — `GET /repos/{owner}/{repo}/issues` with `sort: updated`, `direction: asc`, and `since` set to `lastUpdatedAt - overlapWindowMs`. Ordinary issues are processed directly; entries with a `pull_request` field are enriched separately.
2. **Fetch pull request details** — for each pull request entry returned by the issues query, `GET /repos/{owner}/{repo}/pulls/{number}` fetches the full PR object.
3. **List workflow runs** — `GET /repos/{owner}/{repo}/actions/runs` with `created` query filter set to `lastWorkflowRunCreatedAt - overlapWindowMs`. Pending runs (those previously seen with no conclusion and not in the current page set) are individually fetched via `GET /repos/{owner}/{repo}/actions/runs/{id}` to catch completions.

Each query paginates up to `maxPages`; page results are ordered by time. When the remaining rate-limit budget drops to 5 or fewer requests, the poll loop sleeps for the configured interval before requesting the next page.

### Event Synthesis

Each new or changed entity is synthesized into a `GitHubDelivery` record with a deterministic delivery GUID:

| Entity        | Delivery GUID pattern                                                 |
| ------------- | --------------------------------------------------------------------- |
| New issue     | `poll:<repo>:issue:<number>:<created_at_epoch_ms>`                    |
| Opened PR     | `poll:<repo>:pr:<number>:opened:<headSha>:<created_at_epoch_ms>`      |
| Reopened PR   | `poll:<repo>:pr:<number>:reopened:<headSha>:<updated_at_epoch_ms>`    |
| Synced PR     | `poll:<repo>:pr:<number>:synchronize:<headSha>:<updated_at_epoch_ms>` |
| Workflow done | `poll:<repo>:workflow:<runId>:completed:<updated_at_epoch_ms>`        |

The synthetic delivery carries `x-poll-event` and `x-poll-delivery` in `rawHeaders` instead of incoming webhook headers, but otherwise matches the delivery schema the worker already consumed. The synthesizer sets `status: "received"` and hands the delivery through `GitHubStore.accept()`, which deduplicates by delivery GUID identically to the former webhook path.

### Delivery Acceptance and Worker Notification

After each poll cycle's batch of synthesized deliveries is accepted through `GitHubStore.accept()`, the poll runtime calls `GitHubRuntime.notify()` if at least one delivery was new. The delivery worker then FIFO-claims and processes the batch exactly as before.

## Storage

Four durable collections plus poll state:

- `data/github/deliveries/<deliveryGuid>` — per-delivery records with full lifecycle state
- `data/github/ci/<repository>/<workflowName>` — per-workflow CI failure timestamps within the configured window
- `data/github/runtime.json` — persistent anchors (parent sessions/messages) for fix and review Cortex tasks
- `data/github/poll-state/<encoded repository>` — per-repository cursors and bounded transition state
- session metadata and navigation indexes — GitHub proposal, locator, fix, review, and anchor sessions persist `provenance: "github"` and derive the `github` navigation category through the normal Session storage owner

## Worker Lifecycle

The worker is a single global promise-based loop started by `GitHubRuntime.start()` and stopped by `GitHubRuntime.stop()`. It runs only when `github.enabled` is true.

At startup, `GitHubStore.recoverInFlight()` resets any deliveries left in `processing`, `processing_fix`, or `processing_review` state (from a prior crash or restart) to `retryable_failure`, increments `retryCount`, and records restart recovery metadata so they can be re-claimed within the configured retry limit.

The worker FIFO-claims the next `received` or `retryable_failure` delivery, processes it, and repeats until no work remains. A failed delivery is excluded from later drain cycles within the same worker invocation so a retryable error cannot create a tight loop; a runtime restart or reload starts a fresh worker that can claim it again. A `notify()` call (from the poll runtime after accepting new deliveries) sets the wake flag and spawns the worker only if one is not already running; it does not reset the existing worker's failed-delivery exclusion set. The worker re-checks the flag after each batch to avoid missing deliveries that arrived during processing.

## Processing Pipeline

For each claimed delivery, the worker runs `processDelivery()`:

### L0 Gate

`evaluateGitHubDelivery()` applies deterministic filters in order:

1. **Bot check**: sender login matching `/\[bot\]$/i` → `ignored_bot` (bypassed for PR review events even when the sender is a bot)
2. **Repository allowlist**: when `watchedRepositories` is set, non-matching repositories → `ignored_type`
3. **Event type**: non-configured event types → `ignored_type`

For `pull_request.opened`, `pull_request.reopened`, or `pull_request.synchronize` when `reviewWorkflow.enabled`:

- mapped in `reviewWorkflow.repositoryMapping` → `gated_pr` (review triggered)
- unmapped → `ignored_type`

For `issues.opened`, a regex signal check (`/\b(bug|crash|crashes|crashed|error|exception|broken|failure|fails|failed|regression|reproducible|reproduce)\b/i`) over the combined title and body produces:

- match → `gated_issue`
  - `fixWorkflow.enabled` and mapped in `fixWorkflow.repositoryMapping` → fix triggered
  - `proposalEnabled` (and fix workflow not enabled) → proposal triggered
- no match → `ambiguous_issue` (classifier triggered if `classifierEnabled`)

For `workflow_run.completed`, the worker first registers the conclusion with `GitHubStore.registerWorkflowConclusion()`, which maintains a sliding-window count of failure timestamps. The gate then checks:

- `conclusion === "failure"` and `priorFailures + 1 >= ciFailureThreshold` → `gated_ci` (proposal triggered if `proposalEnabled`)
- otherwise → `ignored_type`

All other event types → `ignored_type`.

Terminal ignored and gated deliveries without classifier/proposal/fix/review are immediately marked `completed` or `ignored`.

### L1 Classifier (optional, shadow only)

When `classifierEnabled` and the decision is `ambiguous_issue`, the worker calls `classifyGitHubObservation()`. This uses the hidden `github-shadow-classifier` agent (nano model role, temperature 0, permission `*: deny`) sessionlessly through the external `AgentTurn` worker pool — no session is created and no transcript is persisted. The call has a 10-second abort timeout. The model budget cap (`modelBudgetNano.maxTokens`) is passed as `maxOutputTokens`. After the call, actual token usage and cost are measured against both limits; an exceeded budget silently discards the result.

A successful classification returns `{ relevant, category, confidence, reason }`. When `relevant` is true and `category === "bug"`:

- `fixWorkflow.enabled` → routes into the fix workflow
- `proposalEnabled` (and fix workflow not enabled) → launches a shadow proposal

### L2 Proposal (optional, shadow only)

When `proposalEnabled` and the gate or classifier decides a proposal is warranted (and no fix workflow is active), the worker calls `launchGitHubProposal()`. This uses the hidden `github-shadow-proposer` agent (mid model role, temperature 0, permission `*: deny`) through a Cortex child session.

The proposal Cortex task is launched with:

- `visibility: "hidden"` — excluded from ordinary Cortex task lists and parent completion notifications, while remaining inspectable in the dedicated GitHub sidebar section
- `notifyParentOnComplete: false` — silent completion
- `tools: {}` — no tool access
- `executionRole: "delegated_subagent"`
- `provenance: "github"` — persists the session in the GitHub navigation category rather than generic Background
- `output.mode: "structured"` with the `GitHubActionProposal` JSON Schema
- `maxRepairTurns: 1`
- `timeoutMs: 120_000`
- `maxOutputTokens` from `modelBudgetProposal.maxTokens`
- `maxCost` from `modelBudgetProposal.maxCost`, checked against final Cortex task usage before output publication

The parent session (`"GitHub Shadow Proposals"`) is created lazily once and reused across all proposals through the `github/runtime.json` anchor.

### L2 Fix Workflow (opt-in, replaces shadow proposal)

When `fixWorkflow.enabled` and the delivery is routed into the fix workflow, the worker calls `GitHubWorkflowOrchestrator.processFixDelivery()`. The fix workflow is autonomous: it inspects, locates, codes, tests, commits, pushes, and opens a PR without human intervention between steps.

**Prerequisites:**

- `fixWorkflow.repositoryMapping` maps the repository full name to a local project directory
- `SYNERGY_GITHUB_APP_ID` and `SYNERGY_GITHUB_APP_PRIVATE_KEY` environment variables are set for GitHub App authentication
- The mapped directory must be a git project

**Workflow steps:**

1. **Scope resolution**: The mapped directory is resolved to a git project Scope with `ensureProjectScope()`.

2. **Anchor session**: An autonomous parent session (`"GitHub Fix Deliveries — <repo>"`) is created lazily per repository, marked with GitHub provenance, and reused.

3. **Installation token**: An ephemeral GitHub App installation token is obtained from the installation ID synthesized in the delivery. This token is used for all GitHub API calls and git credential operations.

4. **Fetch base**: The default branch's HEAD commit SHA is fetched into the local project using the installation token for authentication.

5. **Root-cause locator**: The `github-issue-locator` agent runs as a hidden Cortex subagent in an isolated worktree at the default branch SHA. It inspects only — read, grep, glob, bash are allowed; edits, writes, git push, git remote, and gh CLI are denied. It returns structured `GitHubFixOutput` with root cause, affected files, planned changes, and confidence. The worktree is created at the exact base SHA (`baseRef: "fresh"`).

6. **Proposed-fix comment**: An issue comment with the locator diagnosis is posted to the GitHub issue with a deduplication marker (`<!-- synergy-fix:<deliveryGuid>:proposed -->`). If a comment with the same marker already exists, a new comment is not created.

7. **Fix coder**: The `github-fix-coder` agent runs as a hidden Cortex subagent in a fresh isolated worktree at the same base SHA. It receives the locator's diagnosis, writes a failing behavioral test where appropriate, implements the smallest root-cause fix, runs focused validation, and creates one local commit. It returns structured `GitHubFixExecutionOutput` with summary, changed files, test results, and commit SHA. Permissions: read, grep, glob, edit, write, and bash are allowed; gh CLI, git push, and git remote are denied.

8. **Commit verification**: The actual HEAD commit SHA in the coder's worktree is compared against the reported SHA. A mismatch aborts the delivery.

9. **Push**: The fix branch is pushed to GitHub using the ephemeral installation token. The branch name is derived from `pushBranchPrefix` (default `synergy/fix/`), the issue number, and a slug from the issue title. The push uses a credential helper that injects the token; the token is never exposed to the agent.

10. **PR creation**: A pull request from the pushed branch to the default branch is opened. If a PR already exists for the same head branch, it is reused (deduplicated). The PR body includes the root cause, fix summary, and test results with a `Closes #<number>` reference.

11. **Completion comment**: An issue comment linking to the PR is posted with a deduplication marker (`<!-- synergy-fix:<deliveryGuid>:completed -->`).

12. **Worktree cleanup**: The coder's isolated worktree is removed after successful completion.

**Retry**: Failed fix deliveries are retried up to `fixWorkflow.maxRetries` times (default 3). After exhausting retries, the delivery status is `permanent_failure`.

### L2 Review Workflow (opt-in)

When `reviewWorkflow.enabled` and the delivery is routed into the review workflow, the worker calls `GitHubWorkflowOrchestrator.processReviewDelivery()`. The review workflow is read-only: it inspects, tests, and publishes findings but never modifies the repository.

**Prerequisites:**

- `reviewWorkflow.repositoryMapping` maps the repository full name to a local project directory
- `SYNERGY_GITHUB_APP_ID` and `SYNERGY_GITHUB_APP_PRIVATE_KEY` environment variables are set
- The mapped directory must be a git project

**Workflow steps:**

1. **Scope and anchor**: Same resolution and session pattern as the fix workflow. Parent session is `"GitHub PR Reviews — <repo>"`.

2. **SHA fetch**: Both the PR head SHA and base SHA are fetched into the local project using the installation token. If the head SHA in the delivery observation differs from the live PR head SHA, the delivery is rejected.

3. **Review agent**: The `github-review-agent` runs as a hidden Cortex subagent in an isolated worktree at the head SHA. It performs a defect-first review comparing head against base and runs every configured `reviewCommands` command (`["bun test", "bun run typecheck"]` by default). Permissions: read, grep, glob, bash are allowed; edits, writes, git push, git remote, and gh CLI are denied. Returns structured `GitHubReviewOutput` with defects (file, line, severity, message), test results, and summary.

4. **Review publication** (when `publishReviewComment: true`): A pull request review comment is posted. Deduplication prevents posting a second review for the same PR + head SHA.

5. **Check run** (when `publishCheckRun: true`): A check run named "Synergy Review" is created on the head SHA with conclusion `success` (no defects, all tests passed) or `failure` (defects found or tests failed). Deduplication uses the delivery GUID as `external_id`.

**Retry**: Same pattern as the fix workflow, using `reviewWorkflow.maxRetries`.

## Agents

Five hidden, native agents power the integration. All use temperature 0.

| Agent                      | Model Role | Workflow | Permissions                                                   | Purpose                                              |
| -------------------------- | ---------- | -------- | ------------------------------------------------------------- | ---------------------------------------------------- |
| `github-shadow-classifier` | nano       | Shadow   | `*: deny`                                                     | Classify ambiguous issues as bug/feature/question    |
| `github-shadow-proposer`   | mid        | Shadow   | `*: deny`                                                     | Produce structured `GitHubActionProposal` via Cortex |
| `github-issue-locator`     | mini       | Fix      | read, grep, glob, bash; deny gh, git push/remote              | Locate root cause in checked-out repository          |
| `github-fix-coder`         | mid        | Fix      | read, grep, glob, edit, write, bash; deny gh, git push/remote | Implement fix in isolated worktree                   |
| `github-review-agent`      | mid        | Review   | read, grep, glob, bash; deny gh, git push/remote              | Defect-first review and test execution               |

Agents never receive GitHub tokens. git push and remote operations are performed by the orchestrator using a credential helper that injects the ephemeral installation token outside the agent's execution context. The `gh` CLI is denied to all GitHub agents.

## GitHub API and git Operations

All GitHub API calls use ephemeral installation tokens obtained via the GitHub App JWT flow (`POST /app/installations/{id}/access_tokens`). The JWT is signed with `SYNERGY_GITHUB_APP_PRIVATE_KEY` for the app identified by `SYNERGY_GITHUB_APP_ID`. Installation tokens are cached with a 5-minute refresh window.

git push operations use a credential helper (`credential.helper=!f() {...}`) that injects the installation token via an environment variable. The token is never written to disk or passed to agent processes.

## Delivery Status Lifecycle

```
received → processing | processing_fix | processing_review → completed | ignored | permanent_failure | retryable_failure
```

- `received`: persisted by the poll synthesizer through `GitHubStore.accept()`
- `processing`: claimed by the worker for classifier or proposal work
- `processing_fix`: claimed by the worker for autonomous fix delivery
- `processing_review`: claimed by the worker for PR review
- `completed`: fix delivered and PR opened; review published; or shadow proposal launched
- `ignored`: filtered out by gate or non-bug classification
- `retryable_failure`: processing error; increment `retryCount`; re-claimed on next notify
- `permanent_failure`: retries exhausted for fix or review workflow

## Session Navigation

GitHub App configuration is exposed to the Web client only as `{ configured: boolean }` from `GET /github/configured`. The route reports true when both `SYNERGY_GITHUB_APP_ID` and `SYNERGY_GITHUB_APP_PRIVATE_KEY` are non-empty and never returns either credential value.

When configured, the Web sidebar renders a collapsible GitHub section between Background and Projects. It queries `GET /global/recent?category=github&parentOnly=false`, so persisted GitHub anchor and Cortex child sessions are aggregated across Home and project Scopes with normal cursor ordering. Session updates use the standard navigation event/refetch path. The session's optional `provenance: "github"` field is the durable owner of this classification; titles and agent names are never used to infer it. Channel endpoints retain category precedence over GitHub provenance.

## Invariants

- The integration is inactive until `enabled: true`. Each workflow (`fixWorkflow`, `reviewWorkflow`) is independently gated by its own `enabled` flag.
- Polling is independently gated by `polling.enabled` (default true). Set to false to suppress all outbound API calls while keeping delivery processing active.
- At least one repository must be known (via `watchedRepositories` or a fix/review `repositoryMapping`) when both `github.enabled` and `polling.enabled` are true, or the configuration is invalid.
- `repositoryMapping` is required when either the fix or review workflow is enabled. An unmapped repository is silently ignored by the gate.
- The first poll baseline skips history. Issues and PRs created before the baseline are never synthesized regardless of age or `updated_at`.
- `SYNERGY_GITHUB_APP_ID` and `SYNERGY_GITHUB_APP_PRIVATE_KEY` are env-only. Polling requires them; fix and review workflows also require them for API calls and git push operations.
- There is no inbound webhook route, no webhook secret, no CORS bypass for GitHub, and no HMAC signature verification.
- Deduplication is durable and lock-protected per delivery GUID.
- The worker claims deliveries FIFO by received timestamp and processes at most four concurrently; failure and retry state remains isolated per delivery.
- Classifier calls are sessionless and produce no durable transcript.
- GitHub proposal, locator, fix, review, and anchor sessions persist explicit GitHub provenance; the sessionless classifier remains delivery-only.
- The GitHub sidebar appears only when both environment credentials are configured, and the frontend receives only the boolean configuration state.
- All GitHub agents are hidden, native, denied gh/push/remote, and use temperature 0.
- GitHub tokens are ephemeral, injected through a credential helper, and never reach agent processes.
- Host git subprocesses receive a minimal environment, disable repository hooks, and fetch without writing the shared `FETCH_HEAD`.
- Installation-token cache state is cleared whenever the GitHub runtime stops or reloads.
- Fix and review worktrees are created at exact SHAs with `baseRef: "fresh"` and removed after completion.
- Fix workflow push and PR creation are idempotent: duplicate pushes reuse existing branches; duplicate PRs reuse existing PRs.
- Review comments and check runs are deduplicated: one review comment per PR + head SHA; one check run per delivery.
- Budget overages (tokens or cost) discard classifier results silently.
- The worker recovers in-flight deliveries to retryable state on restart.
- Global `github` config reloads stop and restart both the worker and poll runtime with the newly resolved settings.
- The existing shadow pipeline (classifier + proposal) remains operational when `classifierEnabled` or `proposalEnabled` are set. When `fixWorkflow.enabled` fires, it replaces the shadow proposal for the same event.
