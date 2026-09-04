# Workflow Runtime

This document defines session-local workflow execution. A session's workflow field stores one active kind—`plan`, `lightloop`, `lattice`, or `boss`—while BlueprintLoop keeps a separate execution record bound to that session. Workflow state is session-local; Boss Mode is the exception that spans sessions, deriving its worker tree from the session parent chain rather than a shared execution record.

These workflows provide durable orchestration above the ordinary serial LLM loop.

## Mutual Exclusion and Ownership

Enabling or switching any workflow, plus ordinary workflow disabling, requires an idle session. Light Loop has dedicated instruction-update and cancellation operations: its instructions can change only while no completion review is pending, and cancellation aborts active session work plus descendant reviewer tasks before clearing the workflow. Plan and Light Loop cannot be enabled while another workflow or active BlueprintLoop exists. Lattice can resume its own run but refuses a live user-owned BlueprintLoop. Boss Mode follows the same rule: it cannot be enabled while another workflow or an active BlueprintLoop exists, and it requires an idle session.

A user-owned BlueprintLoop can replace Plan or Light Loop after the session is idle. It cannot replace an active Lattice workflow. A BlueprintLoop with `source: "lattice"` is valid only while Lattice owns the session.

Disabling a pristine Lattice Run cancels it so a later enable starts a new Run. Once Lattice has advanced durable work, disabling pauses the inactive Run before aborting session work, withdrawing queued Inbox work owned by that Run, or cancelling its active Lattice-owned BlueprintLoop. A paused Run cannot advance from a late loop event and requires explicit resume. Cancellation is terminal; resume creates an idempotent state-entry prompt only when the saved action is no longer valid.

## User-Message Projection

Workflow instructions are projected into model context without rewriting the stored user text. Root, user-origin messages receive compact workflow metadata when they are created. During context assembly, the first user text part is wrapped with the agent-specific Plan, Lattice, Light Loop, or Boss contract.

System control messages, non-root messages, and messages from continuation sources are not wrapped again; `boss_report` deliveries are control messages and stay unwrapped. This keeps the durable transcript faithful to what the user wrote while making the active contract explicit to the model.

## Plan Enforcement

Plan prompts instruct the agent to research and author a decision-complete Blueprint instead of executing the result. A finalized Blueprint uses eight shared semantic sections and selects one material implementation route: materially different owners, architectures, data flows, compatibility strategies, domain methods, artifact shapes, and user-visible behaviors must be resolved from evidence, established conventions, or a blocking user decision. Incidental execution mechanics remain delegated to the executor. Tool exposure and execution policy enforce the read-only project boundary in addition to the prompt.

The Note Blueprint policy allows Blueprint creation and modification only in Plan or Lattice. It infers Blueprint intent from `kind` or Blueprint-specific fields and blocks edits to an existing Blueprint outside those workflows. Reading and searching remain available.

## BlueprintLoop State Machine

A BlueprintLoop persists:

- Blueprint note ID and optional version
- execution session and optional parent session
- execution and audit agents
- audit session and Cortex task IDs
- `current`, `new`, or `worktree` run mode
- optional model and run-specific user instruction
- source ownership, loop index, audit attempts, error, and timestamps

Its states are:

```text
armed → running → auditing → completed
             ↑        │
             └────────┘ rejection

armed/running/waiting/auditing → failed | cancelled
```

The execution session is marked with `loopRole: "execution"`; the visible Cortex review child is marked with `loopRole: "audit"`. Only the execution session can call `blueprint_loop_stop`, and only the recorded audit session can approve or reject.

`blueprint_loop_stop` records a durable stop intent during the executor turn. After the execution-session lease is released, the BlueprintLoop continuation prepares the visible Cortex reviewer, binds its task and audit session IDs while moving the loop to `auditing`, then starts the reviewer. The reviewer appears in the execution session's Subagent Dock, while ordinary Cortex completion notification stays disabled because approve or reject owns workflow result delivery. Rejection increments the audit attempt count; when the incremented count reaches `maxIterations`, the loop fails with `iteration_exhausted` instead of returning to execution.

