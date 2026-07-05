import z from "zod"
import { Identifier } from "../id/id"
import { MessageV2 } from "./message-v2"
import { Log } from "../util/log"
import { Session } from "."
import { SessionEvent } from "./event"
import { Agent } from "../agent/agent"
import { Provider } from "../provider/provider"
import { SessionCompaction } from "./compaction"
import { Token } from "@/util/token"
import { ModelLimit } from "@ericsanchezok/synergy-util/model-limit"
import { Bus } from "../bus"
import { SystemPrompt } from "./system"
import { SessionEndpoint } from "./endpoint"
import { Plugin } from "../plugin"
import MAX_STEPS from "./prompt/max-steps.txt"
import CORTEX_REMINDER from "./prompt/cortex-reminder.txt"
import PLANNING_REMINDER from "./prompt/planning-reminder.txt"
import PLAN_MODE from "./prompt/plan-mode.txt"
import PLAN_MODE_SYNERGY from "./prompt/plan-mode-synergy.txt"
import PLAN_MODE_SYNERGY_MAX from "./prompt/plan-mode-synergy-max.txt"
import COAUTHOR_REMINDER from "./prompt/coauthor-reminder.txt"
import { defer } from "../util/defer"
import type { Command } from "../command/command"
import { $ } from "bun"
import { ConfigMarkdown } from "../config/markdown"
import "./summary"
import { NamedError } from "@ericsanchezok/synergy-util/error"
import { fn } from "@/util/fn"
import { SessionProcessor } from "./processor"
import { ExternalAgentProcessor } from "@/external-agent/processor"
import { ExternalAgent } from "@/external-agent/bridge"
import { withPreambleSection } from "@/agent/prompt/preamble"
import { SessionManager } from "./manager"
import { SessionInbox } from "./inbox"
import { SessionHistory } from "./history"
import { TimeoutConfig } from "@/util/timeout-config"
import { ToolResolver } from "./tool-resolver"
import { PromptBudgeter } from "./prompt-budgeter"
import { PermissionNext } from "@/permission/next"
import { ControlProfileCompiler } from "@/control-profile/compiler"
import { buildPermissionContext } from "./permission-context"
import { Config } from "@/config/config"
import { withTimeout } from "@/util/timeout"
import { lastModel, InvokeInput, resolveInputParts, createUserMessage } from "./input"
import { SessionProgress } from "./progress"
import {
  buildMemoryContext,
  buildAlwaysOnlyMemoryContext,
  cacheResult,
  getCachedResult,
  evictRecallCache,
  RECALL_TIMEOUT_MS,
  type InjectionInfo,
} from "./recall"
import "./title"

import { LLM } from "./llm"
import { ScopeContext } from "../scope/context"
import { Scope } from "@/scope"
import { LoopJob } from "./loop-job"
import "./loop-signals"
import { BlueprintContinuation } from "./blueprint-continuation"
import "../library/chronicler"
import { ExperienceEncoder } from "../library/experience-encoder"
import { GitHealth } from "../project/git-health"
import { BlueprintLoopStore } from "../blueprint/loop-store"
import { PlanModeUserWrapper } from "./plan-mode-user-wrapper"
import type { ToolDisplay } from "@ericsanchezok/synergy-plugin/tool"
import { PerformanceSpans } from "@/performance/spans"

export { InvokeInput, resolveInputParts } from "./input"

// @ts-ignore
globalThis.AI_SDK_LOG_WARNINGS = false

export namespace SessionInvoke {
  const log = Log.create({ service: "session.invoke" })
  const ephemeralToolsByMessage = new Map<string, ToolResolver.EphemeralTool[]>()

  async function commandRuntime() {
    return (await import("../command/command")).Command
  }

  export function assertIdle(sessionID: string) {
    return SessionManager.assertIdle(sessionID)
  }
  export function cancel(sessionID: string) {
    log.info("cancel", { sessionID })
    evictRecallCache(sessionID)
    PermissionNext.clearForSession(sessionID).catch((err) => {
      log.error("permission cleanup failed", { sessionID, error: err })
    })
    SessionManager.signalAbort(sessionID)
  }

  /**
   * Repair the persisted incomplete assistant message and clear pendingReply
   * for a session after abort. This is safe to call from the HTTP abort handler
   * or anywhere with a valid sessionID.
   */
  export async function repairAfterAbort(sessionID: string): Promise<void> {
    await repairIncompleteAssistant(sessionID).catch((err) => {
      log.error("assistant repair after abort failed", { sessionID, error: err })
    })
  }

  type InternalInvokeInput = InvokeInput & {
    ephemeralTools?: ToolResolver.EphemeralTool[]
  }

  async function invokeWithInternalTools(input: InternalInvokeInput) {
    return SessionManager.run(input.sessionID, async () => {
      const message = await createUserMessage(input)
      if (input.ephemeralTools?.length) {
        ephemeralToolsByMessage.set(message.info.id, input.ephemeralTools)
      }

      await Session.update(input.sessionID, (draft) => {
        draft.pendingReply = input.noReply !== true || undefined
      })

      if (input.noReply === true) {
        ephemeralToolsByMessage.delete(message.info.id)
        return message
      }

      try {
        return await loop(input.sessionID)
      } finally {
        ephemeralToolsByMessage.delete(message.info.id)
      }
    })
  }

  export const invoke = fn(InvokeInput, async (input) => invokeWithInternalTools(input))

  export async function invokeInternal(input: InternalInvokeInput) {
    return invokeWithInternalTools(input)
  }

  async function recallMemory(
    step: number,
    sessionID: string,
    scopeID: string,
    sessionMessages: MessageV2.WithParts[],
    isTopSession: boolean,
  ): Promise<{ context: string; injection: InjectionInfo } | undefined> {
    if (step === 1 && isTopSession) {
      SessionManager.setStatus(sessionID, { type: "busy", description: "Flashing back..." })
      const cfg = await Config.current()
      return withTimeout(buildMemoryContext(sessionID, scopeID, sessionMessages, cfg.library), RECALL_TIMEOUT_MS).catch(
        (err: any) => {
          log.warn("recall failed or timed out", { sessionID, error: err })
          return undefined
        },
      )
    }
    // Keep the recalled memory/experience in the system prompt for every step
    // so the prefix stays stable (maximizing cache hits) and the agent retains
    // its knowledge context across the entire trajectory, including after
    // compaction boundaries.
    if (step > 1 && isTopSession) {
      return getCachedResult(sessionID)
    }
    if (step === 1 && !isTopSession) {
      const cfg = await Config.current()
      if (cfg.library?.memory?.enabled !== false) {
        const alwaysContext = buildAlwaysOnlyMemoryContext()
        return alwaysContext ? { context: alwaysContext, injection: {} as InjectionInfo } : undefined
      }
    }
    return undefined
  }

