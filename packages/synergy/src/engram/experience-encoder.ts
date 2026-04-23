import { MessageV2 } from "../session/message-v2"
import { TurnDigest } from "./turn-digest"
import { Embedding } from "./embedding"
import { EngramDB } from "./database"
import { ExperienceRecall } from "./experience-recall"
import { Intent } from "./intent"
import { Agent } from "../agent/agent"
import { Provider } from "../provider/provider"
import { LLM } from "../session/llm"
import { Turn } from "../session/turn"
import { Session } from "../session"
import { Scope } from "../scope"
import { Log } from "../util/log"
import { Config } from "../config/config"
import { SessionEndpoint } from "../session/endpoint"
import { Plugin } from "../plugin"

export namespace ExperienceEncoder {
  const log = Log.create({ service: "engram.encoder" })

  interface EncodeOutcome {
    encoded: boolean
    skipped: boolean
    duplicateOf?: string
    experienceID?: string
  }

  export function onComplete(msg: MessageV2.Assistant) {
    if (msg.error && !MessageV2.AbortedError.isInstance(msg.error)) return
    if (msg.finish === "tool-calls") return

    encode(msg.sessionID, msg.parentID)
      .then(async (outcome) => {
        await triggerEncodeAfter(msg.sessionID, msg.parentID, outcome).catch((err) =>
          log.error("encode after hook failed", { sessionID: msg.sessionID, error: err?.message ?? String(err) }),
        )
      })
      .catch((err) => log.error("encoding failed", { sessionID: msg.sessionID, error: err?.message ?? String(err) }))
      .finally(async () => {
        await retryFailedEncodings(msg.sessionID, msg.parentID).catch((err) =>
          log.error("retry failed", { sessionID: msg.sessionID, error: err?.message ?? String(err) }),
        )
        await checkRewardWindow(msg.sessionID).catch((err) =>
          log.error("reward check failed", { sessionID: msg.sessionID, error: err?.message ?? String(err) }),
        )
      })
  }