The persisted BlueprintLoop transition is authoritative evidence that the reviewer successfully called `blueprint_loop_approve` or `blueprint_loop_reject`; a prose response or terminal Cortex task is not approval. If the bound reviewer completes, errors, or is cancelled while the loop remains `auditing`, continuation reuses that exact Cortex session so its evidence remains available, supplies the execution session ID directly, and restricts the recovery turn to the two terminal review tools. Two recovery turns without a successful terminal tool fail the loop with `review_terminal_tool_missing`. An interrupted reviewer remains restart-recovery work and is replaced from the surviving stop intent instead of consuming this budget.

The BlueprintLoop audit agent is host-selected. Non-plugin BlueprintLoops always audit with the built-in `supervisor`; the `auditAgent` field on Blueprint notes is inert legacy metadata that execution and planning agents cannot set through note tools, and only plugin Protocol 5 `blueprint.start` requests may select an audit agent explicitly. A reviewer task that fails before its first model turn (for example, no model configured for the agent) fails the loop immediately with `reviewer_launch_failed` carrying the original error, without consuming the terminal-tool recovery budget.

Audit evidence must match the semantic strength of each claim. Structural or toolchain checks do not by themselves prove behavior, integration, experience, holistic quality, or end-to-end success. Every required outcome must be verified with appropriate evidence before approval; a required outcome that cannot be verified remains blocking rather than being implicitly deferred.

For user-owned loops, approval returns a completion notice to the execution session. For Lattice-owned loops, the BlueprintLoop record is the execution fact consumed by the Lattice controller. Bus events only wake reconciliation and are never sufficient on their own to advance a Pathway.

## Light Loop State

Light Loop stores its instructions directly on the session workflow. A stop request first records the executor's summary, claimed completed work, evidence, limitations, and request identity without reviewer IDs.

After the execution-session lease is released, the Light Loop continuation prepares a visible Cortex reviewer, durably binds its task and session IDs to the stop request, then starts it. The reviewer appears in the execution session's Subagent Dock, while ordinary Cortex completion notification stays disabled because approve or reject owns workflow result delivery. Repeated `loop_stop` calls are idempotent while either the unbound stop intent or bound review is pending.

The `lightloop-reviewer` has exclusive access to `light_loop_approve` and `light_loop_reject` for its parent stop request. Approval clears the workflow even though the review child is running. Rejection clears `stopRequest`, records attempt metadata, and delivers the reason, remaining items, and concrete instructions to the execution session. As with BlueprintLoop, a rejection whose incremented count reaches `maxIterations` terminates with `iteration_exhausted`. The workflow transition made by one of those terminal tools is the authoritative review result. If the bound reviewer completes, errors, or is cancelled without that transition, continuation reuses the same review session with the execution session ID supplied directly and only the approve/reject tools enabled. After two unsuccessful recovery turns, Light Loop terminalizes as failed with `review_terminal_tool_missing`; ordinary loops also receive a visible assistant failure update, while plugin-owned loops retain their existing terminal-hook delivery. Interrupted reviewers remain on the startup replacement path and do not consume the terminal-tool recovery budget. For plugin-owned Light Loops, every terminal path first writes a separate session-scoped terminal record, then clears the interactive workflow before invoking the owning generation's `lightloop.after` observer. The record acknowledges delivery only when the generation matches, at least one handler exists, and every matching handler completes successfully. A mismatch, missing handler, or handler failure persists the error and remains retryable during repeated terminalization and plugin startup reconciliation. The terminal record also keeps `lightloop.get()` available after unequip without occupying the mutually exclusive workflow slot. A per-session delivery lock prevents concurrent terminal paths from duplicating an acknowledged hook. The active instructions may be updated without restarting the workflow; the next model step re-reads the session and uses the revised instructions. The product surface permits editing only while the session is idle, and the service rejects updates while a stop request is under review. Terminalization always clears the interactive workflow, so Plan, Light Loop, or Lattice can be enabled afterward. Light Loop cancellation is idempotent and uses the shared session-abort path to stop the active turn and descendant Cortex review tasks before terminalizing the workflow.

## Lattice Run State

Lattice v2 stores immutable run identity separately from session selection. Run records are keyed by run ID, while one repairable current pointer per session selects the active or most recently selected run. Starting a new run never overwrites terminal history.

