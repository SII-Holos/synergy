# Decision Record: MCP servers fold by default with per-server expand-by-default opt-in

Status: implemented

## Problem

MCP tool schemas are the largest fixed prompt-injection cost in Synergy sessions. Every MCP server's tools were kept resident in the model-visible tool list whenever the total visible MCP tool count stayed below a global threshold (`MCP_DEFER_THRESHOLD = 100`, exposure.ts). A typical setup with a few large MCP servers (~90 tools) never crossed the threshold, so 60-70K tokens of tool schemas were re-sent on every cold request (new session, every Cortex subagent first turn, cache-miss turns). First-turn attribution showed 114K tokens of tool schema across 143 tools, two thirds from MCP.

## Decision

Per-server tool visibility is now controlled by an explicit `expandByDefault` boolean on each MCP server config (a `McpLifecycleFields` member, so it exists on both local and remote server schemas and can be defaulted globally via `mcpDefaults`). Semantics:

- `expandByDefault: true` → the server's tools are resident (always visible, schemas in the prompt).
- `expandByDefault: false` / unset (the default) → the server's tools are folded into an `mcp:<server>` group, discoverable via `expand_tools` / `search_tools`, and auto-expandable when the model calls a folded tool by name.

The global tool-count threshold is retired. `ToolExposure.mcpExposure(serverName, expandByDefault)` decides per server; `ToolExposure.mcpExpandByDefault(server, defaults)` resolves the flag from per-server config with `mcpDefaults` fallback. The three consumers that previously copied the threshold logic now share the per-server decision:

- `ToolResolver` (session/tool-resolver.ts): per-entry exposure during definition collection.
- `ToolDiscovery` (tool/discovery.ts): folded servers always merge into the group catalog (previously gated on the total count), so small folded servers remain expandable.
- `expand_tools` description (tool/expand-tools.ts): the "Connected MCP groups" section renders whenever folded servers exist, filtering out resident servers.

The Web settings MCP page exposes the flag as an "Expand by default" switch per server card (default off), persisted omit-when-false.

## Alternatives considered

- **Keep the global threshold, lower it to 0**: turning every MCP server into a group with no way to keep frequently used servers resident would force an extra expand round-trip per session for tools used in nearly every task.
- **Availability-layer forced groups from session config**: `forcedToolGroups` semantically means "temporarily force visible for this session shape"; it is not a per-server persisted preference, and search/expand state would misreport resident groups as inactive. Resident exposure is the honest expression of a whitelist.
- **UI-only toggle affecting only the settings card's own expand/collapse**: the settings card already has a local expand state; the user-facing need is tool visibility, not card presentation.

## Consequences

- New sessions and subagent first turns stop paying ~60-70K tokens of MCP schema for servers the task does not use; the largest lever on the instructions/tool-schema fixed injection cost (measured separately: first-turn tool schema 114K tokens, 143 tools, ~2/3 MCP).
- Users who rely on a server in every task opt it in once per server via the settings panel; its tools stay resident and cached as before.
- Folded tools remain reachable in the same turn by name through auto-expand; discovery via `expand_tools`/`search_tools` is preserved for small folded servers (the previous count gate would have hidden them from the expandable catalog).
- Servers contributed by plugins or runtimes without a `cfg.mcp` entry are not in the whitelist lookup and therefore fold by default; this is the intended default and does not error.
- Existing sessions that had manually expanded an `mcp:<server>` group keep the group ID in `toolState.expandedGroups`; harmless when the server flips to resident, and a folded server whose flag flips to false defers its tools on the next request — a config-change effect users should expect after toggling the switch (MCP reload is triggered by the config save, as with the enabled toggle).
- The generated config reference and SDK types now carry the new field; `.strict()` server schemas require the field to exist in both plugin and synergy config schemas (done in the same change).
