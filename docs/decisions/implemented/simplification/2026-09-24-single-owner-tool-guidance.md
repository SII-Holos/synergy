# Decision Record: Keep routing catalogs and tool semantics in one description

Status: implemented

## Problem

The [retained two-task diagnosis](../../../research/context-efficiency/2026-09-24-process-waiting-followup.md) identifies a substantial fixed input component. Inspection of an actual request finds 29 full specialist descriptions in both the synergy-max system prompt and task description, duplicating 13,242 UTF-8 bytes of description text. Delegation examples, DAG rules and tool-discovery catalogs also repeat. These are byte observations, not provider token attribution; most tool content is not an exact duplicate.

## Decision

Synergy-max refers to the task tool's permission-filtered catalog for full specialist descriptions instead of injecting a second table. Names and complete descriptions remain available without truncation. The existing task permission and delegation filters remain authoritative. The primary's selection principles remain, and its hand-written discovery-group table is replaced with a reference to expand_tools.

Task guidance keeps assignment scope, input readiness, write ownership, result notifications and acknowledgment, session reuse, structured results and DAG binding, with one dependency example. DAG guidance keeps states, transitions, validation and replacement behavior without requiring a graph as the first action or delegation merely because several nodes are ready. Process examples and expansion prose are condensed while retaining parameter defaults, host limits and permission distinctions. Bash retains command construction and Git safety; tool descriptions remain useful to callers other than synergy-max.

This follows the [static-context ownership decision](2026-09-06-slim-static-prompt-and-tool-context.md) and preserves the [delegation criteria](../feature/2026-09-07-task-delegation-guidance.md). It changes descriptions and prompt composition only: schemas, execution, resident tools, groups, discovery, authorization, history and third-party MCP descriptions are unchanged. The existing builder call signature is retained.

## Alternatives considered

**Truncate specialist descriptions or hide tools unused in two tasks.** Both can remove routing distinctions or capabilities needed in other workflows. Removing a duplicate preserves the full information once.

**Rewrite every primary prompt or third-party MCP description.** The measured duplication belongs to synergy-max and first-party descriptions. Other primary catalogs and externally supplied instructions remain outside this focused change.

**Move all guidance into the primary prompt.** Shared tools also serve agents with shorter or different prompts. Detailed tool semantics belong at the tool; primary prompts retain behavioral principles.

## Consequences

An isolated production-composition fixture without MCP measures system plus serialized tools decreasing from 150,942 to 127,184 UTF-8 bytes, with the same 31 tool names/order, parameter schemas and exposure metadata. Its temporary-home-specific permission hashes are not comparable across fixture instances; catalog denial and exposure tests independently verify permission behavior. These fixture sizes differ from the retained live requests and are not token savings. Size budgets use UTF-8 consistently and include task/process descriptions.

The catalog regression assembles the primary prompt and initialized task description, checking each permitted specialist's full description appears once and a denied specialist's description is absent. Model quality, discovery choices and cache behavior still require task observations. New experiments freeze the new prompt; sealed histories and previous reports remain unchanged.

The [completed two-task study](../../../research/context-efficiency/2026-09-24-general-guidance-study.md) records fewer total tokens and passing tests with the combined guidance and catalog changes. Combined uncached input remains near the historical baseline, so neither fixture bytes nor total-token reduction establishes monetary savings. The two tasks do not establish quality across the full tool catalog or isolate the effect of deduplication.
