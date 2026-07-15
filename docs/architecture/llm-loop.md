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
- the loop-scoped message cache holds the assembled raw history;
- all loop writes update that cache and durable storage;
- cache and recall state are released when the loop exits.

The message cache is valid because the active loop is the sole session writer. Paths that rewrite history in ways the incremental cache does not model, especially compaction, invalidate it and force an authoritative reread.

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
8. Resolve executable tools through the centralized tool boundary.
9. Stream the model response and tool activity into one assistant message.
10. Run post-LLM jobs, persist terminal state, and decide whether another model call is needed.

The assistant created for the step keeps `parentID = R.id` and `rootID = R.id`, even when the step follows a steer, context injection, tool result, or compaction boundary.

## Agent and Model Resolution

Root messages persist the resolved agent and model used to start their task. Session-level explicit overrides can become defaults for later roots, while lower-priority fallback resolution does not write back into a user's draft selection.

The Web composer uses the same intent layering:

1. current user draft selection
2. session default: server `modelOverride`, otherwise the last root message
3. application fallback

An explicit selector choice persists as `modelOverride`. Provider authentication remains provider-specific; the `openai-codex` native Codex path does not receive the normal OpenAI API-key/base-URL override.

## Internal LLM Invocation Paths

Not every model call belongs to a persisted conversation, but every product inference must use a deliberate lifecycle boundary.

| Lifecycle                      | Current boundary                                                                                                                     | Examples and properties                                                                                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sessionless derived work       | Resolve a hidden internal agent and model, then call `LLM.stream()` without creating a session or persisting an inference transcript | title and turn summaries, Experience encoding, SmartAllow classification, and agent generation; no resumable transcript, Cortex progress, or completion notice |
| Existing durable work          | `SessionInvoke` and the owning session loop                                                                                          | user/API input, Channel or Agenda execution, workflow continuation, and in-place compaction                                                                    |
| New delegated or reviewed work | `Cortex.launch()`                                                                                                                    | a child session with lineage, visibility, concurrency, progress, cancellation, timeout, cleanup, and a summary/final/structured output contract                |
| Provider/bootstrap probe       | a narrow direct AI SDK call                                                                                                          | setup capability probing before the normal agent/session runtime is available                                                                                  |

`library/experience-encoder.ts` currently defines a private `callAgent()` helper for its own three encoders. It is not a shared repository API. Other sessionless callers use the same underlying resolution and `LLM.stream()` pattern independently. They may pass an existing or request-scoped session/message identity because the shared API requires context, but they do not create a durable session or store the inference exchange. That shared LLM boundary preserves provider transforms, model variants, prompt-cache policy, plugin chat hooks, telemetry, and reasoning normalization; direct product calls to `generateText()` or `streamText()` would bypass part of that contract.

Sessionless work is appropriate only when the result is derived data and a durable transcript would be noise. Work that users or parent agents must inspect, resume, cancel, audit, or receive as a task belongs in a session. New ordinary child work uses Cortex rather than manually composing `Session.create()` with `SessionInvoke`; specialized existing flows such as `look_at` and Chronicler are explicit exceptions, not the default delegation contract.

SmartAllow is currently in the sessionless family. As these callers converge, new code should reuse a shared internal-agent-call abstraction rather than add another domain-local wrapper; until that abstraction exists, `LLM.stream()` remains the common runtime boundary.

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
- title and summary generation
- Library experience chronicling
- repeated successful tool-call warnings
- repeated same-class tool-error stopping
- tool-category failure analysis and escalation

A blocking job can return `continue` to restart the loop after changing history or `stop` to finish without another model call. Non-blocking jobs cannot hold the critical execution path.

## Prompt Budget

`PromptBudgeter` measures the complete request:

- stable and late system context
- projected history
- tool names, descriptions, schemas, and protocol overhead
- bounded estimates for historical image/file parts

The usable input budget accounts for context and reserved model output. Automatic compaction defaults to a soft threshold of 85% of usable input and can be configured.

After the first provider call, Synergy calibrates estimates using provider-reported input and output tokens plus the smaller newly accumulated delta. This avoids repeatedly estimating the entire prompt with a tokenizer that may not match the provider.

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
3. trims oldest summary input if even the compaction model cannot accept the full history;
4. asks only for a structured continuation summary;
5. writes a terminal assistant message with `summary = true`, `parentID = R.id`, and `rootID = R.id`;
6. writes a `compaction_recovery` part for frontend and recovery use;
7. publishes `session.compacted`.

The compaction agent cannot use tools or continue the user's task. Its prompt requires observed facts, completed work, current state, next steps, constraints, and relevant files without inventing progress.

If the summarization call itself exceeds context, Synergy writes a deterministic mechanical fallback containing recent user requests, involved files, used tools, and a pointer to full history. Other compaction-model failures remain explicit failures.

### Anchor and continuation

The active task anchor is resolved directly from root `R`: user-authored text first, then the root summary title. There is no backward heuristic scan or carried anchor metadata.

Automatic compaction writes a hidden non-root system continuation belonging to `R`, includes the anchor, and returns `continue`. The continuation also carries a deterministic recovery hint: use the summary as the primary handoff, avoid repeating completed work, and only when exact earlier message context is missing, expand the deferred Session tools if needed and use `session_read` around the compaction summary message. The next iteration rereads filtered history and resumes the same task.

### Filtering and pruning

Later model projection keeps the completed summary and messages after that boundary. The underlying pre-compaction messages remain in durable storage and can still be inspected through raw/full history paths.

Separately, asynchronous pruning clears large outputs from older completed tool parts when all of these conditions hold:

- the output lies before the two most recent protected turns;
- it is not after an existing summary boundary;
- it is not already compacted;
- it is not from a protected tool such as `skill`;
- accumulated protected and prunable token thresholds are exceeded.

Pruning is configurable and records a compaction timestamp on the tool state.
It operates on the loop's existing immutable message snapshot, and its `Session.updatePart()` writes maintain the loop-scoped message cache incrementally. Running a prune job does not invalidate or reread the complete session history.

## Streaming and Persistence

Text, reasoning, and tool parts are persisted throughout the step. Streaming text/reasoning writes are coalesced at a short write-behind interval; terminal and discrete updates flush immediately. Before a turn finalizes, pending writes are flushed so a missing terminal callback cannot silently lose accumulated text.

Every `LLM.stream()` consumer takes one owned full stream, text stream, or text promise through the shared `LLM` ownership helpers. Those helpers immediately cancel the residual branch retained by the AI SDK's internal stream tee and settle that cancellation after the consumed branch finishes. Normal turn completion also removes the session-abort listener and closes the per-turn combined signal; settled streams cannot remain anchored until the whole session exits.

Provider SSE input passes through a 16 MiB per-event **SSE event parser bound** before it enters the AI SDK parser. The bound terminates an event whose encoded bytes exceed that threshold, preventing unbounded parser state for one unterminated event; it is not a limit on the total response, transport chunk size, or process memory. Streamed tool-call input is bounded independently at 1 MiB for both incremental deltas and final-only provider calls, and an oversized call is rejected before tool execution with terminal tool and assistant errors.

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
- Sessionless internal inference never implies durable task history or Cortex lifecycle.
- New inspectable delegated or reviewed work enters the session model through Cortex.
- Automatic compaction is a resumable context boundary, not history deletion.
- Compaction can repeat for a long root task and always resolves its anchor from that root.
- Terminal failures are persisted and propagated; they are never silently converted into successful task completion.