  export const loop = fn(Identifier.schema("session"), async (sessionID) => {
    BlueprintContinuation.init()
    SessionManager.registerRuntime(sessionID)
    const abort = SessionManager.acquire(sessionID)
    if (!abort) {
      const runtime = SessionManager.registerRuntime(sessionID)
      return new Promise<MessageV2.WithParts>((onComplete, onCancel) => {
        runtime.waiters.push({ onComplete, onCancel })
      })
    }

    await using _ = defer(async () => {
      evictRecallCache(sessionID)
      await SessionManager.release(sessionID)
    })

    const runtime = SessionManager.registerRuntime(sessionID)
    let step = 0
    let emergencyCompactionTriggered = false
    let session = await Session.get(sessionID)
    let scopeID = (session.scope as Scope).id

    outer: while (true) {
      while (true) {
        SessionManager.setStatus(sessionID, { type: "busy" })
        log.info("loop", { step, sessionID })
        if (abort.aborted) break
        session = await Session.get(sessionID)
        scopeID = (session.scope as Scope).id
        let msgs = await effectiveCompactedMessages(sessionID)

        // Find R: the latest root user message. R is the anchor for the entire
        // loop: rootID, model, agent, system, and compaction anchor all derive
        // from R, not from a heuristic "lastUser".
        let R: MessageV2.User | undefined
        let RParts: MessageV2.Part[] | undefined
        let lastFinished: MessageV2.Assistant | undefined
        let lastFinishedParts: MessageV2.Part[] | undefined
        let lastAssistant: MessageV2.Assistant | undefined
        for (let i = msgs.length - 1; i >= 0; i--) {
          const msg = msgs[i]
          if (msg.info.role === "user") {
            const user = msg.info as MessageV2.User
            if (user.isRoot === true && !R) {
              R = user
              RParts = msg.parts
            }
          }
          if (msg.info.role === "assistant") {
            if (!lastAssistant) {
              lastAssistant = msg.info as MessageV2.Assistant
            }
            if (!lastFinished && SessionProgress.isTerminalAssistant(msg.info as MessageV2.Assistant)) {
              lastFinished = msg.info as MessageV2.Assistant
              lastFinishedParts = msg.parts
            }
          }
          if (R && lastFinished) break
        }

        if (!R) {
          break
        }

        step++

        const rollbackActive = (await SessionHistory.storedInfo(sessionID))?.rollback?.canUnrollback === true

        // Mode-based drain ①: steer items must be materialized BEFORE needsModelCall
        // so they can trigger a model call in this iteration. Context items follow
        // in ② after the predicate confirms a call is needed (piggyback).
        if (!rollbackActive) {
          const steerItems = await SessionInbox.drainSteer(sessionID)
          if (steerItems.length > 0) {
            log.info("drained steer items into session", { sessionID, count: steerItems.length })
            for (const item of steerItems) {
              const materialized = await SessionInbox.materializeItem(item, R.id, { guiding: true })
              if (materialized) msgs.push(materialized)
            }
          }
        }

        if (!SessionProgress.needsModelCall(msgs, R.id)) {
          break
        }

        const jobCtx: LoopJob.Context = {
          session,
          sessionID,
          step,
          messages: msgs,
          lastUser: R,
          lastUserParts: RParts!,
          lastFinished,
          lastFinishedParts,
          lastAssistant,
          abort,
          compactionAutoDisabled: (await Config.current()).compaction?.auto === false,
          compactionOverflowThreshold: (await Config.current()).compaction?.overflowThreshold,
          compactionMaxHistoryImages: (await Config.current()).compaction?.maxHistoryImages ?? 8,
          modelID: R.model.modelID,
          modelLimits: await Promise.all([
            Provider.getModel(R.model.providerID, R.model.modelID)
              .then((m) => m.limit)
              .catch(() => undefined),
            Token.warmup(R.model.modelID),
          ]).then(([limits]) => limits),
        }
        const firedSignals = await LoopJob.detectSignals(jobCtx)

        const preJobs = LoopJob.collect("pre", jobCtx, firedSignals)
        if (preJobs.length > 0) {
          const result = await LoopJob.execute(preJobs, jobCtx)
          if (result === "stop") break
          if (result === "continue") {
            // A processed compaction re-arms the emergency-compaction fallback so
            // that a later overflow — from history accumulated after this
            // compaction — can trigger it again on the same root (issue #321).
            if (firedSignals.includes("compact")) emergencyCompactionTriggered = false
            continue
          }
        }

        // Mode-based drain ②: context items piggyback on confirmed model call.
        // Materialized after needsModelCall is true; do NOT wake idle sessions.
        if (!rollbackActive) {
          const contextItems = await SessionInbox.drainContext(sessionID)
          if (contextItems.length > 0) {
            log.info("drained context items (piggyback)", { sessionID, count: contextItems.length })
            for (const item of contextItems) {
              const materialized = await SessionInbox.materializeItem(item, R.id)
              if (materialized) msgs.push(materialized)
            }
          }
        }

        const userModel = R.model
        let agentName = R.agent

        const agent = await Agent.get(agentName)

        const model = await Provider.getModel(userModel.providerID, userModel.modelID).catch(async () => {
          log.warn("model not found, falling back to agent model", {
            agent: agentName,
            requested: `${userModel.providerID}/${userModel.modelID}`,
          })
          const agentModel = agent?.model
          if (agentModel) {
            return Provider.getModel(agentModel.providerID, agentModel.modelID)
          }
          throw new Error(
            `Model ${userModel.providerID}/${userModel.modelID} not found and no agent fallback available`,
          )
        })

        log.info("resolved agent", {
          name: agentName,
          hasExternal: !!agent.external,
          adapter: agent.external?.adapter,
        })

        if (agent.external) {
          const profileId = await Session.resolveEffectiveControlProfile({
            sessionID: session?.id,
            agentControlProfile: agent.controlProfile,
          })
          const adapter = ExternalAgent.getAdapter(agent.external.adapter, sessionID)
          if (!adapter) {
            log.error("external adapter not found", { adapter: agent.external.adapter, sessionID })
            break
          }

          const runConfig = applyExternalPermissionMode({ ...agent.external.config }, adapter.name, profileId)
          const override = await resolveExternalModelOverride(R.model, adapter.name)
          if (override && adapter.capabilities.modelSwitch) {
            applyModelOverride(runConfig, adapter.name, override)
          }

          const env: Record<string, string> | undefined =
            override?.apiKey && adapter.name === "codex" ? { SYNERGY_CODEX_API_KEY: override.apiKey } : undefined

          if (!adapter.started) {
            await adapter.start({
              cwd: ScopeContext.current.directory,
              config: runConfig,
              env,
            })
          } else {
            const cfg = (adapter as any).adapterConfig as Record<string, unknown> | undefined
            if (cfg) {
              Object.assign(cfg, runConfig)
            }
            if (env) {
              const adapterEnv = (adapter as any).env as Record<string, string | undefined> | undefined
              if (adapterEnv) Object.assign(adapterEnv, env)
            }
          }

          const [instructionParts, taskContext] = await Promise.all([
            SystemPrompt.custom(),
            buildCortexExecutionContext(sessionID),
          ])

          const instructions = [agent.prompt?.trim(), ...instructionParts].filter(Boolean).join("\n\n")

          const context: ExternalAgent.TurnContext = {
            sessionID,
            prompt: MessageV2.extractText(RParts!),
            instructions: instructions ? withPreambleSection(instructions) : withPreambleSection(),
            taskContext: taskContext ?? undefined,
          }

          const approvalDelegate: ExternalAgent.ApprovalDelegate = async () => false

          await ExternalAgentProcessor.process({
            sessionID,
            agent: agent.name,
            adapter,
            parentID: R.id,
            model: R.model,
            context,
            approvalDelegate,
            abort,
          })
          break
        }

        const maxSteps = agent.steps ?? Infinity
        const isLastStep = step >= maxSteps

        const userMetadata = (R.metadata ?? undefined) as Record<string, unknown> | undefined
        const channelPush = !!(userMetadata?.mailbox || userMetadata?.channelPush)
        const toolDisplayByName = new Map<string, ToolDisplay>()
        const processor = SessionProcessor.create({
          assistantMessage: (await Session.updateMessage({
            id: Identifier.ascending("message"),
            parentID: R.id,
            rootID: R.id,
            visible: true,
            role: "assistant",
            mode: agent.name,
            agent: agent.name,
            path: {
              cwd: ScopeContext.current.directory,
              root: ScopeContext.current.directory,
            },
            cost: 0,
            tokens: {
              input: 0,
              output: 0,
              reasoning: 0,
              cache: { read: 0, write: 0 },
            },
            modelID: model.id,
            providerID: model.providerID,
            time: {
              created: Date.now(),
            },
            sessionID,
            ...(channelPush ? { metadata: { channelPush: true } } : {}),
          })) as MessageV2.Assistant,
          sessionID: sessionID,
          model,
          abort,
          toolDisplay: (toolName) => toolDisplayByName.get(toolName),
        })

        // Shallow structural copy: duplicates message/part references but shares
        // the heavy string payloads (tool outputs, text content) to avoid the
        // memory cost of a full deep clone while still isolating msgs from
        // downstream mutations (reminder wrapping, plugin transforms).
        const sessionMessages = msgs.map((m) => ({ ...m, parts: [...m.parts] }))

        // Ephemerally wrap non-root user-origin steer messages with a reminder.
        // Only user-origin steer (mid-run interruptions) get wrapped; cortex/agenda
        // steer messages carry their own structured text and should not be wrapped.
        if (step > 1 && lastFinished) {
          for (const msg of sessionMessages) {
            if (msg.info.role !== "user" || msg.info.id <= lastFinished.id) continue
            const user = msg.info as MessageV2.User
            const isRoot = user.isRoot === true
            const originType = user.origin?.type
            // Only wrap non-root user-origin messages (steer interruptions)
            if (isRoot || (originType && originType !== "user")) continue
            msg.parts = msg.parts.map((part) => {
              if (part.type !== "text") return part
              if (MessageV2.isSystemPart(part)) return part
              if (!part.text.trim()) return part
              return {
                ...part,
                text: [
                  "<system-reminder>",
                  "The user sent the following message:",
                  part.text,
                  "",
                  "Please address this message and continue with your tasks.",
                  "</system-reminder>",
                ].join("\n"),
              }
            })
          }
        }

        await Plugin.trigger("experimental.chat.messages.transform", {}, { messages: sessionMessages })

        // Launch independent async work in parallel: tool resolution, system
        // prompt assembly, cortex context, and memory recall (flashback) all
        // run concurrently to minimise time-to-first-token.
        const isTopSession = !session.parentID

        const [
          toolDefinitions,
          [envParts, customParts],
          cortexExecutionContext,
          cortexReminder,
          agendaReminder,
          memoryResult,
        ] = await Promise.all([
          ToolResolver.definitions({
            agent,
            model,
            sessionID,
            session,
            userTools: R.tools,
            ephemeralTools: ephemeralToolsByMessage.get(R.id),
            includeMCP: true,
          }),
          Promise.all([
            SystemPrompt.environment({ endpointType: SessionEndpoint.type(session.endpoint), session }),
            SystemPrompt.custom(),
          ]).then(([env, custom]) => [env, custom] as const),
          buildCortexExecutionContext(sessionID),
          buildCortexReminder(sessionID),
          buildAgendaReminder(sessionID, scopeID),
          recallMemory(step, sessionID, scopeID, sessionMessages, isTopSession),
        ])

        for (const def of toolDefinitions) {
          if (def.display) toolDisplayByName.set(def.id, def.display)
        }

        // Layered system prompt assembly: stable → semi-stable → dynamic
        // This ordering maximizes prompt caching by keeping static content first.
        const systemParts: string[] = []
        let systemCacheBreakpoint: number | undefined

        // Layer 1: Static — AGENTS.md instructions (stable within session)
        systemParts.push(...customParts)
        if (systemParts.length > 0) systemCacheBreakpoint = systemParts.length - 1

        // Layer 1.5: Semi-static — permission context (stable per session)
        try {
          const workspace = ScopeContext.current.directory
          const workspaceInfo = ScopeContext.current.workspace
          const profileId = await Session.resolveEffectiveControlProfile({
            sessionID: session?.id,
            agentControlProfile: agent.controlProfile,
          })
          const resolved = await ControlProfileCompiler.resolve(profileId, {
            workspace,
            workspaceType: workspaceInfo?.type === "git_worktree" ? "worktree" : "main",
          })
          if (resolved.valid) {
            const ctx = buildPermissionContext(resolved, workspace)
            systemParts.push(ctx)
            systemCacheBreakpoint = systemParts.length - 1
          }
        } catch {
          // Profile resolution failure is non-fatal — skip permission context
        }

        // Layer 2: Semi-static — cortex context (stable during execution)
        if (cortexExecutionContext) systemParts.push(cortexExecutionContext)

        // Layer 2.5: Semi-static — Plan Mode / BlueprintLoop context
        const sessionBlueprint = session?.blueprint
        if (sessionBlueprint?.planMode) {
          systemParts.push(PLAN_MODE.trim())
          if (agent.name === "synergy") systemParts.push(PLAN_MODE_SYNERGY.trim())
          if (agent.name === "synergy-max") systemParts.push(PLAN_MODE_SYNERGY_MAX.trim())
        }
        if (sessionBlueprint?.loopID) {
          const loop = await BlueprintLoopStore.get(scopeID, sessionBlueprint.loopID).catch(() => undefined)
          if (loop) {
            const isAuditSession = sessionBlueprint.loopRole === "audit" || session?.id === loop.auditSessionID
            const loopInstruction = isAuditSession
              ? `You are auditing this BlueprintLoop. Read the Blueprint note with note_read ids=["${loop.noteID}"] and audit the start user instruction when present. Inspect the execution evidence, and decide whether the Blueprint outcome is complete. If changes are required, call blueprint_loop_restart({ loopID: "${loop.id}", reason: "...", completed: "...", remaining: "...", instructions: "..." }). If complete, call blueprint_loop_finish({ loopID: "${loop.id}", status: "completed", summary: "..." }).`
              : agent.name === "synergy-max"
                ? `You are executing this coding BlueprintLoop. Before editing code, call note_read with ids=["${loop.noteID}"] and read the full Blueprint content. Satisfy both the Blueprint note and any start user instruction before requesting audit. Continue until the Blueprint is fully implemented and verified. When ready for audit, call blueprint_loop_finish({ loopID: "${loop.id}", status: "auditing", summary: "..." }).`
                : `You are executing this BlueprintLoop. Before carrying out the Blueprint, call note_read with ids=["${loop.noteID}"] and read the full Blueprint content. Satisfy both the Blueprint note and any start user instruction before requesting audit. Continue until the requested outcome is fully delivered. When ready for audit, call blueprint_loop_finish({ loopID: "${loop.id}", status: "auditing", summary: "..." }).`
            const startUserInstruction = loop.userPrompt
              ? [
                  `Start user instruction: ${loop.userPrompt}`,
                  `This start user instruction is run-specific contract for execution and audit.`,
                ]
              : []
            systemParts.push(
              [
                "<blueprint-loop-context>",
                `Active BlueprintLoop: ${loop.id}`,
                `BlueprintLoop role: ${isAuditSession ? "audit" : "execution"}`,
                `Blueprint Note: ${loop.noteID}`,
                `Title: ${loop.title}`,
                `Description: ${loop.description ?? "N/A"}`,
                `Status: ${loop.status}`,
                ...startUserInstruction,
                "",
                loopInstruction,
                "</blueprint-loop-context>",
              ].join("\n"),
            )
          }
        }

        // Layer 3: Dynamic — memory/experience context (varies per step)
        if (memoryResult) {
          systemParts.push(memoryResult.context)
          if (step === 1) cacheResult(sessionID, memoryResult)
          const { injection } = memoryResult
          if ((injection.memory || injection.experience) && !R.metadata?.injectedContext) {
            const updated = await Session.mergeMessageMetadata({
              sessionID,
              messageID: R.id,
              metadata: { injectedContext: injection },
            })
            if (updated?.role === "user") R = updated
          }
        }

        // Layer 4: Dynamic — environment block (contains timestamp, changes per invoke)
        systemParts.push(...envParts)

        // Layer 4.5: Dynamic — git health diagnostics (warns about uncommitted changes, large files, etc.)
        const gitHealthBlock = GitHealth.injectCached(ScopeContext.current.directory)
        if (gitHealthBlock) systemParts.push(gitHealthBlock)

        // Layer 4.55: Always-on — git commit coauthor footer reminder
        systemParts.push(`<coauthor-reminder>\n${COAUTHOR_REMINDER.trim()}\n</coauthor-reminder>`)

        // Layer 5: Dynamic — upcoming agenda wake-ups (always at the end)
        if (agendaReminder) systemParts.push(agendaReminder)

        // Layer 6: Dynamic — cortex reminders and time context (always at the end)
        if (cortexReminder) systemParts.push(cortexReminder)

        // Layer 7: Dynamic — planning reminder when agent self-executes without a DAG
        const planningReminder = await buildPlanningReminder(sessionID, agent, sessionMessages)
        if (planningReminder) systemParts.push(planningReminder)

        if (step === 1 && lastFinished?.time.completed) {
          const elapsed = R.time.created - lastFinished.time.completed
          if (elapsed > 0) {
            systemParts.push(
              `<time-context>\nTime since your last response: ${formatElapsed(elapsed)}\n</time-context>`,
            )
          }
        }
        const modelSessionMessages = PlanModeUserWrapper.projectMessages({
          messages: sessionMessages,
          session,
          agent,
        })
        const preparedMessages = [
          ...MessageV2.toModelMessage(modelSessionMessages, { maxHistoryImages: jobCtx.compactionMaxHistoryImages }),
          ...(isLastStep
            ? [
                {
                  role: "assistant" as const,
                  content: MAX_STEPS,
                },
              ]
            : []),
        ]

        const promptPlanTimer = log.time("promptBudgeter.buildPlan")
        const promptPlan = await PromptBudgeter.buildPlan({
          sessionID,
          agent: agent.name,
          messageID: lastUser.id,
          model,
          system: systemParts,
          systemCacheBreakpoint,
          messages: preparedMessages,
          toolDefinitions,
        })
        promptPlanTimer.stop()

        const calibration = buildCalibration(msgs)
        const promptDecideTimer = log.time("promptBudgeter.decide")
        const promptDecision = await PromptBudgeter.decide(promptPlan, model.limit, model.id, {
          overflowThreshold: jobCtx.compactionOverflowThreshold,
          calibration,
        })
        promptDecideTimer.stop()

        if (
          !jobCtx.compactionAutoDisabled &&
          !SessionCompaction.hasPendingCompaction(RParts!, msgs, R.id) &&
          promptDecision.shouldCompact
        ) {
          log.info("prompt budget exceeded, injecting compaction", {
            sessionID,
            total: promptDecision.measure.total,
            soft: promptDecision.budget.soft,
            usable: promptDecision.budget.usable,
          })
          await Session.updatePart({
            id: Identifier.ascending("part"),
            messageID: R.id,
            sessionID,
            type: "compaction",
            auto: true,
          })
          continue
        }

        const toolResolveTimer = log.time("toolResolver.resolve")
        const resolvedTools = await ToolResolver.resolveWithAvailability({
          agent,
          model,
          sessionID,
          processor,
          session,
          userTools: R.tools,
          ephemeralTools: ephemeralToolsByMessage.get(R.id),
          includeMCP: true,
        })
        toolResolveTimer.stop()

        SessionManager.setStatus(sessionID, { type: "busy", description: "Awaiting response…" })
        const processTimer = log.time("processor.process")
        const timeoutCfg = await TimeoutConfig.resolve()
        const turnDeadline = new AbortController()
        const deadlineError = new DOMException(
          "Assistant step timed out after " + timeoutCfg.invokeMs + "ms",
          "AbortError",
        )
        let rejectDeadline: (error: Error) => void
        const deadlinePromise = new Promise<never>((_, reject) => {
          rejectDeadline = reject
        })
        deadlinePromise.catch(() => {})
        const turnTimer = setTimeout(() => {
          turnDeadline.abort(deadlineError)
          rejectDeadline(deadlineError)
        }, timeoutCfg.invokeMs)
        abort.addEventListener("abort", () => clearTimeout(turnTimer), { once: true })
        const combinedAbort = AbortSignal.any([abort, turnDeadline.signal])

        // Race against the deadline instead of relying on abort propagation:
        // the processor can be stuck in an await that never observes signals
        // (e.g. a wedged subprocess), and a signal alone cannot interrupt it.
        const turnSpan = PerformanceSpans.start({
          name: "session.turn",
          module: "session",
          scopeID,
          sessionID,
          messageID: R.id,
          attributes: { agent: agent.name, model: model.id, provider: model.providerID },
        })
        let turnSpanEnded = false
        let result: Awaited<ReturnType<typeof processor.process>> = "stop"
        try {
          result = await Promise.race([
            processor.process({
              user: R,
              agent,
              abort: combinedAbort,
              sessionID,
              system: promptPlan.system,
              systemCacheBreakpoint: promptPlan.systemCacheBreakpoint,
              messages: promptPlan.messages,
              tools: resolvedTools.tools,
              activeToolIDs: resolvedTools.activeToolIDs,
              model,
            }),
            deadlinePromise,
          ])
        } catch (error) {
          if (error !== deadlineError) {
            PerformanceSpans.end(turnSpan, { status: "error", error })
            turnSpanEnded = true
            throw error
          }
          log.error("turn deadline exceeded, abandoning turn", { sessionID, timeoutMs: timeoutCfg.invokeMs })
          processor.message.error = MessageV2.fromError(deadlineError, { providerID: model.providerID })
          processor.message.time.completed = Date.now()
          await Session.updateMessage(processor.message)
          Bus.publish(SessionEvent.Error, { sessionID, error: processor.message.error })
          result = "stop"
          PerformanceSpans.end(turnSpan, { status: "timeout", error: deadlineError })
          turnSpanEnded = true
        } finally {
          clearTimeout(turnTimer)
          processTimer.stop()
          if (!turnSpanEnded) {
            PerformanceSpans.end(turnSpan, {
              attributes: {
                result,
                assistantMessageID: processor.message.id,
                finish: processor.message.finish,
              },
            })
          }
        }

        // post-LLM jobs
        const postParts = await MessageV2.parts({ scopeID, sessionID, messageID: processor.message.id })
        const postCtx: LoopJob.Context = {
          ...jobCtx,
          messages: [...jobCtx.messages, { info: processor.message, parts: postParts }],
          lastAssistant: processor.message,
          lastFinished: SessionProgress.isTerminalAssistant(processor.message)
            ? processor.message
            : jobCtx.lastFinished,
          lastFinishedParts: SessionProgress.isTerminalAssistant(processor.message)
            ? postParts
            : jobCtx.lastFinishedParts,
        }
        const postJobs = LoopJob.collect("post", postCtx)
        if (postJobs.length > 0) {
          const postResult = await LoopJob.execute(postJobs, postCtx)
          if (postResult === "stop") break
        }

        if (result === "stop") {
          // If the failure was caused by exceeding context limits, inject a
          // compaction signal and re-enter the loop. The next iteration will
          // detect the signal, run compaction (which now has its own input
          // trimming and mechanical fallback), and then retry the user's request.
          if (
            !emergencyCompactionTriggered &&
            processor.message.error &&
            SessionCompaction.isContextExceeded(processor.message.error)
          ) {
            log.warn("context exceeded, injecting emergency compaction", { sessionID })
            emergencyCompactionTriggered = true
            // Attach the compaction part to R so the next iteration detects it
            // via lastUserParts (same path as the prompt-budget trigger above)
            // and anchors compaction on the task root.
            await Session.updatePart({
              id: Identifier.ascending("part"),
              messageID: R.id,
              sessionID,
              type: "compaction" as const,
              auto: true,
            })
            continue
          }
          break
        }
        continue
      }

      // Inner loop finished — post-turn drain.
      // Use peek-then-commit pattern so items are never deleted before
      // they are successfully materialized and the reply cycle completes.
      if (abort.aborted) {
        // Abort: discard steer/context, keep task items (no auto-start).
        await SessionInbox.removeByMode(sessionID, ["steer", "context"])
        break
      }

      // First: try mode-based next task (drains and materializes)
      const taskItem = await SessionInbox.nextTask(sessionID)
      if (taskItem) {
        log.info("next task found, materializing", { sessionID, itemID: taskItem.id })
        await SessionInbox.materializeItem(taskItem)
        continue outer
      }

      const rollbackActive = (await SessionHistory.storedInfo(sessionID))?.rollback?.canUnrollback === true
      if (await SessionInbox.hasRunnableItem(sessionID, { allowSteer: !rollbackActive })) {
        log.info("runnable inbox items detected, re-entering loop", { sessionID })
        continue outer
      }
      break
    }

    evictRecallCache(sessionID)

    // Clear pendingReply — the loop has fully completed and the assistant has
    // replied. Without this, a crashed/restarted server would see pendingReply=true
    // on already-finished sessions and incorrectly mark them as pending resume.
    await Session.update(sessionID, (draft) => {
      draft.pendingReply = undefined
      if (!abort.aborted && !draft.time.archived && !draft.completionNotice.silent) {
        draft.completionNotice.unread = true
      }
    })

    let resultMessage = selectResultMessage(await Session.messages({ sessionID }))
    if (!resultMessage) {
      resultMessage = await writeAbortedAssistantMessage(sessionID, scopeID)
    }
    // If the assistant message is marked with an error (LLM API error, auth
    // error, output length exceeded, abort, or unknown), propagate it as an
    // exception so cortex/runTask records task.status = "error" instead of
    // silently marking the task as "completed".
    if (resultMessage.info.role === "assistant" && resultMessage.info.error) {
      const err = resultMessage.info.error
      throw new MessageV2.SessionTerminalError({
        errorName: err.name,
        message:
          err.data && typeof err.data === "object" && "message" in err.data ? String(err.data.message) : err.name,
      })
    }
    for (const q of runtime.waiters) {
      q.onComplete(resultMessage)
    }
    return resultMessage
  })

