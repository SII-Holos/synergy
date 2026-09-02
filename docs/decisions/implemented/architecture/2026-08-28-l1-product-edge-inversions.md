# Decision Record: S9d — clear the remaining L1→product edges via source inversions

Status: implemented

## Problem

After S8/S9a–S9c, the harness-core layering analyzer still reported 29 `L1 -> product` import edges outside the session domain (agent→{external-agent, library, plugin}, config→{holos, lsp}, enforcement→plugin, permission→plugin, provider→{holos, plugin}, scope→library, tool→{lsp, note, plugin, remote, synergy-link}, workspace-file→lsp), keeping the whole L1+product graph inside one 53-module SCC.

## Decision

Invert every non-session edge through an L1-side port plus a product-side register adapter, following the existing `ToolMcpSource`/`mcp/tool-source.ts` and `SessionToolContext`/`plugin/tool-context.ts` precedent:

- **New L1 ports (register/get registries):** `agent/plugin-source.ts`, `agent/external-source.ts` (also owns the single `ExternalAgentInfo` zod schema), `permission/plugin-source.ts`, `provider/plugin-auth-source.ts`, `scope/library-store.ts`, `tool/plugin-source.ts`, `tool/lsp-source.ts`, `tool/note-source.ts`, `tool/link-target-source.ts`, `tool/remote-error.ts` (single `SynergyLinkRemoteError` class), `workspace-file/symbol-source.ts`, `config/lsp-catalog.ts`, `control-profile/host-capability.ts` (capability→permission map).
- **Product adapters (register functions for `product-registration.ts`):** `plugin/agent-source.ts`, `plugin/permission-source.ts`, `plugin/provider-auth-source.ts`, `plugin/tool-source.ts`, `external-agent/agent-source.ts`, `note/virtual-file-source.ts`, `library/scope-migration-store.ts`, `lsp/tool-source.ts`, `lsp/workspace-symbol-source.ts`, `lsp/config-catalog.ts`, `synergy-link/tool-target-source.ts`.
- **L0 helper moves instead of ports (shared constants/pure functions):** `library/encoder-constants.ts` → `util/encoder-constants.ts`; `validateHolosEndpoint` + `SYNERGY_REFERER` canonical copies → `util/holos.ts` (holos/security.ts and holos/constants.ts re-export); `lsp/diagnostics-delta.ts` → `tool/diagnostics-delta.ts` with `tool/diagnostic-format.ts` (byte-equal `prettyDiagnostic`).
- **Kit-direct imports instead of ports:** `PluginToolId` from `@ericsanchezok/synergy-plugin/ids` in enforcement (the plugin re-export was a pure passthrough).
- **Narrow L1-local types:** `PluginApprovalCapabilities` in `enforcement/gate.ts` (only `approvedCapabilities` matters for classification; the index signature keeps full approval records and test literals assignable).
- Scope migrations keep their bodies; the three `LibraryDB` touchpoints go through `ScopeLibraryStore` (`experienceScopeIDs`, `removeExperiencesByScope`, `renameExperienceScope`).

Unregistered access degrades quietly (no plugin agents/tools, no diagnostics, symbol search reports unavailable, migrations skip library cleanup) so the L1 modules remain loadable in isolation.

## Alternatives considered

- **Moving `synergy-link-execution.ts` into the synergy-link domain** — rejected in S9a and still wrong: four L1 consumers (bash, process, and both remote backends) would each gain product imports.
- **Porting `ExternalAgentInfo` through a type-only import** — rejected: type-only imports still count as edges for the final gate, and the zod schema must stay a single instance for SDK byte-equality.
- **Rewriting the scope migrations** — rejected by the slice brief; only the LibraryDB touchpoints were ported.

## Consequences

- `bun run deps:analyze` reports `L1 -> product edges: 0` (29→0 including the parallel session-workstream edges); SCC shrinks 54→53 modules.
- Behavior is byte-equal: `prettyDiagnostic` and `matchesSettingCondition` are byte-equal copies, the `ExternalAgentInfo` schema and `SynergyLinkRemoteError` class remain single instances via re-export, and all ported call paths preserve their arguments and error shapes.
- The parent session must wire the eleven register functions into `src/product-registration.ts` (owned by the parallel workstream) before shipping; `test/session/product-source-registrations.test.ts` locks the mount contract meanwhile.
