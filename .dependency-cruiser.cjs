/**
 * Harness-core layering rules (Blueprint: Harness-Core 分层重构 S0–S10).
 *
 * R1  L1 harness-core must not import product or assembly   (error since S10)
 * R2  product layer must be acyclic.                            (error since S10)
 * R3  no product→product module pairs beyond .deps-snapshot.json (warn; snapshot is
 *     recorded/refreshed by `bun run deps:snapshot`).
 * R4  L0 shared base must not depend on any upper layer.        (error from day one)
 *
 * Paths in from/to conditions are matched against module paths relative to the
 * repository root (e.g. "packages/synergy/src/session/index.ts").
 */
const fs = require("node:fs")
const path = require("node:path")

const SRC_PREFIX = "packages/synergy/src/"
const L1 = `^${SRC_PREFIX}(agent|session|tool|enforcement|permission|sandbox|control-profile|bus|scope|storage|migration|file|workspace-file|provider|config|observability|instruction)/`
const PRODUCT_MODULES = [
  "blueprint",
  "lattice",
  "superplan",
  "boss",
  "light-loop",
  "channel",
  "cortex",
  "agenda",
  "browser",
  "library",
  "note",
  "mcp",
  "plugin",
  "plugin-runtime",
  "holos",
  "email",
  "synergy-link",
  "remote",
  "acp",
  "external-agent",
  "project",
  "question",
  "lsp",
  "performance",
  "skill",
  "command",
]
const L0 = `^${SRC_PREFIX}(util|id|flag|global|asset|hashline|vector|process|stats)/`
const PRODUCT = `^${SRC_PREFIX}(${PRODUCT_MODULES.join("|")})/`

function loadSnapshot() {
  const file = path.resolve(__dirname, ".deps-snapshot.json")
  if (!fs.existsSync(file)) return { productInternalPairs: [] }
  return JSON.parse(fs.readFileSync(file, "utf8"))
}

const snapshot = loadSnapshot()
const baselinePairs = new Set((snapshot.productInternalPairs ?? []).map(([from, to]) => `${from}->${to}`))

// R3: one rule per product module. Same-module imports are never violations;
// beyond that only the module's baseline composition targets are allowed.
const r3Rules = PRODUCT_MODULES.map((from) => {
  const allowed = [...baselinePairs]
    .filter((pair) => pair.startsWith(`${from}->`))
    .map((pair) => pair.split("->")[1])
    .sort()
  const permitted = [from, ...allowed]
  return {
    name: `r3-composition-${from}`,
    comment: `product composition allowlist for ${from}: ${allowed.join(", ") || "(none beyond self)"}`,
    severity: "warn",
    from: { path: `^${SRC_PREFIX}${from}/` },
    to: {
      path: PRODUCT,
      pathNot: `^${SRC_PREFIX}(${permitted.join("|")})/`,
    },
  }
})
module.exports = {
  forbidden: [
    {
      name: "r1-core-no-product",
      comment: "L1 harness-core directories must not import product or assembly modules",
      severity: "error",
      from: { path: L1 },
      to: {
        path: `^${SRC_PREFIX}(${PRODUCT_MODULES.join("|")}|server|cli|daemon|runtime)/`,
      },
    },
    {
      name: "r2-product-acyclic",
      comment: "product layer must stay acyclic",
      severity: "error",
      from: { path: PRODUCT },
      to: { path: PRODUCT, circular: true },
    },
    ...r3Rules,
    {
      name: "r4-l0-no-product-or-assembly",
      comment: "L0 shared base must never depend on product or assembly layers",
      severity: "error",
      from: { path: L0 },
      to: { path: `^${SRC_PREFIX}(${PRODUCT_MODULES.join("|")}|server|cli|daemon|runtime)/` },
    },
    {
      name: "r4-l0-core-uplift-baseline",
      comment:
        "L0→L1 uplift edges are a recorded baseline (util/process/hashline/vector import scope/session/config); tracked for S10 review, not gated",
      severity: "warn",
      from: { path: L0 },
      to: { path: L1 },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsConfig: { fileName: path.resolve(__dirname, "packages/synergy/tsconfig.json") },
  },
}
