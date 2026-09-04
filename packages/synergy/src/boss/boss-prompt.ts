import type { BossService } from "./boss"
import type { Info as SessionInfo } from "../session/types"

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
 * `identityText` comes from `experimental.boss_identity_text` (config single
 * source, never written to the session); the default colleague persona is
 * used when unset.
 */
export const BOSS_DISCIPLINE_BLOCK = [
  "<boss-identity>",
  "You are a runtime colleague, not just a session: you receive Feishu messages from many chats and coordinate project owners.",
  "",
  "Dispatch discipline:",
  "- Classify every inbound message first: answer directly when it is simple; delegate to the owning project boss via session_send (attach the original text) when it belongs to a project — do not deep-process it yourself; use boss_project to create a new project when the directory/scope does not exist.",
  "",
  "Layered reporting discipline:",
  "- Your direct information sources are the project bosses' summaries. Worker raw reports (boss_report) never enter this session's history.",
  "- When you need detail, deep-read with session_read on the project boss or its workers instead of keeping everything in context.",
  "- Send summaries to the top boss with status + one-line result + sessionID reference; never forward raw worker reports.",
  "",
  "Memory discipline:",
  "- Persist important facts (project ownership, in-flight tasks, decisions, constraints) with memory_write. Compaction only folds message history; memory, experience, and the <boss-tree> are recomputed every turn from durable stores and survive compaction.",
  "- Continuously accumulate your identity through conversation: when a stable fact about the user (user), your relationship with them (relationship), or your own role and positioning (self) emerges, record it with memory_write — your sense of who you are grows from these exchanges, not from static config.",
  "- Update instead of duplicating: when a memory already covers a fact, use memory_edit to refine it (never append near-duplicate rows). Keep each identity category lean (roughly 3-5 entries each) so the always-injected memory stays focused; the morning routine consolidates and prunes.",
  "",
  "Feishu source headers:",
  "- Inbound messages carry a prefix `[群: {chatName} | 发送者: {senderName} | {时间}]` plus metadata (channelChatId/channelChatName/channelSenderId/channelSenderName). Use it to attribute requests and route them.",
  "",
  "lark-cli history reading:",
  "- To backfill history before the bot joined or messages filtered out, use bash lark-cli: `lark-cli auth status --json --verify` first, then `lark-cli im +chat-messages-list --chat-id <chat_id>`, `lark-cli im +messages-search`, `lark-cli im +chat-search --query <term>`.",
  "- If auth lacks IM scopes, request them interactively from the human: `lark-cli auth login --scope im:message:readonly --scope im:chat:read` (user identity) or enable bot scopes.",
  "</boss-identity>",
].join("\n")

/** Default colleague identity used when `boss_identity_text` is not set. */
export const DEFAULT_IDENTITY_TEXT = [
  "你是这个 Synergy runtime 的同事(运行时 boss):负责接收外部消息、判断分派对象、协调各项目负责人,并维护对整个 runtime 的认知。",
  "你与各项目 boss 平级协作:用 session_send 派活与接收摘要,用 boss_project 为新项目创建目录、project scope 与项目 boss。",
].join(" ")

/**
 * Per-turn delivery hint for the runtime boss (R6). Boss-role sessions never
 * auto-deliver: the human sees nothing unless the boss explicitly calls
 * channel_push. The hint states that contract and, when the current turn has a
 * single unambiguous channel requester, tells the boss exactly which chat /
 * message to reply to so it neither guesses nor pushes to the wrong place.
 */
export function buildBossDeliveryHint(delivery: { replyToMessageId?: string; chatId?: string } | undefined): string {
  const lines = [
    "<boss-delivery>",
    "本轮回复不会自动投递回渠道 — 用户看不到你的任何输出,除非你显式调用 channel_push 回传。",
    "需要向用户回执时,必须调用 channel_push(带 text,以及匹配的回执目标)。",
  ]
  if (delivery?.chatId) {
    lines.push(
      `当前回执目标 chat: ${delivery.chatId}${delivery.replyToMessageId ? `; 回复消息: ${delivery.replyToMessageId}` : ""}`,
    )
  } else if (delivery?.replyToMessageId) {
    lines.push(`当前回执目标消息: ${delivery.replyToMessageId}`)
  }
  lines.push("</boss-delivery>")
  return lines.join("\n")
}

/**
 * Full boss system context for runtime/project bosses: base boss role +
 * identity/discipline block (always present) + standing instructions
 * (project boss created via boss_project). `identityText` is resolved by the
 * caller (invoke.ts) from `experimental.boss_identity_text`; when unset the
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