  async function encode(sessionID: string, userMessageID: string): Promise<EncodeOutcome> {
    const existing = EngramDB.Experience.get(userMessageID)
    if (existing && existing.reward_status !== "encoding_failed") {
      const content = EngramDB.Experience.getContent(userMessageID)
      if (content?.script) return { encoded: false, skipped: true, experienceID: userMessageID }
    }

    const session = await Session.get(sessionID).catch(() => undefined)
    if (!session?.scope) return { encoded: false, skipped: true }
    if (session.parentID) return { encoded: false, skipped: true }
    if (SessionEndpoint.type(session.endpoint) === "genesis") return { encoded: false, skipped: true }
    if (SessionEndpoint.isHolos(session.endpoint)) return { encoded: false, skipped: true }

    const scope = session.scope as Scope

    const config = await Config.get()
    const evo = Config.resolveEvolution(config.identity?.evolution)
    if (evo.encode === false) return { encoded: false, skipped: true }

    const learning = evo.learning
    const msgs = await Session.messages({ sessionID })

    userMessageID = Turn.resolveRealUser(msgs, userMessageID)

    const userMsg = msgs.find((m) => m.info.id === userMessageID)
    if (!userMsg) return { encoded: false, skipped: true }
    if (Turn.isSyntheticUser(userMsg)) return { encoded: false, skipped: true }

    const userText = Turn.resolveUserText(msgs, userMessageID)
    if (!userText) return { encoded: false, skipped: true }

    using _ = log.time("encode", { sessionID, userMessageID })

    try {
      const userInfo = userMsg.info as MessageV2.User
      const intentCtx = await buildIntentContext(sessionID, userInfo, learning)
      const history = buildIntentHistory(msgs, userMessageID)
      const intent = Intent.sanitize(await generateIntent(intentCtx, history, userText), userText)
      const intentEmbedding = await Embedding.generate({ id: userMessageID, text: intent || userText })

      const extracted = await TurnDigest.extractSingle(sessionID, userMessageID, {
        toolOutputBudget: learning.digestToolOutputBudget,
      })
      if (!extracted || extracted.digest.segments.length === 0) {
        return { encoded: false, skipped: true }
      }

      const { digest, turn } = extracted
      const sourceAssistant = turn.assistants.at(-1)
      const scriptCtx = await buildScriptContext(sessionID, turn, digest, learning)
      const script = await generateScript(scriptCtx)
      const scriptEmbedding = script
        ? await Embedding.generate({ id: `${userMessageID}:script`, text: script })
        : undefined

      const duplicate = EngramDB.Experience.findSimilar(
        scope.id,
        intentEmbedding.vector,
        learning.dedupIntentThreshold,
        scriptEmbedding?.vector,
        learning.dedupScriptThreshold,
      )
      if (duplicate) {
        log.info("dedup: skipping", {
          id: userMessageID,
          duplicateOf: duplicate.id,
          intentSimilarity: duplicate.intentSimilarity,
          scriptSimilarity: duplicate.scriptSimilarity,
        })
        return {
          encoded: false,
          skipped: false,
          duplicateOf: duplicate.id,
          experienceID: duplicate.id,
        }
      }

      const retrievedIDs = ExperienceRecall.consumeRetrieval(sessionID)
      const raw = TurnDigest.renderToText(digest)

      EngramDB.Experience.insert({
        id: userMessageID,
        sessionID,
        scopeID: scope.id,
        intent,
        sourceProviderID: sourceAssistant?.info.role === "assistant" ? sourceAssistant.info.providerID : undefined,
        sourceModelID: sourceAssistant?.info.role === "assistant" ? sourceAssistant.info.modelID : undefined,
        intentEmbedding,
        scriptEmbedding,
        content: { script, raw },
        metadata: { changes: digest.changes, channel: digest.channel },
        retrievedExperienceIDs: retrievedIDs,
        createdAt: userInfo.time.created,
        qInit: learning.qInit,
      })
      log.info("encoded", { id: userMessageID })
      return { encoded: true, skipped: false, experienceID: userMessageID }
    } catch (err) {
      const userInfo = userMsg.info as MessageV2.User
      const fallbackTurn = Turn.collectOne(msgs, userMessageID)
      const sourceAssistant = fallbackTurn?.assistants.at(-1)
      EngramDB.Experience.insertFailed({
        id: userMessageID,
        sessionID,
        scopeID: scope.id,
        createdAt: userInfo.time.created,
        sourceProviderID: sourceAssistant?.info.role === "assistant" ? sourceAssistant.info.providerID : undefined,
        sourceModelID: sourceAssistant?.info.role === "assistant" ? sourceAssistant.info.modelID : undefined,
      })
      throw err
    }
  }

  async function triggerEncodeAfter(sessionID: string, userMessageID: string, outcome: EncodeOutcome) {
    await Plugin.trigger(
      "engram.experience.encode.after",
      {
        sessionID,
        userMessageID,
      },
      {
        encoded: outcome.encoded,
        skipped: outcome.skipped,
        duplicateOf: outcome.duplicateOf,
        experienceID: outcome.experienceID,
      },
    )
  }

  async function retryFailedEncodings(sessionID: string, excludeID?: string) {
    const failed = EngramDB.Experience.listFailed(sessionID)
    for (const exp of failed) {
      if (exp.id === excludeID) continue
      log.info("retrying failed encoding", { id: exp.id })
      await encode(sessionID, exp.id).catch((err: any) =>
        log.error("retry encoding failed", { id: exp.id, error: err?.message ?? String(err) }),
      )
    }
  }

  async function checkRewardWindow(sessionID: string) {
    const session = await Session.get(sessionID).catch(() => undefined)
    if (session?.parentID) return
    if (SessionEndpoint.type(session?.endpoint) === "genesis") return
    if (SessionEndpoint.isHolos(session?.endpoint)) return

    const config = await Config.get()
    const evo = Config.resolveEvolution(config.identity?.evolution)
    if (evo.encode === false) return

    const learning = evo.learning
    const pending = EngramDB.Experience.listPendingRewards(sessionID)
    if (pending.length === 0) return

    const msgs = await Session.messages({ sessionID })
    const turns = Turn.collect(msgs, { skipSynthetic: true })
    const userMessageIDs = turns.map((t) => t.user.info.id)

    for (const exp of pending) {
      const turnIdx = userMessageIDs.indexOf(exp.id)
      if (turnIdx < 0) continue

      const subsequentCount = userMessageIDs.length - 1 - turnIdx
      const turnsRemaining = Math.max(0, learning.rewardDelay - subsequentCount)
      EngramDB.Experience.updateTurnsRemaining(exp.id, turnsRemaining)

      if (turnsRemaining > 0) continue

      evaluateReward(exp, sessionID, msgs, turns, turnIdx, learning).catch((err: any) =>
        log.error("reward evaluation failed", { id: exp.id, error: err?.message ?? String(err) }),
      )
    }
  }

