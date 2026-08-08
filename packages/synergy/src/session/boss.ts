import z from "zod"
import { Identifier } from "../id/id"
import { Agent } from "../agent/agent"
import { AgentDelegation } from "../agent/delegation"
import { Session } from "./index"
import { SessionInbox } from "./inbox"
import { SessionManager } from "./manager"
import { SessionInvoke } from "./invoke"
import { SessionInteraction } from "./interaction"

/**
 * BossService — stateless orchestration for the Boss Mode workflow
 * (`workflow.kind === "boss"`). There is no task ledger, state machine, or
 * event log: assignments and reports are SessionInbox messages (message history
 * is the ledger), and the tree is derived read-only from the session parent
 * chain. The boss agent decides routing; this service only enforces tree
 * membership and performs the inbox delivery mechanics.
 *
 * Guards are centralized here and shared by the boss_* tools and the server
 * routes: a caller must be a boss-tree member and a target must be the
 * caller's direct child in the same tree.
 */
export namespace BossService {
  export class BossError extends Error {
    constructor(
      public readonly code: string,
      message: string,
    ) {
      super(message)
      this.name = "BossError"
    }
  }

  export interface BossTreeNode {
    sessionID: string
    title: string
    role: "boss" | "worker"
    workerRole?: string
    agent?: string
    status: "running" | "queued" | "idle" | "archived"
    currentTask?: {
      taskID: string
      taskTitle?: string
    }
    children: BossTreeNode[]
  }

  export const BossTreeNodeSchema: z.ZodType<BossTreeNode> = z
    .lazy(() =>
      z.object({
        sessionID: z.string(),
        title: z.string(),
        role: z.enum(["boss", "worker"]),
        workerRole: z.string().optional(),
        agent: z.string().optional(),
        status: z.enum(["running", "queued", "idle", "archived"]),
        currentTask: z
          .object({
            taskID: z.string(),
            taskTitle: z.string().optional(),
          })
          .optional(),
        children: z.array(BossTreeNodeSchema),
      }),
    )
    .meta({ ref: "BossTreeNode", id: "BossTreeNode" })

  export interface AssignResult {
    itemID: string
    messageID: string
    created: boolean
  }

  export interface ReportResult {
    itemID: string
    messageID: string
  }

  async function requireBoss(sessionID: string): Promise<Session.Info> {
    const session = await SessionManager.getSession(sessionID)
    if (!session) throw new BossError("not_found", `Session ${sessionID} not found`)
    if (session.workflow?.kind !== "boss") {
      throw new BossError("not_boss", `Session ${sessionID} is not part of a Boss Mode tree`)
    }
    return session
  }

  function bossRootID(session: Session.Info): string | undefined {
    if (session.workflow?.kind !== "boss") return undefined
    return session.workflow.role === "boss" ? session.id : session.workflow.rootID
  }

  async function requireSession(sessionID: string): Promise<Session.Info> {
    const session = await SessionManager.getSession(sessionID)
    if (!session) throw new BossError("not_found", `Session ${sessionID} not found`)
    return session
  }

  /** Target must be the caller's direct child in the same boss tree. */
  async function assertDirectChild(caller: Session.Info, targetID: string): Promise<Session.Info> {
    const target = await requireSession(targetID)
    if (target.parentID !== caller.id) {
      throw new BossError("not_direct_child", `Session ${targetID} is not a direct child of ${caller.id}`)
    }
    if (target.workflow?.kind !== "boss" || target.workflow.role !== "worker") {
      throw new BossError("not_worker", `Session ${targetID} is not a boss worker`)
    }
    const callerRoot = bossRootID(caller)
    const targetRoot = bossRootID(target)
    if (!callerRoot || callerRoot !== targetRoot) {
      throw new BossError("tree_mismatch", `Session ${targetID} is not in the same boss tree as ${caller.id}`)
    }
    return target
  }

  function bossMetadata(from: string, to: string, extra: Record<string, unknown>): Record<string, unknown> {
    return { boss: { from, to, ...extra } }
  }

  function bossMetadataOf(
    message: { metadata?: Record<string, unknown> } | undefined,
  ): Record<string, unknown> | undefined {
    const boss = message?.metadata?.boss
    return boss && typeof boss === "object" ? (boss as Record<string, unknown>) : undefined
  }

  function buildTaskText(input: { task: string; context?: string; acceptance?: string[] }): string {
    const lines = [input.task.trim()]
    if (input.context?.trim()) lines.push("", "Context:", input.context.trim())
    if (input.acceptance && input.acceptance.length > 0) {
      lines.push("", "Acceptance criteria:")
      for (const item of input.acceptance) lines.push(`- ${item}`)
    }
    return lines.join("\n")
  }

