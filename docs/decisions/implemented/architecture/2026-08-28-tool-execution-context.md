# Decision Record: Tool execution context — P9 inversion and surface tool partition

Status: implemented

## Problem

Inversion points P6 and P9 of the layering program: `session/tool-resolver.ts` (L1) statically imported five product modules (`@/mcp`, `@/plugin`, `plugin/capability`, `plugin/consent/approval-store`, `plugin/loader`, plus `provider/transform`) for MCP tool entries, plugin gate data, plugin tool hooks, contribution degradation, and blueprint review/stop access — the R1 gate could not reach zero with these edges present. In parallel, 21 surface-domain tools (agenda ×7, note ×7, email ×2, channel ×5) still lived in `src/tool/`, forcing L1 to import five product domains just to register them.

## Decision

Implement H4 as a two-commit slice (S8a tool partition, S8b P9 context inversion):

- **S8a — surface tool partition**: the 21 tools moved into their owning domains (`agenda/tools/`, `note/tools/`, `email/tools/`, `channel/tools/`) with domain `tools.ts` registration modules calling `ToolRegistry.registerToolProvider`, exactly the boss/lattice precedent. The static builtin array in `tool/registry.ts` keeps only harness-core tools; `gen-tool-catalog.ts` now harvests both `<domain>/register.ts` and the new `<domain>/tools.ts` modules so `docs/reference/tools.md` stays generated, not hand-edited.
- **S8b — ToolExecutionContext (P9)**: two L1 registries replace the resolver's product imports. `session/tool-context.ts` (`SessionToolContext`) carries the plugin source — gate option filling (`registeredPluginTools`/`pluginToolCapabilities`/`pluginApprovals` on `GateOptions`), `tool.execute.before/after` hook triggering, and schema-degradation marking — plus the blueprint access adapter (review-tool eligibility, loop-stop eligibility). `tool/mcp-source.ts` (`ToolMcpSource`) carries MCP tool entries, per-tool call timeouts, and the deferred-group catalog. Product adapters (`plugin/tool-context.ts`, `blueprint/tool-access.ts`, `mcp/tool-source.ts`) register the concrete implementations through `product-registration.ts`, the same L4 manifest every entry point loads.
- **Degradation semantics**: an unregistered source degrades quietly — no plugin gate data (matching a host with no loaded plugins), hooks pass through, blueprint checks return false, MCP entries are empty. `tool/discovery.ts` and `tool/expand-tools.ts` route their MCP reads through the same port, so the tool domain no longer imports `@/mcp`.
- **Canary**: `test/session/tool-context.test.ts` asserts the plugin source, blueprint access, and MCP source mount from the product manifest, that blueprint access denies rather than errors, and that surface tool providers drain through `ToolRegistry`.

## Alternatives considered

- **Keeping plugin consent approval data in L1 by moving the approval store** — rejected: the approval store is plugin-domain persisted state (trust tiers, grant contracts); moving it to L1 would invert the ownership the program is establishing.
- **One combined ToolExecutionContext interface for all sources** — rejected: the MCP seam is owned by the tool domain (discovery/expand also need it) while the plugin/blueprint seam is owned by the session resolver; two registries keep each seam at its owning layer instead of forcing tool↔session coupling.
- **Deferring P9 to S9** — rejected: the Blueprint marks P9 as a hard prerequisite for the R1 gate ("此项是 R1 门禁的硬性前置"); the surface tool partition without it would strand the resolver's plugin imports.
- **Migrating browser/cortex/synergy-link/project tools in this slice** — deferred to S9 scattered-edge work where their remaining importers (`browser-shared`, `synergy-link-execution`, `write-quality`) are also untangled; moving them now would just re-point the L1 edges without removing them.

## Consequences

- `session/tool-resolver.ts`, `tool/discovery.ts`, and `tool/expand-tools.ts` no longer import any product module for MCP or plugin data; blueprint access in the resolver is registry-mediated.
- Snapshot: L1→product 43→39 (removed `session→mcp`, `tool→mcp`, `tool→channel`, `tool→email`; `tool→agenda`/`tool→note` removed by the S8a moves), product pairs 40 with R3 violations 0 (`agenda→cortex` is a pre-existing dynamic import now surfaced as a baseline pair).
- `tool/registry.ts` retains imports of plugin modules for the plugin-contribution loading path itself (`fromPlugin`/`fromRuntimePlugin`); that is tool-registry composition of plugins, scheduled for the S9 assembly pass.
- Behavior is byte-equal: gate option filling, hook ordering, timeout metadata, and degradation marking all delegate to the same implementations the resolver called directly before.