  async function evaluateReward(
    exp: EngramDB.Experience.Row,
    sessionID: string,
    msgs: MessageV2.WithParts[],
    turns: Turn.Raw[],
    turnIdx: number,
    learning: Required<Config.Learning>,
  ) {
    using _ = log.time("evaluateReward", { id: exp.id, turnIdx })

    const turn = turns[turnIdx]
    const userMsg = turn.user.info as MessageV2.User
    const assistantMsg = turn.assistants.find((m) => m.info.role === "assistant")?.info as
      | MessageV2.Assistant
      | undefined
    const model = assistantMsg ? await Provider.getModel(assistantMsg.providerID, assistantMsg.modelID) : undefined

    const rewardContent = buildRewardContent(msgs, turns, turnIdx)
    const ctx: AgentContext = { sessionID, userMsg, content: rewardContent, model, learning }

    const rewards = await generateRewards(ctx)
    if (!rewards) {
      log.warn("no rewards generated", { id: exp.id })
      return
    }

    const result = EngramDB.Experience.applyReward(exp.id, {
      rewards,
      rewardWeights: learning.rewardWeights,
      alpha: learning.alpha,
      qHistorySize: learning.qHistorySize,
    })
    if (result) {
      log.info("reward applied", { id: exp.id, ...result })
    }
  }

  interface AgentContext {
    sessionID: string
    userMsg: MessageV2.User
    content: string
    model: Provider.Model | undefined
    learning: Required<Config.Learning>
  }

  async function buildIntentContext(
    sessionID: string,
    userMsg: MessageV2.User,
    learning: Required<Config.Learning>,
  ): Promise<AgentContext> {
    const model = await Provider.getModel(userMsg.model.providerID, userMsg.model.modelID)
    return { sessionID, userMsg, content: "", model, learning }
  }

  async function buildScriptContext(
    sessionID: string,
    turn: Turn.Raw,
    digest: TurnDigest.Info,
    learning: Required<Config.Learning>,
  ): Promise<AgentContext> {
    const userMsg = turn.user.info as MessageV2.User

    const textContent = digest.segments
      .filter((s): s is TurnDigest.Segment & { type: "text" } => s.type === "text")
      .map((s) => s.text)
      .join("\n")

    const toolSummary = buildToolDetails(digest, learning)
    const changeSummary = buildChangeSummary(digest)

    const parts = ["<user>", digest.input, "</user>", "<assistant>", textContent]
    if (toolSummary) parts.push(toolSummary)
    if (changeSummary) parts.push(changeSummary)
    parts.push("</assistant>")

    const assistantMsg = turn.assistants.find((m) => m.info.role === "assistant")?.info as
      | MessageV2.Assistant
      | undefined
    const model = assistantMsg ? await Provider.getModel(assistantMsg.providerID, assistantMsg.modelID) : undefined

    return { sessionID, userMsg, content: parts.join("\n"), model, learning }
  }

  async function callAgent(agentName: string, ctx: AgentContext, content: string): Promise<string> {
    const agent = await Agent.get(agentName)
    if (!agent || !ctx.userMsg) return ""

    const agentModel = await Agent.getAvailableModel(agent)
    const model = agentModel ? await Provider.getModel(agentModel.providerID, agentModel.modelID) : ctx.model
    if (!model) return ""

    const stream = await LLM.stream({
      agent,
      user: ctx.userMsg,
      tools: {},
      model,
      small: true,
      messages: [{ role: "user" as const, content }],
      abort: new AbortController().signal,
      sessionID: ctx.sessionID,
      system: [],
      retries: ctx.learning.encoderRetries,
    })
    return (await stream.text) ?? ""
  }

