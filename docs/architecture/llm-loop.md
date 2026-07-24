# LLM Loop and Compaction

## Purpose

The session LLM loop turns one root task into an ordered sequence of model calls, tool executions, injected context, and persisted assistant messages. It continues until the task has a terminal assistant reply, the user aborts, a blocking loop job stops it, or an unrecoverable error is persisted.

The loop is not an in-memory conversation object. Durable messages and session state remain authoritative; the runtime is a single-writer execution window over that state.

## Entry and Ownership

New direct input is either materialized as a root user message or queued in `SessionInbox`. When a reply is required, the session records `pendingReply` and enters `SessionManager.run()`.

`SessionManager.run()` acquires a generation-tagged lease synchronously, before session lookup or workspace setup can yield. The lease is the loop's owner identity and carries its abort signal. Its runtime phase moves from `starting` to `running`; cancellation moves it to `stopping` without clearing ownership. Only the exact owner lease can complete waiters or release the runtime, so a stale loop cannot abort, complete, or release a newer owner. Other callers attach waiters to the occupied runtime.

During ownership:

- the lease abort signal is shared by the session run;
- status changes are published as busy, retry, idle, or recovering;
- the loop-scoped message cache holds the compaction-aware model working set;
- all loop writes update that cache and durable storage;
- cache and recall state are released when the loop exits.

The message cache is valid because the active loop is the sole session writer. On a cold read, history loading scans ordered message info, applies rollback events, finds the latest committed compaction boundary, and loads parts only for the boundary root, retained summaries, and active suffix. Completed compaction reprojects the cache immediately so pre-boundary parts are released. Structural changes that incremental maintenance cannot model invalidate the cache and force an authoritative working-set reread; full transcript paths remain disk-backed. The process-wide cache byte budget is also a hard ceiling for each session entry: an oversized working set remains disk-backed instead of defeating aggregate eviction.

The cache maintains bounded operational accounting for its estimated retained bytes, active and total entries, largest entries, hits, misses, evictions, and occasions where active protected entries keep it over budget. Entry estimates walk the cached immutable message graph without first materializing a second serialized transcript. Public Performance read models omit Session IDs and expose only aggregate counts and entry sizes.

## Root Selection

Each outer iteration loads effective, canonicalized session history and finds the latest root user message `R`.

`R` owns:

- task identity and `rootID`
- model, agent, variant, system override, and per-message tool mask
- the compaction anchor
- assistant `parentID` and `rootID`

The loop never chooses a Cortex notification, workflow continuation, or other non-root message as the task owner.

## Inbox Drain Order

For root `R`, each inner iteration follows two inbox gates:

1. `steer` items are materialized before `needsModelCall`. A steer can wake or extend the active task.
2. If a model call is required, `context` items are materialized so they piggyback on that call. Context alone never creates a call.

After the inner task loop ends, the outer loop takes the next `task` item and materializes it as a new root. If no task remains but a runnable steer exists for a prior root, the loop re-enters that root.

This order is the scheduling contract. Delivery sources must choose the correct inbox mode rather than encoding scheduling through metadata.

## Per-Step Flow

One model step performs the following work:

1. Load the session, effective messages, root parts, last terminal assistant, and current model limits.
2. Detect loop signals and run pre-LLM jobs.
3. Resolve the root agent and model, including external-agent routing where configured.
4. Resolve tool definitions, system context, Cortex context, Library recall, environment context, and Agenda reminders in parallel where independent.
5. Project workflow-wrapped messages without mutating stored user text.
6. Build and measure the provider prompt.
7. Trigger compaction instead of calling the model if the prompt crosses the configured soft budget.
8. Resolve a serializable model-facing tool catalog separately from Control Plane execution callbacks.
9. Queue the provider turn on `AgentTurn`, consume its bounded event frames, and persist one assistant message.
10. Release the Agent worker, dispatch generation-aware ToolTasks, authorize each operation in the Control Plane before physical execution, and settle results.
11. Run post-LLM jobs, persist terminal state, and decide whether another model call is needed.

The assistant created for the step keeps `parentID = R.id` and `rootID = R.id`, even when the step follows a steer, context injection, tool result, or compaction boundary.

## Agent and Model Resolution

Root messages persist the resolved agent and model used to start their task. Session-level explicit overrides can become defaults for later roots, while lower-priority fallback resolution does not write back into a user's draft selection.

