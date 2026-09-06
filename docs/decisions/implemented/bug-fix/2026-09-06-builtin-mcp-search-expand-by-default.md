# Decision Record: Expand builtin MCP search servers by default

Status: implemented

## Problem

The builtin anysearch/scholight remote MCP servers shipped in #1309 to replace the retired first-party `websearch`, `arxiv_search`, and `arxiv_download` tools inherit the generic MCP folding rule: `mcpExpandByDefault` reads only user config and defaults to folded. The retired first-party tools were resident, so the replacement quietly degraded every agent's first-turn surface — no search tool in the payload at all, just an `expand_tools` hint pointing at an `mcp:anysearch` group. Search went from one hop to two for every agent, not just users migrating from the retired tools.

## Decision

- `ToolExposure.mcpExpandByDefault` gains a third `builtinDefault` fallback: priority is per-server `expandByDefault` → `mcpDefaults` → `builtinDefault` → folded. Any explicit user value at either level (including explicit `false`) wins over the builtin default; only absent values fall through.
- `builtin-catalog.ts` exports `builtinServerStaged(name, userMcp)`: true when the catalog ships the server, `SYNERGY_DISABLE_BUILTIN_MCP` is off, and no user entry owns the name (full typed entry or `enabled: false` stub, per the existing shadowing rules). An apiKey-only stub keeps the builtin staged, so adding a credential never silently folds the tools.
- The staged check flows through the registered MCP tool source (P9 source inversion boundary) as `ToolMcpSource.builtinServerStaged`, and all exposure call sites pass it through: `ToolResolver`, `ToolDiscovery` (group directory and per-tool exposure), and the `expand_tools` description's folded-server table.
- The built-in stub schema gains `expandByDefault`, so `{"mcp": {"anysearch": {"expandByDefault": false}}}` folds one shipped server without taking ownership of its config. `mcpDefaults.expandByDefault: false` folds every builtin at once.

## Alternatives considered

- **Listing anysearch/scholight in `BUILTIN_GROUPS`** — rejected: that table is a static session-independent directory, while MCP groups are per-server and dynamic; merging the two models would fork exposure semantics.
- **Hardcoding the server names inside `exposure.ts`** — rejected: the L1 tool domain must not know the MCP product catalog; the staged check crosses the boundary through the registered source like `toolEntries` and `deferredGroupCatalog` already do.
- **Documentation only** (tell users to set `expandByDefault: true`) — rejected: it shifts the migration cost onto every user; the builtin catalog's job is to preserve the visibility the retired tools had.

## Consequences

anysearch/scholight tools are resident in every session again, matching the retired first-party tools' visibility; their schemas rejoin the always-billed tools payload (the cost the retired tools always paid). Folding remains one config line away per server or globally via `mcpDefaults`. Tests and CI are unaffected: the preload disables the builtin catalog, and the new `builtinServerStaged` tests assert ownership under both states of the disable switch.