  async function generateIntent(ctx: AgentContext, history: string | undefined, userInput: string): Promise<string> {
    const parts: string[] = []
    if (history) parts.push("<history>", history, "</history>", "")
    parts.push("<user>", userInput, "</user>")
    return callAgent("intent", ctx, parts.join("\n"))
  }

  async function generateScript(ctx: AgentContext): Promise<string> {
    return callAgent("script", ctx, ctx.content)
  }

  async function generateRewards(ctx: AgentContext): Promise<EngramDB.Experience.Rewards | undefined> {
    try {
      const result = await callAgent("reward", ctx, ctx.content)
      const trimmed = result.trim()

      const jsonMatch = trimmed.match(/\{[\s\S]*\}/)
      if (!jsonMatch) return parseLegacyReward(trimmed, ctx.learning.legacyRewardConfidence)

      const parsed = JSON.parse(jsonMatch[0])
      const rewards: EngramDB.Experience.Rewards = {}
      const threshold = ctx.learning.snapThreshold

      if (typeof parsed.outcome === "number") rewards.outcome = snapDiscrete(parsed.outcome, threshold)
      if (typeof parsed.intent === "number") rewards.intent = snapDiscrete(parsed.intent, threshold)
      if (typeof parsed.execution === "number") rewards.execution = snapDiscrete(parsed.execution, threshold)
      if (typeof parsed.orchestration === "number") {
        rewards.orchestration = snapDiscrete(parsed.orchestration, threshold)
      }
      if (typeof parsed.expression === "number") rewards.expression = snapDiscrete(parsed.expression, threshold)
      if (typeof parsed.confidence === "number") rewards.confidence = clamp(parsed.confidence, 0, 1)
      if (typeof parsed.reason === "string" && parsed.reason.trim()) rewards.reason = parsed.reason.trim()

      return rewards
    } catch (err: any) {
      log.error("rewards generation failed", { error: err?.message ?? String(err) })
      return undefined
    }
  }

  function parseLegacyReward(raw: string, defaultConfidence: number): EngramDB.Experience.Rewards | undefined {
    const score = parseFloat(raw)
    if (isNaN(score)) return undefined
    return { outcome: clamp(score, -1, 1), confidence: defaultConfidence }
  }