A Run has an independent lifecycle status (`active`, `paused`, `completed`, `failed`, or `cancelled`) and one of seven work states:

1. `clarifying` captures an aligned goal, success criteria, constraints, non-goals, and assumptions.
2. `planning` authors the ordered Pathway.
3. `reviewing_pathway` checks the next step and may replace only unstarted future steps.
4. `blueprinting` authors and binds the current step's Blueprint Note.
5. `reviewing_blueprint` validates the bound Note version and content.
6. `awaiting_execution` waits for explicit collaborative approval.
7. `executing` delegates exclusively to the bound BlueprintLoop.

Step status is one of `pending`, `current`, `executing`, `completed`, `failed`, or `cancelled`.

Step history preserves Blueprint bindings and every BlueprintLoop attempt. Completed, failed, and cancelled attempts remain immutable evidence. A failed or cancelled current attempt pauses the Run; only an explicit resume for that pause reason reopens the same Step for Blueprint work. After a successful step, Lattice returns to `reviewing_pathway` whenever future steps remain, so later work can adapt to the observed result. The final successful step completes the Run and delivers the reviewed completion summary to the execution session.

Pathway reads separate immutable history and current work from the editable pending suffix. Replanning atomically replaces only that pending suffix: retaining an ID revises or reorders an existing future Step, omitting an existing pending ID removes it, and omitting an ID creates a new Step. Replanning never changes Step status or rewrites completed evidence.

The Lattice machine is the sole owner of work state, Run status, current Step, and Step status. Agent tools write artifacts or a single semantic pending action; they do not transition the machine or invoke Session and BlueprintLoop effects. Each action captures the state and Pathway revisions it was based on, so duplicate submission is idempotent and stale or conflicting submission is rejected.

Model-facing Lattice and BlueprintLoop tool results are lifecycle instructions as well as diagnostics. They distinguish repairable argument errors from non-retryable ownership or state conflicts, state whether semantic intent is durably queued, name the host as transition owner, and direct the execution turn to end once an action or audit request is persisted. An unavailable parent Lattice tool during BlueprintLoop execution never authorizes a workaround through ordinary project tools or work on a future Step.

The controller consumes one pending action and persists the next state plus at most one outbox effect before crossing an external boundary. Effects cover state-entry prompts, BlueprintLoop create/start handoffs, and final completion delivery. The final successful Step persists the terminal Run state and completion effect atomically; reconciliation then writes the completion mail with a stable Inbox delivery key before acknowledging the effect and requesting `SessionDrive`. Prompt delivery uses a persisted effect identity with `SessionInbox.deliverUnique`; Blueprint creation and start are separate effects so recovery can reconcile either boundary without creating a duplicate loop. The controller validates the bound Note version and digest immediately before Auto starts execution; if the Note changed, the Run returns to Blueprint review and any armed stale loop is cancelled.

While the Run is `executing`, the parent Lattice prompt and tools are absent and BlueprintLoop owns continuation. The controller accepts only the exact `source: "lattice"` loop bound in the current attempt. It re-reads the loop record on wake; missing, late, foreign, or multiply owned events cannot advance the Run.

Each Scope runtime subscribes to loop events before reconciling persisted Runs and effects. Startup reconciliation is also responsible for detecting an interrupted execution or a running loop that never received its first durable prompt. Normal asynchronous loop start is not diagnosed by that cold-start-only check.

Model calls are accumulated and flushed at turn and lifecycle boundaries. A positive limit is checked before another Lattice continuation and pauses the Run when exhausted. Explicitly resuming a budget-paused Run extends the visible cap by exactly one call, so each additional call requires a fresh user decision. This is a soft operational budget: a hard process failure can lose the final in-memory increment. Lattice event files are idempotent, best-effort audit output; Run, Step, Blueprint binding, and BlueprintLoop records are canonical recovery state.

## Boss Mode

Boss Mode is a session workflow (`kind: "boss"`) that coordinates work across a tree of persistent worker sessions. The session that enables it becomes the root boss and the human's only instruction entry point. Each worker is an ordinary session created as a direct child of its caller with `role: "worker"`, a standing `workerRole` label, the tree `rootID`, and an unattended interaction; workers can spawn their own workers, so the tree has arbitrary depth.

