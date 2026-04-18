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
import { Bus } from "../bus"
import { SystemPrompt } from "./system"
import { SessionEndpoint } from "./endpoint"
import { Plugin } from "../plugin"
import MAX_STEPS from "./prompt/max-steps.txt"
import CORTEX_REMINDER from "./prompt/cortex-reminder.txt"
import { defer } from "../util/defer"
import { Command } from "../skill/command"
import { $ } from "bun"
import { ConfigMarkdown } from "../config/markdown"
import "./summary"
import { NamedError } from "@ericsanchezok/synergy-util/error"
import { fn } from "@/util/fn"
import { SessionProcessor } from "./processor"
import { ExternalAgentProcessor } from "@/external-agent/processor"
import { ExternalAgent } from "@/external-agent/bridge"
import { SessionManager } from "./manager"
import { ToolResolver } from "./tool-resolver"
import { PermissionNext } from "@/permission/next"
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
import { SessionRevert } from "./revert"
import { Instance } from "../scope/instance"
import { Scope } from "@/scope"
import { LoopJob } from "./loop-job"
import "./loop-signals"
import "../engram/chronicler"
import { ExperienceEncoder } from "../engram/experience-encoder"

export { InvokeInput, resolveInputParts } from "./input"

// @ts-ignore
globalThis.AI_SDK_LOG_WARNINGS = false

export namespace SessionInvoke {
  const log = Log.create({ service: "session.invoke" })
  export const OUTPUT_TOKEN_MAX = LLM.OUTPUT_TOKEN_MAX

  SessionManager.onMailboxReady(async (sessionID) => {
    await processMailbox(sessionID)
  })

  export const assertIdle = SessionManager.assertIdle
  export function cancel(sessionID: string) {
    log.info("cancel", { sessionID })
    evictRecallCache(sessionID)
    SessionManager.release(sessionID).catch((err) => {
      log.error("release failed", { sessionID, error: err })
    })
  }

  export const invoke = fn(InvokeInput, async (input) => {
    return SessionManager.run(input.sessionID, async () => {
      const session = await Session.get(input.sessionID)
      await SessionRevert.cleanup(session)

      const message = await createUserMessage(input)

      await Session.update(input.sessionID, (draft) => {
        draft.pendingReply = input.noReply !== true || undefined
      })

      if (input.noReply === true) {
        return message
      }

      return loop(input.sessionID)
    })
  })

  async function processMailbox(sessionID: string): Promise<void> {
    const assistantMails = SessionManager.drainMails(sessionID, "assistant")
    const userMails = SessionManager.drainMails(sessionID, "user")
    const fallbackModel = await lastModel(sessionID).catch(() => undefined)

    for (const mail of assistantMails) {
      await writeAssistantMail(sessionID, mail)
    }

    if (userMails.length === 0) return

    const needsReply = userMails.some((mail) => !mail.noReply)

    for (const mail of userMails) {
      const model = mail.model ?? fallbackModel
      if (!model) {
        log.warn("processMailbox: no model for mail, skipping", { sessionID })
        continue
      }
      await createUserMessage({
        sessionID,
        model,
        parts: partsFromMail(mail),
        noReply: !needsReply,
        summary: mail.summary,
        metadata: mail.metadata,
      })
    }

    await Session.update(sessionID, (draft) => {
      draft.pendingReply = needsReply || undefined
    })

    if (needsReply) {
      await loop(sessionID)
    }
  }