  /**
   * Spawn a persistent specialist worker as a direct child of the caller.
   * The worker is a normal session with `workflow.kind === "boss"` and an
   * unattended interaction; its standing role label is carried in workerRole
   * and optional standing instructions are persisted in workflow.instructions.
   */
  export async function spawn(
    callerID: string,
    input: { role: string; agent?: string; instructions?: string },
  ): Promise<Session.Info> {
    const caller = await requireBoss(callerID)
    const role = input.role.trim()
    if (!role) throw new BossError("invalid_role", "role is required")
    const rootID = bossRootID(caller)
    if (!rootID) throw new BossError("not_boss", `Session ${callerID} is not part of a Boss Mode tree`)

    const agent = input.agent?.trim() || "synergy"
    const agentInfo = await Agent.get(agent).catch(() => undefined)
    if (!agentInfo) throw new BossError("unknown_agent", `Unknown agent "${agent}"`)
    if (agentInfo.hidden || !AgentDelegation.isVisibleToCaller(agentInfo, caller.agentOverride ?? "synergy")) {
      throw new BossError("agent_not_delegatable", `Agent "${agent}" is not delegatable from this session`)
    }

    const instructions = input.instructions?.trim()
    return Session.create({
      parentID: caller.id,
      title: `${caller.title} · ${role}`,
      agentOverride: agent,
      interaction: SessionInteraction.unattended("boss"),
      workflow: {
        kind: "boss",
        role: "worker",
        workerRole: role,
        rootID,
        ...(instructions ? { instructions } : {}),
      },
    })
  }

  /**
   * Assign a task to a direct child worker. Idempotent per
   * (caller, taskID): the same deliveryKey yields one inbox delivery.
   */
  export async function assign(
    callerID: string,
    input: { sessionID: string; taskID: string; task: string; context?: string; acceptance?: string[] },
  ): Promise<AssignResult> {
    const caller = await requireBoss(callerID)
    const target = await assertDirectChild(caller, input.sessionID)
    const taskID = input.taskID.trim()
    if (!taskID) throw new BossError("invalid_task_id", "taskID is required")
    if (!input.task.trim()) throw new BossError("invalid_task", "task is required")

    const deliveryKey = `boss:${caller.id}:${taskID}`
    const taskTitle = input.task.trim().slice(0, 80)
    const result = await SessionInbox.deliverUnique({
      sessionID: target.id,
      deliveryKey,
      mode: "task",
      message: {
        role: "user",
        agent: target.agentOverride,
        origin: { type: "system", detail: "boss_assign" },
        visible: true,
        parts: [{ type: "text", text: buildTaskText(input) }],
        metadata: bossMetadata(caller.id, target.id, { taskID, taskTitle }),
        summary: { title: `Task: ${taskTitle}` },
      },
    })
    if (result.created) SessionManager.scheduleWake(target.id, "boss_assign")
    return { itemID: result.itemID, messageID: result.messageID, created: result.created }
  }

  /**
   * A worker reports its outcome to its parent. Only workers may call this;
   * the report is delivered as a steer message to the parent and wakes it.
   * The parent must still be an active member of the same boss tree, and the
   * report carries the originating taskID so the parent can correlate it.
   */
  export async function report(
    callerID: string,
    input: { summary: string; status?: "completed" | "blocked" | "needs_input"; refs?: string[] },
  ): Promise<ReportResult> {
    const caller = await requireBoss(callerID)
    if (caller.workflow?.kind !== "boss" || caller.workflow.role !== "worker") {
      throw new BossError("not_worker", `Session ${callerID} is not a boss worker`)
    }
    const parentID = caller.parentID
    if (!parentID) throw new BossError("no_parent", `Worker ${callerID} has no parent to report to`)
    const parent = await requireBoss(parentID)
    const callerRoot = bossRootID(caller)
    const parentRoot = bossRootID(parent)
    if (!callerRoot || callerRoot !== parentRoot) {
      throw new BossError("tree_mismatch", `Worker ${callerID} is no longer in the same active boss tree as its parent`)
    }
    if (!input.summary.trim()) throw new BossError("invalid_summary", "summary is required")

    const status = input.status ?? "completed"
    const refs = input.refs?.filter((ref) => ref.trim()) ?? []
    const text = [
      `Status: ${status}`,
      input.summary.trim(),
      ...(refs.length > 0 ? ["", "References:", ...refs.map((ref) => `- ${ref}`)] : []),
    ].join("\n")
    const reportID = Identifier.ascending("message")
    const currentTask = await latestAssignedTask(caller.id)
    const result = await SessionInbox.deliver({
      sessionID: parent.id,
      mode: "steer",
      message: {
        role: "user",
        origin: { type: "system", detail: "boss_report" },
        visible: true,
        parts: [{ type: "text", text }],
        metadata: bossMetadata(caller.id, parent.id, {
          reportID,
          status,
          ...(currentTask ? { taskID: currentTask.taskID } : {}),
        }),
        summary: { title: `Report from ${caller.title}` },
      },
    })
    SessionManager.scheduleWake(parent.id, "boss_report")
    return { itemID: result.itemID, messageID: result.messageID }
  }