Boss Mode has no task ledger, state machine, or event log: assignments and reports are `SessionInbox` messages, so message history is the ledger, and the tree is derived read-only from the session parent chain. This contrasts with Lattice, which persists an explicit Run machine, and with BlueprintLoop's separate execution record. Routing decisions belong to the boss agent; `BossService` only enforces tree membership and performs the delivery mechanics.

Enabling Boss Mode requires an idle session with no active workflow and no BlueprintLoop, and it is mutually exclusive with Plan, Light Loop, and Lattice. Disabling it clears only the root projection; worker sessions and their history remain, and workers fall dormant once the root is gone.

Workers are created with `boss_spawn` (a role label and an optional agent) and receive tasks through `boss_assign`, which uses `SessionInbox.deliverUnique` with delivery key `boss:<callerID>:<taskID>` so re-assignment is idempotent. A worker reports to its direct parent with `boss_report`, which delivers a steer-mode message and wakes the parent. `boss_cancel` interrupts a running turn and removes matching pending assignments; `boss_status` derives the caller's subtree with per-node status, agent, and most recent task. All five tools and the server routes funnel through the single `BossService` guard: a caller must be a boss-tree member, and a target must be the caller's direct child in the same tree.

`BossContinuationPolicy` (priority `40`) owns idle continuation. The root session never receives a continuation proposal and stays human-driven; a worker whose assigned task has not reported is nudged to continue or report, and workers fall dormant when the root is disabled or archived. There is no separate Boss recovery flow: after a process restart, workers holding runnable inbox items resume through the ordinary boot wake path, and the next turn re-injects the tree overview so the model can rebuild its view with `boss_status`.

The model prompt is injected at the workflow context layer: the root receives `<boss-context>` plus a live `<boss-tree>` overview, and workers receive `<boss-worker-context>`. `WorkflowUserWrapper` supports Boss Mode for message projection, and `boss_report` deliveries are never wrapped again.

### Runtime Boss Mode

Runtime Boss Mode is an opt-in experimental mode (`experimental.boss_mode` in the Runtime domain) that provisions a singleton runtime boss session and routes Feishu conversation ingress to it. When enabled, the runtime idempotently creates one boss session per enabled Feishu account, in the home scope, with `workflow: { kind: "boss", role: "boss" }`, an interactive interaction, and the endpoint keyed `scope:boss`. All accepted Feishu group and direct messages for that account route to this session — after the existing mention, `allowGroup`, and `allowDM` filters — with a source prefix and `channelChatId`/`channelSenderId` metadata, and replies anchor back to the original message. The runtime boss session runs on the dedicated `boss-synergy` primary agent: a whitelisted coordination-only toolset (dispatch/status, session control/read, scope list, the full agenda and note read/write suites, memory read/write/search, channel_push, read-only bash) with no subagent spawning (`task`), no file-editing tools, and no `note_archive`/`note_delete` (destructive note operations stay in the App).

**Explicit channel delivery (R6):** boss-role sessions never auto-deliver. An inbound message is accepted silently — no Feishu streaming card is created and no terminal is posted by the outbound bridge (the bridge skips terminals whose session is `workflow kind "boss", role "boss"`); status reactions still give lightweight progress feedback. The boss must call `channel_push(text, chatId, replyToMessageId)` to reply. Because the provisioned runtime boss endpoint stores a sentinel chat id (`"boss"`), the real chat always travels on the inbound message's metadata (`channelChatId`/`channelChatType`), and `channel_push` resolves its default target from that metadata. An anchored reply (`replyToMessageId`) to the chat the current inbound message arrived from, using the session's own account, is the boss's normal answer path and needs no permission prompt; an unanchored new message, another chat, or another account still crosses the communication boundary and requires an explicit permission decision. Non-boss channel sessions (ordinary Feishu, Clarus, GitHub) keep their existing automatic delivery semantics unchanged, and worker `boss_report` internal reporting never touches a channel.

