import { Bus } from "../bus"
import { Config } from "../config/config"
import { Identifier } from "../id/id"
import { Log } from "../util/log"
import { Session } from "../session"
import { SessionInvoke, resolveInputParts } from "../session/invoke"
import { SessionManager } from "../session/manager"
import { Agent } from "../agent/agent"
import { MessageV2 } from "../session/message-v2"
import { CortexTypes } from "./types"
import { Trajectory } from "./trajectory"
import { CortexConcurrency } from "./concurrency"
import { fn } from "@/util/fn"
import { Dag } from "../session/dag"
import { CortexEvent } from "./event"
import { Plugin } from "../plugin"

export namespace Cortex {
  const log = Log.create({ service: "cortex" })

  const tasks: Map<string, CortexTypes.Task> = new Map()
  const taskWaiters: Map<string, Set<{ resolve: (task: CortexTypes.Task) => void; timeout: Timer }>> = new Map()
  const acquiredTasks = new Set<string>()

  const CLEANUP_DELAY_MS = 5 * 60 * 1000
  const DEFAULT_SUBAGENT_BLOCKED_TOOLS = [
    "task",
    "task_output",
    "task_list",
    "task_cancel",
    "dagwrite",
    "dagread",
    "dagpatch",
  ]

  export const Event = CortexEvent

  export const launch = fn(CortexTypes.LaunchInput, async (input) => {
    const taskID = Identifier.short("cortex")
    const executionRole = input.executionRole ?? "primary"
    log.info("launching", {
      taskID,
      description: input.description,
      agent: input.agent,
      executionRole,
    })

    const config = await Config.get()
    const parent = await Session.get(input.parentSessionID)
    const blockedTools = Array.from(
      new Set([...(config.experimental?.primary_tools ?? []), ...DEFAULT_SUBAGENT_BLOCKED_TOOLS]),
    )

    const session = await Session.create({
      scope: parent.scope as import("@/scope").Scope,
      parentID: input.parentSessionID,
      title: `[Cortex] ${input.description} (@${input.agent})`,
      permission: [
        { permission: "question", pattern: "*", action: "deny" },
        ...(executionRole === "delegated_subagent"
          ? blockedTools.map((tool) => ({
              pattern: "*",
              action: "deny" as const,
              permission: tool,
            }))
          : []),
      ],
    })

    const task: CortexTypes.Task = {
      id: taskID,
      sessionID: session.id,
      parentSessionID: input.parentSessionID,
      parentMessageID: input.parentMessageID,
      description: input.description,
      prompt: input.prompt,
      agent: input.agent,
      executionRole: input.executionRole,
      category: input.category,
      dagNodeId: input.dagNodeId,
      status: "queued",
      startedAt: Date.now(),
      progress: {
        toolCalls: 0,
        lastUpdate: Date.now(),
      },
    }

    tasks.set(taskID, task)

    Bus.publish(Event.TaskCreated, { task })

    await CortexConcurrency.acquire(input.agent)
    acquiredTasks.add(taskID)

    const current = tasks.get(taskID)
    if (!current || current.status === "cancelled") {
      acquiredTasks.delete(taskID)
      CortexConcurrency.release(input.agent)
      return current ?? task
    }

    current.status = "running"
    tasks.set(taskID, current)
    Bus.publish(Event.TasksUpdated, { tasks: list() })

    runTask(current, input.model).catch((error) => {
      log.error("task error", { taskID, error })
      updateTaskStatus(taskID, "error", String(error))
    })

    return current
  })

  async function runTask(task: CortexTypes.Task, model?: { providerID: string; modelID: string }): Promise<void> {
    log.info("running task", { taskID: task.id, sessionID: task.sessionID })

    const initial = tasks.get(task.id)
    if (!initial || initial.status === "cancelled") return

    const agent = await Agent.get(task.agent)
    const resolvedModel = model ?? (await Agent.getAvailableModel(agent))

    if (!resolvedModel) {
      throw new Error(`No model configured for agent ${task.agent}`)
    }

    const unsub = Bus.subscribe(MessageV2.Event.PartUpdated, (evt) => {
      if (evt.properties.part.sessionID !== task.sessionID) return
      if (evt.properties.part.type === "tool") {
        const current = tasks.get(task.id)
        if (!current || current.status !== "running") return
        current.progress = {
          toolCalls: (current.progress?.toolCalls ?? 0) + 1,
          lastTool: evt.properties.part.tool,
          lastUpdate: Date.now(),
        }
        tasks.set(task.id, current)
      }
    })

    const parts = await resolveInputParts(task.prompt)

    try {
      await SessionInvoke.invoke({
        sessionID: task.sessionID,
        model: resolvedModel,
        agent: task.agent,
        parts,
      })

      unsub()

      const summary = await Trajectory.summarize(task.sessionID)
      updateTaskStatus(task.id, "completed", undefined, summary || undefined)
    } catch (error) {
      unsub()
      log.error("task execution failed", { taskID: task.id, error })
      updateTaskStatus(task.id, "error", String(error))
    }
  }