  export function selectResultMessage(messages: MessageV2.WithParts[]): MessageV2.WithParts | undefined {
    let lastReplyRequiredUser: MessageV2.User | undefined
    for (let index = messages.length - 1; index >= 0; index--) {
      const msg = messages[index]
      if (msg.info.role !== "user") continue
      const user = msg.info as MessageV2.User
      if (!SessionProgress.isReplyRequiredUser(user)) continue
      lastReplyRequiredUser = user
      break
    }

    if (lastReplyRequiredUser) {
      const reply = SessionProgress.findTerminalReply(messages, lastReplyRequiredUser.id)
      if (reply) return reply
    }

    for (let index = messages.length - 1; index >= 0; index--) {
      const msg = messages[index]
      if (msg.info.role === "assistant") return msg
    }
  }

  // --- Helpers ---

  /**
   * Repair an incomplete assistant message when abort was requested but the
   * processor never reached the normal completion path. Marks the last assistant
   * with time.completed, finish: "error", and an AbortedError, then clears
   * pendingReply so working.ts no longer reports "recovering".
   */
  async function repairIncompleteAssistant(sessionID: string): Promise<void> {
    const session = await SessionManager.getSession(sessionID)
    if (!session) return

    const messages = await Session.messages({ sessionID })
    let latestAssistant: MessageV2.Assistant | undefined
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].info.role === "assistant") {
        latestAssistant = messages[i].info as MessageV2.Assistant
        break
      }
    }
    if (!latestAssistant || latestAssistant.time.completed != null) return

    log.info("repairing incomplete assistant after abort", {
      sessionID,
      messageID: latestAssistant.id,
    })

    const repaired: MessageV2.Assistant = {
      ...latestAssistant,
      time: { ...latestAssistant.time, completed: Date.now() },
      finish: "error",
      error: new MessageV2.AbortedError({
        message: "Session aborted during turn — assistant response was not completed",
      }).toObject(),
    }
    await Session.updateMessage(repaired)

    await Session.update(sessionID, (draft) => {
      draft.pendingReply = undefined
    })
  }

  async function writeAbortedAssistantMessage(sessionID: string, scopeID: string): Promise<MessageV2.WithParts> {
    const abortedParentID = Identifier.ascending("message")
    const assistantMessage = (await Session.updateMessage({
      id: Identifier.ascending("message"),
      parentID: abortedParentID,
      rootID: abortedParentID,
      visible: true,
      role: "assistant",
      mode: "unknown",
      agent: "unknown",
      path: {
        cwd: ScopeContext.current.directory,
        root: ScopeContext.current.directory,
      },
      cost: 0,
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      modelID: "unknown",
      providerID: "unknown",
      time: {
        created: Date.now(),
        completed: Date.now(),
      },
      finish: "error",
      error: new MessageV2.AbortedError({ message: "Session ended before producing an assistant message" }).toObject(),
      sessionID,
    })) as MessageV2.Assistant
    ExperienceEncoder.onComplete(assistantMessage)
    await Plugin.trigger(
      "session.turn.after",
      {
        sessionID,
        userMessageID: assistantMessage.parentID,
        assistantMessageID: assistantMessage.id,
        assistant: assistantMessage,
        finish: assistantMessage.finish,
        error: assistantMessage.error,
      },
      {},
    )
    return {
      info: assistantMessage,
      parts: await MessageV2.parts({ scopeID, sessionID, messageID: assistantMessage.id }),
    }
  }

  async function buildDagUpstreamContext(
    sessionID: string,
    parentSessionID: string,
    dagNodeId?: string,
  ): Promise<string | undefined> {
    if (!dagNodeId) return undefined

    const { Dag } = await import("./dag")
    const nodes = await Dag.get(parentSessionID)
    const current = nodes.find((n) => n.id === dagNodeId)
    if (!current || current.deps.length === 0) return undefined

    const upstreamResults: string[] = []
    let totalChars = 0
    const MAX_PER_NODE = 4096
    const MAX_TOTAL = 16384

    for (const depId of current.deps) {
      const depNode = nodes.find((n) => n.id === depId)
      if (!depNode || depNode.status !== "completed" || !depNode.result) continue

      let result = depNode.result
      if (result.length > MAX_PER_NODE) {
        result = result.slice(0, MAX_PER_NODE - 3) + "..."
      }

      const block = [
        `## Node: ${depNode.id} — ${depNode.content}`,
        depNode.assign ? `**Agent**: @${depNode.assign}` : "",
        "**Result**:",
        result,
      ]
        .filter(Boolean)
        .join("\n")

      const blockSize = block.length + 2 // +2 for the blank line separator
      if (totalChars + blockSize > MAX_TOTAL) break

      upstreamResults.push(block)
      totalChars += blockSize
    }

    if (upstreamResults.length === 0) return undefined

    return [
      "<upstream-results>",
      "The following upstream DAG nodes have completed. Their results are provided as context for your task. Use these findings — do not redo work already done.",
      "",
      ...upstreamResults,
      "</upstream-results>",
    ].join("\n")
  }

  async function buildCortexExecutionContext(sessionID: string): Promise<string | undefined> {
    const { Cortex } = await import("../cortex/manager")
    const task = Cortex.list().find((task) => task.sessionID === sessionID)
    if (!task || task.executionRole !== "delegated_subagent") return undefined

    const upstreamContext = await buildDagUpstreamContext(sessionID, task.parentSessionID, task.dagNodeId)

    const parts: string[] = []
    if (upstreamContext) parts.push(upstreamContext)
    parts.push(
      [
        "<cortex-execution>",
        "Execution role: delegated_subagent",
        "You are executing a delegated task.",
        "Default to direct execution and return your result to the parent agent.",
        "Do not delegate further and do not use task_output unless this session launched a visible background task itself.",
        "Never call task_output speculatively.",
        "</cortex-execution>",
      ].join("\n"),
    )
    return parts.join("\n")
  }

  async function buildCortexReminder(sessionID: string): Promise<string | undefined> {
    const mod = await import("../cortex/manager")
    const Cortex = mod.Cortex
    if (!Cortex || typeof Cortex.getRunningTasks !== "function") return undefined
    const running = Cortex.getRunningTasks().filter((t) => t.parentSessionID === sessionID)
    if (running.length === 0) return undefined

    const taskList = running
      .map((t) => {
        const elapsed = Math.floor((Date.now() - t.startedAt) / 1000)
        const info = Cortex.describe(t)
        const lastTool = info.lastTool
          ? ` | last: ${info.lastTool}${info.lastToolStatus ? ` (${info.lastToolStatus})` : ""}`
          : ""
        return `- \`${t.id}\` [${elapsed}s] — @${t.agent} — ${t.description} — ${info.health}${lastTool}`
      })
      .join("\n")

    return `<cortex-reminder>\n${CORTEX_REMINDER.replace("{{count}}", String(running.length)).replace("{{task_list}}", taskList)}\n</cortex-reminder>`
  }

  /**
   * Build an agenda reminder — tells the agent about pending agenda items that
   * will wake this session (agenda_watch items with delay triggers) so it
   * doesn't need to poll or set redundant watches.
   */
  async function buildAgendaReminder(sessionID: string, scopeID: string): Promise<string | undefined> {
    const { AgendaStore } = await import("../agenda/store")
    const items = await AgendaStore.listForScope(scopeID)
    const now = Date.now()

    // Filter to items that:
    // 1. Are active/pending
    // 2. Have wake !== false (will wake the session)
    // 3. Originate from this session (origin.sessionID === sessionID)
    // 4. Have a delay or at trigger with a future nextRunAt
    const waking = items.filter((item) => {
      if (item.status !== "active" && item.status !== "pending") return false
      if (item.wake === false) return false
      if (item.origin.sessionID !== sessionID) return false
      if (item.state.nextRunAt === undefined || item.state.nextRunAt <= now) return false
      return true
    })

    if (waking.length === 0) return undefined

    const lines = waking.map((item) => {
      const remaining = item.state.nextRunAt! - now
      const remainingStr = formatElapsed(remaining)
      return `- **\`${item.id}\`** "${item.title}" will wake this session in ~${remainingStr}`
    })

    return [
      `<agenda-reminder>`,
      `The following agenda items will automatically wake this session when they fire:`,
      ...lines,
      `Do NOT set up redundant \`agenda_watch\` calls — the system handles waking you automatically.`,
      `</agenda-reminder>`,
    ].join("\n")
  }

  const ACCUMULATING_TOOLS = new Set([
    "bash",
    "process",
    "read",
    "grep",
    "ast_grep",
    "glob",
    "look_at",
    "scan_document",
    "edit",
    "write",
    "websearch",
    "webfetch",
    "diagram",
  ])
  const CLEARING_TOOLS = new Set(["dagwrite", "dagread", "dagpatch", "task", "task_list", "task_output", "task_cancel"])

  async function buildPlanningReminder(
    sessionID: string,
    agent: { name: string; mode?: string },
    sessionMessages: { info: { role: string }; parts: { type: string; tool?: string }[] }[],
  ): Promise<string | undefined> {
    if (agent.name !== "synergy-max") return undefined

    const lastUserIdx = sessionMessages.reduce((last, msg, idx) => (msg.info.role === "user" ? idx : last), -1)
    if (lastUserIdx < 0) return undefined

    const currentTurnTools = new Set<string>()
    for (let i = lastUserIdx + 1; i < sessionMessages.length; i++) {
      for (const part of sessionMessages[i].parts) {
        if (part.type === "tool" && part.tool) {
          currentTurnTools.add(part.tool)
        }
      }
    }

    let counter = 0
    for (const tool of currentTurnTools) {
      if (CLEARING_TOOLS.has(tool)) counter = 0
      else if (ACCUMULATING_TOOLS.has(tool)) counter += 1
    }
    if (counter < 3) return undefined

    const { Dag } = await import("./dag")
    const nodes = await Dag.get(sessionID)
    if (nodes.length > 0) return undefined

    return `<planning-reminder>\n${PLANNING_REMINDER.trim()}\n</planning-reminder>`
  }

  function formatElapsed(ms: number): string {
    const seconds = Math.floor(ms / 1000)
    if (seconds < 60) return `${seconds} seconds`
    const minutes = Math.floor(seconds / 60)
    if (minutes < 60) return `${minutes} minute${minutes !== 1 ? "s" : ""}`
    const hours = Math.floor(minutes / 60)
    const remainingMinutes = minutes % 60
    if (hours < 24) {
      if (remainingMinutes === 0) return `${hours} hour${hours !== 1 ? "s" : ""}`
      return `${hours} hour${hours !== 1 ? "s" : ""} ${remainingMinutes} minute${remainingMinutes !== 1 ? "s" : ""}`
    }
    const days = Math.floor(hours / 24)
    const remainingHours = hours % 24
    if (remainingHours === 0) return `${days} day${days !== 1 ? "s" : ""}`
    return `${days} day${days !== 1 ? "s" : ""} ${remainingHours} hour${remainingHours !== 1 ? "s" : ""}`
  }

  interface ExternalModelInfo {
    model: string
    providerID?: string
    baseURL?: string
    apiKey?: string
  }

  export function applyExternalPermissionMode(
    config: Record<string, unknown>,
    adapterName: string,
    controlProfile: string,
  ): Record<string, unknown> {
    config.controlProfile = controlProfile

    if (adapterName === "claude-code") {
      delete config.skipPermissions
      config.permissionMode = controlProfile === "full_access" ? "bypassPermissions" : "default"
      return config
    }

    return config
  }

  function applyModelOverride(config: Record<string, unknown>, adapterName: string, override: ExternalModelInfo): void {
    switch (adapterName) {
      case "codex":
        config.model = override.model
        if (override.providerID) config.providerID = override.providerID
        if (override.baseURL) config.baseURL = override.baseURL
        break
      case "claude-code":
        config.model = override.model
        break
      default:
        break
    }
  }

  async function resolveExternalModelOverride(
    userModel: { providerID: string; modelID: string },
    adapterName: string,
  ): Promise<ExternalModelInfo | undefined> {
    try {
      const provider = await Provider.getProvider(userModel.providerID)
      const model = await Provider.getModel(userModel.providerID, userModel.modelID)
      if (!provider || !model) return undefined

      const npm = model.api.npm ?? ""
      if (!isModelCompatibleWithAdapter(npm, adapterName)) {
        log.info("skipping model override — incompatible provider for adapter", {
          adapterName,
          npm,
          modelID: model.api.id,
        })
        return undefined
      }

      const options: Record<string, any> = { ...provider.options, ...model.options }
      const baseURL = (options["baseURL"] as string) || model.api.url
      const apiKey = (options["apiKey"] as string) || provider.key

      return {
        model: model.api.id,
        providerID: userModel.providerID,
        baseURL: baseURL || undefined,
        apiKey: apiKey || undefined,
      }
    } catch (e) {
      log.warn("resolveExternalModelOverride failed, falling back", { error: String(e) })
      return undefined
    }
  }

  function isModelCompatibleWithAdapter(npm: string, adapterName: string): boolean {
    switch (adapterName) {
      case "codex":
        return npm.includes("openai") || npm.includes("openrouter")
      case "claude-code":
        return npm.includes("anthropic")
      default:
        return false
    }
  }

  export const CommandInput = z.object({
    messageID: Identifier.schema("message").optional(),
    sessionID: Identifier.schema("session"),
    agent: z.string().optional(),
    model: z.string().optional(),
    arguments: z.string(),
    command: z.string(),
    variant: z.string().optional(),
    parts: z
      .array(
        z.discriminatedUnion("type", [
          MessageV2.AttachmentPart.omit({
            messageID: true,
            sessionID: true,
          }).partial({
            id: true,
          }),
        ]),
      )
      .optional(),
  })
  export type CommandInput = z.infer<typeof CommandInput>
  const bashRegex = /!`([^`]+)`/g
  // Match [Image N] as single token, quoted strings, or non-space sequences
  const argsRegex = /(?:\[Image\s+\d+\]|"[^"]*"|'[^']*'|[^\s"']+)/gi
  const placeholderRegex = /\$(\d+)/g
  const quoteTrimRegex = /^["']|["']$/g

  function commandMetadata(command: Command.Info) {
    return {
      command: {
        name: command.name,
        kind: command.kind,
        action: command.action,
        promptVisible: command.promptVisible,
      },
      promptVisible: command.promptVisible,
      source: "command",
      // Denormalized for easier frontend access (metadata.commandName vs. metadata.command?.name)
      commandName: command.name,
    }
  }

  async function deterministicCommandResult(input: CommandInput, command: Command.Info, result: Command.Result) {
    const CommandRuntime = await commandRuntime()
    const userID = input.messageID ?? Identifier.ascending("message")
    const agentName = input.agent ?? (await Agent.defaultAgent().catch(() => "system"))
    const parsedModel = input.model
      ? Provider.parseModel(input.model)
      : ((await lastModel(input.sessionID).catch(() => undefined)) ?? { providerID: "system", modelID: "command" })
    const metadata = commandMetadata(command)

    const user = await Session.updateMessage({
      id: userID,
      role: "user",
      sessionID: input.sessionID,
      time: { created: Date.now() },
      agent: agentName,
      model: parsedModel,
      origin: { type: "user" },
      isRoot: true,
      rootID: userID,
      visible: true,
      // Canonical context switch: action commands (promptVisible === false) are
      // kept out of the model context. metadata.command.promptVisible is retained
      // only as a frontend hint for action-command rendering.
      includeInContext: command.promptVisible !== false,
      metadata,
    })
    await Session.updatePart({
      id: Identifier.ascending("part"),
      messageID: user.id,
      sessionID: input.sessionID,
      type: "text",
      origin: "user",
      text: `/${input.command}${input.arguments ? ` ${input.arguments}` : ""}`,
    })

    const msg: MessageV2.Assistant = {
      id: Identifier.ascending("message"),
      sessionID: input.sessionID,
      parentID: user.id,
      rootID: user.id,
      visible: true,
      role: "assistant",
      mode: agentName,
      agent: agentName,
      cost: 0,
      path: {
        cwd: ScopeContext.current.directory,
        root: ScopeContext.current.directory,
      },
      time: { created: Date.now(), completed: Date.now() },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      finish: "stop",
      modelID: parsedModel.modelID,
      providerID: parsedModel.providerID,
      metadata,
    }
    await Session.updateMessage(msg)
    await Session.updatePart({
      id: Identifier.ascending("part"),
      messageID: msg.id,
      sessionID: input.sessionID,
      type: "text",
      text: result.output,
      metadata: result.metadata,
    })
    Bus.publish(CommandRuntime.Event.Executed, {
      name: input.command,
      sessionID: input.sessionID,
      arguments: input.arguments,
      messageID: user.id,
    })
    return { info: msg, parts: await MessageV2.parts({ sessionID: input.sessionID, messageID: msg.id }) }
  }

  export async function command(input: CommandInput) {
    log.info("command", input)
    const CommandRuntime = await commandRuntime()
    const command = await CommandRuntime.require(input.command)
    if (command.kind === "action") {
      if (!command.action) throw new CommandRuntime.UnknownActionError({ action: "" })
      return SessionManager.run(input.sessionID, async () => {
        const result = await CommandRuntime.runAction({ action: command.action!, input, command })
        return deterministicCommandResult(input, command, result)
      })
    }
    if (!command.template) throw new CommandRuntime.NotFoundError({ name: input.command })
    const agentName = command.agent ?? input.agent ?? (await Agent.defaultAgent())

    const raw = input.arguments.match(argsRegex) ?? []
    const args = raw.map((arg) => arg.replace(quoteTrimRegex, ""))

    const templateCommand = await command.template

    const placeholders = templateCommand.match(placeholderRegex) ?? []
    let last = 0
    for (const item of placeholders) {
      const value = Number(item.slice(1))
      if (value > last) last = value
    }

    // Let the final placeholder swallow any extra arguments so prompts read naturally
    const withArgs = templateCommand.replaceAll(placeholderRegex, (_, index) => {
      const position = Number(index)
      const argIndex = position - 1
      if (argIndex >= args.length) return ""
      if (position === last) return args.slice(argIndex).join(" ")
      return args[argIndex]
    })
    let template = withArgs.replaceAll("$ARGUMENTS", input.arguments)

    const sh = ConfigMarkdown.shell(template)
    if (sh.length > 0) {
      const results = await Promise.all(
        sh.map(async ([, cmd]) => {
          try {
            return await $`${{ raw: cmd }}`.quiet().nothrow().text()
          } catch (error) {
            return `Error executing command: ${error instanceof Error ? error.message : String(error)}`
          }
        }),
      )
      let index = 0
      template = template.replace(bashRegex, () => results[index++])
    }
    template = template.trim()

    const model = await (async () => {
      if (command.model) {
        return Provider.parseModel(command.model)
      }
      if (command.agent) {
        const cmdAgent = await Agent.get(command.agent)
        if (cmdAgent?.model) {
          return cmdAgent.model
        }
      }
      if (input.model) return Provider.parseModel(input.model)
      return await lastModel(input.sessionID)
    })()

    try {
      await Provider.getModel(model.providerID, model.modelID)
    } catch (e) {
      if (Provider.ModelNotFoundError.isInstance(e)) {
        const { providerID, modelID, suggestions } = e.data
        const hint = suggestions?.length ? ` Did you mean: ${suggestions.join(", ")}?` : ""
        Bus.publish(SessionEvent.Error, {
          sessionID: input.sessionID,
          error: new NamedError.Unknown({ message: `Model not found: ${providerID}/${modelID}.${hint}` }).toObject(),
        })
      }
      throw e
    }
    const agent = await Agent.get(agentName)
    if (!agent) {
      const available = await Agent.list().then((agents) => agents.filter((a) => !a.hidden).map((a) => a.name))
      const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
      const error = new NamedError.Unknown({ message: `Agent not found: "${agentName}".${hint}` })
      Bus.publish(SessionEvent.Error, {
        sessionID: input.sessionID,
        error: error.toObject(),
      })
      throw error
    }

    const templateParts = await resolveInputParts(template)
    const parts = [...templateParts, ...(input.parts ?? [])]

    const result = (await invoke({
      sessionID: input.sessionID,
      messageID: input.messageID,
      model,
      agent: agentName,
      parts,
      variant: input.variant,
    })) as MessageV2.WithParts

    Bus.publish(CommandRuntime.Event.Executed, {
      name: input.command,
      sessionID: input.sessionID,
      arguments: input.arguments,
      messageID: result.info.id,
    })

    return result
  }

  export const initialize = fn(
    z.object({
      sessionID: Identifier.schema("session"),
      modelID: z.string(),
      providerID: z.string(),
      messageID: Identifier.schema("message"),
    }),
    async (input) => {
      const CommandRuntime = await commandRuntime()
      await command({
        sessionID: input.sessionID,
        messageID: input.messageID,
        model: input.providerID + "/" + input.modelID,
        command: CommandRuntime.Default.INIT,
        arguments: "",
      })
    },
  )

  export async function resumePending(): Promise<void> {
    const sessionIDs = await SessionManager.listPendingReply()
    for (const sessionID of sessionIDs) {
      const session = await SessionManager.getSession(sessionID)
      if (!session) continue
      if (session.agenda) continue

      const messages = await effectiveCompactedMessages(sessionID)
      const pendingReply = SessionProgress.pendingReply(messages)

      if (session.pendingReply !== pendingReply) {
        await Session.update(sessionID, (draft) => {
          draft.pendingReply = pendingReply || undefined
        })
      }

      if (!pendingReply) continue

      // Auto-repair: if a session has pendingReply but the latest assistant
      // message is incomplete (time.completed == null) and no runtime is
      // active, repair it so working.ts stops reporting "recovering".
      const latestAssistant = messages.find((m) => m.info.role === "assistant")?.info as MessageV2.Assistant | undefined
      if (latestAssistant && latestAssistant.time.completed == null && !SessionManager.getRuntime(sessionID)?.abort) {
        log.info("pending reply found with incomplete assistant; auto-repairing", { sessionID })
        await repairIncompleteAssistant(sessionID).catch((err) => {
          log.error("auto-repair failed", { sessionID, error: err })
        })
        continue
      }

      log.info("pending reply found; automatic assistant resume is disabled", { sessionID })
    }
  }

  async function effectiveCompactedMessages(sessionID: string) {
    const messages = await Session.messages({ sessionID })
    return MessageV2.filterCompacted(newestFirst(messages))
  }

  async function* newestFirst(messages: MessageV2.WithParts[]) {
    for (let i = messages.length - 1; i >= 0; i--) yield messages[i]
  }

  /**
   * Build calibration data from the most recent assistant message that has
   * real API-reported token counts. This lets PromptBudgeter use the model's
   * native token count as a baseline and only estimate the small delta of
   * new messages, rather than re-tokenizing the entire conversation through
   * a mismatched tokenizer (o200k_base can overestimate by ~2x for Claude).
   */
  function buildCalibration(msgs: MessageV2.WithParts[]): PromptBudgeter.Calibration | undefined {
    let calibrationIdx = -1
    let calibrationTokens: MessageV2.Assistant["tokens"] | undefined
    for (let i = msgs.length - 1; i >= 0; i--) {
      const info = msgs[i].info
      if (info.role !== "assistant") continue
      const assistant = info as MessageV2.Assistant
      if (assistant.summary) {
        if (assistant.finish) break
        continue
      }
      const tokens = assistant.tokens
      if (ModelLimit.actualInput(tokens) > 0) {
        calibrationIdx = i
        calibrationTokens = tokens
        break
      }
    }
    if (calibrationIdx < 0 || !calibrationTokens) return undefined

    const actualInput = ModelLimit.actualInput(calibrationTokens)
    const outputTokens = calibrationTokens.output + calibrationTokens.reasoning

    let deltaChars = 0
    for (let i = calibrationIdx + 1; i < msgs.length; i++) {
      for (const part of msgs[i].parts) {
        switch (part.type) {
          case "text":
            deltaChars += part.text?.length ?? 0
            break
          case "tool":
            if (part.state.status === "completed") {
              deltaChars += part.state.time.compacted ? 40 : (part.state.output?.length ?? 0)
              deltaChars += JSON.stringify(part.state.input).length
            }
            break
          case "attachment":
            deltaChars += 200
            break
        }
      }
    }
    const deltaTokens = Math.ceil(deltaChars / 4)

    return { actualInput, outputTokens, deltaTokens }
  }
}