The runtime boss receives a one-time world-overview briefing covering sessions, projects, agenda, memory, and experience, plus its persona identity; the briefing is delivered as a steer message with a deduplicated delivery key. With `boss_briefing_interval_days` set, an Agenda item delivers a periodic refresh instruction on that cadence, steering the boss to re-enumerate sessions, projects, agenda, memory, and experience with `session_list` / `scope_list` / `agenda_list` / `memory_search` (the world-overview briefing itself is rebuilt only on demand, not on a schedule). The colleague identity is deterministic text rendered from `experimental.boss_persona` (preset `project_manager` or `ops_assistant`, or `custom` with formality/conciseness/proactiveness/warmth sliders) plus the runtime name stored in the shared memory library as a `self`-category row titled `boss_name`; `experimental.boss_identity_text` remains readable as a legacy fallback when no persona is set. Each turn injects `<boss-persona>` (name/identity/tone), `<boss-report-style>` (preset- or dimension-derived reporting style), the channel reply target for the inbound message, and the collaboration discipline — dispatch, layered reporting, memory discipline (continuously accumulate user/relationship/self positioning with `memory_write`, refine with `memory_edit` without duplication, keep each category lean), lark-cli history reading, and Feishu source headers — so the discipline block is unconditionally present every turn.

The runtime boss and project bosses are peers: there is no cross-scope parent tree. Delegation flows through `session_send`; worker reports (`boss_report`) enter only the direct project boss history, and the top boss receives only project-boss summaries and deep-reads through `session_read`. Memory written with `memory_write` survives compaction. The `boss_project` tool (`orchestration.session`) creates one project per call: it creates the directory when missing, binds it through `Scope.fromDirectory`, and creates an interactive project boss session (`workflow boss`, role `boss`) in that project scope. Directories inside the home directory are allowed — the runtime boss commonly clones repositories under its own workspace and binds them as project scopes. The project boss's `workflow.instructions` carry the default layered-reporting discipline — report only status-change summaries plus a one-line result with a `sessionID` reference to the top boss via `session_send`, never forwarding raw worker reports. The tool requires a boss-role caller (the runtime boss or a project boss, never a worker).

Disabling `experimental.boss_mode` reverts Feishu routing to the per-chat sessions used before; the runtime boss session and its history remain.

**Opening from Settings:** the Runtime Boss Mode panel exposes **Open boss session**, which flushes the pending Runtime-domain draft, calls `POST /boss/session/open` (`boss.session.open`), and navigates the App to the returned session. The open is idempotent: it reuses the account-routed boss session when one is registered for an enabled Feishu account; otherwise it reuses or creates a channel-less local runtime boss session in home scope (`workflow { kind: "boss", role: "boss" }`, the `boss-synergy` primary agent, interactive interaction, title `Runtime Boss (本地)`), delivering the one-time world-overview briefing only when the session is first created. The R6 explicit-delivery hint is injected only for channel-routed boss sessions; the channel-less local session replies inside the App and carries no `channel_push` contract. Opening while `boss_mode` is disabled fails with `409 boss_disabled`.

**Greeting kickoff:** when the opened channel-less local boss session has no conversation yet and a model can be resolved (agent override → `Agent.getAvailableModel` → `Provider.defaultModel`), the open delivers a one-time system-origin task root (`detail: boss_open`, fixed delivery key `boss-open:<sessionID>`) and wakes the session, so `boss-synergy` produces a short greeting and the App lands on a formed chat instead of a bare new-session screen; the pending world-overview steer is drained into that same turn. The kickoff is skipped silently when no model is available or when the session already has a conversation root or a queued task, and channel-routed boss sessions never receive a synthetic greeting — they form from real Feishu ingress.

## Continuation Drive

`SessionDrive` is the single session-level arbitration entry point. Cortex completion, Agenda delivery or wait release, Lattice resume, and `SessionManager.release` all request the drive instead of delivering workflow continuations independently. Requests are serialized per session: each arbitration is queued after the previous request settles, so reentrant requests are not lost and processing wakes happen outside the tracked arbitration promise.

The driver does nothing while the session owns an active loop lease. Once idle, it first honors runnable durable Inbox work. Only when the Inbox has no runnable item does it ask the ContinuationKernel for a workflow proposal. The winning proposal is persisted with `SessionInbox.deliverUnique` under a stable delivery key, committed to policy deduplication, and then scheduled through the normal session wake path.

