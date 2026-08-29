# Decision Record: Lattice vertical slice — the prompt registry becomes the full session-loop lifecycle surface

Status: implemented

## Problem

The Lattice domain was the deepest harness-core coupling of the four workflow domains (inversion points P2/P3/P5/P6 applied to the lattice kind): `session/invoke.ts` held four static lattice imports and five call sites (runtime init, model-call flush at loop exit, the Layer 2.5 system block, per-turn model-call accounting), `session/workflow.ts` inlined the entire enable/disable/projection-rollback orchestration, `session/working.ts` and the workflow user wrapper carried lattice branches, `channel/command.ts` imported `LatticeError` for its conflict reply, and the three parent tools (`pathway_read`, `pathway_write`, `lattice_submit`) lived in the builtin `tool/registry.ts` array.

## Decision

Complete the lattice vertical slice (S5) by extending the H2 prompt registry into the full session-loop lifecycle surface and moving the domain in behind it:

- **S5a golden first**: `test/lattice/prompt-contract.test.ts` locks the system-block composition byte-exactly (base + mode + state + `<lattice-context>` joined by blank lines), mode swap, goal fallbacks (`requirements.goal` → `goalSeed` → sentinel), the unlimited budget sentinel, the executing-state empty block, the three agent wrapper variants, and `lattice_continuation` suppression.
- **Registry lifecycle hooks**: `WorkflowPromptRegistry.Contribution` gains `init` (runtime prepare before the loop), `finalize(sessionID, scopeID)` (counter flush at loop exit), `onModelCall(sessionID)` (per-turn accounting), `isActive(session)` (recovery detection), `enable(sessionID, input)` (workflow enable with conflict checks and rollback), `disable(sessionID)` (durable state release on `/chat`), and `workflowConflict(error)` (user-facing conflict classification). All optional; only lattice implements them today.
- **invoke.ts**: all five lattice call sites become registry fan-outs (`kinds().map(...)` for init/finalize; kind lookup for the system block and model-call record). No lattice import remains.
- **Enable/disable**: `SessionWorkflowService.enableLattice` delegates to `contribution.enable`; the moved body is unchanged (same lock — now exposed as `SessionWorkflowService.lock` — conflict checks, projection rollback, post-enable `reconcileDirect`). `setNone` releases the active kind's durable state through `contribution.disable`. `LatticeError.StateConflict` still propagates unchanged: server routes keep their 409 mapping, tests keep `.data.reason` assertions, and `channel/command.ts` maps it through `workflowConflict` with a byte-identical reply.
- **Tools**: `tool/{pathway-read,pathway-write,lattice-submit}.{ts,txt}` → `src/lattice/tools/`; the builtin array drops them and `registerLatticeDomain()` provides them via `ToolRegistry.registerToolProvider("lattice", ...)`.
- **Wrapper**: the three inline lattice builders are deleted; `WorkflowUserWrapper.build` resolves lattice through the registry exactly like boss/lightloop. The manifest's lattice legacy-bridge line is deleted; `scope/runtime.ts`'s `LatticeRuntime.init` stays for S9's StartupContribution work.

## Alternatives considered

- **Keep `enableLattice` in core and register only the prompt surface** — rejected: the enable path is where lattice owns durable state, conflict semantics, and rollback; leaving it in core keeps the largest `session→lattice` surface and defeats the slice's purpose.
- **A separate LatticeBridge-style lifecycle registry** — rejected: the lifecycle hooks are optional members of the existing H2 contribution, so no eighth registry is invented (the program caps at seven hooks).
- **Convert `LatticeError.StateConflict` to `WorkflowConflictError` at the enable boundary** — rejected: the NamedError carries structured `.data` consumed by routes (409 bodies) and tests; converting would change the error surface for a layering win the delegation already delivers.

## Consequences

- L1→product drops to 45 (`session→lattice` and `tool→lattice` removed; `scope→lattice` remains until S9). Product pairs 43→42; R3 violations 0; total analyzer warnings 190→166.
- The prompt registry is now the complete workflow lifecycle surface: policy (H1), prompts/wrappers/control-sources, init/finalize/onModelCall, enable/disable, recovery (`isActive`), and conflict classification. Core `session/` no longer contains any workflow-domain behavior beyond plan (the one core-owned kind).
- Without lattice registration, lattice sessions pass through unwrapped, `enableLattice` throws a load-the-manifest error, and recovery treats the workflow as inactive — the correct loud/quiet degradation split.
- Registry-asserting tests import `src/product-registration`; the S5a golden and the lattice tool tests exercise the registry-mediated path.