The Web composer uses the same intent layering:

1. current user draft selection
2. session default: server `modelOverride`, otherwise the last root message
3. application fallback

An explicit selector choice persists as `modelOverride`. Provider authentication remains provider-specific; the `openai-codex` native Codex path does not receive the normal OpenAI API-key/base-URL override.

### Model variants and reasoning options

Model capability metadata from catalogs such as models.dev describes what a model advertises, but it does not prove that a service reusing another provider's AI SDK package accepts the same provider option semantics. Automatic reasoning variants are derived from model identity (`model.id`, API model ID, or model family) combined with the direct transport. They are not selected from provider IDs, and a shared npm package alone does not establish option compatibility, so custom provider aliases retain correct behavior.

`ProviderTransform.variants()` applies transport-specific rules for third-party services on Anthropic and OpenAI-compatible wiring. Kimi K3 models on direct Anthropic transport expose catalog-declared `low`, `high`, and `max` variants. `low` and `high` map to Anthropic `effort`; `max` omits `effort` because Kimi's service default is already `max` and the locked Anthropic SDK accepts only `low`, `medium`, or `high`. Selecting no variant likewise uses Kimi's server-side `max` default. Kimi K2.x models remain provider-managed and receive no automatic Anthropic thinking variants. MiniMax M2.x models on direct Anthropic transport likewise produce no variants because reasoning is always on. MiniMax M3 on direct Anthropic transport exposes only a `max` variant mapped to `thinking: { type: "adaptive" }`; without it, reasoning defaults to off. MiniMax models on direct OpenAI-compatible Chat transport receive no `reasoningEffort` variants because that endpoint does not support `reasoning_effort`.

When a third-party transport case returns no automatic variants, a configured `role_variant` such as `max` is applied only if the resolved model exposes a same-named variant; otherwise the provider receives no generated option and uses its server-side reasoning default. User-defined model `variants` are merged after automatic defaults and can add or override named variants for individual models.

## Internal LLM Invocation Paths

Not every model call belongs to a persisted conversation, but every product inference must use a deliberate lifecycle boundary.

| Lifecycle                      | Current boundary                                                                                                             | Examples and properties                                                                                                                                                |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sessionless derived work       | `AgentCall.text()` or a domain-owned `AgentTurn` call through the external worker pool, without persisting an inference turn | title and turn summaries, SmartAllow, agent generation, GitHub classification, and Experience encoding; no resumable transcript, Cortex progress, or completion notice |
| Existing durable work          | `SessionInvoke` and the owning session loop, with each provider turn executed by `AgentTurn`                                 | user/API input, Channel or Agenda execution, workflow continuation, and in-place compaction                                                                            |
| New delegated or reviewed work | `Cortex.launch()`                                                                                                            | a child session with lineage, visibility, concurrency, progress, cancellation, timeout, cleanup, and a summary/final/structured output contract                        |
| Provider/bootstrap probe       | a narrow direct AI SDK call                                                                                                  | setup capability probing before the normal agent/session runtime is available                                                                                          |

`AgentCall.text()` is the Core boundary for text-only Sessionless work. It resolves the Agent and model (with an explicit caller-owned fallback), creates only ephemeral LLM identity when no request identity exists, fixes the model-facing tool catalog to empty, combines caller cancellation, timeout, and output-limit aborts, queues the call through `AgentTurn`, collects an owned text stream within a bound, and disposes it in `finally`. It returns structured missing-agent/model, timeout, cancellation, and input/output-bound errors. It never creates Session history, Cortex work, Experience lineage, or completion notices. The caller continues to own prompts, retry count, fallback policy, parsing, persistence, and domain error mapping.

Title and turn summary generation, SmartAllow, agent generation, GitHub classification, and Experience Encoder all enter the same external Agent worker boundary. Domain-specific callers may use `AgentCall.text()` or `AgentTurn` directly when they require usage accounting or specialized parsing, but production product code does not call `LLM.stream()` outside the Agent worker runner. The setup capability probe remains the narrow bootstrap exception because it runs before normal runtime orchestration is available.

The GitHub shadow classifier (`classifyGitHubObservation()`) is a sessionless caller in this family: it resolves the hidden `github-shadow-classifier` agent through the nano model role, queues an `AgentTurn` with an ephemeral session/message identity, passes `maxOutputTokens` from its budget config, and discards the exchange. No session or message record persists.