The shared continuation gate rejects archived sessions, sessions with an explicit continuation wait, sessions without a terminal assistant for the latest reply-required user message, and terminal assistant errors. `ContinuationWait` currently derives waits from queued or running Cortex child sessions and one-shot Agenda watches that own the next wake.

Policies run in descending priority:

1. BlueprintLoop (`100`)
2. Lattice (`50`)
3. Boss (`40`)
4. Light Loop (`25`)

The first policy that returns a proposal wins. Per-session, per-policy deduplication normally keys the decision to the terminal assistant message. A policy that reconciles multiple durable workflow revisions against the same terminal parent turn supplies a revision key derived from that workflow state and bound task identity. Inbox delivery keys make persistence idempotent across concurrent requests and restart recovery. Persisted Lattice lifecycle effects such as explicit resume and startup repair may materialize their own unique Inbox entry before requesting the drive; they still use the same Inbox-first ordering and never invoke the model loop directly.

BlueprintLoop normally continues a `running` bound loop, but an unbound stop intent is handled first by preparing, binding, and starting its reviewer. Lattice reconciles semantic actions and persisted effects, then proposes ordinary state continuation only after a successful terminal turn. Light Loop similarly handles an unbound stop intent before proposing its ordinary task check. Boss Mode proposes continuation only for workers with an un-reported assigned task; the root session stays human-driven.

### Agenda Wait Ownership

Only wake-capable Agenda items with `autoDone === true` are continuation waits. These one-shot watch-style items deliver directly to their origin session and complete after that delivery, so ordinary workflow continuation must not race their promised wake. Ordinary recurring or manually managed Agenda schedules remain wakeable but do not suppress workflow continuation merely because they are active.

The wait check deliberately ignores `nextRunAt`, so an overdue or just-fired one-shot watch remains a wait while its status is still `active` or `pending`. Cancelling, pausing, removing, making the item non-waking or silent, or automatically completing it releases the wait. `AgendaSessionWakeup.resumeIfReleased` then requests `SessionDrive`; for automatic completion, that request is deliberately deferred until after the Agenda result is persisted to the Inbox.

When Agenda delivery wakes an active Light Loop or running BlueprintLoop execution session, the delivery appends system-origin cleanup guidance: it lists remaining one-shot waits with their `agenda_cancel` commands, exposes `agenda_cancel`, `agenda_list`, and the correct stop tool, and instructs the loop to cancel those waits before requesting review.

`loop_stop` and `blueprint_loop_stop` call `AgendaSessionWakeup.assertClear` to reject the request while any one-shot wait remains, showing the cancellation commands in the error message. Pending stop intents suppress Agenda wake guidance and are re-driven through `SessionDrive` during startup recovery. A reviewer task interrupted after its durable binding is replaced from the surviving parent stop intent rather than treated as terminal review work. A completed, errored, or cancelled reviewer whose terminal tool did not settle the stop intent keeps its binding and is re-driven into the bounded same-session recovery path.

## Invariants

- Workflow instructions are a context projection; stored user text remains unchanged.
- Plan authors a Blueprint and cannot directly execute the requested outcome.
- Blueprint writes occur only in Plan or Lattice.
- Executors request completion; independent reviewer sessions decide it.
- Lattice owns work-state transitions and only the exact BlueprintLoop bound to its current attempt can advance its Pathway.
- Boss Mode derives its tree from the session parent chain; assignments and reports are the ledger, and only tree members can act through `BossService`.
- One shared drive serializes Inbox work and workflow proposals, and the shared gate prevents continuation while child work, an incomplete or erroring turn, or a one-shot Agenda wait is still active.

## SuperPlan Storage Substrate

The repository also contains `superplan/` schemas, storage, events, session ownership metadata, and worktree owner types for a graph of nodes and merge waves. No current CLI command, server route, tool registration, or continuation runner exposes SuperPlan as a selectable product workflow. The supported large-goal workflow is Lattice.

Treat SuperPlan fields as an internal persisted substrate that must remain import/export- and migration-safe while present. Do not route new product behavior through it or describe it as equivalent to Plan, BlueprintLoop, or Lattice without first adding an explicit lifecycle and user-facing contract.
