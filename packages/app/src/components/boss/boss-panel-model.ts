/**
 * Boss panel view model — pure functions over the BossService tree shape.
 * Kept dependency-free so it can be unit tested without a server or SDK.
 */

export type BossStatus = "running" | "idle" | "archived"

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

export function workerCount(node: BossTreeNodeVM): number {
  let count = node.role === "worker" ? 1 : 0
  for (const child of node.children) count += workerCount(child)
  return count
}

export function idleWorkers(node: BossTreeNodeVM): BossTreeNodeVM[] {
  const out: BossTreeNodeVM[] = []
  if (node.role === "worker" && node.status === "idle") out.push(node)
  for (const child of node.children) out.push(...idleWorkers(child))
  return out
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
