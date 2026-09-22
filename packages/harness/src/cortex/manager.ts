import { ExecutionCapacity } from "../session/execution-capacity"
import { WorkspaceAccess } from "../workspace/access"
import { RuntimeContext } from "../lifecycle/context"
import { SessionExecutionContributions } from "../session/execution-contributions"
import { SessionUsage } from "../session/usage"
import { RolloutLifecycle } from "../session/rollout/lifecycle"
import { record, RolloutRecordingError } from "../session/rollout/error"
import { $ } from "bun"

import { BusyError } from "../session/error"
import { CortexWorkspace } from "./workspace"
import { Bus } from "../bus"
import { Config } from "../config/config"
import { Identifier } from "../id/id"
import { Log } from "../util/log"
import { Session } from "../session"
import { SessionInvoke, resolveInputParts } from "../session/invoke"
import { lastModel } from "../session/input"
import { SessionManager } from "../session/manager"
import { Agent } from "../agent/agent"
import { MessageV2 } from "../session/message-v2"
import { CortexTypes } from "./types"
import { Trajectory } from "./trajectory"
import { CortexConcurrency } from "./concurrency"
import { fn } from "../util/fn"
import { Dag } from "../session/dag"
import { CortexEvent } from "./event"
import { SessionPluginHooks } from "../session/plugin-hooks"
import { CortexOutput } from "./output"
import { ScopeContext } from "../scope/context"
import { Observability } from "../observability"
import { pluginTaskSnapshotFromTask } from "./plugin-task"
import { SessionInbox } from "../session/inbox"
import { SessionDrive } from "../session/drive"
import { LoopJob } from "../session/loop-job"
import { Lock } from "../util/lock"

export namespace Cortex {
  const log = Log.create({ service: "cortex" })

  const runtimeState = RuntimeContext.state(() => ({
    stopped: false,
    background: new Map<Promise<void>, string>(),
    backgroundErrors: [] as unknown[],
    retentionTimers: new Set<ReturnType<typeof setTimeout>>(),
    tasks: new Map() as Map<string, CortexTypes.Task>,
    taskWaiters: new Map() as Map<string, Set<{ resolve: (task: CortexTypes.Task) => void; timeout: Timer }>>,
    taskRuns: new Map() as Map<string, Promise<void>>,
    taskBudgets: new Map<string, { maxOutputTokens?: number; maxCost?: number }>(),
    acquiredTasks: new Set<string>(),
    capacityOwners: new Map<string, { controller: AbortController; unregister(): void }>(),
    admissions: new Map<string, AbortController>(),
    taskTimeouts: new Map<string, ReturnType<typeof setTimeout>>(),
    finalizingTasks: new Set<string>(),
    cancellationRequests: new Set<string>(),
    timeoutRequests: new Set<string>(),
    timeoutErrors: new Map<string, string>(),
    progressUpdateTimer: undefined as Timer | undefined,
  }))

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
    const instanceState = runtimeState()

    if (instanceState.stopped) throw new Error("Cortex is stopping")
    using _ = input.reuseInterrupted
      ? await Lock.write(`cortex-task-prepare:${input.parentSessionID}:${input.agent}:${input.parentMessageID}`)
      : undefined
    if (input.reuseInterrupted) {
      const active = Array.from(instanceState.tasks.values()).find(
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
      new Set([...(config.cortex?.primaryOnlyTools ?? []), ...DEFAULT_SUBAGENT_BLOCKED_TOOLS]),
    )

    const reusableSession =
      input.reuseInterrupted && !input.sessionID
        ? (await Session.children(input.parentSessionID)).find(
            (child) =>
              child.cortex?.parentMessageID === input.parentMessageID &&
              child.cortex.agent === input.agent &&
              (child.cortex.status === "queued" || child.cortex.status === "interrupted"),
          )
        : undefined
    const existing = input.sessionID ? await Session.get(input.sessionID) : reusableSession
    if (input.sessionID && !existing) throw new Error(`Session ${input.sessionID} not found`)

    let session: import("../session/types").Info

    if (existing) {
      if (existing.parentID !== input.parentSessionID) {
        throw new Error(
          `Session ${existing.id} does not belong to parent session ${input.parentSessionID}. ` +
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
        scope: parent.scope as import("../scope").Scope,
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
          const created = await CortexWorkspace.create({
            name: input.worktree?.name,
            sessionID: session.id,
            baseRef: input.worktree?.baseRef ?? "current",
            baseRevision: input.worktree?.baseRevision,
          })
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
      draft.cortex.launchFailure = undefined
      draft.cortex.deliveryNotifiedAt = undefined
      draft.cortex.output = undefined
      draft.cortex.owner = input.owner
      draft.cortex.timeoutMs = input.timeoutMs
      draft.cortex.tools = input.tools
      draft.cortex.outputConfig = input.output
      draft.cortex.visibility = input.visibility
      draft.completionNotice.silent = input.visibility === "hidden"
    })
    instanceState.taskBudgets.set(taskID, {
      maxOutputTokens: input.maxOutputTokens,
      maxCost: input.maxCost,
    })

    instanceState.tasks.set(taskID, task)
    emitPluginTaskObservability(task, "started")
    emitPluginTaskObservability(task, "queued")
    SessionManager.registerChildRuntime(session.id)

    if (task.visibility !== "hidden") {
      Bus.publish(Event.TaskCreated, { task })
    }

    return task
  })

