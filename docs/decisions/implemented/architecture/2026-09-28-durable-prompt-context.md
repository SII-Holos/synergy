# Decision Record: Persist advisory context as replayable section updates

Status: implemented

## Problem

The late-user-context layout appended a freshly rendered advisory message to each request without recording it in the Session transcript. The next request placed assistant/tool history where the previous advisory had been, breaking the shared prefix even when that advisory was unchanged. Repeating complete todo and DAG observations also added avoidable input.

## Decision

Normal Session calls using the existing `late-user-context` provider policy persist advisory updates as hidden, non-root, system-origin user messages. Environment, Library recall, diagnostics and reminders have stable section identities. Unchanged sections emit nothing; changed sections append a replacement; removed state appends an explicit withdrawal. Task-scoped recall and reminders refresh for a new root, while elapsed-time observations are recorded once per task. Cortex reminders describe task state without a continually changing elapsed-seconds field.

`SessionPromptContext` derives comparison state from the effective, compaction-aware messages already loaded by the loop. Version 1 metadata contains section/content fingerprints and references to the actual text parts, not duplicate bodies. Missing, excluded or modified parts cannot prove that context is retained. Provider/model identity participates in comparison. No independent durable index or process-global baseline is introduced.

Context is masked and prepared before projection and budgeting. A context identity is reserved before the assistant identity. Once the budget admits a call, the context and assistant shell are written in one transaction, in that order with the same materialization timestamp. Preflight compaction discards the uncommitted preparation. Repeating a committed preparation does not duplicate messages; provider attempts reuse the prepared request. Committing means the history is ready to replay, not that a provider has received or cached it.

Internal prepared-message writes reuse Session materialization's transactional and observer behavior after artifact preparation and masking. Public input and transcript import strip the reserved comparison metadata. Imported text remains historical evidence; the target invocation establishes its own current context. Existing messages require no storage rewrite: the new metadata is additive and versioned, and old sessions establish their first recorded baseline at the next admitted call. Previously unrecorded prompt text is not reconstructed. Rollback, fork and compaction use the history they actually retain; a missing baseline causes a fresh snapshot.

Planning and Library query selection use canonical root/user/channel input semantics, so hidden context cannot reset tool counts or replace the user's query. Projection identifies durable context through provider metadata, allowing it to receive cache breakpoints even if its text mentions the legacy runtime tag.

The system-layout provider path keeps its current instruction priority. Permission, project and workflow instructions continue to use the existing high-priority path; real authorization remains at execution. Dynamic tool registration, model transitions, plugin transformations and intentional history pruning can still rebuild a prefix. This change does not introduce provider-specific mid-conversation system or tool protocols.

Todo writes acknowledge the submitted list while retaining full UI metadata and explicit reads. DAG patches return actual changed nodes, including backend promotions and partial-failure feedback; unrelated nodes stay in earlier history. DAG reads and writes still provide complete graph observations. Cortex completion delivery retains its existing unique Inbox notification instead of adding a second DAG notification stream.

Provenance: Codex [WorldState sections](https://github.com/openai/codex/blob/44fe510ce3ee61c8ef623adcbf89b901c73ddd61/codex-rs/core/src/context/world_state/mod.rs) motivate retained-context comparison and semantic updates; its [plan handler](https://github.com/openai/codex/blob/44fe510ce3ee61c8ef623adcbf89b901c73ddd61/codex-rs/core/src/tools/handlers/plan.rs) motivates short acknowledgments when the submitted plan is already in history. Synergy keeps its existing Session authority, multi-provider projection, masking and execution checks. The [broader proposal](../../proposed/architecture/2026-09-28-append-only-model-context.md) records future provider-specific work; it is not all implemented by this decision.

## Alternatives considered

**Persist every complete advisory block on every step.** This preserves chronology but increases redundant context. Section comparison avoids duplication and expresses removal explicitly.

**Persist a second provider request journal as conversation authority.** This duplicates Session state and adds recovery/import synchronization. Rollout remains evidence, and Session messages remain authoritative.

**Move all instructions and tool schemas into ordinary user text.** This changes instruction priority and does not register tools with providers. Those paths require separate protocol capability work.

## Consequences

Deterministic tests capture final HTTP requests through the real SDK and loop with real temporary Session storage and tool execution. They verify retained prefixes across consecutive tool steps, a changed environment and another invocation. Additional tests cover materialization retries and rollback, Runtime reopening, compaction, missing retained parts, input/import metadata boundaries, recall, cache breakpoints and bounded plan observations. Existing loop, model-selection, pause and compaction tests remain applicable.

Comparison scans only the model working set; it does not load the full transcript or keep a second unbounded cache. Updates still occupy context until normal compaction. Plugin rewriting and deliberate history pruning remain observable exceptions to prefix retention. No paid-model experiment or cache-hit, latency, quality or cost improvement percentage is claimed.