  /**
   * Cancel a task (or all tasks) assigned to a direct child worker:
   * interrupt a running turn only when it belongs to the requested task
   * (or when no taskID is given), and remove matching pending inbox items.
   */
  export async function cancel(
    callerID: string,
    input: { sessionID: string; taskID?: string },
  ): Promise<{ cancelled: boolean }> {
    const caller = await requireBoss(callerID)
    const target = await assertDirectChild(caller, input.sessionID)
    let cancelled = false

    if (SessionManager.isRunning(target.id)) {
      const runningTask = await latestAssignedTask(target.id)
      if (!input.taskID || runningTask?.taskID === input.taskID) {
        SessionInvoke.cancel(target.id)
        cancelled = true
      }
    }

    const items = await SessionInbox.list(target.id)
    for (const item of items) {
      const boss = bossMetadataOf(item.message)
      if (!boss || boss.from !== caller.id) continue
      if (input.taskID && boss.taskID !== input.taskID) continue
      await SessionInbox.remove({ sessionID: target.id, itemID: item.id })
      cancelled = true
    }
    return { cancelled }
  }

  /** The most recently assigned task, from message history (materialized tasks). */
  async function latestAssignedTask(sessionID: string): Promise<{ taskID: string; taskTitle?: string } | undefined> {
    const messages = await Session.messages({ sessionID, limit: 20 }).catch(() => [])
    for (let index = messages.length - 1; index >= 0; index--) {
      const info = messages[index].info
      if (info.role !== "user") continue
      const boss = bossMetadataOf({ metadata: info.metadata })
      if (boss && typeof boss.taskID === "string") {
        return { taskID: boss.taskID, taskTitle: typeof boss.taskTitle === "string" ? boss.taskTitle : undefined }
      }
    }
    return undefined
  }

  /** Derive the current task from pending inbox items, then message history. */
  async function currentTask(sessionID: string): Promise<{ taskID: string; taskTitle?: string } | undefined> {
    const items = await SessionInbox.list(sessionID).catch(() => [])
    for (let index = items.length - 1; index >= 0; index--) {
      const boss = bossMetadataOf(items[index].message)
      if (boss && typeof boss.taskID === "string") {
        return { taskID: boss.taskID, taskTitle: typeof boss.taskTitle === "string" ? boss.taskTitle : undefined }
      }
    }
    return latestAssignedTask(sessionID)
  }

  /** Recursively derive the caller's subtree, skipping archived children. */
  export async function status(callerID: string, input: { depth?: number } = {}): Promise<BossTreeNode> {
    const caller = await requireBoss(callerID)
    const maxDepth = input.depth !== undefined && input.depth >= 0 ? input.depth : 16
    return buildNode(caller, maxDepth)
  }

  async function buildNode(session: Session.Info, remainingDepth: number): Promise<BossTreeNode> {
    const task = await currentTask(session.id)
    const hasQueuedTask = await SessionInbox.hasRunnableItem(session.id, { allowSteer: false }).catch(() => false)
    const node: BossTreeNode = {
      sessionID: session.id,
      title: session.title,
      role: session.workflow?.kind === "boss" ? session.workflow.role : "worker",
      workerRole: session.workflow?.kind === "boss" ? session.workflow.workerRole : undefined,
      agent: session.agentOverride,
      status: session.time.archived
        ? "archived"
        : SessionManager.isRunning(session.id)
          ? "running"
          : hasQueuedTask
            ? "queued"
            : "idle",
      currentTask: task,
      children: [],
    }
    if (remainingDepth <= 0 || session.time.archived) return node

    const children = await Session.children(session.id)
    const bossChildren = children.filter((child) => !child.time.archived && child.workflow?.kind === "boss")
    node.children = await Promise.all(bossChildren.map((child) => buildNode(child, remainingDepth - 1)))
    return node
  }
}