  export async function start(taskID: string): Promise<CortexTypes.Task> {
    const instanceState = runtimeState()
    if (instanceState.stopped) throw new Error("Cortex is stopping")

    using _ = await Lock.write(`cortex-task-start:${taskID}`)
    const task = instanceState.tasks.get(taskID)
    if (!task) throw new Error(`Cortex task ${taskID} not found`)
    if (task.status !== "queued") return task

    const admission = new AbortController()
    instanceState.admissions.set(taskID, admission)
    try {
      await ExecutionCapacity.wait(() => CortexConcurrency.acquire(task.agent, admission.signal))
    } catch (error) {
      if (instanceState.cancellationRequests.has(taskID) || isTerminal(task.status)) return task
      throw error
    } finally {
      if (instanceState.admissions.get(taskID) === admission) instanceState.admissions.delete(taskID)
    }
    instanceState.acquiredTasks.add(taskID)

    const current = instanceState.tasks.get(taskID)
    if (!current || current.status === "cancelled") {
      instanceState.taskBudgets.delete(taskID)
      instanceState.acquiredTasks.delete(taskID)
      CortexConcurrency.release(task.agent)
      return current ?? task
    }

    const controller = new AbortController()
    let resuming: Promise<void> | undefined
    const branches = new Set<{ active: boolean }>()
    const pause = () => {
      if (instanceState.acquiredTasks.delete(taskID)) CortexConcurrency.release(task.agent)
    }
    const resume = async () => {
      if (instanceState.acquiredTasks.has(taskID) || controller.signal.aborted) return
      if (resuming) return resuming
      resuming = (async () => {
        try {
          await CortexConcurrency.acquire(task.agent, controller.signal)
          if (controller.signal.aborted) {
            CortexConcurrency.release(task.agent)
            return
          }
          instanceState.acquiredTasks.add(taskID)
        } catch (error) {
          if (!controller.signal.aborted) throw error
        }
      })().finally(() => {
        resuming = undefined
      })
      return resuming
    }
    const unregister = ExecutionCapacity.registerSession(task.sessionID, {
      pause,
      resume,
      fork() {
        const branch = { active: true }
        branches.add(branch)
        return {
          pause() {
            branch.active = false
            if (![...branches].some((branch) => branch.active)) pause()
          },
          async resume() {
            await resume()
            branch.active = true
          },
          finish() {
            branches.delete(branch)
            if (branches.size && ![...branches].some((branch) => branch.active)) pause()
          },
        }
      },
    })
    instanceState.capacityOwners.set(taskID, { controller, unregister })
    await setTaskStatus(taskID, "running")

    const budget = instanceState.taskBudgets.get(taskID)
    instanceState.taskBudgets.delete(taskID)
    const run = runTask(current, current.model, budget?.maxOutputTokens, budget?.maxCost)
      .catch(async (error) => {
        log.error("task error", { taskID, error })
        await updateTaskStatus(taskID, "error", String(error), undefined, { launchFailure: true })
      })
      .finally(() => {
        instanceState.taskRuns.delete(taskID)
      })
    instanceState.taskRuns.set(taskID, run)

    if (current.timeoutMs) {
      const timeout = setTimeout(() => {
        track(
          taskID,
          (async () => {
            const active = instanceState.tasks.get(taskID)
            if (!active || isTerminal(active.status)) return
            // Claim the deadline before any await so a concurrently settling run
            // cannot publish completed first; updateTaskStatus converts the claim.
            if (instanceState.timeoutRequests.has(taskID)) return
            instanceState.timeoutRequests.add(taskID)
            if (isTerminal(instanceState.tasks.get(taskID)?.status ?? "queued")) {
              instanceState.timeoutRequests.delete(taskID)
              return
            }
            const message = `Task exceeded its ${current.timeoutMs}ms runtime limit.`
            instanceState.timeoutErrors.set(taskID, message)
            try {
              await SessionInbox.fenceQueuedWork(active.sessionID, (fenceQueuedBefore) => {
                SessionInvoke.cancel(active.sessionID, { fenceQueuedWork: true, fenceQueuedBefore })
              })
            } catch (error) {
              SessionInvoke.cancel(active.sessionID, { fenceQueuedWork: true })
              log.error("failed to discard queued follow-ups on timeout", { taskID, error })
              instanceState.timeoutErrors.set(
                taskID,
                `${message} Queued follow-up cleanup failed; they may still be queued.`,
              )
            }
            await updateTaskStatus(taskID, "error", instanceState.timeoutErrors.get(taskID))
          })(),
        )
      }, current.timeoutMs)
      instanceState.taskTimeouts.set(taskID, timeout)
    }

    return current
  }

