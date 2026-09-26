#!/usr/bin/env bun
/**
 * Circular dependency analyzer for TypeScript projects.
 *
 * Usage:
 *   bun script/deps.ts                          # find all cycles
 *   bun script/deps.ts --from src/session/input.ts  # trace cycles through a specific file
 *   bun script/deps.ts --chain src/session/input.ts src/session/message-v2.ts
 *                                                # show import chain between two files
 *   bun script/deps.ts --simulate src/session/input.ts
 *                                                # simulate ESM load, show which imports are partial
 */
import fs from "fs/promises"
import path from "path"
import { Glob } from "bun"

const ROOT = path.resolve(import.meta.dir, "../src")
const ALIAS: Record<string, string> = {
  "@/": ROOT + "/",
}

// ── Parse imports ──────────────────────────────────────────────────────────

const IMPORT_RE = /^import\s+(?!type\s).*?\s+from\s+["']([^"']+)["']/gm
const SIDE_EFFECT_RE = /^import\s+["']([^"']+)["']/gm
const REEXPORT_RE = /^export\s+(?!type\s)\{[^}]*\}\s+from\s+["']([^"']+)["']/gm

function extractImports(source: string): string[] {
  const specifiers = new Set<string>()
  for (const re of [IMPORT_RE, SIDE_EFFECT_RE, REEXPORT_RE]) {
    re.lastIndex = 0
    for (const m of source.matchAll(re)) {
      specifiers.add(m[1])
    }
  }
  return [...specifiers]
}

// ── Resolve specifier → absolute file path ─────────────────────────────────

async function resolveSpecifier(specifier: string, fromFile: string): Promise<string | null> {
  // Only resolve relative and aliased imports (skip node_modules / bare specifiers)
  let resolved: string | undefined
  if (specifier.startsWith(".")) {
    resolved = path.resolve(path.dirname(fromFile), specifier)
  } else {
    for (const [alias, target] of Object.entries(ALIAS)) {
      if (specifier.startsWith(alias)) {
        resolved = target + specifier.slice(alias.length)
        break
      }
    }
  }
  if (!resolved) return null

  // Try extensions and index files
  const candidates = [resolved, resolved + ".ts", resolved + ".tsx", resolved + "/index.ts", resolved + "/index.tsx"]
  for (const c of candidates) {
    if (await Bun.file(c).exists()) return c
  }
  return null
}

// ── Build full dependency graph ────────────────────────────────────────────

type Graph = Map<string, string[]>

async function buildGraph(): Promise<Graph> {
  const graph: Graph = new Map()
  const glob = new Glob("**/*.{ts,tsx}")

  for await (const entry of glob.scan({ cwd: ROOT, absolute: true })) {
    if (entry.includes("/node_modules/")) continue
    const source = await Bun.file(entry).text()
    const specifiers = extractImports(source)
    const deps: string[] = []
    for (const spec of specifiers) {
      const resolved = await resolveSpecifier(spec, entry)
      if (resolved) deps.push(resolved)
    }
    graph.set(entry, deps)
  }
  return graph
}

// ── Cycle detection (Johnson's algorithm simplified / DFS-based) ───────────

function findAllCycles(graph: Graph): string[][] {
  const cycles: string[][] = []
  const visited = new Set<string>()
  const stack = new Set<string>()
  const path: string[] = []

  function dfs(node: string) {
    if (stack.has(node)) {
      // Found a cycle – extract it
      const idx = path.indexOf(node)
      if (idx !== -1) {
        cycles.push([...path.slice(idx), node])
      }
      return
    }
    if (visited.has(node)) return

    visited.add(node)
    stack.add(node)
    path.push(node)

    for (const dep of graph.get(node) ?? []) {
      dfs(dep)
    }

    path.pop()
    stack.delete(node)
  }

  for (const node of graph.keys()) {
    dfs(node)
  }
  return cycles
}

// ── Find cycles involving a specific file ──────────────────────────────────

function cyclesThrough(cycles: string[][], file: string): string[][] {
  return cycles.filter((c) => c.some((n) => n === file))
}

// ── Find shortest path between two nodes (BFS) ────────────────────────────

function findChain(graph: Graph, from: string, to: string): string[] | null {
  const queue: string[][] = [[from]]
  const visited = new Set<string>([from])

  while (queue.length > 0) {
    const chain = queue.shift()!
    const current = chain[chain.length - 1]

    for (const dep of graph.get(current) ?? []) {
      if (dep === to) return [...chain, dep]
      if (!visited.has(dep)) {
        visited.add(dep)
        queue.push([...chain, dep])
      }
    }
  }
  return null
}

// ── Pretty printing ────────────────────────────────────────────────────────

function rel(abs: string): string {
  return path.relative(ROOT, abs)
}

