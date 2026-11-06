# Decision Record: Share MCP default access across Agents

Status: implemented

## Problem

Role templates begin with a closed tool set. Restricting the MCP component's default grant to research profiles prevents review and implementation agents from discovering connected sources required for their work. An inherited execution profile cannot restore a tool removed during catalog assembly, so a delegated review can lose access available to its parent.

## Decision

The MCP component contributes one unconditional `mcp__*: allow` base rule through `AgentPermissionContributions`. The rule covers every Agent assembled through the contribution mechanism and every MCP tool name, including remote writes. It depends only on selecting the MCP component. Agent identities, owners and role profiles do not select MCP access.

Explicit global and Agent configuration continue to override component defaults using existing precedence. Discovery, expansion and execution consume the existing resolved policy. Session and per-call restrictions, host policy, connection and Workspace requirements remain effective. MCP invocation retains capability classification and control-profile approval. Model-only operations retain their explicit tool sets and compaction execution restrictions. The current rules are specified in [MCP tool access](../../../architecture/execution-boundaries.md#mcp-tool-access).

## Alternatives considered

**Add review profiles to the research allowlist.** This fixes one role but leaves implementation and future roles dependent on another identity exception. A shared component capability should have one default.

**Add MCP grants to each Agent template.** This duplicates a component-owned policy across Harness definitions and makes future Agent additions another opportunity for inconsistent access.

**Bypass permission filtering for MCP inside discovery and execution.** This creates separate authorization paths and risks overriding explicit configuration. The existing base contribution already provides the required default without modifying either consumer.

## Consequences

Primary agents and subagents can discover and expand all connected MCP tools by default. Agent roles alone do not enforce read-only access to external systems; explicit policy and execution approval own those restrictions. Deferred presentation still limits model-context cost. No configuration schema, stored-session migration or new permission mechanism is required.

Component tests cover all resolved Agent roles, independent Runtimes and explicit configuration. Discovery tests exercise parent and review-child sessions under all three control profiles, including read and write tools and retained per-call restrictions. A deterministic model-loop test verifies that a review child executes an MCP call once under its inherited profile and retains expansion through compaction.
