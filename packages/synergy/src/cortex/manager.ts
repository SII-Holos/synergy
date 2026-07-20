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
import { ScopeContext } from "../scope/context"
import { Observability } from "../observability"
import { pluginTaskSnapshotFromTask } from "./plugin-task"
import { SessionInbox } from "../session/inbox"
import { SessionDrive } from "../session/drive"
import { Lock } from "../util/lock"

export namespace Cortex {
  const log = Log.create({ service: "cortex" })

  const tasks: Map<string, CortexTypes.Task> = new Map()
  const taskWaiters: Map<string, Set<{ resolve: (task: CortexTypes.Task) => void; timeout: Timer }>> = new Map()
  const taskRuns: Map<string, Promise<void>> = new Map()
  const taskBudgets = new Map<string, { maxOutputTokens?: number; maxCost?: number }>()
  const acquiredTasks = new Set<string>()
  const taskTimeouts = new Map<string, ReturnType<typeof setTimeout>>()
  const finalizingTasks = new Set<string>()
  const cancellationRequests = new Set<string>()
  let progressUpdateTimer: Timer | undefined

  const PROMPT_COMPACT_DELAY_MS = 30 * 1000
  const TASK_CLEANUP_DELAY_MS = 5 * 60 * 1000
  const PROGRESS_UPDATE_EVENT_DELAY_MS = 200
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
        if (part.type !== "text" || MessageV2.isSystemPart(part)) continue
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