  async function recallMemory(
    step: number,
    sessionID: string,
    scopeID: string,
    sessionMessages: MessageV2.WithParts[],
    isTopSession: boolean,
    isGenesis: boolean,
    lastUserParts: MessageV2.Part[] | undefined,
  ): Promise<{ context: string; injection: InjectionInfo } | undefined> {
    if (step === 1 && isTopSession && !isGenesis) {
      SessionManager.setStatus(sessionID, { type: "busy", description: "Flashing back..." })
      const cfg = await Config.get()
      return withTimeout(
        buildMemoryContext(sessionID, scopeID, sessionMessages, Config.resolveEvolution(cfg.identity?.evolution)),
        RECALL_TIMEOUT_MS,
      ).catch((err: any) => {
        log.warn("recall failed or timed out", { sessionID, error: err?.message ?? String(err) })
        return undefined
      })
    }
    if (step > 1 && isTopSession && lastUserParts?.some((p) => p.type === "compaction")) {
      return getCachedResult(sessionID)
    }
    if (step === 1 && !isTopSession) {
      const cfg = await Config.get()
      const evo = Config.resolveEvolution(cfg.identity?.evolution)
      if (evo.active) {
        const alwaysContext = buildAlwaysOnlyMemoryContext()
        return alwaysContext ? { context: alwaysContext, injection: {} as InjectionInfo } : undefined
      }
    }
    return undefined
  }

