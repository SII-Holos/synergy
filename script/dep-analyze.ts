#!/usr/bin/env bun
/**
 * Harness-core layering analyzer: module-level import graph over
 * packages/synergy/src with layer edge accounting, SCC detection, and the
 * R3 product-to-product composition allowlist check.
 *
 * Modes:
 *   bun script/dep-analyze.ts             print the layering report
 *   bun script/dep-analyze.ts --snapshot  write .deps-snapshot.json at repo root
 */
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname, resolve, relative, sep } from "node:path"

const REPO_ROOT = resolve(import.meta.dir, "..")
const SRC = join(REPO_ROOT, "packages/synergy", "src")
const SNAPSHOT_FILE = join(REPO_ROOT, ".deps-snapshot.json")

export const L1_DIRS = [
  "agent",
  "session",
  "tool",
  "enforcement",
  "permission",
  "sandbox",
  "control-profile",
  "bus",
  "scope",
  "storage",
  "migration",
  "file",
  "workspace-file",
  "provider",
  "config",
  "observability",
  "instruction",
] as const

export const L0_DIRS = ["util", "id", "flag", "global", "asset", "hashline", "vector", "process", "stats"] as const

export const L4_DIRS = ["server", "cli", "daemon", "runtime"] as const

export const PRODUCT_DIRS = [
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
] as const

/** R3 ratchet: `.deps-snapshot.json` productInternalPairs is the committed
 * baseline; `bun run deps:snapshot` refreshes it deliberately. Pairs that
 * appear without a refresh are flagged. The Blueprint's final-state
 * composition target (lattice→blueprint, blueprint→plugin, ...) is a design
 * note, not a gate. */

export type Layer = "L0" | "L1" | "product" | "L4" | "unclassified"

export function layerOf(module: string): Layer {
  if ((L0_DIRS as readonly string[]).includes(module)) return "L0"
  if ((L1_DIRS as readonly string[]).includes(module)) return "L1"
  if ((L4_DIRS as readonly string[]).includes(module)) return "L4"
  if ((PRODUCT_DIRS as readonly string[]).includes(module)) return "product"
  return "unclassified"
}

const ASSET_RE = /\.(txt|json|md|css|svg|png|jpg|wasm|node)$/
const STMT_RE = /(?:^|\n)[ \t]*(?:import|export)[ \t]+(type[ \t]+)?[$\w\s{},*]+?[ \t]*from[ \t]*["']([^"']+)["']/g
const SIDE_EFFECT_RE = /(?:^|\n)[ \t]*import[ \t]*["']([^"']+)["']/g
const DYNAMIC_RE = /\bimport[ \t]*\([ \t]*["']([^"']+)["'][ \t]*\)/g

export interface FileImports {
  specs: Set<string>
  typeOnly: Set<string>
}

export function extractImports(source: string): FileImports {
  const specs = new Set<string>()
  const typeOnly = new Set<string>()
  for (const match of source.matchAll(STMT_RE)) {
    if (ASSET_RE.test(match[2]!)) continue
    specs.add(match[2]!)
    if (match[1]) typeOnly.add(match[2]!)
  }
  for (const match of source.matchAll(SIDE_EFFECT_RE)) {
    if (!ASSET_RE.test(match[1]!)) specs.add(match[1]!)
  }
  for (const match of source.matchAll(DYNAMIC_RE)) {
    if (!ASSET_RE.test(match[1]!)) specs.add(match[1]!)
  }
  return { specs, typeOnly }
}

export function resolveSpec(fromFile: string, spec: string, srcRoot: string): string | null {
  if (spec.startsWith("@/")) return join(srcRoot, spec.slice(2))
  if (spec.startsWith(".")) return resolve(dirname(fromFile), spec)
  return null
}

export function moduleOf(srcRoot: string, file: string): string {
  return relative(srcRoot, file).split(sep)[0]!
}

export function walkSource(root: string): string[] {
  const acc: string[] = []
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry)
      const st = statSync(full)
      if (st.isDirectory()) {
        if (entry === "test" || entry === "__tests__" || entry === "node_modules" || entry === "dist") continue
        visit(full)
      } else if (
        entry.endsWith(".ts") &&
        !entry.endsWith(".d.ts") &&
        !entry.endsWith(".test.ts") &&
        !entry.endsWith(".spec.ts")
      ) {
        acc.push(full)
      }
    }
  }
  visit(root)
  return acc
}

