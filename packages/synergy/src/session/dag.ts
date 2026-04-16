import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import z from "zod"
import { Storage } from "../storage/storage"
import { StoragePath } from "@/storage/path"
import { Identifier } from "../id/id"
import { SessionManager } from "./manager"
import { Scope } from "@/scope"

export namespace Dag {
  const { asSessionID } = Identifier
  export const VALID_STATUSES = ["pending", "running", "completed", "failed", "cancelled"] as const
  export type Status = (typeof VALID_STATUSES)[number]

  export const VALID_ASSIGNS = ["self", "master", "explore", "scout", "scholar", "scribe", "advisor"] as const
  export type Assign = (typeof VALID_ASSIGNS)[number]

  export const VALID_TRANSITIONS: Record<Status, Status[]> = {
    pending: ["running", "cancelled"],
    running: ["completed", "failed", "cancelled"],
    completed: [],
    failed: ["pending"],
    cancelled: ["pending"],
  }

  export const Node = z
    .object({
      id: z.string().describe("Unique identifier for the node"),
      content: z.string().describe("Brief description of the task"),
      status: z.string().describe("Current status: pending, running, completed, failed, cancelled"),
      deps: z.array(z.string()).describe("IDs of nodes this depends on. Empty array for root nodes"),
      assign: z
        .string()
        .optional()
        .describe("Suggested executor: self, master, explore, scout, scholar, scribe, advisor"),
    })
    .meta({ ref: "DagNode" })
  export type Node = z.infer<typeof Node>

  export const Event = {
    Updated: BusEvent.define(
      "dag.updated",
      z.object({
        sessionID: z.string(),
        nodes: z.array(Node),
        ready: z.array(z.string()),
      }),
    ),
  }

  export async function update(input: { sessionID: string; nodes: Node[] }) {
    const ready = computeReady(input.nodes)
    const session = await SessionManager.requireSession(input.sessionID)
    const scopeID = Identifier.asScopeID((session.scope as Scope).id)
    await Storage.write(StoragePath.sessionDag(scopeID, asSessionID(input.sessionID)), input.nodes)
    Bus.publish(Event.Updated, { sessionID: input.sessionID, nodes: input.nodes, ready })
  }

  export async function get(sessionID: string) {
    const session = await SessionManager.requireSession(sessionID)
    const scopeID = Identifier.asScopeID((session.scope as Scope).id)
    return Storage.read<Node[]>(StoragePath.sessionDag(scopeID, asSessionID(sessionID)))
      .then((x) => x || [])
      .catch(() => [])
  }

  export function computeReady(nodes: Node[]): string[] {
    const completed = new Set(nodes.filter((n) => n.status === "completed").map((n) => n.id))
    return nodes.filter((n) => n.status === "pending" && n.deps.every((d) => completed.has(d))).map((n) => n.id)
  }

  export function autoPromote(nodes: Node[]): string[] {
    const completed = new Set(nodes.filter((n) => n.status === "completed").map((n) => n.id))
    const promoted: string[] = []
    for (const node of nodes) {
      if (node.status === "pending" && node.deps.every((d) => completed.has(d))) {
        node.status = "running"
        promoted.push(node.id)
      }
    }
    return promoted
  }

  export interface ValidationResult {
    valid: boolean
    errors: string[]
    warnings: string[]
    fixes: string[]
    nodes: Node[]
  }

