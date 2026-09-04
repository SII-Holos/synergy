# Decision Record: MCP group directory in the expand_tools description

Status: implemented
Archived: 2026-09-04

## Problem

When the total number of connected MCP tools reaches `MCP_DEFER_THRESHOLD` (100), every MCP tool is folded behind a `mcp:<server>` group. Built-in deferred groups (note/session/agenda/browser, …) are discoverable because the `expand_tools` description statically lists them; MCP groups were absent from that list, so the model had zero awareness that a configured MCP server existed. Agents therefore kept calling the only visible search tool (`websearch`) even when it repeatedly returned no results, never discovering `mcp:anysearch` and similar servers.

## Decision

`expand_tools` now appends a dynamic "Connected MCP groups" section to its tool description whenever the defer threshold is active and at least one MCP server is connected:

- `MCP.deferredGroupCatalog()` (`packages/synergy/src/mcp/index.ts`) reads the supervisor's cached `toolDefs` directly — no `dynamicTool` conversion, no network calls — and returns `{ totalTools, servers: [{ serverName, toolNames }] }` for connected servers with at least one tool.
- `ToolExposure.mcpGroupTable()` (`packages/synergy/src/tool/exposure.ts`) renders the same three-column markdown shape as the built-in `groupTable()`, one row per server: group id (`mcp:<server>` via `mcpGroupID`), server name, tool count, up to six tool names, and an `expand_tools({groups:["mcp:<server>"]})` hint. Rows are capped at 10 servers and 6 tool names with `… and N more` summaries.
- The section renders only when `totalTools >= MCP_DEFER_THRESHOLD` (the condition that actually defers MCP tools) and is omitted entirely (heading included) when no servers are connected. Failure to read the catalog degrades to an empty section.
- The description is built inside the async `Tool.define` factory, so it refreshes on every `ToolRegistry.tools()` pass — main sessions and Cortex subagent sessions both see the directory.
- No permission, exposure-mode, `search_tools`, `session.toolState`, config, persisted-state, SDK, or plugin-API semantics changed. This is a discovery-only change; `expand_tools` execution still fails closed on permission-denied groups.

## Alternatives considered

- **Injecting the directory into the system prompt environment on every turn** — rejected: fixed per-turn token cost even when unused, and a second maintenance surface for the same information; the `expand_tools` description is the natural discovery location and costs tokens only when the model reads it.
- **Adding the directory to the `search_tools` description** — rejected: `search_tools` is the on-demand query path; keeping it single-purpose preserves its role.
- **Reusing `ToolDiscovery.collect()` inside the description build** — rejected: `collect()` calls `ToolRegistry.tools()` → `expand_tools.init()`, which would recurse infinitely. The catalog must read the MCP supervisor directly.
- **Reusing `MCP.toolEntries()` as the data source** — rejected: it converts every tool to a `dynamicTool` and builds input schemas, a significant per-init cost for 100+ tools; the cached `toolDefs` already hold everything needed.
- **Filtering the directory by session expansion state** — rejected: the description is built without session context (init receives only `{ agent }`), and the built-in table is unconditional too; listing already-expanded groups is harmless.

## Consequences

- Models can discover deferred MCP servers from the `expand_tools` description in both main and subagent sessions, and can expand them directly with the printed group id — the described fix for the "agent keeps calling websearch" gap.
- Token cost is bounded: at most ~10 table rows, ~6 tool names each, only when the model reads the `expand_tools` description.
- The `expand_tools` tool schema changes when MCP server composition changes (prompt-cache invalidation for that tool only); MCP composition changes are infrequent and the rest of the tool set is unaffected.
- The description may list servers whose tools are permission-denied for a particular agent; the existing fail-closed expansion path and the "may still be hidden" disclaimer keep this informational only.
