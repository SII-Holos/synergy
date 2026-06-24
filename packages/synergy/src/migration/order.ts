import type { Migration } from "./types"
import { NamedError } from "@ericsanchezok/synergy-util/error"
import z from "zod"

export const CycleError = NamedError.create("MigrationCycleError", z.object({ cycle: z.array(z.string()) }))

/**
 * Three-tier ordering:
 * 1. Topological (dependsOn) — base migrations before dependents
 * 2. Semver (version) — optionally-specified version ordered ascending
 * 3. Lexical (id) — stable fallback
 *
 * Detects cycles in dependsOn and throws CycleError.
 */
export function orderMigrations(migrations: Migration[]): Migration[] {
  if (migrations.length <= 1) return [...migrations]

  const byId = new Map<string, Migration>()
  for (const m of migrations) {
    byId.set(m.id, m)
  }

  // Detect cycles before attempting topological sort
  detectCycles(migrations)

  // Topological sort by dependsOn
  const inDegree = new Map<string, number>()
  const adjacency = new Map<string, string[]>()

  for (const m of migrations) {
    if (!inDegree.has(m.id)) inDegree.set(m.id, 0)
    if (!adjacency.has(m.id)) adjacency.set(m.id, [])
    for (const depId of m.dependsOn ?? []) {
      if (!byId.has(depId)) continue // skip deps not in this batch
      if (!adjacency.has(depId)) adjacency.set(depId, [])
      adjacency.get(depId)!.push(m.id)
      inDegree.set(m.id, (inDegree.get(m.id) ?? 0) + 1)
    }
  }

  const queue: string[] = []
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id)
  }

  const sortedIds: string[] = []
  while (queue.length > 0) {
    // Sort queue by version then lexical before dequeuing
    queue.sort((a, b) => compareIds(byId.get(a), byId.get(b)))
    const id = queue.shift()!
    sortedIds.push(id)
    for (const neighbor of adjacency.get(id) ?? []) {
      const newDeg = (inDegree.get(neighbor) ?? 1) - 1
      inDegree.set(neighbor, newDeg)
      if (newDeg === 0) queue.push(neighbor)
    }
  }

  return sortedIds.map((id) => byId.get(id)!)
}

function detectCycles(migrations: Migration[]): void {
  const byId = new Map<string, Migration>()
  for (const m of migrations) {
    byId.set(m.id, m)
  }

  const WHITE = 0
  const GRAY = 1
  const BLACK = 2
  const color = new Map<string, number>()

  const cycle: string[] = []

  function visit(id: string): void {
    if (cycle.length > 0) return
    color.set(id, GRAY)
    const m = byId.get(id)
    for (const depId of m?.dependsOn ?? []) {
      if (!byId.has(depId)) continue
      const c = color.get(depId) ?? WHITE
      if (c === GRAY) {
        cycle.push(depId, id)
        return
      }
      if (c === WHITE) visit(depId)
      if (cycle.length > 0) {
        if (cycle[0] !== id) cycle.push(id)
        return
      }
    }
    color.set(id, BLACK)
  }

  for (const m of migrations) {
    if ((color.get(m.id) ?? WHITE) === WHITE) {
      visit(m.id)
      if (cycle.length > 0) {
        throw new CycleError({ cycle })
      }
    }
  }
}

function compareIds(a: Migration | undefined, b: Migration | undefined): number {
  if (!a && !b) return 0
  if (!a) return 1
  if (!b) return -1

  // Tier 2: version sorting
  if (a.version || b.version) {
    const cmp = compareVersions(a.version, b.version)
    if (cmp !== 0) return cmp
  }

  // Tier 3: lexical id
  return a.id.localeCompare(b.id)
}

function compareVersions(a?: string, b?: string): number {
  if (!a && !b) return 0
  if (!a) return -1
  if (!b) return 1

  const aParts = a.split(".").map(Number)
  const bParts = b.split(".").map(Number)
  const len = Math.max(aParts.length, bParts.length)

  for (let i = 0; i < len; i++) {
    const aVal = aParts[i] ?? 0
    const bVal = bParts[i] ?? 0
    if (aVal < bVal) return -1
    if (aVal > bVal) return 1
  }
  return 0
}