  function updateTaskStatus(taskID: string, status: CortexTypes.TaskStatus, error?: string, result?: string): void {
    const task = tasks.get(taskID)
    if (!task) return

    if (isTerminal(task.status)) {
      log.info("ignoring task status update for terminal task", { taskID, current: task.status, next: status })
      return
    }

    task.status = status
    task.completedAt = Date.now()
    if (error) task.error = error
    if (result) task.result = result

    tasks.set(taskID, task)
    log.info("task status updated", { taskID, status })

    if (acquiredTasks.delete(taskID)) {
      CortexConcurrency.release(task.agent)
    }

    Bus.publish(Event.TaskCompleted, { task })
    Bus.publish(Event.TasksUpdated, { tasks: list() })
    void Plugin.trigger(
      "cortex.task.after",
      {
        task,
      },
      {},
    ).catch((error) => {
      log.error("cortex task hook failed", { taskID, error })
    })

    updateDagNode(task)

    const waiters = taskWaiters.get(taskID)
    if (waiters && waiters.size > 0) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timeout)
        waiter.resolve(task)
      }
      taskWaiters.delete(taskID)
      log.info("task result delivered to waiters, skipping mail", { taskID, waiterCount: waiters.size })
    } else {
      notifyParentSession(task)
    }

    setTimeout(() => {
      void (async () => {
        tasks.delete(taskID)
        acquiredTasks.delete(taskID)
        SessionManager.unregisterRuntime(task.sessionID)
        log.info("task cleaned up", { taskID })
      })()
    }, CLEANUP_DELAY_MS)
  }

  async function updateDagNode(task: CortexTypes.Task): Promise<void> {
    if (!task.dagNodeId) return
    try {
      const nodes = await Dag.get(task.parentSessionID)
      const node = nodes.find((n) => n.id === task.dagNodeId)
      if (!node) return
      node.status = task.status === "completed" ? "completed" : "failed"
      Dag.autoPromote(nodes)
      await Dag.update({ sessionID: task.parentSessionID, nodes })
      log.info("dag node updated", { dagNodeId: task.dagNodeId, status: node.status })
    } catch (error) {
      log.error("failed to update dag node", { dagNodeId: task.dagNodeId, error })
    }
  }

  function notifyParentSession(task: CortexTypes.Task): void {
    const statusText = task.status === "error" ? "FAILED" : task.status === "cancelled" ? "CANCELLED" : "COMPLETED"
    const notification = [
      `[BACKGROUND TASK ${statusText}]`,
      `**ID:** \`${task.id}\``,
      `**Description:** ${task.description}`,
      `**Duration:** ${formatDuration(task)}`,
      task.status === "error" && task.error ? `**Error:** ${task.error}` : "",
      "Use `task_list()` to inspect visible background tasks.",
      `Use \`task_output(task_id="${task.id}")\` only for tasks visible from this session.`,
    ]
      .filter(Boolean)
      .join("\n")

    void SessionManager.deliver({
      target: task.parentSessionID,
      mail: {
        type: "user",
        noReply: false,
        parts: [
          {
            id: Identifier.ascending("part"),
            messageID: "",
            sessionID: task.parentSessionID,
            type: "text",
            text: notification,
            synthetic: true,
          },
        ],
        metadata: {
          mailbox: true,
          sourceSessionID: task.sessionID,
        },
      },
    })
  }

  function isTerminal(status: CortexTypes.TaskStatus): boolean {
    return status === "completed" || status === "error" || status === "cancelled"
  }

  function formatDuration(task: CortexTypes.Task): string {
    const start = task.startedAt
    const end = task.completedAt ?? Date.now()
    const seconds = Math.floor((end - start) / 1000)
    if (seconds < 60) return `${seconds}s`
    const minutes = Math.floor(seconds / 60)
    const remainingSeconds = seconds % 60
    return `${minutes}m ${remainingSeconds}s`
  }

  export function get(taskID: string): CortexTypes.Task | undefined {
    return tasks.get(taskID)
  }

  export function list(): CortexTypes.Task[] {
    return Array.from(tasks.values())
  }

  export function getRunningTasks(): CortexTypes.Task[] {
    return Array.from(tasks.values()).filter((t) => t.status === "running")
  }

  export function getCompletedTasks(): CortexTypes.Task[] {
    return Array.from(tasks.values()).filter((t) => t.status === "completed" || t.status === "error")
  }

  export function getTasksForSession(sessionID: string): CortexTypes.Task[] {
    return Array.from(tasks.values()).filter((t) => t.parentSessionID === sessionID)
  }

  export function getVisibleTasks(sessionID: string): CortexTypes.Task[] {
    return getTasksForSession(sessionID)
  }

  export function getVisibleTask(sessionID: string, taskID: string): CortexTypes.Task | undefined {
    return getVisibleTasks(sessionID).find((task) => task.id === taskID)
  }

  function getDescendantTasks(parentSessionID: string): CortexTypes.Task[] {
    const pending = [parentSessionID]
    const seen = new Set<string>()
    const result: CortexTypes.Task[] = []

    while (pending.length > 0) {
      const currentSessionID = pending.shift()!
      for (const task of Array.from(tasks.values())) {
        if (task.parentSessionID !== currentSessionID) continue
        if (seen.has(task.id)) continue
        seen.add(task.id)
        result.push(task)
        pending.push(task.sessionID)
      }
    }

    return result
  }

  export async function cancel(taskID: string): Promise<void> {
    const task = tasks.get(taskID)
    if (!task) return
    if (isTerminal(task.status)) return

    log.info("cancelling task", { taskID, sessionID: task.sessionID, status: task.status })
    SessionInvoke.cancel(task.sessionID)
    updateTaskStatus(taskID, "cancelled")
  }

  export async function cancelAll(parentSessionID: string): Promise<number> {
    const toCancel = getDescendantTasks(parentSessionID).filter((t) => t.status === "running" || t.status === "queued")

    for (const task of toCancel) {
      await cancel(task.id)
    }

    return toCancel.length
  }

  export async function output(taskID: string): Promise<string> {
    const task = tasks.get(taskID)
    if (!task) {
      return `Task ${taskID} not found. It may have expired or been cancelled.`
    }

    const duration = formatDuration(task)

    if (task.status === "queued") {
      return [`Task: ${task.id}`, `Status: queued (waiting for concurrency slot)`, `Duration: ${duration}`].join("\n")
    }

    if (task.status === "running") {
      const progress = task.progress
      return [
        `Task: ${task.id}`,
        `Status: running`,
        `Duration: ${duration}`,
        progress
          ? `Progress: ${progress.toolCalls} tool calls${progress.lastTool ? `, last: ${progress.lastTool}` : ""}`
          : "",
      ]
        .filter(Boolean)
        .join("\n")
    }

    if (task.status === "error") {
      return [
        `Task: ${task.id}`,
        `Status: error`,
        `Duration: ${duration}`,
        "",
        "--- Error ---",
        task.error ?? "Unknown error",
      ].join("\n")
    }

    return [
      `Task: ${task.id}`,
      `Status: ${task.status}`,
      `Duration: ${duration}`,
      "",
      "--- Result ---",
      task.result ?? "No output captured",
    ].join("\n")
  }

  export async function waitFor(taskID: string, timeoutSeconds: number): Promise<CortexTypes.Task | undefined> {
    const task = tasks.get(taskID)
    if (!task || (task.status !== "running" && task.status !== "queued")) return task

    return new Promise((resolve) => {
      let resolved = false

      const waiter = {
        resolve: (completedTask: CortexTypes.Task) => {
          if (resolved) return
          resolved = true
          resolve(completedTask)
        },
        timeout: setTimeout(() => {
          if (resolved) return
          resolved = true
          // Unregister this waiter — if the task completes later with no waiters, mail will be sent
          const waiters = taskWaiters.get(taskID)
          if (waiters) {
            waiters.delete(waiter)
            if (waiters.size === 0) taskWaiters.delete(taskID)
          }
          resolve(tasks.get(taskID))
        }, timeoutSeconds * 1000),
      }

      if (!taskWaiters.has(taskID)) taskWaiters.set(taskID, new Set())
      taskWaiters.get(taskID)!.add(waiter)
    })
  }

  export function reset(): void {
    tasks.clear()
    acquiredTasks.clear()
    for (const waiters of taskWaiters.values()) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timeout)
      }
    }
    taskWaiters.clear()
    CortexConcurrency.reset()
  }
}