export interface ModuleGraph {
  modules: string[]
  fileCount: Record<string, number>
  edges: Record<string, string[]>
  typeOnlyEdges: Record<string, string[]>
}

export function buildGraph(srcRoot: string): ModuleGraph {
  const edges = new Map<string, Set<string>>()
  const typeOnlyEdges = new Map<string, Set<string>>()
  const fileCount = new Map<string, number>()
  const ensure = (module: string) => {
    if (!edges.has(module)) {
      edges.set(module, new Set())
      typeOnlyEdges.set(module, new Set())
      fileCount.set(module, 0)
    }
  }
  for (const file of walkSource(srcRoot)) {
    const from = moduleOf(srcRoot, file)
    ensure(from)
    fileCount.set(from, fileCount.get(from)! + 1)
    const { specs, typeOnly } = extractImports(readFileSync(file, "utf8"))
    for (const spec of specs) {
      const resolved = resolveSpec(file, spec, srcRoot)
      if (!resolved) continue
      const rel = relative(srcRoot, resolved)
      if (rel.startsWith("..") || rel.startsWith("/") || rel === "") continue
      const to = rel.split(sep)[0]!
      if (to === from) continue
      ensure(to)
      edges.get(from)!.add(to)
      if (typeOnly.has(spec)) typeOnlyEdges.get(from)!.add(to)
    }
  }
  const record = (map: Map<string, Set<string>>) => {
    const out: Record<string, string[]> = {}
    for (const [module, targets] of [...map.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      out[module] = [...targets].sort()
    }
    return out
  }
  return {
    modules: [...edges.keys()].sort(),
    fileCount: Object.fromEntries([...fileCount.entries()].sort(([a], [b]) => a.localeCompare(b))),
    edges: record(edges),
    typeOnlyEdges: record(typeOnlyEdges),
  }
}

export function stronglyConnectedComponents(adjacency: Record<string, string[]>): string[][] {
  const nodes = [...new Set([...Object.keys(adjacency), ...Object.values(adjacency).flat()])].sort()
  const forward = new Map<string, string[]>(nodes.map((n) => [n, adjacency[n] ?? []]))
  const reverse = new Map<string, string[]>(nodes.map((n) => [n, []]))
  for (const [from, targets] of Object.entries(adjacency)) {
    for (const to of targets) reverse.get(to)!.push(from)
  }
  const visited = new Set<string>()
  const order: string[] = []
  const dfs1 = (node: string) => {
    if (visited.has(node)) return
    visited.add(node)
    for (const next of forward.get(node)!) dfs1(next)
    order.push(node)
  }
  for (const node of nodes) dfs1(node)
  const components = new Map<string, number>()
  const dfs2 = (node: string, id: number) => {
    if (components.has(node)) return
    components.set(node, id)
    for (const prev of reverse.get(node)!) dfs2(prev, id)
  }
  let id = 0
  for (const node of [...order].reverse()) {
    if (!components.has(node)) dfs2(node, id++)
  }
  const grouped = new Map<number, string[]>()
  for (const node of nodes) {
    const component = components.get(node)!
    if (!grouped.has(component)) grouped.set(component, [])
    grouped.get(component)!.push(node)
  }
  return [...grouped.values()]
    .filter((members) => members.length > 1)
    .map((members) => members.sort())
    .sort((a, b) => b.length - a.length || a[0]!.localeCompare(b[0]!))
}

export interface R3Options {
  allowlist?: ReadonlyArray<readonly [string, string]>
  productDirs?: readonly string[]
}

export function r3Violations(edges: Record<string, string[]>, options: R3Options = {}): [string, string][] {
  const allowlist = options.allowlist ?? []
  const productDirs = options.productDirs ?? PRODUCT_DIRS
  const allowed = new Set(allowlist.map(([from, to]) => `${from}->${to}`))
  const violations: [string, string][] = []
  for (const [from, targets] of Object.entries(edges)) {
    if (!productDirs.includes(from)) continue
    for (const to of targets) {
      if (!productDirs.includes(to)) continue
      if (!allowed.has(`${from}->${to}`)) violations.push([from, to])
    }
  }
  return violations.sort(([a, b], [c, d]) => a.localeCompare(c) || b.localeCompare(d))
}

function loadSnapshotPairs(): [string, string][] {
  try {
    const parsed = JSON.parse(readFileSync(SNAPSHOT_FILE, "utf8")) as { productInternalPairs?: [string, string][] }
    return parsed.productInternalPairs ?? []
  } catch {
    return []
  }
}

export interface LayeringSummary {
  totalModules: number
  totalFiles: number
  cyclicSCCs: string[][]
  l1ToProduct: [string, string][]
  l1ToAssembly: [string, string][]
  productInternalPairs: [string, string][]
  r3Violations: [string, string][]
}

export function summarize(graph: ModuleGraph): LayeringSummary {
  const pairList = (filter: (from: string, to: string) => boolean): [string, string][] => {
    const pairs: [string, string][] = []
    for (const [from, targets] of Object.entries(graph.edges)) {
      for (const to of targets) if (filter(from, to)) pairs.push([from, to])
    }
    return pairs.sort(([a, b], [c, d]) => a.localeCompare(c) || b.localeCompare(d))
  }
  return {
    totalModules: graph.modules.length,
    totalFiles: Object.values(graph.fileCount).reduce((sum, count) => sum + count, 0),
    cyclicSCCs: stronglyConnectedComponents(graph.edges),
    l1ToProduct: pairList((from, to) => layerOf(from) === "L1" && layerOf(to) === "product"),
    l1ToAssembly: pairList((from, to) => layerOf(from) === "L1" && layerOf(to) === "L4"),
    productInternalPairs: pairList((from, to) => layerOf(from) === "product" && layerOf(to) === "product"),
    r3Violations: r3Violations(graph.edges, { allowlist: loadSnapshotPairs() }),
  }
}

function printReport(summary: LayeringSummary): void {
  console.log(`modules=${summary.totalModules} files=${summary.totalFiles}`)
  console.log(`cyclic SCCs (>1 module): ${summary.cyclicSCCs.length}`)
  for (const component of summary.cyclicSCCs.slice(0, 3)) {
    console.log(`  SCC(${component.length}): ${component.slice(0, 8).join(", ")}${component.length > 8 ? " ..." : ""}`)
  }
  console.log(`L1 -> product edges: ${summary.l1ToProduct.length}`)
  for (const [from, to] of summary.l1ToProduct) console.log(`  ${from} -> ${to}`)
  console.log(`L1 -> assembly edges: ${summary.l1ToAssembly.length}`)
  for (const [from, to] of summary.l1ToAssembly) console.log(`  ${from} -> ${to}`)
  console.log(
    `product -> product edges: ${summary.productInternalPairs.length} (R3 violations: ${summary.r3Violations.length})`,
  )
  for (const [from, to] of summary.r3Violations) console.log(`  R3 ${from} -> ${to}`)
}

async function main(): Promise<void> {
  const snapshot = process.argv.includes("--snapshot")
  const graph = buildGraph(SRC)
  const summary = summarize(graph)
  printReport(summary)
  if (snapshot) {
    // Format through Prettier (the repository formatter) so generated
    // snapshots always pass format:check without manual fixups.
    const { format } = await import("prettier")
    writeFileSync(
      SNAPSHOT_FILE,
      await format(
        JSON.stringify({
          totalModules: summary.totalModules,
          totalFiles: summary.totalFiles,
          cyclicSCCs: summary.cyclicSCCs,
          l1ToProduct: summary.l1ToProduct,
          l1ToAssembly: summary.l1ToAssembly,
          productInternalPairs: summary.productInternalPairs,
          r3Violations: summary.r3Violations,
        }),
        { parser: "json" },
      ),
    )
    console.log(`snapshot written: ${relative(REPO_ROOT, SNAPSHOT_FILE)}`)
  }
}

if (import.meta.main) main()

export const __testHooks = { SRC, SNAPSHOT_FILE, mkdtemp: () => mkdtempSync(join(tmpdir(), "dep-analyze-")) }
