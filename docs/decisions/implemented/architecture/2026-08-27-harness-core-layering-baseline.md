# Decision Record: Harness-core layering baseline and dependency gates

Status: implemented

## Problem

`packages/synergy/src` is a single 52-module strongly connected component: every product module (blueprint, lattice, boss flows, plugin, channel, …) is transitively reachable from the session/tool execution core and vice versa, so no directory can be tested, replaced, or evolved in isolation. The core currently holds 56 module-level import edges into product directories (session→14 product modules, tool→17, migration→8, scope→5) and 8 into assembly directories, and nothing in the toolchain notices when a new one appears. There was no dependency-rule tooling at all (no dependency-cruiser, madge, or eslint import restrictions), so the inversion grew silently through `registerBuiltins()`-style static registration points.

## Decision

Introduce a layering baseline and machine-checked rules for the harness-core refactor (S0 of the S0–S10 program):

- **Layer vocabulary** in `script/dep-analyze.ts`: L0 shared base (util/id/flag/global/asset/hashline/vector/process/stats), L1 harness-core (agent/session/tool/enforcement/permission/sandbox/control-profile/bus/scope/storage/migration/file/workspace-file/provider/config/observability/instruction), product layer (blueprint/lattice/superplan/boss/light-loop/channel/cortex/agenda/browser/library/note/mcp/plugin/plugin-runtime/holos/email/synergy-link/remote/acp/external-agent/project/question/lsp/performance/skill/command), L4 assembly (server/cli/daemon/runtime). The analyzer builds the module-level import graph (statement, side-effect, and dynamic imports; `@/` alias aware; type-only imports tracked separately), reports SCCs and layer-edge counts, and writes the committed snapshot `.deps-snapshot.json`.
- **R1** L1 must not import product modules — `warn` until S10, then `error`.
- **R2** product layer must be acyclic — `warn` until S10, then `error`.
- **R3** no product→product module pairs beyond the snapshot baseline — per-product-module allowlists are derived from `.deps-snapshot.json` (single source of truth); new composition pairs require a deliberate `bun run deps:snapshot` refresh.
- **R4** split by measured reality: L0→product/assembly is `error` from day one (zero violations at baseline); L0→L1 uplift (15 existing edges: util/process/hashline/vector importing scope/session/config/observability) is a recorded `warn` baseline for S10 review — the Blueprint's "R4 already holds" claim was wrong for the L1 direction and the rule follows the evidence.
- **Wiring**: root `package.json` gains `deps:analyze`, `deps:snapshot`, `deps:check` scripts, the `dependency-cruiser` devDependency, and `deps:check` joins the `ci-static` gate cluster (exits 0 while rules are advisory).

Baseline (recorded in `.deps-snapshot.json`): 61 modules, 967 files, one SCC of 52 modules, L1→product 56 edges, L1→assembly 8, product→product 36 pairs.

**Edge budget by slice** (module-level L1→product edge count; the S2–S5 vertical slices move files and invert their call sites in the same commit, so edges go down without a transient rise):

| Slice                                      | Expected L1→product                        |
| ------------------------------------------ | ------------------------------------------ |
| S0 baseline                                | 56                                         |
| S1 migration registry                      | 48 (−8 migration→product)                  |
| S2 boss vertical                           | 46 (−session/tool boss edges)              |
| S3 light-loop vertical                     | 43                                         |
| S4 blueprint vertical                      | 40                                         |
| S5 lattice vertical                        | 34                                         |
| S6 workflow-kind registry                  | 33                                         |
| S7 instruction unification                 | 28 (−session→skill/command, scope→command) |
| S8 tool partition + ToolExecutionContext   | ≤ 10 (tool/session residuals)              |
| S9 startup contributions + scattered edges | 0                                          |
| S10 gates                                  | 0 (R1/R2 flip to error)                    |

## Alternatives considered

- **madge or eslint `no-restricted-imports`** — rejected: neither combines per-layer reachability, circular detection, tsconfig path-alias resolution, and a committed snapshot ratchet; dependency-cruiser provides all four and its config can be generated from the snapshot.
- **Gate R1/R2 as errors immediately** — rejected: the baseline is red by definition (56 edges, one giant SCC); a ratchet-first design keeps CI green at every safe stopping point while the S-slices drive the counts to zero, matching the program's revertability requirement.
- **Hardcode the R3 composition allowlist in `.dependency-cruiser.cjs`** — rejected after trying it: two sources of truth drifted within one work session (5 hand-picked pairs vs the 36 measured); deriving rules from the committed snapshot makes the ratchet self-consistent and refresh-visible in review.
- **Full R4 (L0 depends on nothing above) as error now** — rejected on evidence: 15 L0→L1 uplift edges exist (util/env→scope, hashline session stores→session/bus, util/log→observability, vector→config, process→scope/observability); they point only at L1, never at product or assembly, so the dangerous direction is gated immediately and the uplift baseline is surfaced for the S10 review instead of silently failing the build.

## Consequences

- Every slice PR compares `bun run deps:analyze` against this record's budget; R1/R2 stay advisory so a mid-program stop point never leaves a red CI.
- New product→product composition requires a visible snapshot refresh in the same PR; hidden additions surface as `r3-composition-*` warnings in `deps:check`.
- `ci-static` runs dependency-cruiser over ~1500 modules (~30s), accepted for machine-checked layer boundaries.
- The L0→L1 uplift baseline (15 edges) is now visible debt with an owner (S9/S10 review) instead of invisible.
