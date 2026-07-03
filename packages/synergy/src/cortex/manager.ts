import { $ } from "bun"

import { BusyError } from "../session/error"
import { Worktree } from "../project/worktree"
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
import { CortexOutput } from "./output"

export namespace Cortex {
  const log = Log.create({ service: "cortex" })

  const tasks: Map<string, CortexTypes.Task> = new Map()
  const taskWaiters: Map<string, Set<{ resolve: (task: CortexTypes.Task) => void; timeout: Timer }>> = new Map()
  const taskRuns: Map<string, Promise<void>> = new Map()
  const acquiredTasks = new Set<string>()

  const CLEANUP_DELAY_MS = 20 * 60 * 1000
  const EXTERNAL_TASK_RESULT_CHAR_LIMIT = 120_000
  const EXTERNAL_TASK_RESULT_HEAD_CHARS = 20_000
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

  /** Extract final text from an external-agent subagent session.
   *  Reads all assistant text parts (excluding synthetic, ignored, tool output, reasoning)
   *  and returns the concatenated result, capped to avoid excessive context size. */
  export async function extractExternalTaskResult(sessionID: string): Promise<string> {
    const messages = await Session.messages({ sessionID })
    const chunks: string[] = []

    for (const message of messages) {
      if (message.info.role !== "assistant") continue

      for (const part of message.parts) {
        if (part.type !== "text" || part.synthetic || part.ignored) continue
        const text = part.text.trim()
        if (text) chunks.push(text)
      }
    }

    const result = chunks.join("\n\n").trim()
    if (!result) return "No assistant text found in external subagent session."

    if (result.length <= EXTERNAL_TASK_RESULT_CHAR_LIMIT) return result

    const tailChars = EXTERNAL_TASK_RESULT_CHAR_LIMIT - EXTERNAL_TASK_RESULT_HEAD_CHARS
    const omitted = result.length - EXTERNAL_TASK_RESULT_CHAR_LIMIT
    return [
      result.slice(0, EXTERNAL_TASK_RESULT_HEAD_CHARS).trimEnd(),
      "",
      `[External subagent result truncated: ${omitted.toLocaleString()} characters omitted.]`,
      "",
      result.slice(-tailChars).trimStart(),
    ].join("\n")
  }

  export const launch = fn(CortexTypes.LaunchInput, async (input) => {
    const taskID = Identifier.short("cortex")
    const executionRole = input.executionRole ?? "primary"
    log.info("launching", {
      taskID,
      description: input.description,
      agent: input.agent,
      executionRole,
    })

    const config = await Config.current()
    const parent = await Session.get(input.parentSessionID)
    const blockedTools = Array.from(
      new Set([...(config.experimental?.primary_tools ?? []), ...DEFAULT_SUBAGENT_BLOCKED_TOOLS]),
    )

    let session: import("../session/types").Info

    if (input.sessionID) {
      const existing = await Session.get(input.sessionID)
      if (!existing) {
        throw new Error(`Session ${input.sessionID} not found`)
      }
      if (existing.parentID !== input.parentSessionID) {
        throw new Error(
          `Session ${input.sessionID} does not belong to parent session ${input.parentSessionID}. ` +
            `Reuse is only allowed for sessions created by the same parent.`,
        )
      }
      if (SessionManager.isRunning(input.sessionID)) {
        throw new BusyError(input.sessionID)
      }
      session = existing
      log.info("reusing existing session", {
        taskID,
        sessionID: existing.id,
        description: input.description,
      })
    } else {
      session = await Session.create({
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
        cortex: {
          parentSessionID: input.parentSessionID,
          parentMessageID: input.parentMessageID,
          description: input.description,
          agent: input.agent,
          executionRole,
          status: "queued",
          startedAt: Date.now(),
          visibility: input.visibility,
          tools: input.tools,
          output: input.output,
        },
        workspace: (parent as import("../session/types").Info).workspace,
      })
    }
    if (input.worktree?.create) {
      const parentWorkspace = (parent as import("../session/types").Info).workspace
      if (parentWorkspace?.type !== "git_worktree") {
        try {
          const created = await Worktree.create({
            name: input.worktree.name,
            baseRef: input.worktree.baseRef,
            bind: false,
          })
          await Worktree.enter({ sessionID: session.id, target: created.id, force: false })
          log.info("worktree bound to child session", {
            taskID,
            worktreeID: created.id,
            worktreeName: created.name,
          })
        } catch (error) {
          log.warn("failed to create worktree for child session", { taskID, error })
        }
      } else {
        log.info("parent already in worktree, child inherits parent workspace", { taskID })
      }
    }

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
        recentTools: [],
      },
      notifyParentOnComplete: input.notifyParentOnComplete ?? (input.visibility === "hidden" ? false : undefined),
      visibility: input.visibility,
      tools: input.tools,
      output: input.output,
    }