function printCycle(cycle: string[], index?: number) {
  const prefix = index !== undefined ? `Cycle #${index + 1}` : "Cycle"
  const len = cycle.length - 1 // last element is duplicate of first
  console.log(`\n${prefix} (${len} files):`)
  for (let i = 0; i < cycle.length; i++) {
    const marker = i === cycle.length - 1 ? "↩ " : "→ "
    console.log(`  ${marker}${rel(cycle[i])}`)
  }
}

function printChain(chain: string[], label: string) {
  console.log(`\n${label} (${chain.length} files):`)
  for (let i = 0; i < chain.length; i++) {
    const marker = i === chain.length - 1 ? "⏹ " : "→ "
    console.log(`  ${marker}${rel(chain[i])}`)
  }
}

// ── Resolve a CLI path argument to an absolute path ────────────────────────

function resolveCLIPath(p: string): string {
  if (path.isAbsolute(p)) return p
  // Try relative to CWD first, then relative to ROOT
  const fromCwd = path.resolve(process.cwd(), p)
  const fromRoot = path.resolve(ROOT, p)
  // Prefer the one inside ROOT
  if (fromRoot.startsWith(ROOT)) return fromRoot
  return fromCwd
}

// ── Simulate ESM module loading order ───────────────────────────────────────
//
// ESM evaluates modules depth-first. When a cycle is hit, the importing module
// gets the *partially initialized* exports of the cycled module. This simulator
// walks the graph in DFS order (matching real ESM semantics) and, for a given
// target file, reports exactly which of its imports are fully initialized vs
// partially initialized at the time it runs.

interface LoadSimResult {
  order: string[] // files in the order they finish evaluating
  log: { file: string; dep: string; status: "ok" | "partial" | "missing" }[]
}

function simulateLoad(graph: Graph, entrypoint: string, target: string): LoadSimResult {
  const evaluated = new Set<string>() // modules that finished evaluating
  const evaluating = new Set<string>() // modules currently in their evaluation stack
  const order: string[] = []
  const log: LoadSimResult["log"] = []

  function evaluate(file: string) {
    if (evaluated.has(file)) return
    if (evaluating.has(file)) return // cycle — already in stack, partially initialized

    evaluating.add(file)
    const deps = graph.get(file) ?? []

    for (const dep of deps) {
      if (file === target) {
        // Record the state of each import at the time `target` is being evaluated
        if (evaluated.has(dep)) {
          log.push({ file: rel(file), dep: rel(dep), status: "ok" })
        } else if (evaluating.has(dep)) {
          log.push({ file: rel(file), dep: rel(dep), status: "partial" })
        } else {
          // Not yet visited — will be evaluated now (depth-first), so it will be "ok"
          // unless it itself has a cycle back. We'll evaluate it first.
          evaluate(dep)
          if (evaluated.has(dep)) {
            log.push({ file: rel(file), dep: rel(dep), status: "ok" })
          } else {
            log.push({ file: rel(file), dep: rel(dep), status: "partial" })
          }
          continue
        }
      }
      evaluate(dep)
    }

    evaluating.delete(file)
    evaluated.add(file)
    order.push(file)
  }

  evaluate(entrypoint)
  return { order, log }
}