Sessionless work is appropriate only when the result is derived data and a durable transcript would be noise. Work that users or parent agents must inspect, resume, cancel, audit, or receive as a task belongs in a session. New ordinary child work uses Cortex rather than manually composing `Session.create()` with `SessionInvoke`; specialized existing flows such as `look_at` and Chronicler are explicit exceptions, not the default delegation contract.

SmartAllow remains in the sessionless family. New text-only Sessionless inference uses `AgentCall.text()` rather than adding a domain-local lifecycle wrapper unless the caller needs specialized parsing or usage accounting.

## Prompt Assembly

Prompt assembly is ordered from stable to volatile to maximize provider cache reuse.

| Layer                       | Content                                                                                             |
| --------------------------- | --------------------------------------------------------------------------------------------------- |
| Agent base                  | Agent prompt or provider fallback prompt, always first.                                             |
| Static project instructions | Discovered instruction files and explicit instruction additions.                                    |
| Permission context          | Effective control profile, sandbox/workspace boundaries, and execution guidance.                    |
| Cortex context              | Parent task and delegated execution context.                                                        |
| Workflow context            | Plan, Lattice, Light Loop, or BlueprintLoop execution/audit contract.                               |
| Recall                      | Loop-stable Library memory and experience context.                                                  |
| Environment                 | Scope, workspace, platform, date, session, endpoint, and worktree facts.                            |
| Diagnostics and reminders   | Git health, coauthor reminder, Agenda wake-ups, Cortex status, planning reminder, and elapsed time. |

Stable system content and a cache breakpoint remain early. Volatile advisory context is placed according to provider prompt-cache policy: either as later system content or as a final `<runtime-context>` user message. Advisory context cannot override agent, permission, workflow, developer, or tool instructions.

Plugins can transform the system prompt at budget and final phases. If a transform removes every system message, Synergy restores the pre-transform system prompt rather than sending an empty safety/instruction context.

## Library Recall

Top-level sessions build memory and experience context in parallel from the current task text.

- `always` memories are included without semantic matching.
- `contextual` memories are retrieved with category-aware thresholds and limits.
- `search_only` memories are available only through memory tools.
- experiences are retrieved within the current Scope.
- child sessions receive lightweight always-only memory context.

Recall has a bounded timeout and a loop-level cache. The context remains available across steps and compaction boundaries. The root message records which memory or experience context was injected so the durable task can be inspected later.

## Tool Resolution and Execution

Tool definitions are filtered for agent visibility and current workflow before prompt budgeting. Immediately before execution, `ToolResolver` resolves availability and crosses the execution boundary described in [Execution boundaries](execution-boundaries.md).

`SessionProcessor` owns streamed tool state:

- tool input can move through generating, pending, and running states;
- streamed raw argument deltas are transport/progress data used for incremental bounds and diagnostics, while the AI SDK `tool-call.input` is the canonical input for final bounds, persistence, loop guards, permission evaluation, and execution;
- each provider call ID owns one runtime execution promise, so replayed AI SDK callbacks reuse the original result or error instead of repeating tool side effects;
- each execution has a settlement slot keyed by provider call ID;
- completed output, attachments, metadata, timing, and errors are persisted on the original tool part;
- settlement is terminal for that provider call ID, so late or replayed stream events cannot allocate a second tool part;
- more than one tool execution can settle without losing original message-part order;
- unresolved tools are completed with explicit abort or settlement errors;
- repeated identical calls can trigger loop protection or permission review.

Model tool-call repair is narrow: known tool names can be case-folded, and syntactically truncated JSON can be repaired only when native parsing fails and the resolved tool exists. Semantic schema errors and hallucinated tools are not rewritten into plausible calls.

## Loop Jobs and Guards

`LoopJob` is the pre/post step extension point. Jobs can be blocking or non-blocking and can react to registered signals.

Current loop-level behavior includes:

- compaction processing
- asynchronous old-tool-output pruning
- title, body, and turn diff summary generation
- Library experience chronicling
- repeated successful tool-call warnings
- repeated same-class tool-error stopping
- tool-category failure analysis and escalation

A blocking job can return `continue` to restart the loop after changing history or `stop` to finish without another model call. Non-blocking jobs cannot hold the critical execution path.

### Turn diff settlement