  export const prepare = fn(CortexTypes.LaunchInput, async (input) => {
    using _ = input.reuseInterrupted
      ? await Lock.write(`cortex-task-prepare:${input.parentSessionID}:${input.agent}:${input.parentMessageID}`)
      : undefined
    if (input.reuseInterrupted) {
      const active = Array.from(tasks.values()).find(
        (task) =>
          task.parentSessionID === input.parentSessionID &&
          task.parentMessageID === input.parentMessageID &&
          task.agent === input.agent &&
          (task.status === "queued" || task.status === "running"),
      )
      if (active) return active
    }

    const taskID = Identifier.short("cortex")
    const executionRole = input.executionRole ?? "primary"
    const notifyParentOnComplete = input.notifyParentOnComplete ?? input.visibility !== "hidden"
    log.info("preparing", {
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

    const reusableSession = input.reuseInterrupted
      ? (await Session.children(input.parentSessionID)).find(
          (child) =>
            child.cortex?.parentMessageID === input.parentMessageID &&
            child.cortex.agent === input.agent &&
            (child.cortex.status === "queued" || child.cortex.status === "interrupted"),
        )
      : undefined

    let session: import("../session/types").Info

    if (input.sessionID || reusableSession) {
      const existing = reusableSession ?? (await Session.get(input.sessionID!))
      if (!existing) {
        throw new Error(`Session ${input.sessionID} not found`)
      }
      if (existing.parentID !== input.parentSessionID) {
        throw new Error(
          `Session ${input.sessionID} does not belong to parent session ${input.parentSessionID}. ` +
            `Reuse is only allowed for sessions created by the same parent.`,
        )
      }
      if (SessionManager.isRunning(existing.id)) {
        throw new BusyError(existing.id)
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
        provenance: input.provenance,
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
          taskID,
          parentSessionID: input.parentSessionID,
          parentMessageID: input.parentMessageID,
          description: input.description,
          agent: input.agent,
          model: input.model,
          executionRole,
          status: "queued",
          startedAt: Date.now(),
          notifyParentOnComplete,
          visibility: input.visibility,
          tools: input.tools,
          outputConfig: input.output,
          owner: input.owner,
          timeoutMs: input.timeoutMs,
        },
        workspace: (parent as import("../session/types").Info).workspace,
        completionNotice: { silent: input.visibility === "hidden" },
      })
    }
    if (input.worktree?.create) {
      const parentWorkspace = (parent as import("../session/types").Info).workspace
      if (parentWorkspace?.type !== "git_worktree") {
        const createWorktree = async () => {
          const created = await Worktree.create({
            name: input.worktree?.name,
            sessionID: session.id,
            owner: { type: "session", sessionID: session.id },
            baseRef: input.worktree?.baseRef ?? "current",
            baseRevision: input.worktree?.baseRevision,
            bind: false,
          })
          await Worktree.enter({ sessionID: session.id, target: created.id, force: false })
          log.info("worktree bound to child session", {
            taskID,
            worktreeID: created.id,
            worktreeName: created.name,
          })
        }
        if (input.worktree.failOnError) {
          await createWorktree()
        } else {
          await createWorktree().catch((error) => {
            log.warn("failed to create worktree for child session", { taskID, error })
          })
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
      model: input.model,
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
      notifyParentOnComplete,
      visibility: input.visibility,
      tools: input.tools,
      outputConfig: input.output,
      owner: input.owner,
      timeoutMs: input.timeoutMs,
    }

    await Session.update(session.id, (draft) => {
      if (!draft.cortex) return
      draft.cortex.taskID = taskID
      draft.cortex.parentSessionID = input.parentSessionID
      draft.cortex.parentMessageID = input.parentMessageID
      draft.cortex.description = input.description
      draft.cortex.agent = input.agent
      draft.cortex.model = input.model
      draft.cortex.executionRole = input.executionRole
      draft.cortex.notifyParentOnComplete = notifyParentOnComplete
      draft.cortex.status = "queued"
      draft.cortex.startedAt = task.startedAt
      draft.cortex.completedAt = undefined
      draft.cortex.error = undefined
      draft.cortex.output = undefined
      draft.cortex.deliveryNotifiedAt = undefined
      draft.cortex.owner = input.owner
      draft.cortex.timeoutMs = input.timeoutMs
    })
    taskBudgets.set(taskID, {
      maxOutputTokens: input.maxOutputTokens,
      maxCost: input.maxCost,
    })

    tasks.set(taskID, task)
    emitPluginTaskObservability(task, "started")
    emitPluginTaskObservability(task, "queued")
    SessionManager.registerChildRuntime(session.id)

    if (task.visibility !== "hidden") {
      Bus.publish(Event.TaskCreated, { task })
    }

    return task
  })

  export async function start(taskID: string): Promise<CortexTypes.Task> {
    using _ = await Lock.write(`cortex-task-start:${taskID}`)
    const task = tasks.get(taskID)
    if (!task) throw new Error(`Cortex task ${taskID} not found`)
    if (task.status !== "queued") return task

    await CortexConcurrency.acquire(task.agent)
    acquiredTasks.add(taskID)

    const current = tasks.get(taskID)
    if (!current || current.status === "cancelled") {
      taskBudgets.delete(taskID)
      acquiredTasks.delete(taskID)
      CortexConcurrency.release(task.agent)
      return current ?? task
    }

    setTaskStatus(taskID, "running")

    const budget = taskBudgets.get(taskID)
    taskBudgets.delete(taskID)
    const run = runTask(current, current.model, budget?.maxOutputTokens, budget?.maxCost)
      .catch(async (error) => {
        log.error("task error", { taskID, error })
        await updateTaskStatus(taskID, "error", String(error))
      })
      .finally(() => {
        taskRuns.delete(taskID)
      })
    taskRuns.set(taskID, run)

    if (current.timeoutMs) {
      const timeout = setTimeout(() => {
        const active = tasks.get(taskID)
        if (!active || isTerminal(active.status)) return
        SessionInvoke.cancel(active.sessionID)
        void updateTaskStatus(taskID, "error", `Task exceeded its ${current.timeoutMs}ms runtime limit.`)
      }, current.timeoutMs)
      taskTimeouts.set(taskID, timeout)
    }

    return current
  }

  export const launch = fn(CortexTypes.LaunchInput, async (input) => {
    const task = await prepare(input)
    return start(task.id)
  })

  function setTaskStatus(taskID: string, status: CortexTypes.TaskStatus): void {
    const task = tasks.get(taskID)
    if (!task) return

    task.status = status
    tasks.set(taskID, task)
    log.info("task status updated", { taskID, status })
    emitPluginTaskObservability(task, status)

    void Session.update(task.sessionID, (draft) => {
      if (draft.cortex) {
        draft.cortex.status = status as "queued" | "running" | "completed" | "error" | "cancelled" | "interrupted"
      }
    }).catch((error) => {
      log.error("failed to persist task status", { taskID, status, error })
    })

    publishVisibleTasksUpdate()
  }

  function emitPluginTaskObservability(task: CortexTypes.Task, phase: string): void {
    if (!task.owner) return
    void Observability.emit(`plugin.task.${phase}`, {
      traceId: task.owner.correlationId,
      sessionID: task.sessionID,
      scopeID: task.owner.scopeId,
      level: phase === "error" || phase === "interrupted" ? "error" : "info",
      data: {
        pluginId: task.owner.pluginId,
        pluginGeneration: task.owner.pluginGeneration,
        correlationId: task.owner.correlationId,
        taskId: task.id,
        status: task.status,
        agent: task.agent,
        model: task.model,
        startedAt: task.startedAt,
        completedAt: task.completedAt,
        durationMs: task.completedAt ? task.completedAt - task.startedAt : undefined,
        usage: task.usage,
      },
    })
  }

  function publishVisibleTasksUpdate(): void {
    void Bus.publish(Event.TasksUpdated, { tasks: listVisible() })
  }

  function scheduleProgressUpdate(task: CortexTypes.Task): void {
    if (task.visibility === "hidden") return
    if (progressUpdateTimer) return
    progressUpdateTimer = setTimeout(() => {
      progressUpdateTimer = undefined
      publishVisibleTasksUpdate()
    }, PROGRESS_UPDATE_EVENT_DELAY_MS)
  }

  async function runTask(
    task: CortexTypes.Task,
    model?: { providerID: string; modelID: string },
    maxOutputTokens?: number,
    maxCost?: number,
  ): Promise<void> {
    log.info("running task", { taskID: task.id, sessionID: task.sessionID })

    const initial = tasks.get(task.id)
    if (!initial || initial.status === "cancelled") return

    const agent = await Agent.get(task.agent)
    const resolvedModel = model ?? (await Agent.getAvailableModel(agent))

    if (!resolvedModel) {
      throw new Error(`No model configured for agent ${task.agent}`)
    }
    const outputConfig = CortexOutput.normalize(task.outputConfig)
    if (agent.external && outputConfig.mode === "structured") {
      throw new Error("Structured Cortex output is not supported for external agents")
    }
    CortexOutput.assertValidStructuredSchema(outputConfig)
    const currentTask = tasks.get(task.id)
    if (currentTask) {
      currentTask.model = resolvedModel
      tasks.set(task.id, currentTask)
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
          scheduleProgressUpdate(current)
          return
        }

        if (part.type === "text" && !MessageV2.isSystemPart(part)) {
          const text = part.text.trim()
          current.progress = {
            ...progress,
            lastMessage: text.length > 240 ? `${text.slice(0, 237)}...` : text,
            lastPartId: part.id,
            lastUpdate: now,
          }
          tasks.set(task.id, current)
          scheduleProgressUpdate(current)
        }
      })

      const parts = await resolveInputParts(CortexOutput.initialPrompt(task.prompt, outputConfig))
      const invokeTools = CortexOutput.toolsFor(task.tools, outputConfig)
      const ephemeralTools = CortexOutput.ephemeralTools(outputConfig)

      const initialMessage = await SessionInvoke.invokeInternal({
        sessionID: task.sessionID,
        model: resolvedModel,
        agent: task.agent,
        parts,
        tools: invokeTools,
        ephemeralTools,
        maxOutputTokens,
      })

      let outputResolution = await CortexOutput.resolve({
        sessionID: task.sessionID,
        output: outputConfig,
        rootMessageID: rootMessageID(initialMessage),
      })
      if (outputConfig.mode === "structured") {
        let repairTurns = 0
        while (outputResolution && !outputResolution.ok) {
          if (repairTurns >= CortexOutput.maxRepairTurns(outputConfig)) break
          repairTurns++
          const repairParts = await resolveInputParts(
            CortexOutput.repairPrompt(outputConfig, outputResolution, repairTurns),
          )
          const repairMessage = await SessionInvoke.invokeInternal({
            sessionID: task.sessionID,
            model: resolvedModel,
            agent: task.agent,
            parts: repairParts,
            tools: CortexOutput.repairTools(),
            ephemeralTools,
            maxOutputTokens,
          })
          outputResolution = await CortexOutput.resolve({
            sessionID: task.sessionID,
            output: outputConfig,
            rootMessageID: rootMessageID(repairMessage),
          })
        }

        if (outputResolution && !outputResolution.ok) {
          unsub()
          unsub = undefined
          await updateTaskStatus(
            task.id,
            "error",
            `Structured output validation failed after ${CortexOutput.maxRepairTurns(outputConfig)} repair turns: ${outputResolution.error}`,
          )
          return
        }
      }

      unsub()
      unsub = undefined

      if (maxCost !== undefined) {
        const usage = await taskUsage(task.sessionID)
        if (usage.cost > maxCost) {
          await updateTaskStatus(task.id, "error", `Task exceeded its ${maxCost} cost budget.`)
          return
        }
      }
      const completedOutput = await completedTaskOutput(task, agent, outputConfig, outputResolution)
      await updateTaskStatus(task.id, "completed", undefined, completedOutput)
    } catch (error) {
      unsub?.()
      log.error("task execution failed", { taskID: task.id, error })
      await updateTaskStatus(task.id, "error", String(error))
    }
  }

  async function completedTaskOutput(
    task: CortexTypes.Task,
    agent: Awaited<ReturnType<typeof Agent.get>>,
    outputConfig: CortexTypes.OutputConfig,
    resolution: CortexOutput.Resolution | undefined,
  ): Promise<CortexTypes.TaskOutput> {
    if (outputConfig.mode === "final_response") {
      return resolution?.ok ? resolution.output : { mode: "final_response", value: "" }
    }
    if (outputConfig.mode === "structured") {
      if (!resolution?.ok) throw new Error("Structured Cortex output was not resolved")
      return resolution.output
    }
    const value = agent.external
      ? await extractExternalTaskResult(task.sessionID)
      : await Trajectory.summarize(task.sessionID)
    return { mode: "summary", value }
  }

  async function taskUsage(sessionID: string): Promise<CortexTypes.TaskUsage> {
    const messages = await Session.messages({ sessionID, raw: true }).catch(() => [])
    return messages.reduce<CortexTypes.TaskUsage>(
      (total, message) => {
        if (message.info.role !== "assistant") return total
        total.inputTokens += message.info.tokens.input
        total.outputTokens += message.info.tokens.output
        total.reasoningTokens += message.info.tokens.reasoning
        total.cacheReadTokens += message.info.tokens.cache.read
        total.cacheWriteTokens += message.info.tokens.cache.write
        total.cost += message.info.cost
        return total
      },
      {
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        cost: 0,
      },
    )
  }

  function rootMessageID(message: MessageV2.WithParts): string {
    if (message.info.role === "assistant") return message.info.rootID ?? message.info.parentID
    return message.info.rootID ?? message.info.id
  }

  function truncate(value: string, maxChars: number): string {
    return value.length > maxChars ? value.slice(0, maxChars - 3) + "..." : value
  }

  async function updateTaskStatus(
    taskID: string,
    status: CortexTypes.TaskStatus,
    error?: string,
    output?: CortexTypes.TaskOutput,
  ): Promise<void> {
    const task = tasks.get(taskID)
    if (!task) return

    // Once cancel() accepts a request, an abort/error callback from the task
    // processor must not race it into the less precise "error" terminal state.
    if (cancellationRequests.has(taskID)) {
      status = "cancelled"
      error = undefined
      output = undefined
    }

    if (isTerminal(task.status)) {
      log.info("ignoring task status update for terminal task", { taskID, current: task.status, next: status })
      return
    }
    if (finalizingTasks.has(taskID)) {
      if (status === "cancelled") {
        task.status = "cancelled"
        task.completedAt ??= Date.now()
        task.error = undefined
        task.output = undefined
        tasks.set(taskID, task)
        publishVisibleTasksUpdate()
        log.info("published cancellation during concurrent task finalization", { taskID })
        return
      }
      log.info("ignoring concurrent task finalization", { taskID, next: status })
      return
    }
    finalizingTasks.add(taskID)

    try {
      const terminalTask: CortexTypes.Task = {
        ...task,
        status,
        completedAt: Date.now(),
        usage: await taskUsage(task.sessionID),
      }
      if (error) terminalTask.error = error
      if (output) terminalTask.output = output
      const waiters = taskWaiters.get(taskID)
      const shouldNotifyParent = !waiters?.size && terminalTask.notifyParentOnComplete !== false
      terminalTask.notifyParentOnComplete = shouldNotifyParent

      const timeout = taskTimeouts.get(taskID)
      if (timeout) {
        clearTimeout(timeout)
        taskTimeouts.delete(taskID)
      }

      await Session.update(task.sessionID, (draft) => {
        if (draft.cortex) {
          draft.cortex.status = status
          draft.cortex.completedAt = terminalTask.completedAt
          draft.cortex.model = terminalTask.model
          if (error) draft.cortex.error = error
          if (output) draft.cortex.output = output
          draft.cortex.usage = terminalTask.usage
          draft.cortex.notifyParentOnComplete = shouldNotifyParent
        }
      }).catch((error) => {
        log.error("failed to persist terminal task fields", { taskID, error })
      })

      // Cancellation may arrive while usage/session metadata is being
      // persisted. Reconcile once more immediately before the synchronous
      // publication boundary so an accepted cancel cannot surface as error.
      if (cancellationRequests.has(taskID) && terminalTask.status !== "cancelled") {
        terminalTask.status = "cancelled"
        terminalTask.error = undefined
        terminalTask.output = undefined
        await Session.update(task.sessionID, (draft) => {
          if (draft.cortex) {
            draft.cortex.status = "cancelled"
            draft.cortex.error = undefined
            draft.cortex.output = undefined
          }
        }).catch((error) => {
          log.error("failed to persist task cancellation", { taskID, error })
        })
      }

      if (acquiredTasks.delete(taskID)) {
        CortexConcurrency.release(terminalTask.agent)
      }

      if (!shouldNotifyParent) {
        if (waiters?.size) {
          log.info("task result has waiters, skipping mail", { taskID, waiterCount: waiters.size })
        } else {
          log.info("task parent notification suppressed", { taskID })
        }
      }

      // Keep the task handle returned by launch() live while still publishing
      // the terminal transition at this single, ordered boundary.
      Object.assign(task, terminalTask)
      tasks.set(taskID, task)
      log.info("task status updated", { taskID, status: terminalTask.status })
      emitPluginTaskObservability(terminalTask, terminalTask.status)
      publishVisibleTasksUpdate()

      if (terminalTask.visibility !== "hidden") {
        Bus.publish(Event.TaskCompleted, { task: terminalTask })
      }
      if (shouldNotifyParent) {
        await notifyParentSession(terminalTask).catch((error) => {
          log.error("failed to notify parent session", {
            taskID,
            parentSessionID: terminalTask.parentSessionID,
            error,
          })
        })
      }
      const pluginSnapshot = pluginTaskSnapshotFromTask(terminalTask)
      if (pluginSnapshot) {
        void Session.get(terminalTask.sessionID)
          .then((session) =>
            ScopeContext.provide({
              scope: session.scope,
              fn: () =>
                Plugin.triggerForPlugin(
                  pluginSnapshot.owner.pluginId,
                  pluginSnapshot.owner.pluginGeneration,
                  "cortex.task.after",
                  { task: pluginSnapshot },
                  {},
                ),
            }),
          )
          .catch((error) => {
            log.error("cortex task hook failed", { taskID, error })
          })
      }

      void updateDagNode(terminalTask)

      if (waiters?.size) {
        for (const waiter of waiters) {
          clearTimeout(waiter.timeout)
          waiter.resolve(terminalTask)
        }
        taskWaiters.delete(taskID)
        log.info("task result delivered to waiters", { taskID, waiterCount: waiters.size })
      }

      void cleanupChildWorktree(terminalTask)

      setTimeout(() => {
        const task = tasks.get(taskID)
        if (task) {
          task.prompt = truncate(task.prompt, 4096)
          task.progress = undefined
          log.info("task compacted", { taskID })
        }
      }, PROMPT_COMPACT_DELAY_MS)

      setTimeout(() => {
        tasks.delete(taskID)
        taskBudgets.delete(taskID)
        acquiredTasks.delete(taskID)
        SessionManager.unregisterRuntime(terminalTask.sessionID)
        log.info("task cleaned up", { taskID })
      }, TASK_CLEANUP_DELAY_MS)
    } finally {
      // Once the terminal state is published, isTerminal() is the durable race
      // guard. Keeping task IDs here would turn this lock into a lifetime leak.
      finalizingTasks.delete(taskID)
      cancellationRequests.delete(taskID)
    }
  }

  async function updateDagNode(task: CortexTypes.Task): Promise<void> {
    if (!task.dagNodeId) return
    try {
      const nodes = await Dag.get(task.parentSessionID)
      const node = nodes.find((n) => n.id === task.dagNodeId)
      if (!node) return
      node.status = task.status === "completed" ? "completed" : "failed"
      const raw =
        task.status === "completed" ? CortexOutput.renderTaskOutputForDag(task.output) : (task.error ?? "Task failed")
      node.result = truncate(raw, 8192)
      Dag.autoPromote(nodes)
      await Dag.update({ sessionID: task.parentSessionID, nodes })
      log.info("dag node updated", { dagNodeId: task.dagNodeId, status: node.status })
    } catch (error) {
      log.error("failed to update dag node", { dagNodeId: task.dagNodeId, error })
    }
  }

  function parentNotificationKey(taskID: string): string {
    return `cortex:taskNotification:${taskID}`
  }

  function parentNotificationLock(taskID: string): string {
    return `cortex-parent-notification:${taskID}`
  }

  export async function acknowledgeParentCompletion(input: {
    taskID: string
    parentSessionID: string
  }): Promise<boolean> {
    const task = tasks.get(input.taskID)
    if (task && (task.parentSessionID !== input.parentSessionID || !isTerminal(task.status))) return false

    using _ = await Lock.write(parentNotificationLock(input.taskID))
    let session = task ? await Session.get(task.sessionID).catch(() => undefined) : undefined
    if (!session?.cortex || session.cortex.taskID !== input.taskID) {
      const children = await Session.children(input.parentSessionID).catch(() => [])
      session = children.find((child) => child.cortex?.taskID === input.taskID)
    }
    const delegation = session?.cortex
    if (
      !session ||
      !delegation ||
      delegation.parentSessionID !== input.parentSessionID ||
      !isTerminal(delegation.status)
    ) {
      return false
    }

    if (!task) log.warn("acknowledging parent completion from durable delegation", input)
    if (task) task.notifyParentOnComplete = false
    await Session.update(session.id, (draft) => {
      if (!draft.cortex || draft.cortex.taskID !== input.taskID) return
      draft.cortex.notifyParentOnComplete = false
    })
    const deliveryKey = parentNotificationKey(input.taskID)
    const pending = (await SessionInbox.list(input.parentSessionID)).find((item) => item.deliveryKey === deliveryKey)
    if (pending) await SessionInbox.remove({ sessionID: input.parentSessionID, itemID: pending.id })
    log.info("acknowledged parent task completion", input)
    return true
  }

  export async function reconcileParentNotifications(scopeID?: string): Promise<void> {
    const sessionIDs = await SessionManager.listCortexDelegationsForParentDelivery(scopeID)
    for (const sessionID of sessionIDs) {
      const session = await Session.get(sessionID).catch(() => undefined)
      const delegation = session?.cortex
      if (!session || !delegation || !isTerminal(delegation.status)) continue
      if (delegation.notifyParentOnComplete !== true || delegation.visibility === "hidden") continue

      if (delegation.deliveryNotifiedAt) {
        const deliveryKey = parentNotificationKey(delegation.taskID)
        const pending = (await SessionInbox.list(delegation.parentSessionID)).some(
          (item) => item.deliveryKey === deliveryKey,
        )
        if (pending) await SessionDrive.request(delegation.parentSessionID, "cortex-completion-recovery")
        continue
      }

      await notifyParentSession({
        id: delegation.taskID,
        sessionID: session.id,
        parentSessionID: delegation.parentSessionID,
        description: delegation.description,
        status: delegation.status,
        startedAt: delegation.startedAt,
        completedAt: delegation.completedAt,
        error: delegation.error,
      }).catch((error) => {
        log.error("failed to reconcile parent notification", {
          taskID: delegation.taskID,
          parentSessionID: delegation.parentSessionID,
          error,
        })
      })
    }
  }

  async function notifyParentSession(task: {
    id: string
    sessionID: string
    parentSessionID: string
    description: string
    status: CortexTypes.TaskStatus
    startedAt: number
    completedAt?: number
    error?: string
  }): Promise<void> {
    const statusText =
      task.status === "error"
        ? "FAILED"
        : task.status === "cancelled"
          ? "CANCELLED"
          : task.status === "interrupted"
            ? "INTERRUPTED"
            : "COMPLETED"
    const notification = [
      `[BACKGROUND TASK ${statusText}]`,
      `**ID:** \`${task.id}\``,
      `**Description:** ${task.description}`,
      `**Duration:** ${formatDuration(task)}`,
      task.status === "error" && task.error ? `**Error:** ${task.error}` : "",
      `Retrieve the final result once with \`task_output(task_id="${task.id}", mode="full")\`.`,
    ]
      .filter(Boolean)
      .join("\n")
    const deliveryKey = parentNotificationKey(task.id)
    using _ = await Lock.write(parentNotificationLock(task.id))
    const session = await Session.get(task.sessionID).catch(() => undefined)
    if (!session?.cortex || session.cortex.taskID !== task.id) return
    if (session.cortex.notifyParentOnComplete !== true) return

    const delivery = await SessionInbox.deliverUnique({
      sessionID: task.parentSessionID,
      deliveryKey,
      mode: "steer",
      message: {
        role: "user",
        metadata: { source: "cortex", sourceSessionID: task.sessionID },
        parts: [{ type: "text", text: notification }],
      },
    })
    await Session.update(task.sessionID, (draft) => {
      if (!draft.cortex || draft.cortex.taskID !== task.id) return
      draft.cortex.deliveryNotifiedAt ??= Date.now()
    })

    const pending = await SessionInbox.getStored(task.parentSessionID, delivery.itemID).catch(() => undefined)
    if (pending) await SessionDrive.request(task.parentSessionID, "cortex-completion")
  }

  function isTerminal(status: CortexTypes.TaskStatus): boolean {
    return status === "completed" || status === "error" || status === "cancelled" || status === "interrupted"
  }

  export type TaskHealth = "queued" | "active" | "tool-running" | "stale" | "terminal"

  function formatDuration(task: { startedAt: number; completedAt?: number }): string {
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
    return listVisible().filter(
      (t) => t.status === "completed" || t.status === "error" || t.status === "cancelled" || t.status === "interrupted",
    )
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

  function taskFromDurableSession(session: import("../session/types").Info): CortexTypes.Task | undefined {
    const delegation = session.cortex
    if (!delegation) return undefined
    return {
      id: delegation.taskID,
      sessionID: session.id,
      parentSessionID: delegation.parentSessionID,
      parentMessageID: delegation.parentMessageID,
      description: delegation.description,
      prompt: "",
      agent: delegation.agent,
      model: delegation.model,
      executionRole: delegation.executionRole,
      status: delegation.status,
      startedAt: delegation.startedAt,
      completedAt: delegation.completedAt,
      error: delegation.error,
      notifyParentOnComplete: delegation.notifyParentOnComplete,
      visibility: delegation.visibility,
      tools: delegation.tools,
      outputConfig: delegation.outputConfig,
      output: delegation.output,
      owner: delegation.owner,
      timeoutMs: delegation.timeoutMs,
      usage: delegation.usage,
    }
  }

  export async function getVisibleTaskForOutput(
    parentSessionID: string,
    taskID: string,
  ): Promise<CortexTypes.Task | undefined> {
    const live = getVisibleTask(parentSessionID, taskID)
    if (live) return live

    const children = await Session.children(parentSessionID).catch(() => [])
    const child = children.find(
      (session) =>
        session.cortex?.taskID === taskID &&
        session.cortex.parentSessionID === parentSessionID &&
        session.cortex.visibility !== "hidden" &&
        isTerminal(session.cortex.status),
    )
    return child ? taskFromDurableSession(child) : undefined
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
    cancellationRequests.add(taskID)
    SessionInvoke.cancel(task.sessionID)
    await updateTaskStatus(taskID, "cancelled")

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
    parentSessionID?: string,
  ): Promise<string> {
    const task =
      tasks.get(taskID) ?? (parentSessionID ? await getVisibleTaskForOutput(parentSessionID, taskID) : undefined)
    if (!task) {
      return `Task ${taskID} not found. It may have expired or been cancelled.`
    }

    if (mode === "progress" || mode === "summary") return renderProgress(task)
    if (mode === "tail") return renderTail(task)

    if (task.status === "queued" || task.status === "running") return renderProgress(task)

    if (task.status === "error") {
      return [renderProgress(task), "", "--- Error ---", task.error ?? "Unknown error"].join("\n")
    }

    return [renderProgress(task), "", "--- Result ---", CortexOutput.renderTaskOutput(task.output)].join("\n")
  }

  export function outputView(taskID: string) {
    const task = tasks.get(taskID)
    if (!task) {
      return {
        taskID,
        status: "error" as const,
        rendered: `Task ${taskID} not found. It may have expired or been cancelled.`,
        error: "Task not found",
      }
    }
    return CortexOutput.renderTaskOutputView(task)
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
        if (part.type === "text" && !MessageV2.isSystemPart(part)) {
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
    taskBudgets.clear()
    acquiredTasks.clear()
    finalizingTasks.clear()
    cancellationRequests.clear()
    for (const timeout of taskTimeouts.values()) clearTimeout(timeout)
    taskTimeouts.clear()
    if (progressUpdateTimer) {
      clearTimeout(progressUpdateTimer)
      progressUpdateTimer = undefined
    }
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
