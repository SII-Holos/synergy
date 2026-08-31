# Decision Record: Tool domain partition completion — surface-domain tool migration

Status: implemented

## Problem

The S8 tool partition left 35 surface-domain tool files (browser ×21 including browser-shared, cortex ×5, project ×5, question ×2, library ×5, lsp ×2, synergy-link ×1) in `src/tool/`, forcing the L1 tool module to import seven product domains just to register them, and keeping two registration gates (CLI flag for question, experimental flag for lsp) as builtin-array conditionals inside `tool/registry.ts`.

## Decision

Complete the partition following the S8a precedent exactly:

- All 35 files moved via `git mv` into their owning domains' `tools/` directories with seven new `<domain>/tools.ts` provider modules calling `ToolRegistry.registerToolProvider`, tool order preserved from the builtin array.
- The question CLI gate and lsp experimental gate moved inside their providers, evaluated per drain — byte-equal to the old builtin-array conditionals because both flags are env snapshots read at registration time in the old code and at drain time now, and drains happen after module load in every entry point.
- `tool/registry.ts` now holds only the 39 harness-core builtin tools plus the plugin-contribution loading path; the `Flag` import is gone.
- `browser-shared.ts` moved with the browser domain after verifying no L1 file imports it (the suspected importers `tool/process.ts`, `tool/resolve-conflicts.ts`, `agent/agent.ts`, `holos/runtime.ts`, `external-agent/index.ts` all import other browser modules or none).
- Deliberately left in `src/tool/`: `synergy-link-execution.ts`, `bash/remote.ts`, `process/remote.ts` (moving them would create new L1→product edges from the bash/process tools that stay), `read.ts`/`view-file.ts`/`write-quality.ts` (lsp-touch, parent port pass), and the two codex-gated image tools (no product imports).
- `script/coverage-exempt.json` path updated for the moved session-control tool; `gen-tool-catalog.ts` already harvested `<domain>/tools.ts` from S8, and the regenerated `docs/reference/tools.md` is byte-identical (pure move).

## Alternatives considered

- **Moving the remote-execution helpers into synergy-link** — rejected: four L1 consumers (`bash.ts`, `process.ts`, `bash/remote.ts`, `process/remote.ts`) would each gain a product import; the correct fix is a port during the scattered-edge slice, not a move now.
- **Keeping the flag gates in registry.ts** — rejected: the gates are tool-availability policy owned by their domains; the provider body is the established location after S8.

## Consequences

- Snapshot: L1→product edges 39→34 (tool→browser/cortex/library/project/question removed), product pairs 40→41 with `project→question` (dynamic import inside the moved session-control tool, R3-clean after snapshot refresh).
- The builtin registry array is now harness-only; every product tool registers through a provider drained by `ToolRegistry.tools()`.
- Tool ids, descriptions, parameter schemas, and exposure are unchanged; domain suites (browser/cortex/project/question/library/lsp/synergy-link) pass 658/658 and the full `test/tool/` directory 786 pass / 1 skip.