  export const launch = fn(CortexTypes.LaunchInput, async (input) => {
    const task = await prepare(input)
    return WorkspaceAccess.handoff(() => start(task.id))
  })

  async function setTaskStatus(taskID: string, status: CortexTypes.TaskStatus): Promise<void> {
    const instanceState = runtimeState()

    const task = instanceState.tasks.get(taskID)
    if (!task) return

    task.status = status
    instanceState.tasks.set(taskID, task)
    log.info("task status updated", { taskID, status })
    emitPluginTaskObservability(task, status)

    await Session.update(task.sessionID, (draft) => {
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
    track(
      task.id,
      Observability.emit(`plugin.task.${phase}`, {
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
      }),
    )
  }

  function publishVisibleTasksUpdate(): void {
    track("", Bus.publish(Event.TasksUpdated, { tasks: listVisible() }))
  }

  function scheduleProgressUpdate(task: CortexTypes.Task): void {
    const instanceState = runtimeState()

    if (task.visibility === "hidden") return
    if (instanceState.progressUpdateTimer) return
    instanceState.progressUpdateTimer = setTimeout(() => {
      instanceState.progressUpdateTimer = undefined
      publishVisibleTasksUpdate()
    }, PROGRESS_UPDATE_EVENT_DELAY_MS)
  }

  async function runTask(
    task: CortexTypes.Task,
    model?: { providerID: string; modelID: string },
    maxOutputTokens?: number,
    maxCost?: number,
  ): Promise<void> {
    const instanceState = runtimeState()

    log.info("running task", { taskID: task.id, sessionID: task.sessionID })

    const initial = instanceState.tasks.get(task.id)
    if (!initial || initial.status === "cancelled") return

    const agent = await Agent.get(task.agent)
    const resolvedModel =
      model ?? (await Agent.getAvailableModel(agent)) ?? (await lastModel(task.parentSessionID).catch(() => undefined))

    if (!resolvedModel) {
      throw new Error(`No model configured for agent ${task.agent}`)
    }
    const outputConfig = CortexOutput.normalize(task.outputConfig)
    if (agent.external && outputConfig.mode === "structured") {
      throw new Error("Structured Cortex output is not supported for external agents")
    }
    CortexOutput.assertValidStructuredSchema(outputConfig)
    const currentTask = instanceState.tasks.get(task.id)
    if (currentTask) {
      currentTask.model = resolvedModel
      instanceState.tasks.set(task.id, currentTask)
    }
    // Persist resolved model to session metadata
    await Session.update(task.sessionID, (draft) => {
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
        const current = instanceState.tasks.get(task.id)
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
          instanceState.tasks.set(task.id, current)
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
          instanceState.tasks.set(task.id, current)
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
        origin: { type: "system" },
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
            origin: { type: "system" },
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
    const digest = await SessionUsage.read(await Session.get(sessionID))
    return {
      inputTokens: digest.tokens.input,
      outputTokens: digest.tokens.output,
      reasoningTokens: digest.tokens.reasoning,
      cacheReadTokens: digest.tokens.cache.read,
      cacheWriteTokens: digest.tokens.cache.write,
      cost: digest.cost,
      accounting: digest.accounting,
    }
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
    options?: { launchFailure?: boolean },
  ): Promise<void> {
    const instanceState = runtimeState()

    const task = instanceState.tasks.get(taskID)
    if (!task) return

    if (instanceState.cancellationRequests.has(taskID)) {
      status = "cancelled"
      error = undefined
      output = undefined
      options = undefined
    }
    const timeoutMessage = instanceState.timeoutErrors.get(taskID)
    if (timeoutMessage !== undefined) {
      status = "error"
      error = timeoutMessage
      output = undefined
      options = undefined
    }

    if (isTerminal(task.status)) {
      log.info("ignoring task status update for terminal task", { taskID, current: task.status, next: status })
      return
    }
    if (instanceState.finalizingTasks.has(taskID)) {
      if (status === "cancelled") {
        task.status = "cancelled"
        task.completedAt ??= Date.now()
        task.error = undefined
        task.output = undefined
        instanceState.tasks.set(taskID, task)
        await record(() =>
          Session.update(task.sessionID, (draft) => {
            if (!draft.cortex) return
            draft.cortex.status = "cancelled"
            draft.cortex.completedAt = task.completedAt
            draft.cortex.error = undefined
            draft.cortex.output = undefined
          }),
        )
        publishVisibleTasksUpdate()
        log.info("published cancellation during concurrent task finalization", { taskID })
        return
      }
      if (instanceState.timeoutErrors.has(taskID)) {
        task.status = "error"
        task.completedAt ??= Date.now()
        task.error = instanceState.timeoutErrors.get(taskID)
        instanceState.tasks.set(taskID, task)
        await record(() =>
          Session.update(task.sessionID, (draft) => {
            if (!draft.cortex) return
            draft.cortex.status = "error"
            draft.cortex.completedAt = task.completedAt
            draft.cortex.error = task.error
          }),
        )
        publishVisibleTasksUpdate()
        log.info("published runtime-limit failure during concurrent task finalization", { taskID })
        return
      }
      log.info("ignoring concurrent task finalization", { taskID, next: status })
      return
    }
    instanceState.finalizingTasks.add(taskID)

    try {
      const terminalTask: CortexTypes.Task = {
        ...task,
        status,
        completedAt: Date.now(),
        usage: await taskUsage(task.sessionID),
      }
      if (error) terminalTask.error = error
      if (output) terminalTask.output = output
      if (options?.launchFailure) terminalTask.launchFailure = true
      const waiters = instanceState.taskWaiters.get(taskID)
      const shouldNotifyParent = !waiters?.size && terminalTask.notifyParentOnComplete !== false
      terminalTask.notifyParentOnComplete = shouldNotifyParent

      const timeout = instanceState.taskTimeouts.get(taskID)
      if (timeout) {
        clearTimeout(timeout)
        instanceState.taskTimeouts.delete(taskID)
      }

      await record(() =>
        Session.update(task.sessionID, (draft) => {
          if (draft.cortex) {
            draft.cortex.status = status
            draft.cortex.completedAt = terminalTask.completedAt
            draft.cortex.model = terminalTask.model
            if (error) draft.cortex.error = error
            if (output) draft.cortex.output = output
            draft.cortex.launchFailure = options?.launchFailure === true ? true : undefined
            draft.cortex.usage = terminalTask.usage
            draft.cortex.notifyParentOnComplete = shouldNotifyParent
          }
        }),
      )

      // Cancellation or a claimed runtime deadline may arrive while usage and
      // session metadata are being persisted. Reconcile once more immediately
      // before the synchronous publication boundary so an accepted cancel or
      // timeout cannot surface as completed.
      const forcedStatus = instanceState.cancellationRequests.has(taskID)
        ? "cancelled"
        : instanceState.timeoutErrors.has(taskID)
          ? "error"
          : undefined
      if (forcedStatus && terminalTask.status !== forcedStatus) {
        terminalTask.status = forcedStatus
        terminalTask.error = forcedStatus === "error" ? instanceState.timeoutErrors.get(taskID) : undefined
        terminalTask.output = undefined
        terminalTask.launchFailure = undefined
        await record(() =>
          Session.update(task.sessionID, (draft) => {
            if (!draft.cortex) return
            draft.cortex.status = forcedStatus
            draft.cortex.error = terminalTask.error
            draft.cortex.output = undefined
            draft.cortex.launchFailure = undefined
          }),
        )
      }

      const capacity = instanceState.capacityOwners.get(taskID)
      capacity?.controller.abort(new DOMException("Cortex task ended", "AbortError"))
      capacity?.unregister()
      instanceState.capacityOwners.delete(taskID)
      if (instanceState.acquiredTasks.delete(taskID)) {
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
      instanceState.tasks.set(taskID, task)
      log.info("task status updated", { taskID, status: terminalTask.status })
      emitPluginTaskObservability(terminalTask, terminalTask.status)
      publishVisibleTasksUpdate()

      if (terminalTask.visibility !== "hidden") {
        Bus.publish(Event.TaskCompleted, { task: terminalTask })
      }
      let deliverySettled = true
      if (shouldNotifyParent) {
        await notifyParentSession(terminalTask).catch((error) => {
          if (RolloutRecordingError.isInstance(error)) throw error
          deliverySettled = false
          log.error("failed to notify parent session", {
            taskID,
            parentSessionID: terminalTask.parentSessionID,
            error,
          })
        })
      } else {
        await requestSilentParentDrive({
          parentSessionID: terminalTask.parentSessionID,
          tasks: [{ sessionID: terminalTask.sessionID, taskID: terminalTask.id }],
          reason: "cortex-completion",
        }).catch((error) => {
          if (RolloutRecordingError.isInstance(error)) throw error
          deliverySettled = false
          log.error("failed to drive parent session after task completion", {
            taskID,
            parentSessionID: terminalTask.parentSessionID,
            error,
          })
        })
      }
      const pluginSnapshot = pluginTaskSnapshotFromTask(terminalTask)
      if (pluginSnapshot) {
        await Session.get(terminalTask.sessionID)
          .then((session) =>
            ScopeContext.provide({
              scope: session.scope,
              fn: () =>
                SessionPluginHooks.triggerForPlugin(
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

      await updateDagNode(terminalTask)
      // Detached summary/title work for the child session writes through the
      // worktree snapshot; settle it before the managed directory is removed
      // or the summary's git diff races the cleanup into a failed diff state.
      try {
        await LoopJob.settleDetached(task.sessionID)
      } catch (error) {
        log.warn("child detached work failed to settle before worktree cleanup", { taskID: task.id, error })
      }
      await cleanupChildWorktree(terminalTask)

      if (deliverySettled) {
        const settled = await record(() =>
          Session.update(task.sessionID, (draft) => {
            if (draft.cortex) draft.cortex.settledAt = Date.now()
          }),
        )
        const parent = await RolloutLifecycle.parent(settled)
        if (parent?.owner.kind === "session" && parent.runID)
          await RolloutLifecycle.reconcile(parent.owner.sessionID, parent.runID)
      }

      if (waiters?.size) {
        for (const waiter of waiters) {
          clearTimeout(waiter.timeout)
          waiter.resolve(terminalTask)
        }
        instanceState.taskWaiters.delete(taskID)
        log.info("task result delivered to waiters", { taskID, waiterCount: waiters.size })
      }

      retain(() => {
        const task = instanceState.tasks.get(taskID)
        if (task) {
          task.prompt = truncate(task.prompt, 4096)
          task.progress = undefined
          log.info("task compacted", { taskID })
        }
      }, PROMPT_COMPACT_DELAY_MS)

      retain(() => {
        instanceState.tasks.delete(taskID)
        instanceState.taskBudgets.delete(taskID)
        instanceState.acquiredTasks.delete(taskID)
        SessionManager.unregisterRuntime(terminalTask.sessionID)
        log.info("task cleaned up", { taskID })
      }, TASK_CLEANUP_DELAY_MS)
    } finally {
      // Once the terminal state is published, isTerminal() is the durable race
      // guard. Keeping task IDs here would turn this lock into a lifetime leak.
      instanceState.finalizingTasks.delete(taskID)
      instanceState.cancellationRequests.delete(taskID)
      instanceState.timeoutRequests.delete(taskID)
      instanceState.timeoutErrors.delete(taskID)
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
    const instanceState = runtimeState()

    const task = instanceState.tasks.get(input.taskID)
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
    const sessionIDs = await SessionManager.listTerminalCortexDelegations(scopeID)
    const silentTasksByParent = new Map<
      string,
      Array<{
        sessionID: string
        taskID: string
        parentMessageID: string
        deliveryNotifiedAt?: number
        parent: Session.Info
      }>
    >()

    for (const sessionID of sessionIDs) {
      const session = await Session.get(sessionID).catch(() => undefined)
      const delegation = session?.cortex
      if (!session || !delegation || !isTerminal(delegation.status)) continue

      if (delegation.notifyParentOnComplete !== true || delegation.visibility === "hidden") {
        const parent = await Session.get(delegation.parentSessionID).catch(() => undefined)
        if (!parent || !hasContinuationWorkflow(parent)) continue
        const candidates = silentTasksByParent.get(parent.id) ?? []
        candidates.push({
          sessionID: session.id,
          taskID: delegation.taskID,
          parentMessageID: delegation.parentMessageID,
          deliveryNotifiedAt: delegation.deliveryNotifiedAt,
          parent,
        })
        silentTasksByParent.set(parent.id, candidates)
        continue
      }

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
        parentMessageID: delegation.parentMessageID,
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

    const { ContinuationKernel } = await import("../session/continuation-kernel")
    for (const candidates of silentTasksByParent.values()) {
      const parent = candidates[0]?.parent
      if (!parent) continue
      const gate = await ScopeContext.provide({
        scope: parent.scope,
        fn: () => ContinuationKernel.passesSharedGate(parent.id),
      })
      if (!gate) continue
      const current = candidates.filter((candidate) => candidate.parentMessageID === gate.terminalMessageID)
      if (current.length === 0) continue
      const undelivered = current
        .filter((candidate) => candidate.deliveryNotifiedAt === undefined)
        .map(({ sessionID, taskID }) => ({ sessionID, taskID }))

      await ScopeContext.provide({
        scope: parent.scope,
        fn: async () => {
          if (undelivered.length > 0) {
            await requestSilentParentDrive({
              parentSessionID: parent.id,
              tasks: undelivered,
              reason: "cortex-completion-recovery",
            })
            return
          }
          if (await SessionInbox.hasRunnableItem(parent.id)) {
            await SessionDrive.request(parent.id, "cortex-completion-recovery")
          }
        },
      }).catch((error) => {
        log.error("failed to drive parent session after silent task recovery", {
          parentSessionID: parent.id,
          error,
        })
      })
    }
  }

  const hasContinuationWorkflow = SessionExecutionContributions.hasContinuation

  async function requestSilentParentDrive(input: {
    parentSessionID: string
    tasks: Array<{ sessionID: string; taskID: string }>
    reason: string
  }): Promise<boolean> {
    const handled = await SessionDrive.request(input.parentSessionID, input.reason)
    if (!handled) return false
    const deliveredAt = Date.now()
    await Promise.all(
      input.tasks.map(({ sessionID, taskID }) =>
        Session.update(sessionID, (draft) => {
          if (!draft.cortex || draft.cortex.taskID !== taskID) return
          draft.cortex.deliveryNotifiedAt ??= deliveredAt
        }),
      ),
    )
    return true
  }

  async function notifyParentSession(task: {
    id: string
    sessionID: string
    parentSessionID: string
    parentMessageID: string
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
    const parentSession = await Session.get(task.parentSessionID).catch(() => undefined)
    const parentChannel = parentSession?.endpoint?.kind === "channel" ? parentSession.endpoint.channel : undefined
    const parentMessage = await MessageV2.get({
      sessionID: task.parentSessionID,
      messageID: task.parentMessageID,
    }).catch(() => undefined)
    const parentRootID = parentMessage?.info.rootID ?? parentMessage?.info.id
    const parentRoot = parentRootID
      ? await MessageV2.get({ sessionID: task.parentSessionID, messageID: parentRootID }).catch(() => undefined)
      : undefined
    const channelReplyToMessageId =
      parentRoot?.info.role === "user" &&
      typeof parentRoot.info.metadata?.channelReplyToMessageId === "string" &&
      parentRoot.info.metadata.channelReplyToMessageId.trim()
        ? parentRoot.info.metadata.channelReplyToMessageId
        : undefined
    const replyToChannel = parentChannel?.type !== "app" && !!parentChannel?.accountId && !!channelReplyToMessageId

    const delivery = await SessionInbox.deliverUnique({
      sessionID: task.parentSessionID,
      deliveryKey,
      mode: "steer",
      message: {
        role: "user",
        metadata: {
          source: "cortex",
          sourceSessionID: task.sessionID,
          ...(replyToChannel ? { channelPush: true, channelReply: true, channelReplyToMessageId } : {}),
        },
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
    return CortexTypes.isTerminalStatus(status)
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
    const instanceState = runtimeState()

    return instanceState.tasks.get(taskID)
  }

  export function list(): CortexTypes.Task[] {
    const instanceState = runtimeState()

    return Array.from(instanceState.tasks.values())
  }

  export function listVisible(): CortexTypes.Task[] {
    const instanceState = runtimeState()

    return Array.from(instanceState.tasks.values()).filter((task) => task.visibility !== "hidden")
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
    const instanceState = runtimeState()

    return Array.from(instanceState.tasks.values()).filter((t) => t.parentSessionID === sessionID)
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
      launchFailure: delegation.launchFailure,
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
    const instanceState = runtimeState()

    const pending = [parentSessionID]
    const seen = new Set<string>()
    const result: CortexTypes.Task[] = []

    while (pending.length > 0) {
      const currentSessionID = pending.shift()!
      for (const task of Array.from(instanceState.tasks.values())) {
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
    const instanceState = runtimeState()

    const task = instanceState.tasks.get(taskID)
    if (!task) return
    if (isTerminal(task.status)) return

    log.info("cancelling task", { taskID, sessionID: task.sessionID, status: task.status })
    instanceState.cancellationRequests.add(taskID)
    instanceState.admissions.get(taskID)?.abort(new DOMException("Cortex task cancelled", "AbortError"))
    try {
      await SessionInbox.fenceQueuedWork(task.sessionID, (fenceQueuedBefore) => {
        SessionInvoke.cancel(task.sessionID, { fenceQueuedWork: true, fenceQueuedBefore })
      })
    } catch (error) {
      SessionInvoke.cancel(task.sessionID, { fenceQueuedWork: true })
      log.error("failed to discard queued follow-ups on cancel", { taskID, error })
      // Do not acknowledge: retained items could restart the cancelled work.
      instanceState.cancellationRequests.delete(taskID)
      throw new Error(
        `Task ${taskID} cancellation could not discard its queued follow-ups; they may still restart the session.`,
      )
    }
    await updateTaskStatus(taskID, "cancelled")
  }

  function track(taskID: string, operation: Promise<unknown>) {
    const state = runtimeState()
    const tracked = operation
      .then(
        () => {},
        (error) => {
          state.backgroundErrors.push(error)
          log.error("Cortex background task failed", { taskID, error })
        },
      )
      .finally(() => state.background.delete(tracked))
    state.background.set(tracked, taskID)
  }

  function retain(action: () => void, delay: number) {
    const state = runtimeState()
    if (state.stopped) return
    const timer = setTimeout(() => {
      state.retentionTimers.delete(timer)
      action()
    }, delay)
    timer.unref()
    state.retentionTimers.add(timer)
  }

  export async function drain(taskID?: string): Promise<void> {
    const state = runtimeState()
    const task = taskID ? state.tasks.get(taskID) : undefined
    const selected = taskID
      ? new Set([taskID, ...getDescendantTasks(task?.sessionID ?? "").map((child) => child.id)])
      : undefined
    while (true) {
      const operations = [
        ...[...state.taskRuns].filter(([id]) => !selected || selected.has(id)).map(([, operation]) => operation),
        ...[...state.background].filter(([, id]) => !selected || selected.has(id)).map(([operation]) => operation),
      ]
      if (!operations.length) break
      await Promise.all(operations)
    }
    if (!selected && state.backgroundErrors.length)
      throw new AggregateError(state.backgroundErrors.splice(0), "Cortex background tasks failed")
  }

  export async function stop() {
    const state = runtimeState()
    state.stopped = true
    for (const admission of state.admissions.values()) admission.abort(new DOMException("Cortex stopped", "AbortError"))
    try {
      await drain()
    } finally {
      reset()
    }
  }

  export async function cancelAll(parentSessionID: string): Promise<number> {
    const toCancel = getDescendantTasks(parentSessionID).filter((t) => t.status === "running" || t.status === "queued")

    let cancelled = 0
    const failures: Error[] = []
    for (const task of toCancel) {
      try {
        await cancel(task.id)
        cancelled++
      } catch (error) {
        log.error("failed to cancel descendant task", { taskID: task.id, error })
        failures.push(new Error(`Task ${task.id} cancellation failed`, { cause: error }))
      }
    }

    if (failures.length) {
      throw new AggregateError(
        failures,
        `Cancelled ${cancelled} of ${toCancel.length} background tasks; ${failures.map((error) => error.message).join("; ")}.`,
      )
    }
    return cancelled
  }

  export async function output(
    taskID: string,
    mode: "summary" | "progress" | "tail" | "full" = "full",
    parentSessionID?: string,
  ): Promise<string> {
    const instanceState = runtimeState()

    const task =
      instanceState.tasks.get(taskID) ??
      (parentSessionID ? await getVisibleTaskForOutput(parentSessionID, taskID) : undefined)
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
    const instanceState = runtimeState()

    const task = instanceState.tasks.get(taskID)
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

  export async function waitFor(
    taskID: string,
    timeoutSeconds: number,
    signal = WorkspaceAccess.signal(),
  ): Promise<CortexTypes.Task | undefined> {
    const instanceState = runtimeState()
    signal?.throwIfAborted()
    const task = instanceState.tasks.get(taskID)
    if (!task || (task.status !== "running" && task.status !== "queued")) return task
    return WorkspaceAccess.handoff(
      () =>
        new Promise((resolve, reject) => {
          let settled = false
          const cleanup = () => {
            clearTimeout(waiter.timeout)
            signal?.removeEventListener("abort", abort)
            const waiters = instanceState.taskWaiters.get(taskID)
            waiters?.delete(waiter)
            if (waiters?.size === 0) instanceState.taskWaiters.delete(taskID)
          }
          const finish = (value: CortexTypes.Task | undefined) => {
            if (settled) return
            settled = true
            cleanup()
            resolve(value)
          }
          const abort = () => {
            if (settled) return
            settled = true
            cleanup()
            reject(signal?.reason)
          }
          const waiter = {
            resolve: finish,
            timeout: setTimeout(() => finish(instanceState.tasks.get(taskID)), Math.max(0, timeoutSeconds * 1000)),
          }
          if (!instanceState.taskWaiters.has(taskID)) instanceState.taskWaiters.set(taskID, new Set())
          instanceState.taskWaiters.get(taskID)!.add(waiter)
          signal?.addEventListener("abort", abort, { once: true })
          if (signal?.aborted) abort()
        }),
    )
  }

  export function reset(): void {
    const instanceState = runtimeState()

    for (const timer of instanceState.retentionTimers) clearTimeout(timer)
    instanceState.retentionTimers.clear()
    instanceState.tasks.clear()
    instanceState.taskRuns.clear()
    instanceState.taskBudgets.clear()
    for (const admission of instanceState.admissions.values())
      admission.abort(new DOMException("Cortex stopped", "AbortError"))
    instanceState.admissions.clear()
    for (const owner of instanceState.capacityOwners.values()) {
      owner.controller.abort(new DOMException("Cortex stopped", "AbortError"))
      owner.unregister()
    }
    instanceState.capacityOwners.clear()
    instanceState.acquiredTasks.clear()
    instanceState.finalizingTasks.clear()
    instanceState.cancellationRequests.clear()
    instanceState.timeoutRequests.clear()
    instanceState.timeoutErrors.clear()
    for (const timeout of instanceState.taskTimeouts.values()) clearTimeout(timeout)
    instanceState.taskTimeouts.clear()
    if (instanceState.progressUpdateTimer) {
      clearTimeout(instanceState.progressUpdateTimer)
      instanceState.progressUpdateTimer = undefined
    }
    for (const waiters of instanceState.taskWaiters.values()) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timeout)
      }
    }
    instanceState.taskWaiters.clear()
    CortexConcurrency.reset()
  }

  async function cleanupChildWorktree(task: CortexTypes.Task) {
    await CortexWorkspace.cleanup({ sessionID: task.sessionID, taskID: task.id })
  }
}