    tasks.set(taskID, task)

    if (task.visibility !== "hidden") {
      Bus.publish(Event.TaskCreated, { task })
    }

    await CortexConcurrency.acquire(input.agent)
    acquiredTasks.add(taskID)

    const current = tasks.get(taskID)
    if (!current || current.status === "cancelled") {
      acquiredTasks.delete(taskID)
      CortexConcurrency.release(input.agent)
      return current ?? task
    }

    setTaskStatus(taskID, "running")

    const run = runTask(current, input.model)
      .catch((error) => {
        log.error("task error", { taskID, error })
        updateTaskStatus(taskID, "error", String(error))
      })
      .finally(() => {
        taskRuns.delete(taskID)
      })
    taskRuns.set(taskID, run)

    return current
  })

  function setTaskStatus(taskID: string, status: CortexTypes.TaskStatus): void {
    const task = tasks.get(taskID)
    if (!task) return

    task.status = status
    tasks.set(taskID, task)
    log.info("task status updated", { taskID, status })

    void Session.update(task.sessionID, (draft) => {
      if (draft.cortex) {
        draft.cortex.status = status as "queued" | "running" | "completed" | "error" | "cancelled"
      }
    }).catch((error) => {
      log.error("failed to persist task status", { taskID, status, error })
    })

    Bus.publish(Event.TasksUpdated, { tasks: listVisible() })
  }

  async function runTask(task: CortexTypes.Task, model?: { providerID: string; modelID: string }): Promise<void> {
    log.info("running task", { taskID: task.id, sessionID: task.sessionID })

    const initial = tasks.get(task.id)
    if (!initial || initial.status === "cancelled") return

    const agent = await Agent.get(task.agent)
    const resolvedModel = model ?? (await Agent.getAvailableModel(agent))

    if (!resolvedModel) {
      throw new Error(`No model configured for agent ${task.agent}`)
    }
    const output = CortexOutput.normalize(task.output)
    if (agent.external && output.mode === "structured") {
      throw new Error("Structured Cortex output is not supported for external agents")
    }
    // Persist resolved model to session metadata
    void Session.update(task.sessionID, (draft) => {
      if (draft.cortex) {
        draft.cortex.model = { providerID: resolvedModel.providerID, modelID: resolvedModel.modelID }
      }
    }).catch((error) => {
      log.error("failed to persist task model", { taskID: task.id, error })
    })
    let unsub: (() => void) | undefined
    try {
      unsub = Bus.subscribe(MessageV2.Event.PartUpdated, (evt) => {
        if (evt.properties.part.sessionID !== task.sessionID) return
        const current = tasks.get(task.id)
        if (!current || current.status !== "running") return

        const now = Date.now()
        const progress = current.progress ?? { toolCalls: 0, lastUpdate: now, recentTools: [] }
        const part = evt.properties.part

        if (part.type === "tool") {
          const existing = progress.recentTools?.some((item) => item.id === part.id) ?? false
          const title = "title" in part.state ? part.state.title : undefined
          const entry: CortexTypes.TaskToolProgress = {
            id: part.id,
            tool: part.tool,
            status: part.state.status,
            title,
            updatedAt: now,
          }
          current.progress = {
            ...progress,
            toolCalls: progress.toolCalls + (existing ? 0 : 1),
            lastTool: part.tool,
            lastToolStatus: part.state.status,
            lastTitle: title,
            lastPartId: part.id,
            lastUpdate: now,
            recentTools: [entry, ...(progress.recentTools ?? []).filter((item) => item.id !== part.id)].slice(0, 8),
          }
          tasks.set(task.id, current)
          return
        }

        if (part.type === "text" && !part.synthetic && !part.ignored) {
          const text = part.text.trim()
          current.progress = {
            ...progress,
            lastMessage: text.length > 240 ? `${text.slice(0, 237)}...` : text,
            lastPartId: part.id,
            lastUpdate: now,
          }
          tasks.set(task.id, current)
        }
      })

      const parts = await resolveInputParts(CortexOutput.initialPrompt(task.prompt, output))
      const invokeTools = CortexOutput.toolsFor(task.tools, output)
      const ephemeralTools = CortexOutput.ephemeralTools(output)

      await SessionInvoke.invokeInternal({
        sessionID: task.sessionID,
        model: resolvedModel,
        agent: task.agent,
        parts,
        tools: invokeTools,
        ephemeralTools,
      })

      let outputResult = await CortexOutput.resolve(task.sessionID, output, 0)
      if (output.mode === "structured") {
        let repairTurns = 0
        while (outputResult?.mode === "structured" && outputResult.status === "invalid") {
          if (repairTurns >= CortexOutput.maxRepairTurns(output)) break
          repairTurns++
          const repairParts = await resolveInputParts(CortexOutput.repairPrompt(output, outputResult, repairTurns))
          await SessionInvoke.invokeInternal({
            sessionID: task.sessionID,
            model: resolvedModel,
            agent: task.agent,
            parts: repairParts,
            tools: invokeTools,
            ephemeralTools,
          })
          outputResult = await CortexOutput.resolve(task.sessionID, output, repairTurns)
        }

        if (outputResult?.mode === "structured" && outputResult.status === "invalid") {
          unsub()
          unsub = undefined
          updateTaskStatus(
            task.id,
            "error",
            outputResult.error ?? "Structured Cortex output is invalid",
            undefined,
            outputResult,
          )
          return
        }
      }

      unsub()
      unsub = undefined

      const result = agent.external
        ? await extractExternalTaskResult(task.sessionID)
        : await Trajectory.summarize(task.sessionID)
      updateTaskStatus(task.id, "completed", undefined, result || undefined, outputResult)
    } catch (error) {
      unsub?.()
      log.error("task execution failed", { taskID: task.id, error })
      updateTaskStatus(task.id, "error", String(error))
    }
  }

  function updateTaskStatus(
    taskID: string,
    status: CortexTypes.TaskStatus,
    error?: string,
    result?: string,
    outputResult?: CortexTypes.OutputResult,
  ): void {
    const task = tasks.get(taskID)
    if (!task) return

    if (isTerminal(task.status)) {
      log.info("ignoring task status update for terminal task", { taskID, current: task.status, next: status })
      return
    }

    task.completedAt = Date.now()
    if (error) task.error = error
    if (result) task.result = result
    if (outputResult) task.outputResult = outputResult
    tasks.set(taskID, task)

    setTaskStatus(taskID, status)

    // Terminal-specific: extra session fields (status already synced by setTaskStatus)
    void Session.update(task.sessionID, (draft) => {
      if (draft.cortex) {
        draft.cortex.completedAt = task.completedAt
        if (error) draft.cortex.error = error
        if (result) draft.cortex.result = result
        if (outputResult) draft.cortex.outputResult = outputResult
      }
    }).catch((error) => {
      log.error("failed to persist terminal task fields", { taskID, error })
    })

    if (acquiredTasks.delete(taskID)) {
      CortexConcurrency.release(task.agent)
    }

    if (task.visibility !== "hidden") {
      Bus.publish(Event.TaskCompleted, { task })
    }
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
    } else if (task.notifyParentOnComplete !== false) {
      notifyParentSession(task)
    } else {
      log.info("task parent notification suppressed", { taskID })
    }

    void cleanupChildWorktree(task)

    setTimeout(() => {
      const task = tasks.get(taskID)
      if (task) {
        task.prompt = ""
        task.result = undefined
        task.error = undefined
        task.outputResult = undefined
        log.info("task strings evicted", { taskID })
      }
    }, CLEANUP_DELAY_MS)

    setTimeout(
      () => {
        void (async () => {
          tasks.delete(taskID)
          acquiredTasks.delete(taskID)
          SessionManager.unregisterRuntime(task.sessionID)
          log.info("task cleaned up", { taskID })
        })()
      },
      CLEANUP_DELAY_MS + 5 * 60 * 1000,
    )
  }

  async function updateDagNode(task: CortexTypes.Task): Promise<void> {
    if (!task.dagNodeId) return
    try {
      const nodes = await Dag.get(task.parentSessionID)
      const node = nodes.find((n) => n.id === task.dagNodeId)
      if (!node) return
      node.status = task.status === "completed" ? "completed" : "failed"
      if (task.result || task.error) {
        const raw = task.status === "completed" ? (task.result ?? "") : (task.error ?? "")
        node.result = raw.length > 8192 ? raw.slice(0, 8189) + "..." : raw
      }
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
      `Use \`task_output(task_id="${task.id}", mode="progress")\` to inspect live progress.`,
      `Use \`task_output(task_id="${task.id}", mode="tail")\` to inspect recent activity.`,
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
          channelPush: true,
          source: "cortex",
          sourceSessionID: task.sessionID,
        },
      },
    }).catch((error) => {
      log.error("failed to notify parent session", { taskID: task.id, parentSessionID: task.parentSessionID, error })
    })
  }

  function isTerminal(status: CortexTypes.TaskStatus): boolean {
    return status === "completed" || status === "error" || status === "cancelled"
  }

  export type TaskHealth = "queued" | "active" | "tool-running" | "stale" | "terminal"

  function formatDuration(task: CortexTypes.Task): string {
    const start = task.startedAt
    const end = task.completedAt ?? Date.now()
    const seconds = Math.floor((end - start) / 1000)
    if (seconds < 60) return `${seconds}s`
    const minutes = Math.floor(seconds / 60)
    const remainingSeconds = seconds % 60
    return `${minutes}m ${remainingSeconds}s`
  }

  function formatAge(timestamp?: number): string {
    if (!timestamp) return "never"
    const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000))
    if (seconds < 5) return "just now"
    if (seconds < 60) return `${seconds}s ago`
    const minutes = Math.floor(seconds / 60)
    if (minutes < 60) return `${minutes}m ago`
    const hours = Math.floor(minutes / 60)
    return `${hours}h ago`
  }

  export function health(task: CortexTypes.Task): TaskHealth {
    if (isTerminal(task.status)) return "terminal"
    if (task.status === "queued") return "queued"
    const recentRunningTool = task.progress?.recentTools?.some(
      (tool) => tool.status === "running" || tool.status === "generating",
    )
    if (recentRunningTool) return "tool-running"
    const lastUpdate = task.progress?.lastUpdate ?? task.startedAt
    return Date.now() - lastUpdate > 5 * 60 * 1000 ? "stale" : "active"
  }

  export function describe(task: CortexTypes.Task) {
    return {
      duration: formatDuration(task),
      health: health(task),
      lastUpdate: formatAge(task.progress?.lastUpdate ?? task.startedAt),
      lastTool: task.progress?.lastTool,
      lastToolStatus: task.progress?.lastToolStatus,
      lastTitle: task.progress?.lastTitle,
      toolCalls: task.progress?.toolCalls ?? 0,
    }
  }

  export function get(taskID: string): CortexTypes.Task | undefined {
    return tasks.get(taskID)
  }

  export function list(): CortexTypes.Task[] {
    return Array.from(tasks.values())
  }

  export function listVisible(): CortexTypes.Task[] {
    return Array.from(tasks.values()).filter((task) => task.visibility !== "hidden")
  }

  export function getRunningTasks(): CortexTypes.Task[] {
    return listVisible().filter((t) => t.status === "running")
  }

  export function getCompletedTasks(): CortexTypes.Task[] {
    return listVisible().filter((t) => t.status === "completed" || t.status === "error")
  }

  export function getTasksForSession(sessionID: string): CortexTypes.Task[] {
    return Array.from(tasks.values()).filter((t) => t.parentSessionID === sessionID)
  }

  export function getVisibleTasks(sessionID: string): CortexTypes.Task[] {
    return getTasksForSession(sessionID).filter((task) => task.visibility !== "hidden")
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
    await SessionInvoke.cancel(task.sessionID)
    updateTaskStatus(taskID, "cancelled")

    const run = taskRuns.get(taskID)
    // Don't block cancel on processor settle — status is already "cancelled".
    // The run promise fulfills when the session loop exits (triggered by the
    // SessionInvoke.cancel call above plus abort signal propagation), after
    // which the task's finally block in launch() will clean up taskRuns.
    if (run) run.catch(() => {})
  }

  export async function cancelAll(parentSessionID: string): Promise<number> {
    const toCancel = getDescendantTasks(parentSessionID).filter((t) => t.status === "running" || t.status === "queued")

    for (const task of toCancel) {
      await cancel(task.id)
    }

    return toCancel.length
  }

  export async function output(
    taskID: string,
    mode: "summary" | "progress" | "tail" | "full" = "full",
  ): Promise<string> {
    const task = tasks.get(taskID)
    if (!task) {
      return `Task ${taskID} not found. It may have expired or been cancelled.`
    }

    if (mode === "progress" || mode === "summary") return renderProgress(task)
    if (mode === "tail") return renderTail(task)

    if (task.status === "queued" || task.status === "running") return renderProgress(task)

    if (task.status === "error") {
      return [renderProgress(task), "", "--- Error ---", task.error ?? "Unknown error"].join("\n")
    }

    return [renderProgress(task), "", "--- Result ---", task.result ?? "No output captured"].join("\n")
  }

  function renderProgress(task: CortexTypes.Task): string {
    const info = describe(task)
    const lines = [
      `Task: ${task.id}`,
      `Status: ${task.status}`,
      `Agent: ${task.agent}`,
      `Description: ${task.description}`,
      `Duration: ${info.duration}`,
      `Health: ${info.health}`,
      `Last update: ${info.lastUpdate}`,
      `Tool calls: ${info.toolCalls}`,
      info.lastTool ? `Last tool: ${info.lastTool}${info.lastToolStatus ? ` (${info.lastToolStatus})` : ""}` : "",
      info.lastTitle ? `Last title: ${info.lastTitle}` : "",
      task.dagNodeId ? `DAG node: ${task.dagNodeId}` : "",
    ].filter(Boolean)

    const recentTools = task.progress?.recentTools ?? []
    if (recentTools.length > 0) {
      lines.push("", "## Recent Tools")
      for (const tool of recentTools) {
        lines.push(
          `- ${tool.tool} — ${tool.status}${tool.title ? ` — ${tool.title}` : ""} [${formatAge(tool.updatedAt)}]`,
        )
      }
    }

    if (task.progress?.lastMessage) {
      lines.push("", "## Recent Text", task.progress.lastMessage)
    }

    return lines.join("\n")
  }

  async function renderTail(task: CortexTypes.Task): Promise<string> {
    const messages = await Session.messages({ sessionID: task.sessionID })
    const lines = [renderProgress(task), "", "## Recent Session Tail"]
    const recent = messages.slice(-4)
    for (const message of recent) {
      const parts: string[] = []
      for (const part of message.parts) {
        if (part.type === "text" && !part.synthetic && !part.ignored) {
          const text = part.text.trim().replace(/\s+/g, " ")
          if (text) parts.push(`text: ${text.length > 260 ? `${text.slice(0, 257)}...` : text}`)
        }
        if (part.type === "tool") {
          const title = "title" in part.state && part.state.title ? ` — ${part.state.title}` : ""
          parts.push(`tool: ${part.tool} — ${part.state.status}${title}`)
        }
      }
      if (parts.length > 0) lines.push(`- ${message.info.role}: ${parts.join("; ")}`)
    }
    return lines.join("\n")
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
    taskRuns.clear()
    acquiredTasks.clear()
    for (const waiters of taskWaiters.values()) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timeout)
      }
    }
    taskWaiters.clear()
    CortexConcurrency.reset()
  }

  async function cleanupChildWorktree(task: CortexTypes.Task) {
    try {
      const session = await Session.get(task.sessionID)
      const workspace = session.workspace
      if (workspace?.type !== "git_worktree" || !workspace.worktreeID) return
      const state = await Worktree.status(task.sessionID)
      if (!state.worktree || !state.worktree.managed) return
      const owner = state.worktree.owner
      if (owner?.type !== "session" || owner.sessionID !== task.sessionID) return
      if (state.dirty) {
        await Worktree.markLifecycle(state.worktree.id, "gc_candidate")
        log.info("child worktree dirty, marked for gc", {
          taskID: task.id,
          worktreeID: state.worktree.id,
          worktreeName: state.worktree.name,
        })
        return
      }
      if (state.worktree.branch) {
        const result = await $`git rev-list --count HEAD --not --remotes`.quiet().nothrow().cwd(state.path)
        const localOnly = parseInt(result.stdout.toString().trim(), 10)
        if (!isNaN(localOnly) && localOnly > 0) {
          log.info("child worktree has local-only commits, kept for review", {
            taskID: task.id,
            worktreeID: state.worktree.id,
            worktreeName: state.worktree.name,
            branch: state.worktree.branch,
            localCommits: localOnly,
          })
          return
        }
      }
      await Worktree.remove({ sessionID: task.sessionID, target: state.worktree.id, force: false })
      log.info("child worktree removed", {
        taskID: task.id,
        worktreeID: state.worktree.id,
        worktreeName: state.worktree.name,
      })
    } catch (error) {
      log.warn("child worktree cleanup failed", { taskID: task.id, error })
    }
  }
}
