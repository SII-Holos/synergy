# Decision Record: Tool intent and qualified execution evidence

Status: implemented

## Problem

Tool capability descriptions, entity descriptions and call-specific purposes have different meanings. Treating them as the same field obscures Agent input contracts and produces ambiguous conversation labels. Historical file inspection and root outcomes also require facts belonging to the selected operation and execution, independent of current resources and session activity.

## Decision

The common model-tool facade adds optional `workBrief` with a single purpose-and-target instruction. Request-frozen bindings preserve native schemas, including conflicting fields and references, by using an envelope when flattening is unsafe. Execution receives native business input; parts retain intent and facade shape, model history reconstructs them, and raw audit records remain unchanged. Registered secrets are masked before intent storage and publication; renamed entity text fields retain the final provider-payload masking boundary. Intent does not affect authorization, duplicate comparisons or execution identity. Tool owners adapt precise entity names at the Agent boundary and register historical field mappings with the central versioned Session migration.

Optional activity evidence retains qualified operation resources, ranges, content references and truncation through existing Artifacts and execution ledgers. File and search results describe the captured observation; commands expose their own output and actual process receipt. Scope-aware read-only SDK queries bound selected results and root-status batches. Root lifecycle and stopped segments come from canonical execution records, with approvals matched to their owning root. Existing events invalidate loaded roots and selected calls; no second synchronization transport or presentation inference is created.

The conversation consumes one stable projection in every display mode. Ordinary rows select a read-only result rather than disclose protocol details. One lazy Session panel opens the captured result first and retains parameters and diagnostics as a secondary view. Selection is fenced by connection, Scope, Session, message, part and call identity. Closing releases rendering. The [conversation presentation decision](../feature/2026-10-01-conversation-process-presentation.md) defines disclosure, submission and reading ownership.

## Alternatives considered

**Add a description to every tool separately** duplicates contracts, misses dynamic tools and conflicts with third-party fields. One facade preserves tool-author independence and stable native arguments.

**Generate call summaries after execution** adds latency and cost and can confuse intended action with established results. Optional known-context intent and deterministic action facts keep execution independent from presentation inference.

**Read current resources for historical results** cannot establish what an earlier invocation observed. Captured evidence preserves that distinction; missing historical snapshots remain explicit.

**Use the current Session status for every turn** overwrites stopped historical roots when another task finishes. Root execution segments preserve independent outcomes and prior stops across continuation.

Agent prompt examples and scripted model providers use the published facade and precise entity names. Direct executor tests pass native business fields without facade metadata. Processor test doubles implement model-input retrieval, and dynamic MCP fixtures declare their native input schemas, so test admission follows the same split as production.

Schema-only `AgentCall` outputs cross the same facade boundary. The call snapshots the native schema before dispatch and decodes returned arguments with that binding before returning them to the domain validator. The raw response, including intent and envelopes, remains in rollout evidence and counts toward the output limit. Native fields named `workBrief` and unrelated unknown fields are preserved; domain validation still decides whether the decoded object is valid.

## Consequences

Agents receive consistent invocation and entity semantics without UI instructions. The UI can present clear intent while distinguishing actual success, errors, background execution and missing evidence. The cost is additive message metadata, bounded read queries and owner-registered migrations. Older histories retain available protocol output where operation snapshots do not exist; migrations cannot manufacture that evidence. Ordinary business APIs, entity storage and third-party server contracts retain their boundaries.