  export function validate(nodes: Node[], previous?: Node[]): ValidationResult {
    const result: ValidationResult = { valid: true, errors: [], warnings: [], fixes: [], nodes: structuredClone(nodes) }

    if (result.nodes.length === 0) {
      result.errors.push("DAG is empty — at least one node is required")
      result.valid = false
      return result
    }

    // --- Layer 1: Duplicate IDs (hard error) ---
    const idCount = new Map<string, number>()
    for (const node of result.nodes) {
      idCount.set(node.id, (idCount.get(node.id) ?? 0) + 1)
    }
    const duplicates = [...idCount.entries()].filter(([, count]) => count > 1).map(([id]) => id)
    if (duplicates.length > 0) {
      result.errors.push(`Duplicate node IDs: ${duplicates.join(", ")}`)
      result.valid = false
      return result
    }

    const ids = new Set(result.nodes.map((n) => n.id))

    // --- Layer 2: Status enum validation (hard error) ---
    const validStatuses = new Set<string>(VALID_STATUSES)
    for (const node of result.nodes) {
      if (!validStatuses.has(node.status)) {
        result.errors.push(`Node "${node.id}" has invalid status "${node.status}". Valid: ${VALID_STATUSES.join(", ")}`)
        result.valid = false
      }
    }
    if (!result.valid) return result

    // --- Layer 3: Auto-fix — strip dangling deps, self-deps, invalid assign ---
    for (const node of result.nodes) {
      const originalDeps = [...node.deps]
      node.deps = node.deps.filter((dep) => {
        if (dep === node.id) {
          result.fixes.push(`Removed self-dependency on node "${node.id}"`)
          return false
        }
        if (!ids.has(dep)) {
          result.fixes.push(`Removed unknown dep "${dep}" from node "${node.id}"`)
          return false
        }
        return true
      })

      if (node.assign && !new Set<string>(VALID_ASSIGNS).has(node.assign)) {
        result.fixes.push(`Removed invalid assign "${node.assign}" from node "${node.id}" (defaulting to self)`)
        node.assign = undefined
      }
    }

    // --- Layer 4: Cycle detection via Kahn's algorithm (hard error) ---
    const cycleError = detectCycles(result.nodes)
    if (cycleError) {
      result.errors.push(cycleError)
      result.valid = false
      return result
    }

    // --- Layer 5: Evolution consistency — compare with previous DAG ---
    if (previous && previous.length > 0) {
      const allPreviousTerminal = previous.every(
        (n) => n.status === "completed" || n.status === "cancelled" || n.status === "failed",
      )
      const hasOverlap = previous.some((n) => ids.has(n.id))

      // If all previous nodes are terminal and no IDs overlap, this is a fresh DAG replacing
      // a finished one — skip evolution checks entirely.
      if (!allPreviousTerminal || hasOverlap) {
        const prevMap = new Map(previous.map((n) => [n.id, n]))

        for (const prev of previous) {
          if (prev.status === "completed" && !ids.has(prev.id)) {
            result.warnings.push(`Completed node "${prev.id}" was dropped — verify this is intentional.`)
          }
          if (prev.status === "running" && !ids.has(prev.id)) {
            result.warnings.push(`Running node "${prev.id}" was dropped. It may still be executing.`)
          }
        }

        for (const node of result.nodes) {
          const prev = prevMap.get(node.id)
          if (!prev) continue

          if (prev.status === "completed") {
            if (node.status !== "completed") {
              result.warnings.push(
                `Status of completed node "${node.id}" was changed (${prev.status} → ${node.status}). Completed nodes are usually immutable.`,
              )
            }
            if (node.content !== prev.content) {
              result.warnings.push(
                `Content of completed node "${node.id}" was modified. Completed nodes are usually immutable.`,
              )
            }
          } else {
            const validTransitions = VALID_TRANSITIONS[prev.status as Status]
            if (validTransitions && node.status !== prev.status && !validTransitions.includes(node.status as Status)) {
              result.warnings.push(
                `Unusual status transition on node "${node.id}": ${prev.status} → ${node.status}. Expected one of: ${validTransitions.join(", ")}`,
              )
            }
          }
        }
      }
    }

    if (!result.valid) return result

    // --- Layer 6: Semantic warnings ---
    const statusMap = new Map(result.nodes.map((n) => [n.id, n.status]))

    for (const node of result.nodes) {
      if (node.status === "running" || node.status === "completed") {
        for (const dep of node.deps) {
          const depStatus = statusMap.get(dep)
          if (depStatus && depStatus !== "completed") {
            result.warnings.push(
              `Node "${node.id}" is ${node.status} but dep "${dep}" is ${depStatus} (should be completed)`,
            )
          }
        }
      }

      for (const dep of node.deps) {
        const depStatus = statusMap.get(dep)
        if (node.status === "pending" && (depStatus === "failed" || depStatus === "cancelled")) {
          result.warnings.push(
            `Node "${node.id}" depends on ${depStatus} node "${dep}" — it will never become ready unless "${dep}" is retried`,
          )
        }
      }
    }

    const roots = result.nodes.filter((n) => n.deps.length === 0)
    if (roots.length === 0) {
      result.warnings.push("No root nodes found (all nodes have dependencies). Verify this is intentional.")
    }

    return result
  }

  function detectCycles(nodes: Node[]): string | undefined {
    const adj = new Map<string, string[]>()
    const inDegree = new Map<string, number>()
    for (const node of nodes) {
      adj.set(node.id, [])
      inDegree.set(node.id, 0)
    }
    for (const node of nodes) {
      for (const dep of node.deps) {
        adj.get(dep)!.push(node.id)
        inDegree.set(node.id, (inDegree.get(node.id) ?? 0) + 1)
      }
    }

    const queue: string[] = []
    for (const [id, deg] of inDegree) {
      if (deg === 0) queue.push(id)
    }

    let visited = 0
    while (queue.length > 0) {
      const current = queue.shift()!
      visited++
      for (const next of adj.get(current) ?? []) {
        const deg = inDegree.get(next)! - 1
        inDegree.set(next, deg)
        if (deg === 0) queue.push(next)
      }
    }

    if (visited !== nodes.length) {
      const cycleNodes = [...inDegree.entries()].filter(([, deg]) => deg > 0).map(([id]) => id)
      return `Circular dependency detected among nodes: ${cycleNodes.join(", ")}`
    }

    return undefined
  }
}
