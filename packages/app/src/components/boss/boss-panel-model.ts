import type { DagNode } from "@ericsanchezok/synergy-ui/dag-graph"

/**
 * Boss panel view model — pure functions over the BossService tree shape.
 * Kept dependency-free so it can be unit tested without a server or SDK.
 */

export type BossStatus = "running" | "queued" | "idle" | "archived"

export interface BossTreeNodeVM {
  sessionID: string
  title: string
  role: "boss" | "worker"
  workerRole?: string
  agent?: string
  status: BossStatus
  currentTask?: { taskID: string; taskTitle?: string }
  children: BossTreeNodeVM[]
}

export function flattenTree(node: BossTreeNodeVM, depth = 0): { node: BossTreeNodeVM; depth: number }[] {
  const out: { node: BossTreeNodeVM; depth: number }[] = [{ node, depth }]
  for (const child of node.children) out.push(...flattenTree(child, depth + 1))
  return out
}

export function bossNodeLabel(node: BossTreeNodeVM): string {
  if (node.role === "boss") return node.title
  return node.workerRole || node.title
}

function dagStatus(status: BossStatus): DagNode["status"] {
  if (status === "running") return "running"
  return "pending"
}

export function bossTreeToDagNodes(root: BossTreeNodeVM): DagNode[] {
  const nodes: DagNode[] = []

  const visit = (node: BossTreeNodeVM, parentSessionID?: string) => {
    nodes.push({
      id: node.sessionID,
      content: bossNodeLabel(node),
      status: dagStatus(node.status),
      deps: parentSessionID ? [parentSessionID] : [],
      assign: node.agent,
      task_id: node.currentTask?.taskID,
      session_id: node.sessionID,
    })
    for (const child of node.children) visit(child, node.sessionID)
  }

  visit(root)
  return nodes
}

export function bossTreePath(node: BossTreeNodeVM, sessionID: string): BossTreeNodeVM[] | undefined {
  if (node.sessionID === sessionID) return [node]
  for (const child of node.children) {
    const path = bossTreePath(child, sessionID)
    if (path) return [node, ...path]
  }
  return undefined
}

export function workerCount(node: BossTreeNodeVM): number {
  let count = node.role === "worker" ? 1 : 0
  for (const child of node.children) count += workerCount(child)
  return count
}

/**
 * Direct idle children of the given node. The assign route is called with the
 * panel's root as the caller and BossService only accepts direct children, so
 * nested workers are intentionally excluded from the assignment dropdown.
 */
export function directIdleWorkers(node: BossTreeNodeVM): BossTreeNodeVM[] {
  return node.children.filter((child) => child.role === "worker" && child.status === "idle")
}

export function renderTreeText(node: BossTreeNodeVM): string {
  return flattenTree(node)
    .map(({ node: n, depth }) => {
      const task = n.currentTask
        ? ` — task ${n.currentTask.taskID}${n.currentTask.taskTitle ? `: ${n.currentTask.taskTitle}` : ""}`
        : ""
      const role = n.role === "boss" ? "boss" : `worker(${n.workerRole ?? "?"})`
      const agent = n.agent ? ` [${n.agent}]` : ""
      return `${"  ".repeat(depth)}- [${n.status}] ${n.title} (${role}${agent}, ${n.sessionID})${task}`
    })
    .join("\n")
}
