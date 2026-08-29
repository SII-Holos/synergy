# Decision Record: Assembly edge clearance — reload executor port and infrastructure relocation

Status: implemented

## Problem

The final eight L1→assembly edges (`config→runtime`, `enforcement→server`, `file→runtime`, `observability→{daemon,server}`, `provider→runtime`, `session→server`, `tool→runtime`) kept the entire codebase inside one 53-module strongly connected component: L1 tool/config/provider files imported the L4 `runtime/reload.ts` orchestrator (which fans out to every product domain), while `managed-parent` and the daemon lock infrastructure sat in assembly directories despite having zero assembly dependencies. R1/R2 gates could not reach error severity with these edges present, and criterion 2 of the program (L1 independent of the giant component) was unmet.

## Decision

Split the reload surface by ownership and port the execution:

- **Schema and path detection move to L1 config**: `runtime/schema.ts` → `config/reload-schema.ts` (pure zod, plus `ReloadInput` and the verbatim `formatCompactReloadResult` formatter), `runtime/reload-path.ts` → `config/reload-path.ts` (imports only L0/L1: config/domain, global, scope/context, instruction/source-profile, util). `builtinSourceEditWarning` moves into `RuntimeReloadPath` with its constant.
- **`RuntimeReloadExecutor` L1 port** (`config/reload-executor.ts`): carries both `reload` and `reloadGlobal` entry points — their semantics differ (`includePrerequisites`/`useCurrentDirectory` forcing) and collapsing them would not be byte-equal. The port's `ReloadOptions.configChange` uses the real `Config.Change` type (config is L1). Unregistered access returns a synthetic success parsed through `ReloadResult` with an explicit "runtime reload executor not registered" warning. The L4 manifest registers both slots delegating to `RuntimeReload.reload/reloadGlobal`.
- **`runtime/reload.ts` remains the L4 facade**: same public surface (Target/Scope/Result re-exports, `formatCompactResult`, `builtinSourceEditWarning` delegate to the L1 homes); the orchestration body is unchanged.
- **Zero-dependency infrastructure relocates to L0**: `server/managed-parent.ts` → `util/managed-parent.ts` (no imports at all), `daemon/paths.ts` → `util/daemon-paths.ts` (imports only Global), `daemon/server-process-lock.ts` → `util/server-process-lock.ts` (imports only the paths module and node builtins). This also keeps R4 clean: no L0 module imports product or assembly.
- **L1 consumers rewired**: tool write paths (edit/revise-file/write/save-file/resolve-conflicts) detect targets via `RuntimeReloadPath` and reload via the executor port; the `runtime_reload` tool builds parameters from `config/reload-schema`; `file/watcher.ts` and `provider/{auth-recovery,catalog}.ts` — dynamic-import sites the static edge lists miss, discovered during implementation — route through the same port; `enforcement/policy-worker/runner.ts` and `session/agent-turn/runner.ts` import `util/managed-parent`; `observability/diagnostics.ts` reads the daemon lock through util.

## Alternatives considered

- **Keeping the L1→assembly edges as a documented baseline** — rejected: the Blueprint's acceptance criterion 2 requires L1 outside the giant component; a baseline would have made R1/R2 error promotion impossible.
- **Moving `runtime/reload.ts` itself into L1** — rejected: it is the fan-out orchestrator importing every product domain; that is assembly work by definition.
- **One executor slot with flag normalization** — rejected during implementation: `reloadGlobal` deliberately skips prerequisite forcing and current-directory resolution; routing it through `reload` changes behavior.

## Consequences

- `deps:analyze`: L1→product 0, L1→assembly 0, R3 0. The historical SCC(53) decomposes into SCC(25) (core layer, closed only through L0 uplift baselines), SCC(20) (product layer), SCC(2) (command/project) — the product-layer cycles are addressed by the follow-up S10b record.
- Subprocess-style test fixtures that import `server/server` rather than `server/runtime` never load the product manifest; any port they exercise must be registered inside the fixture (established for `provider/fixtures/models-runtime-offline.ts`).
- L4 server/CLI/daemon files may keep importing `runtime/reload` directly (L4→L4 is allowed); `runtime/reload.ts` is the deliberate facade with no other shim left behind.
