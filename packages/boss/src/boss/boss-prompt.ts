import type { BossService } from "./boss"
import type { Info as SessionInfo } from "@ericsanchezok/synergy-harness/session/types"

/**
 * Boss Mode system-prompt builders. Pure functions over session state so the
 * Layer 2.5 injection in invoke.ts stays thin and the text is unit-testable.
 */
export function buildBossContext(session: SessionInfo): string {
  return [
    "<boss-context>",
    "You are the boss of a Boss Mode worker tree — the human's only interface to the tree.",
    "You decide, delegate, monitor, and summarize. Use boss_spawn to create specialist workers, boss_assign to hand them tasks, boss_status to monitor the tree, and boss_cancel to stop work.",
    "Answer simple requests directly when they do not need a worker; delegate substantive execution to specialist workers and summarize their boss_report reports for the human.",
    "When a worker reports, decide the next step from the report. When a decision belongs to the human, ask the human — do not guess on their behalf.",
    "</boss-context>",
  ].join("\n")
}

/**
 * Runtime Boss Mode identity + collaboration discipline block. Injected into
 * every boss turn (Layer 2.5, `case "boss"`) when the session is the runtime
 * boss (home scope, `scope:boss` endpoint) or any project boss.
 *
 * `identityText` comes from `boss.identityText` (config single
 * source, never written to the session); the default colleague persona is
 * used when unset.
 */
export const BOSS_DISCIPLINE_BLOCK = [
  "<boss-identity>",
  "You coordinate project owners and maintain a concise view of ongoing work.",
  "Dispatch discipline: answer simple requests directly and delegate substantive execution to the responsible project owner or worker.",
  "Layered reporting discipline: use project owners’ summaries first, inspect supporting evidence when needed, and report status, result and the relevant session reference. Do not forward raw worker transcripts.",
  "</boss-identity>",
].join("\n")

/** Default colleague identity used when `boss_identity_text` is not set. */
export const DEFAULT_IDENTITY_TEXT = [
  "你是这个 Synergy runtime 的同事(运行时 boss):负责接收外部消息、判断分派对象、协调各项目负责人,并维护对整个 runtime 的认知。",
  "你与各项目负责人平级协作，派发工作、接收摘要，并在需要时建立新项目。",
].join(" ")

/**
 * Full boss system context for runtime/project bosses: base boss role +
 * identity/discipline block (always present) + standing instructions
 * (project boss created via boss_project). `identityText` is resolved by the
 * caller (invoke.ts) from `boss.identityText`; when unset the
 * default colleague persona is injected instead, so the discipline block is
 * unconditionally present every turn. `instructions` come from
 * `workflow.instructions` (project-boss reporting discipline).
 */
export function buildRuntimeBossContext(
  session: SessionInfo,
  options: { identityText?: string; instructions?: string; reportStyle?: string },
): string {
  const lines = [buildBossContext(session)]
  const identity = options.identityText?.trim() || DEFAULT_IDENTITY_TEXT
  lines.push("", BOSS_DISCIPLINE_BLOCK, "", `<boss-persona>\n${identity}\n</boss-persona>`)
  const reportStyle = options.reportStyle?.trim()
  if (reportStyle) {
    lines.push("", `<boss-report-style>\n${reportStyle}\n</boss-report-style>`)
  }
  const instructions = options.instructions?.trim()
  if (instructions) {
    lines.push("", "Standing instructions from your coordinator:", instructions)
  }
  return lines.join("\n")
}

export function buildWorkerContext(session: SessionInfo): string {
  const workflow = session.workflow?.kind === "boss" ? session.workflow : undefined
  const workerRole = workflow?.workerRole ?? "general"
  const rootID = workflow?.rootID ?? session.id
  const instructions = workflow?.instructions?.trim()
  const lines = [
    "<boss-worker-context>",
    `You are a ${workerRole} specialist worker in a Boss Mode worker tree rooted at session ${rootID}.`,
    "Tasks are dispatched to you through your inbox. Complete each assigned task, then call boss_report with a summary and status.",
    'Use status "completed" when done, "blocked" when you are stuck, and "needs_input" when you need a decision.',
    "When child workers report to you, handle their reports or summarize them upward to your parent.",
    "You do not contact the human directly — report to your parent with boss_report.",
  ]
  if (instructions) {
    lines.push("", "Standing instructions from your boss:", instructions)
  }
  lines.push("</boss-worker-context>")
  return lines.join("\n")
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

/** Count every worker node in the subtree (recursive). */
export function countWorkers(node: BossService.BossTreeNode): number {
  let count = node.role === "worker" ? 1 : 0
  for (const child of node.children) count += countWorkers(child)
  return count
}