The `summarize` post-step job computes file diffs and derives title/body for each completed turn without joining the blocking loop path:

1. The job writes `diffState: { status: "pending", deadlineAt }` immediately so the frontend sees the pending state.
2. It computes diffs from the complete root turn's snapshot range (`step-start` → latest `step-finish` across its assistant revisions).
3. On success, it writes `{ diffs, diffState: { status: "ready" } }` atomically. A diff failure writes `{ diffState: { status: "error", code } }`; a per-run timeout applies `error/timeout` only while that turn is still `pending`, preserving a diff that already reached `ready` while later enrichment or session aggregation was running.
4. Title generation may proceed after either outcome. Body generation runs only after a successful non-empty diff settlement, and the applicable LLM calls run in parallel.

Concurrent summarizations for the same session use a FIFO queue keyed by terminal assistant revision, allowing later continuations of one root turn while coalescing duplicate triggers. Cancellation propagates through snapshot and LLM work, and a worker settles before the queue advances so late writes cannot overwrite a newer revision. A stale persisted `pending` state is projected to `error/timeout` at the backend read boundary. The frontend renders that server-owned state without comparing `deadlineAt` to its local clock. Each run owns a `diffCache` so its session-level and turn-level computations can share an identical in-flight snapshot range. See [Sessions and Messages — Turn Diffs](session-and-messages.md#turn-diffs) for the schema and contract.

The post-job gives the first worker the loop's existing top-level message snapshot instead of rereading complete session history. It treats message entries and nested info/parts as immutable while deriving summaries. Later queued revisions retain only their bounded root-turn snapshot rather than another full working set; session aggregation extends the discardable persisted summary cursor, while direct callers without a snapshot read authoritative durable history. If an existing session aggregation has no cursor, one bounded call rebuilds it from complete history before incremental updates resume.

## Prompt Budget

`PromptBudgeter` measures the complete request:

- stable and late system context
- projected history
- tool names, descriptions, schemas, and protocol overhead
- bounded estimates for historical image/file parts

The usable input budget accounts for context and reserved model output. Automatic compaction defaults to a soft threshold of 85% of usable input and can be configured.

After the first provider call, Synergy calibrates estimates using provider-reported input and output tokens plus the smaller newly accumulated delta. This avoids repeatedly estimating the entire prompt with a tokenizer that may not match the provider.

## Context Usage Snapshots

Before streaming a normal assistant step, `MessageV2.projectModelMessages()` derives history provenance in the same pass that emits provider messages, after effective-history filtering and workflow wrapping. After `PromptBudgeter.buildPlan()` applies the budget-phase provider and plugin transforms, `SessionInvoke` remaps those category hints over the plan's final messages, discarding removed content and classifying transformed or inserted content from its final provider role. It then adds only tool definitions that survive final availability resolution. `LLM.stream()` adds the final assembled system and late-system prompt and measures all categories with the selected model tokenizer.

When the provider reports input usage for the completed step, `SessionProcessor` reconciles the draft into `AssistantMessage.contextUsage`. `totalInput` is the provider-exact input total used by the latest call; category totals remain estimates attributed from the model-tokenizer draft. If estimates exceed the exact total, category attribution is scaled down with largest-remainder rounding. Otherwise the unassigned difference is recorded as overhead. The snapshot also records provider/model identity, context and usable-input limits when known, estimator metadata, reconciliation mode and factor, and capture time.

Historical assistant messages that predate `contextUsage` remain valid. Their token totals are still available through the existing `tokens` field, but they do not receive a backfilled category breakdown. The feature adds only an optional assistant-message field and uses existing message update events; it does not require a route, event, config, storage migration, or historical backfill.

## Compaction

Compaction establishes a new model-context boundary while preserving durable history.

### Triggering

Compaction can be requested explicitly or injected automatically when:

- prompt measurement crosses the configured soft budget; or
- the provider returns a recognized context-length error.

The request is a `compaction` part attached to root `R`. Pending requests are counted against completed compaction summaries for that same root, so a long task can compact more than once without endlessly reprocessing one request.

### Summary generation

The compaction job:

1. resolves the dedicated `compaction` agent and its available model, falling back to the root model;
2. projects the current effective history with no tools;
3. trims oldest summary input if even the compaction model cannot accept the full history, advancing the cut past any tool results whose assistant tool calls were omitted;
4. persists a hidden compaction attempt with `includeInContext = false` and `metadata.compactionAttempt.state = "running"` so streamed output remains auditable without affecting later prompts;
5. asks only for a structured continuation summary;
6. records provider or processor failures as `failed` and empty output as `empty`, leaving those terminal attempts hidden and outside model context;
7. after a non-empty summary is complete, writes a `compaction_recovery` part and commits the assistant with attempt state `committed`, `summary = true`, `visible = true`, `includeInContext = true`, `parentID = R.id`, and `rootID = R.id`;
8. publishes `session.compacted` only after that commit.

The `summary` flag is the context-boundary commit marker, not an in-progress placeholder. The attempt state is the presentation lifecycle: `running` survives the processor's terminal checkpoint until the compaction owner resolves it to `committed`, `failed`, or `empty`. Failed and empty attempts stay hidden and excluded from model context, do not fulfill the request, and do not establish a filtering or pruning boundary.

The compaction agent cannot use tools or continue the user's task. Its built-in permission layer denies every tool subject to normal configuration precedence, while the invocation independently passes an empty tool set so no configured permission can equip the compaction model with tools. Its prompt requires observed facts, completed work, current state, next steps, constraints, and relevant files without inventing progress.

If the summarization call itself exceeds context, Synergy writes a deterministic mechanical fallback and commits it through the same boundary. Other compaction-model failures remain explicit failures.

### Anchor and continuation

The active task anchor is resolved directly from root `R`: user-authored text first, then the root summary title. There is no backward heuristic scan or carried anchor metadata.

Automatic compaction writes a hidden non-root system continuation belonging to `R`, includes the anchor, and returns `continue`. The continuation also carries a deterministic recovery hint: use the summary as the primary handoff, avoid repeating completed work, and only when exact earlier message context is missing, expand the deferred Session tools if needed and use `session_read` around the compaction summary message. The next iteration rereads filtered history and resumes the same task.

### Filtering and pruning

Later model projection keeps the boundary root, completed summaries for that root, and messages after the latest summary. Earlier completed summaries remain available for audit but are marked out of context. The underlying pre-compaction messages remain in durable storage and can still be inspected through raw/full history paths.

Model working-set loading applies rollback before boundary selection and restores legacy stable-ID chronology from message creation time. It scans all small message-info records but loads parts only for the selected working set. The active loop caches that projected set and maintains it incrementally; it never retains the full pre-compaction transcript.

Separately, asynchronous pruning clears large outputs from older completed tool parts when all of these conditions hold:

- the output lies before the two most recent protected turns;
- it is not after an existing summary boundary;
- it is not already compacted;
- it is not from a protected tool such as `skill`;
- accumulated protected and prunable token thresholds are exceeded.

Pruning is configurable and records a compaction timestamp on the tool state.
It operates on the loop's existing immutable working-set snapshot, and its `Session.updatePart()` writes maintain the loop-scoped cache incrementally. Running a prune job does not invalidate or reread the complete session history.

## Streaming and Persistence

Text, reasoning, and tool parts are persisted throughout the step. Streaming text/reasoning writes are coalesced at a short write-behind interval; terminal and discrete updates flush immediately. Before a turn finalizes, pending writes are flushed so a missing terminal callback cannot silently lose accumulated text.

Inside an Agent worker, the `LLM.stream()` consumer takes one owned full stream through the shared `LLM` ownership helper. The helper immediately cancels the residual branch retained by the AI SDK's internal stream tee and settles that cancellation after the consumed branch finishes. Normal turn completion also removes the session-abort listener and closes the per-turn combined signal; settled streams cannot remain anchored until the whole session exits.

The external `AgentTurn` boundary transfers immutable turn snapshots through a versioned, schema-validated protocol. Requests are capped at 64 MiB and paged through acknowledged 1 MiB chunks rather than one unbounded IPC object. Worker event frames are capped at 2 MiB, text/reasoning deltas coalesce up to 16 ms or 32 KiB, and each frame remains the only buffered frame until the Control Plane consumer acknowledges it. Agent queue counts and aggregate bytes are bounded, and cancellation, heartbeat timeout, crash replacement, RSS/heap/turn-count recycling, and parent-death cleanup affect only the owned turn.

Agent worker provider-model caches include a one-way credential fingerprint, so installing a new per-turn provider plan cannot reuse a model instance created with an older key. A worker that exits before the `ready` handshake is treated as a startup failure: replacement attempts use exponential backoff from 250 ms to 4 seconds, and the sixth consecutive startup failure opens the pool circuit, rejects queued turns, and makes later turns fail immediately. A successful handshake resets the startup-failure sequence; crashes after readiness remain eligible for immediate replacement.

Normal session turns also carry one bounded memory-attribution handle from history projection through stream disposal. It records estimated history bytes before and after projection, the prepared request and tool-schema bytes, streamed output and raw tool-input characters, active turn and stream counts, and process-memory deltas relative to turn start. Memory checkpoints run before and after projection, after stream startup, periodically while a stream remains active, at bounded tool-input intervals, and after stream disposal. Checkpoints publish sizes and deltas only; prompt text, tool input, and response content never enter observability.

Memory checkpoints share one process-wide collection coordinator. Concurrent turns coalesce behind one in-flight request, all pressure levels observe the same minimum interval, and routine collection is asynchronous so critical pressure cannot make each active turn trigger another synchronous full GC on the server event loop.

After a normally settled model turn, the loop clears large prompt, tool, projection, and provenance containers in place before dropping its local references. The Agent worker releases its provider stream before the Control Plane authorizes or dispatches proposed tools, so permission waits, tool execution, questions, and child sessions never retain an Agent slot. A timed-out processor may still be consuming its input, so that abandoned path drops loop references without mutating the shared containers.

Provider SSE input passes through a 16 MiB per-event **SSE event parser bound** before it enters the AI SDK parser. The bound terminates an event whose encoded bytes exceed that threshold, preventing unbounded parser state for one unterminated event; it is not a limit on the total response, transport chunk size, or process memory. Provider body wrappers read only on downstream demand and release their owned reader after normal completion, upstream failure, timeout, or downstream cancellation. Streamed tool-call input is bounded independently at 1 MiB for both incremental deltas and final-only provider calls, and an oversized call is rejected before tool execution with terminal tool and assistant errors.

Persisted file diffs retain at most 8,000 characters of preview per file and at most 1 MiB of UTF-8 preview bytes across one diff array. Once the aggregate budget is exhausted, later entries keep file, additions, deletions, binary, and byte-size metadata, omit `preview`, and set `truncated = true`. New snapshots, imports, canonical reads, and the session migration apply the same bound.

Client wire transport can replace full accumulated streaming parts with incremental delta frames and periodic full checkpoints. That optimization does not change the in-process message or event model; see [Frontend data sync](frontend-data-sync.md).

## Completion, Abort, and Errors

When the inner loop reaches a terminal assistant:

- post-step jobs run;
- the next queued task may start in the outer loop;
- when no runnable work remains, `pendingReply` is cleared;
- completion notification state is updated;
- waiters receive the selected terminal assistant.

Provider, auth, output-length, timeout, abort, and unknown failures are persisted on the assistant message with terminal timing. A terminal assistant error is then propagated to callers such as Cortex so a failed task cannot be reported as completed.

If abort interrupts a processor before normal finalization, repair writes an explicit aborted assistant and clears `pendingReply`. Runtime startup also detects and repairs incomplete persisted turns.

Abort never publishes idle by itself. The owner remains in `stopping` until its loop exits and releases the lease, after terminal persistence and waiter settlement. A repeated abort reports that stopping is already in progress.

## Invariants

- One lease owns one session at a time across starting, running, and stopping phases.
- Every assistant step remains attached to the current root `R`.
- Steer is drained before the call predicate; context only piggybacks on an already-required call.
- Stored user text is not rewritten to apply workflow instructions.
- Prompt assembly keeps stable content before volatile advisory context.
- Tool visibility and tool execution permission remain separate stages.
- Model-facing tools are serializable schemas without `execute()` callbacks.
- Agent workers never write canonical session state or wait for permission/tools after their provider turn ends.
- ToolTask identity includes session generation, message, call, executor, and attempt; dispatch never automatically replays a possibly side-effecting running call.
- Sessionless internal inference never implies durable task history or Cortex lifecycle.
- New inspectable delegated or reviewed work enters the session model through Cortex.
- Automatic compaction is a resumable context boundary, not history deletion.
- Compaction can repeat for a long root task and always resolves its anchor from that root.
- Terminal failures are persisted and propagated; they are never silently converted into successful task completion.