// Find all possible entrypoints that can reach `target`
function findEntrypoints(graph: Graph, target: string): string[] {
  // Reverse graph
  const reverse = new Map<string, string[]>()
  for (const [node, deps] of graph) {
    for (const dep of deps) {
      if (!reverse.has(dep)) reverse.set(dep, [])
      reverse.get(dep)!.push(node)
    }
  }
  // Find all files that can reach `target` (these are potential entrypoints)
  // But we want root-level entrypoints (files nobody imports)
  const imported = new Set<string>()
  for (const deps of graph.values()) {
    for (const d of deps) imported.add(d)
  }
  const roots = [...graph.keys()].filter((k) => !imported.has(k))
  // Among roots, find those that can reach `target`
  return roots.filter((root) => {
    const visited = new Set<string>()
    const queue = [root]
    while (queue.length > 0) {
      const n = queue.shift()!
      if (n === target) return true
      if (visited.has(n)) continue
      visited.add(n)
      for (const dep of graph.get(n) ?? []) queue.push(dep)
    }
    return false
  })
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2)
  console.log("Building dependency graph...")
  const graph = await buildGraph()
  console.log(`Scanned ${graph.size} files\n`)

  const fromIdx = args.indexOf("--from")
  const chainIdx = args.indexOf("--chain")
  const simIdx = args.indexOf("--simulate")

  if (simIdx !== -1) {
    // --simulate <target> [--entry <entrypoint>]
    const target = resolveCLIPath(args[simIdx + 1])
    const entryIdx = args.indexOf("--entry")
    let entrypoints: string[]
    if (entryIdx !== -1) {
      entrypoints = [resolveCLIPath(args[entryIdx + 1])]
    } else {
      entrypoints = findEntrypoints(graph, target)
    }

    console.log(`Simulating ESM load order for: ${rel(target)}`)
    console.log(`Found ${entrypoints.length} root entrypoint(s) that reach this file\n`)

    for (const entry of entrypoints.slice(0, 5)) {
      console.log(`━━━ Entry: ${rel(entry)} ━━━`)
      const result = simulateLoad(graph, entry, target)

      if (result.log.length === 0) {
        console.log(`  (target not reached from this entry)\n`)
        continue
      }

      const partialDeps = result.log.filter((l) => l.status === "partial")
      const okDeps = result.log.filter((l) => l.status === "ok")

      if (partialDeps.length > 0) {
        console.log(`\n  ⚠  PARTIALLY INITIALIZED imports (${partialDeps.length}):`)
        for (const l of partialDeps) {
          console.log(`     ${l.dep}  ← namespace/exports may be undefined!`)
        }
      }
      if (okDeps.length > 0) {
        console.log(`\n  ✓  Fully initialized imports (${okDeps.length}):`)
        for (const l of okDeps) {
          console.log(`     ${l.dep}`)
        }
      }

      // Show the evaluation order up to and including target
      const targetIdx = result.order.indexOf(target)
      if (targetIdx !== -1) {
        console.log(`\n  Load order (${targetIdx + 1} modules evaluated before ${rel(target)} finishes):`)
        for (let i = 0; i <= Math.min(targetIdx, 30); i++) {
          const marker = result.order[i] === target ? "→ " : "  "
          console.log(`   ${(i + 1).toString().padStart(3)}. ${marker}${rel(result.order[i])}`)
        }
        if (targetIdx > 31) console.log(`   ... (${targetIdx - 31} more)`)
      }
      console.log()
    }
    return
  }

  if (chainIdx !== -1) {
    // --chain <from> <to>
    const fromFile = resolveCLIPath(args[chainIdx + 1])
    const toFile = resolveCLIPath(args[chainIdx + 2])
    if (!graph.has(fromFile)) {
      console.error(`File not in graph: ${rel(fromFile)}`)
      process.exit(1)
    }
    const forward = findChain(graph, fromFile, toFile)
    const backward = findChain(graph, toFile, fromFile)
    if (forward) printChain(forward, `${rel(fromFile)} → ${rel(toFile)}`)
    else console.log(`No path from ${rel(fromFile)} to ${rel(toFile)}`)
    if (backward) printChain(backward, `${rel(toFile)} → ${rel(fromFile)}`)
    else console.log(`No path from ${rel(toFile)} to ${rel(fromFile)}`)
    return
  }

  console.log("Detecting cycles...")
  const cycles = findAllCycles(graph)

  if (fromIdx !== -1) {
    // --from <file>
    const file = resolveCLIPath(args[fromIdx + 1])
    const matching = cyclesThrough(cycles, file)
    console.log(`Found ${matching.length} cycle(s) through ${rel(file)}:`)
    // Sort by length (shortest = most direct)
    matching.sort((a, b) => a.length - b.length)
    for (let i = 0; i < matching.length; i++) {
      printCycle(matching[i], i)
    }
  } else {
    // All cycles
    if (cycles.length === 0) {
      console.log("No circular dependencies found! 🎉")
    } else {
      // Deduplicate: normalize cycle by rotating to smallest element
      const seen = new Set<string>()
      const unique: string[][] = []
      for (const cycle of cycles) {
        const nodes = cycle.slice(0, -1) // remove duplicate tail
        const minIdx = nodes.indexOf(nodes.reduce((a, b) => (a < b ? a : b)))
        const rotated = [...nodes.slice(minIdx), ...nodes.slice(0, minIdx), nodes[minIdx]]
        const key = rotated.map(rel).join(" → ")
        if (!seen.has(key)) {
          seen.add(key)
          unique.push(rotated)
        }
      }
      // Sort: shortest first
      unique.sort((a, b) => a.length - b.length)
      console.log(`Found ${unique.length} unique cycle(s):`)
      for (let i = 0; i < unique.length; i++) {
        printCycle(unique[i], i)
      }

      // Summary: which directories are most involved
      const dirCount = new Map<string, number>()
      for (const cycle of unique) {
        const dirs = new Set(cycle.slice(0, -1).map((f) => path.dirname(rel(f))))
        for (const d of dirs) dirCount.set(d, (dirCount.get(d) ?? 0) + 1)
      }
      console.log("\nMost affected directories:")
      const sorted = [...dirCount.entries()].sort((a, b) => b[1] - a[1])
      for (const [dir, count] of sorted.slice(0, 10)) {
        console.log(`  ${count.toString().padStart(3)} cycles  ${dir}/`)
      }
    }
  }
}

await main()
