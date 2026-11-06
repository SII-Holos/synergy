# Decision Record: Consolidate classic primary tool guidance

Status: implemented

## Problem

The classic primary repeats complete subagent descriptions in its prompt and the task tool. The prompt table filters delegation visibility but does not apply the task tool's permission filtering, so denied descriptions remain in the assembled request. Its Shell guidance also recommends blocking polls without the dependency and progress conditions already expressed by the shared process tools and coding primary.

## Decision

The classic primary keeps its role, routing principles and delegation examples, and refers to the task tool for complete subagent descriptions. The task catalog remains the single permission-filtered owner of that information, extending the [single-owner guidance](2026-09-24-single-owner-tool-guidance.md) to the classic primary. The builder's existing signature is retained.

Shell guidance uses the [dependency and evidence waiting principles](../bug-fix/2026-09-24-evidence-based-process-guidance.md): continue independent work while a command runs, wait when completion gates progress and no independent work remains, and check readiness for persistent services. Explicit input requests or unexplained lack of progress warrant diagnosis; confirmed quiet work may continue. Unattended input must be known and authorized. Repeated status checks, reruns and an expired wait window do not establish progress or failure. Tool descriptions remain authoritative for parameters and host limits.

Agent names, permissions, model selection, tool exposure, the lightweight primary and file-editing tools remain unchanged. Background task notifications and full-result retrieval retain their existing contracts.

## Alternatives considered

**Keep or truncate the duplicate prompt table.** Keeping it repeats fixed input and bypasses catalog permission filtering. Truncation can lose routing distinctions; a complete description once preserves the information.

**Always block or inspect progress on every wait.** Either can serialize independent work or replace useful waiting with repeated observations. The next action depends on available work, dependencies and evidence.

**Copy the coding primary's entire prompt or tool surface.** That would change the classic execution and delegation workflow beyond the duplicated catalog and waiting principles.

## Consequences

Catalog regressions assemble each primary prompt with the initialized task description. They verify that every permitted full description appears once and denied descriptions are absent, with both unrestricted and denied-specialist fixtures. Assembled-prompt checks preserve the conditional waiting and existing background-notification contracts.

A full-composition fixture with the pinned Anthropic catalog, no MCP and initial tool exposure resolved 55 agents, seven permitted subagents and 30 tool descriptions through `Agent.list()` and `ToolResolver.definitions()`. Compared with `6f349fcd7`, the classic primary prompt plus resolved descriptions decreased from 92,832 to 91,871 UTF-8 bytes, a net reduction of 961 bytes after adding waiting conditions. Complete permitted subagent descriptions appeared exactly once.

These measurements cover that prompt and tool-description fixture only; no model-backed token, latency or task-quality improvement is inferred from these checks.