  function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value))
  }

  function snapDiscrete(value: number, threshold: number): number {
    const clamped = clamp(value, -1, 1)
    if (clamped >= threshold) return 1
    if (clamped <= -threshold) return -1
    return 0
  }

  function buildToolDetails(digest: TurnDigest.Info, learning: Required<Config.Learning>): string | undefined {
    const toolSegments = digest.segments.filter((s): s is TurnDigest.Segment & { type: "tool" } => s.type === "tool")
    if (toolSegments.length === 0) return undefined

    return toolSegments
      .map((seg) => {
        const header = seg.status === "error" ? `[Tool: ${seg.tool}] (error)` : `[Tool: ${seg.tool}] ${seg.title}`
        const lines = [header]

        if (seg.input) {
          for (const [key, value] of Object.entries(seg.input)) {
            const str = typeof value === "string" ? value : JSON.stringify(value)
            lines.push(`  ${key}: ${truncate(str, learning.encoderToolFieldBudget)}`)
          }
        }

        const output = seg.output?.trim()
        if (output) {
          const label = seg.status === "error" ? "  error:" : "  →"
          lines.push(`${label} ${truncate(output, learning.encoderToolOutputBudget)}`)
        }

        return lines.join("\n")
      })
      .join("\n\n")
  }

  function buildChangeSummary(digest: TurnDigest.Info): string | undefined {
    const { files, additions, deletions } = digest.changes
    if (files.length === 0) return undefined
    return `[Files changed: ${files.length} | +${additions} -${deletions} lines]`
  }

  function truncate(value: string, maxChars: number): string {
    if (value.length <= maxChars) return value
    return value.slice(0, maxChars) + ` [truncated, ${value.length} chars]`
  }

  function buildHistory(msgs: MessageV2.WithParts[], currentUserMsgId: string): string | undefined {
    const turns = Turn.collect(msgs, { skipSynthetic: true })
    const currentIdx = turns.findIndex((t) => t.user.info.id === currentUserMsgId)
    if (currentIdx <= 0) return undefined

    return turns
      .slice(0, currentIdx)
      .map((turn) => {
        const userInput = Turn.resolveUserText(msgs, turn.user.info.id) ?? ""

        const assistantLines: string[] = []
        for (const msg of turn.assistants) {
          for (const part of msg.parts) {
            if (part.type === "text" && !part.synthetic && part.text.trim()) {
              assistantLines.push(part.text.trim())
            } else if (part.type === "tool" && part.state.status === "completed") {
              assistantLines.push(`[Tool: ${part.tool}] ${part.state.title}`)
            } else if (part.type === "tool" && part.state.status === "error") {
              assistantLines.push(`[Tool: ${part.tool}] (error)`)
            }
          }
        }

        const lines = [`User: ${userInput}`]
        if (assistantLines.length > 0) lines.push(`Assistant: ${assistantLines.join("\n")}`)
        return lines.join("\n")
      })
      .join("\n\n")
  }

  function buildIntentHistory(msgs: MessageV2.WithParts[], currentUserMsgId: string): string | undefined {
    const turns = Turn.collect(msgs, { skipSynthetic: true })
    const currentIdx = turns.findIndex((t) => t.user.info.id === currentUserMsgId)
    if (currentIdx <= 0) return undefined

    return turns
      .slice(0, currentIdx)
      .map((turn) => {
        const userInput = Turn.resolveUserText(msgs, turn.user.info.id) ?? ""

        const assistantLines: string[] = []
        for (const msg of turn.assistants) {
          for (const part of msg.parts) {
            if (part.type === "text" && !part.synthetic && part.text.trim()) {
              assistantLines.push(part.text.trim())
            } else if (part.type === "tool" && part.state.status === "completed") {
              assistantLines.push(`(used ${part.tool}: ${part.state.title})`)
            } else if (part.type === "tool" && part.state.status === "error") {
              assistantLines.push(`(used ${part.tool}: error)`)
            }
          }
        }

        const lines = [`User: ${userInput}`]
        if (assistantLines.length > 0) lines.push(`Assistant: ${assistantLines.join("; ")}`)
        return lines.join("\n")
      })
      .join("\n\n")
  }

  function buildRewardContent(msgs: MessageV2.WithParts[], turns: Turn.Raw[], turnIdx: number): string {
    const turn = turns[turnIdx]

    const userInput = Turn.resolveUserText(msgs, turn.user.info.id) ?? ""

    const assistantLines: string[] = []
    for (const msg of turn.assistants) {
      for (const part of msg.parts) {
        if (part.type === "text" && !part.synthetic && part.text.trim()) {
          assistantLines.push(part.text.trim())
        } else if (part.type === "tool" && part.state.status === "completed") {
          assistantLines.push(`[Tool: ${part.tool}] ${part.state.title}`)
        } else if (part.type === "tool" && part.state.status === "error") {
          assistantLines.push(`[Tool: ${part.tool}] (error)`)
        }
      }
    }

    const parts = ["<user>", userInput, "</user>", "<assistant>", assistantLines.join("\n"), "</assistant>"]

    const subsequentTurns = turns.slice(turnIdx + 1)
    if (subsequentTurns.length > 0) {
      const subsequent = subsequentTurns
        .map((t) => {
          const uInput = Turn.resolveUserText(msgs, t.user.info.id) ?? ""

          const aLines: string[] = []
          for (const msg of t.assistants) {
            for (const part of msg.parts) {
              if (part.type === "text" && !part.synthetic && part.text.trim()) {
                aLines.push(part.text.trim())
              } else if (part.type === "tool" && part.state.status === "completed") {
                aLines.push(`[Tool: ${part.tool}] ${part.state.title}`)
              } else if (part.type === "tool" && part.state.status === "error") {
                aLines.push(`[Tool: ${part.tool}] (error)`)
              }
            }
          }

          const lines = [`User: ${uInput}`]
          if (aLines.length > 0) lines.push(`Assistant: ${aLines.join("\n")}`)
          return lines.join("\n")
        })
        .join("\n\n")

      parts.push("<subsequent>", subsequent, "</subsequent>")
    }

    return parts.join("\n")
  }
}
