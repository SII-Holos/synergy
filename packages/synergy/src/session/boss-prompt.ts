import type { BossService } from "./boss"
import type { Info as SessionInfo } from "./types"

/**
 * Boss Mode system-prompt builders. Pure functions over session state so the
 * Layer 2.5 injection in invoke.ts stays thin and the text is unit-testable.
 */
export function buildBossContext(session: SessionInfo): string {
  return [
    "<boss-context>",
    "You are the boss of a Boss Mode worker tree — the human's only interface to the tree.",
    "You decide, delegate, monitor, and summarize. Use boss_spawn to create specialist workers, boss_assign to hand them tasks, boss_status to monitor the tree, and boss_cancel to stop work.",
    "Do not implement tasks yourself: delegate execution to workers and summarize their boss_report reports for the human.",
    "When a worker reports, decide the next step from the report. When a decision belongs to the human, ask the human — do not guess on their behalf.",
    "</boss-context>",
  ].join("\n")
}

export function buildWorkerContext(session: SessionInfo): string {
  const workflow = session.workflow?.kind === "boss" ? session.workflow : undefined
  const workerRole = workflow?.workerRole ?? "general"
  const rootID = workflow?.rootID ?? session.id
  return [
    "<boss-worker-context>",
    `You are a ${workerRole} specialist worker in a Boss Mode worker tree rooted at session ${rootID}.`,
    "Tasks are dispatched to you through your inbox. Complete each assigned task, then call boss_report with a summary and status.",
    'Use status "completed" when done, "blocked" when you are stuck, and "needs_input" when you need a decision.',
    "When child workers report to you, handle their reports or summarize them upward to your parent.",
    "You do not contact the human directly — report to your parent with boss_report.",
    "</boss-worker-context>",
  ].join("\n")
}

export function renderBossTree(node: BossService.BossTreeNode): string {
  const lines: string[] = []
  function visit(current: BossService.BossTreeNode, indent: string): void {
    const role = current.role === "boss" ? "boss" : `worker(${current.workerRole ?? "?"})`
    const task = current.currentTask
      ? ` task: ${current.currentTask.taskID}${current.currentTask.taskTitle ? ` — ${current.currentTask.taskTitle}` : ""}`
      : ""
    lines.push(`${indent}- [${current.status}] ${current.title} (${role}, ${current.sessionID})${task}`)
    for (const child of current.children) visit(child, `${indent}  `)
  }
  visit(node, "")
  return lines.join("\n")
}