  export const loop = fn(Identifier.schema("session"), async (sessionID) => {
    SessionManager.registerRuntime(sessionID)
    const abort = SessionManager.acquire(sessionID)
    if (!abort) {
      const runtime = SessionManager.registerRuntime(sessionID)
      return new Promise<MessageV2.WithParts>((onComplete, onCancel) => {
        runtime.waiters.push({ onComplete, onCancel })
      })
    }

    using _ = defer(() => cancel(sessionID))

    const runtime = SessionManager.registerRuntime(sessionID)
    let step = 0
    let emergencyCompactionTriggered = false
    const session = await Session.get(sessionID)
    const scopeID = (session.scope as Scope).id

    outer: while (true) {
      while (true) {
        SessionManager.setStatus(sessionID, { type: "busy" })
        log.info("loop", { step, sessionID })
        if (abort.aborted) break
        let msgs = await MessageV2.filterCompacted(MessageV2.stream({ scopeID, sessionID }))

        let lastUser: MessageV2.User | undefined
        let lastUserParts: MessageV2.Part[] | undefined
        let lastFinished: MessageV2.Assistant | undefined
        let lastFinishedParts: MessageV2.Part[] | undefined
        let lastAssistant: MessageV2.Assistant | undefined
        for (let i = msgs.length - 1; i >= 0; i--) {
          const msg = msgs[i]
          if (!lastUser && msg.info.role === "user") {
            const user = msg.info as MessageV2.User
            if (SessionProgress.isReplyRequiredUser(user)) {
              lastUser = user
              lastUserParts = msg.parts
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
          if (lastUser && lastFinished) break
        }

        if (!lastUser) {
          break
        }
        if (lastFinished && lastUser.id < lastFinished.id) {
          break
        }

        step++

        const jobCtx: LoopJob.Context = {
          session,
          sessionID,
          step,
          messages: msgs,
          lastUser,
          lastUserParts: lastUserParts!,
          lastFinished,
          lastFinishedParts,
          lastAssistant,
          abort,
          compactionAutoDisabled: (await Config.get()).compaction?.auto === false,
          modelID: lastUser.model.modelID,
          modelLimits: await Promise.all([
            Provider.getModel(lastUser.model.providerID, lastUser.model.modelID)
              .then((m) => m.limit)
              .catch(() => undefined),
            Token.warmup(lastUser.model.modelID),
          ]).then(([limits]) => limits),
        }
        const firedSignals = await LoopJob.detectSignals(jobCtx)

        const preJobs = LoopJob.collect("pre", jobCtx, firedSignals)
        if (preJobs.length > 0) {
          const result = await LoopJob.execute(preJobs, jobCtx)
          if (result === "stop") break
          if (result === "continue") continue
        }

        // Drain user mails that arrived while the agent was working.
        const userMails = SessionManager.drainMails(sessionID, "user")
        if (userMails.length > 0) {
          const userModel = await lastModel(sessionID).catch(() => undefined)
          for (const mail of userMails) {
            const mailModel = mail.model ?? userModel
            if (!mailModel) continue
            const created = await createUserMessage({
              sessionID,
              model: mailModel,
              parts: partsFromMail(mail),
              noReply: mail.noReply,
              summary: mail.summary,
            })
            msgs.push(created)
          }
          log.info("drained user mails into session", { sessionID, count: userMails.length })
        }

        const model = await Provider.getModel(lastUser.model.providerID, lastUser.model.modelID)

        let agentName = lastUser.agent

        const agent = await Agent.get(agentName)

        log.info("resolved agent", {
          name: agentName,
          hasExternal: !!agent.external,
          adapter: agent.external?.adapter,
        })

        if (agent.external) {
          const allowAll = await PermissionNext.isAllowingAll(sessionID)
          const adapter = ExternalAgent.getAdapter(agent.external.adapter, sessionID)
          if (!adapter) {
            log.error("external adapter not found", { adapter: agent.external.adapter, sessionID })
            break
          }

          const runConfig = applyExternalPermissionMode({ ...agent.external.config }, adapter.name, allowAll)
          const override = await resolveExternalModelOverride(lastUser.model, adapter.name)
          if (override && adapter.capabilities.modelSwitch) {
            applyModelOverride(runConfig, adapter.name, override)
          }

          const env: Record<string, string> | undefined =
            override?.apiKey && adapter.name === "codex" ? { SYNERGY_CODEX_API_KEY: override.apiKey } : undefined

          if (!adapter.started) {
            await adapter.start({
              cwd: Instance.directory,
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

          const context: ExternalAgent.TurnContext = {
            sessionID,
            prompt: MessageV2.extractText(lastUserParts!),
            instructions: instructionParts.length > 0 ? instructionParts.join("\n\n") : undefined,
            taskContext: taskContext ?? undefined,
          }

          const approvalDelegate: ExternalAgent.ApprovalDelegate = async () => false

          await ExternalAgentProcessor.process({
            sessionID,
            agent: agent.name,
            adapter,
            parentID: lastUser.id,
            model: lastUser.model,
            context,
            approvalDelegate,
            abort,
          })
          break
        }

        const maxSteps = agent.steps ?? Infinity
        const isLastStep = step >= maxSteps

        const processor = SessionProcessor.create({
          assistantMessage: (await Session.updateMessage({
            id: Identifier.ascending("message"),
            parentID: lastUser.id,
            role: "assistant",
            mode: agent.name,
            agent: agent.name,
            path: {
              cwd: Instance.directory,
              root: Instance.directory,
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
          })) as MessageV2.Assistant,
          sessionID: sessionID,
          model,
          abort,
        })

        // Shallow structural copy: duplicates message/part references but shares
        // the heavy string payloads (tool outputs, text content) to avoid the
        // memory cost of a full deep clone while still isolating msgs from
        // downstream mutations (reminder wrapping, plugin transforms).
        const sessionMessages = msgs.map((m) => ({ ...m, parts: [...m.parts] }))

        // Ephemerally wrap queued user messages with a reminder to stay on track
        if (step > 1 && lastFinished) {
          for (const msg of sessionMessages) {
            if (msg.info.role !== "user" || msg.info.id <= lastFinished.id) continue
            msg.parts = msg.parts.map((part) => {
              if (part.type !== "text" || part.ignored || part.synthetic) return part
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
        const isGenesis = SessionEndpoint.type(session.endpoint) === "genesis"

        const [tools, [envParts, customParts], cortexExecutionContext, cortexReminder, memoryResult] =
          await Promise.all([
            ToolResolver.resolve({
              agent,
              model,
              sessionID,
              processor,
              session,
              userTools: lastUser.tools,
              includeMCP: true,
            }),
            Promise.all([
              SystemPrompt.environment({ endpointType: SessionEndpoint.type(session.endpoint), session }),
              SystemPrompt.custom(),
            ]).then(([env, custom]) => [env, custom] as const),
            buildCortexExecutionContext(sessionID),
            buildCortexReminder(sessionID),
            recallMemory(step, sessionID, scopeID, sessionMessages, isTopSession, isGenesis, lastUserParts),
          ])

        const systemParts = [...envParts, ...customParts]
        if (cortexExecutionContext) systemParts.push(cortexExecutionContext)
        if (cortexReminder) systemParts.push(cortexReminder)

        if (step === 1 && lastFinished?.time.completed) {
          const elapsed = lastUser.time.created - lastFinished.time.completed
          if (elapsed > 0) {
            systemParts.push(
              `<time-context>\nTime since your last response: ${formatElapsed(elapsed)}\n</time-context>`,
            )
          }
        }

        if (memoryResult) {
          systemParts.push(memoryResult.context)
          cacheResult(sessionID, memoryResult)
          const { injection } = memoryResult
          if (injection.memory || injection.experience) {
            const updated: MessageV2.User = {
              ...lastUser,
              metadata: { ...lastUser.metadata, injectedContext: injection },
            }
            await Session.updateMessage(updated)
          }
        }

        SessionManager.setStatus(sessionID, { type: "busy", description: "Awaiting response..." })
        const result = await processor.process({
          user: lastUser,
          agent,
          abort,
          sessionID,
          system: systemParts,
          messages: [
            ...MessageV2.toModelMessage(sessionMessages),
            ...(isLastStep
              ? [
                  {
                    role: "assistant" as const,
                    content: MAX_STEPS,
                  },
                ]
              : []),
          ],
          tools,
          model,
        })

        // post-LLM jobs
        const postJobs = LoopJob.collect("post", jobCtx)
        if (postJobs.length > 0) {
          const postResult = await LoopJob.execute(postJobs, jobCtx)
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
            const emergencyUser = await Session.updateMessage({
              id: Identifier.ascending("message"),
              role: "user",
              sessionID,
              time: { created: Date.now() },
              agent: lastUser.agent,
              model: lastUser.model,
              summary: { title: "Emergency compaction", diffs: [] },
            })
            await Session.updatePart({
              id: Identifier.ascending("part"),
              messageID: emergencyUser.id,
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

      // Inner loop finished — check for user mails that arrived during the last LLM call.
      // If any need a reply, persist them and re-enter the loop.
      const remainingMails = SessionManager.drainMails(sessionID, "user")
      if (remainingMails.length > 0) {
        const needsReply = remainingMails.some((mail) => !mail.noReply)
        const userModel = await lastModel(sessionID).catch(() => undefined)
        for (const mail of remainingMails) {
          const mailModel = mail.model ?? userModel
          if (!mailModel) continue
          await createUserMessage({
            sessionID,
            model: mailModel,
            parts: partsFromMail(mail),
            noReply: !needsReply,
            summary: mail.summary,
          })
        }
        if (needsReply) continue outer
      }
      break
    }

    // Drain assistant mails and write them as messages
    const assistantMails = SessionManager.drainMails(sessionID, "assistant")
    for (const mail of assistantMails) {
      await writeAssistantMail(sessionID, mail)
    }

    evictRecallCache(sessionID)

    let resultMessage = selectResultMessage(await Session.messages({ sessionID }))
    if (!resultMessage) {
      resultMessage = await writeAbortedAssistantMessage(sessionID, scopeID)
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
      for (let index = messages.length - 1; index >= 0; index--) {
        const msg = messages[index]
        if (msg.info.role !== "assistant") continue
        const assistant = msg.info as MessageV2.Assistant
        if (assistant.parentID === lastReplyRequiredUser.id) {
          return msg
        }
      }
    }

    for (let index = messages.length - 1; index >= 0; index--) {
      const msg = messages[index]
      if (msg.info.role === "assistant") return msg
    }
  }

  // --- Helpers ---

  async function writeAbortedAssistantMessage(sessionID: string, scopeID: string): Promise<MessageV2.WithParts> {
    const assistantMessage = (await Session.updateMessage({
      id: Identifier.ascending("message"),
      parentID: Identifier.ascending("message"),
      role: "assistant",
      mode: "unknown",
      agent: "unknown",
      path: {
        cwd: Instance.directory,
        root: Instance.directory,
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

  async function writeAssistantMail(sessionID: string, mail: SessionManager.SessionMail.Assistant): Promise<void> {
    // Use an orphan parentID so the message is not grouped into any existing turn
    const parentID = Identifier.ascending("message")

    const assistantMessage: MessageV2.Assistant = {
      id: Identifier.ascending("message"),
      role: "assistant",
      sessionID,
      parentID,
      agent: mail.agentID ?? "unknown",
      mode: mail.agentID ?? "unknown",
      path: {
        cwd: Instance.directory,
        root: Instance.directory,
      },
      cost: 0,
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      modelID: mail.model?.modelID ?? "unknown",
      providerID: mail.model?.providerID ?? "unknown",
      time: {
        created: Date.now(),
        completed: Date.now(),
      },
      finish: "stop",
      metadata: mail.metadata,
    }
    for (const part of mail.parts) {
      await Session.updatePart({
        ...part,
        messageID: assistantMessage.id,
        sessionID,
      })
    }

    await Session.updateMessage(assistantMessage)
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

    log.info("assistant mail written", {
      sessionID,
      messageID: assistantMessage.id,
      metadata: JSON.stringify(assistantMessage.metadata ?? {}).slice(0, 200),
    })
  }

  function partsFromMail(mail: SessionManager.SessionMail.User): InvokeInput["parts"] {
    const textParts = mail.parts.filter((part): part is MessageV2.TextPart => part.type === "text")
    if (textParts.length > 0) {
      return textParts.map((part) => ({
        type: "text" as const,
        text: part.text ?? "",
        synthetic: part.synthetic,
      }))
    }
    return [{ type: "text" as const, text: "" }]
  }

  async function buildCortexExecutionContext(sessionID: string): Promise<string | undefined> {
    const { Cortex } = await import("../cortex/manager")
    const role = Cortex.list().find((task) => task.sessionID === sessionID)?.executionRole
    if (role !== "delegated_subagent") return undefined

    return [
      "<cortex-execution>",
      "Execution role: delegated_subagent",
      "You are executing a delegated task.",
      "Default to direct execution and return your result to the parent agent.",
      "Do not delegate further and do not use task_output unless this session launched a visible background task itself.",
      "Never call task_output speculatively.",
      "</cortex-execution>",
    ].join("\n")
  }

  async function buildCortexReminder(sessionID: string): Promise<string | undefined> {
    const { Cortex } = await import("../cortex/manager")
    const running = Cortex.getRunningTasks().filter((t) => t.parentSessionID === sessionID)
    if (running.length === 0) return undefined

    const taskList = running
      .map((t) => {
        const elapsed = Math.floor((Date.now() - t.startedAt) / 1000)
        return `- **\`${t.id}\`** (${t.agent}): ${t.description} [${elapsed}s]`
      })
      .join("\n")

    return `<cortex-reminder>\n${CORTEX_REMINDER.replace("{{count}}", String(running.length)).replace("{{task_list}}", taskList)}\n</cortex-reminder>`
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
    allowAll: boolean,
  ): Record<string, unknown> {
    config.allowAll = allowAll

    if (adapterName === "claude-code") {
      delete config.skipPermissions
      config.permissionMode = allowAll ? "bypassPermissions" : "default"
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
          MessageV2.FilePart.omit({
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

  export async function command(input: CommandInput) {
    log.info("command", input)
    const command = await Command.get(input.command)
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

    Bus.publish(Command.Event.Executed, {
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
      await command({
        sessionID: input.sessionID,
        messageID: input.messageID,
        model: input.providerID + "/" + input.modelID,
        command: Command.Default.INIT,
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

      const messages = await MessageV2.filterCompacted(MessageV2.stream({ sessionID }))
      const pendingReply = SessionProgress.pendingReply(messages)

      if (session.pendingReply !== pendingReply) {
        await Session.update(sessionID, (draft) => {
          draft.pendingReply = pendingReply || undefined
        })
      }

      if (!pendingReply) continue

      SessionManager.run(sessionID, () => loop(sessionID)).catch(() => {})
    }
  }
}
