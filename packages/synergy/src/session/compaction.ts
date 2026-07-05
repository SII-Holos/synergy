import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Session } from "."
import { Identifier } from "../id/id"
import { Provider } from "../provider/provider"
import { MessageV2 } from "./message-v2"
import z from "zod"
import { Token } from "../util/token"
import { Log } from "../util/log"
import { SessionProcessor } from "./processor"
import { ModelLimit } from "@ericsanchezok/synergy-util/model-limit"
import { SessionManager } from "./manager"
import { Scope } from "@/scope"
import { Agent } from "@/agent/agent"
import { Plugin } from "@/plugin"
import { Config } from "@/config/config"
import { Turn } from "./turn"
import { LoopJob } from "./loop-job"
import { LLM } from "./llm"
import type { ModelMessage } from "ai"

export namespace SessionCompaction {
  const log = Log.create({ service: "session.compaction" })

  export interface CompactionCompletion {
    requestPartID?: string
  }

  export const Event = {
    Compacted: BusEvent.define(
      "session.compacted",
      z.object({
        sessionID: z.string(),
      }),
    ),
  }

  export const PRUNE_MINIMUM = 20_000
  export const PRUNE_PROTECT = 40_000

  const PRUNE_PROTECTED_TOOLS = ["skill"]

  export function completedCompactionHistory(
    messages: MessageV2.WithParts[],
    parentID: string,
  ): CompactionCompletion[] {
    return messages
      .map((m) => m.info)
      .filter(
        (info): info is MessageV2.Assistant =>
          info.role === "assistant" && info.summary === true && !!info.finish && info.parentID === parentID,
      )
      .map((summary) => {
        const requestPartID = summaryRequestID(summary)
        return requestPartID ? { requestPartID } : {}
      })
  }

  function summaryRequestID(summary: MessageV2.Assistant): string | undefined {
    const value = summary.metadata?.compactionRequestPartID
    return typeof value === "string" ? value : undefined
  }

  export function pendingCompactionRequest(
    messages: MessageV2.WithParts[],
    parentID: string,
    parts: MessageV2.Part[],
  ): MessageV2.CompactionPart | undefined {
    return pendingCompactionRequestFromHistory(completedCompactionHistory(messages, parentID), parts)
  }

  export function pendingCompactionRequestFromHistory(
    history: CompactionCompletion[],
    parts: MessageV2.Part[],
  ): MessageV2.CompactionPart | undefined {
    const requests = parts.filter((part): part is MessageV2.CompactionPart => part.type === "compaction")
    if (requests.length === 0) return undefined

    const requestIDs = new Set(requests.map((part) => part.id))
    const fulfilled = new Set<string>()
    for (const completion of history) {
      const requestID = completion.requestPartID
      if (requestID) {
        if (requestIDs.has(requestID)) fulfilled.add(requestID)
        continue
      }

      const legacyRequest = requests.find((part) => !fulfilled.has(part.id))
      if (legacyRequest) fulfilled.add(legacyRequest.id)
    }

    return requests.findLast((part) => !fulfilled.has(part.id))
  }

  /** Detect whether a processor error was caused by exceeding the model's context window. */
  export function isContextExceeded(error: unknown): boolean {
    if (!error || typeof error !== "object") return false
    const obj = error as { name?: string; data?: { message?: string; statusCode?: number; responseBody?: string } }

    const texts: string[] = [obj.data?.message ?? "", obj.data?.responseBody ?? ""]

    // Provider streaming errors (e.g. SSE error events from OpenAI Codex) may
    // arrive as a plain Error instead of APICallError, and fromError() stores
    // them as NamedError.Unknown with the JSON-stringified error payload in
    // the message field. Try to extract nested keywords so emergency compaction
    // can still recognize them.
    if (typeof obj.data?.message === "string") {
      try {
        const nested = JSON.parse(obj.data.message)
        for (const key of ["code", "type", "message"]) {
          if (typeof nested?.error?.[key] === "string") texts.push(nested.error[key])
        }
        if (typeof nested?.error === "string") texts.push(nested.error)
      } catch {}
    }

    const lower = texts.filter(Boolean).map((s) => s.toLowerCase())
    if (lower.length === 0) return false
    return lower.some(
      (msg) =>
        msg.includes("context_length_exceeded") ||
        msg.includes("context length") ||
        msg.includes("maximum context") ||
        msg.includes("max_tokens") ||
        (msg.includes("token") && msg.includes("exceed")) ||
        (msg.includes("too long") && msg.includes("context")) ||
        (msg.includes("request too large") && msg.includes("token")),
    )
  }

  const IMAGE_TOKEN_ESTIMATE = 500

  function sanitizeMessagesForEstimation(msgs: ModelMessage[]) {
    let imageParts = 0
    const sanitized = msgs.map((msg) => ({
      ...msg,
      content: Array.isArray(msg.content)
        ? msg.content.map((part: any) => {
            if (part.type === "image") {
              imageParts++
              return { ...part, image: "[image]" }
            }
            if (part.type === "file") {
              imageParts++
              return { ...part, data: "[file data]", mediaType: part.mediaType }
            }
            return part
          })
        : msg.content,
    }))
    return { sanitized, imageParts }
  }

  /**
   * Trim a ModelMessage array so the compaction LLM's input stays within its
   * context window. Keeps the most recent messages (highest signal for
   * summarization) and inserts a marker for omitted history.
   */
  export async function trimMessagesForContext(
    messages: ModelMessage[],
    budget: number,
    modelID?: string,
  ): Promise<ModelMessage[]> {
    const estimateJSON = modelID
      ? (value: unknown) => Token.estimateModelJSONSync(modelID, value)
      : (value: unknown) => Token.estimateJSON(value)
    const { sanitized, imageParts } = sanitizeMessagesForEstimation(messages)
    const estimated = estimateJSON(sanitized) + imageParts * IMAGE_TOKEN_ESTIMATE
    if (estimated <= budget) return messages
    const effectiveBudget = Math.max(budget, 0)
    let used = 0
    let startIndex = messages.length
    for (let i = messages.length - 1; i >= 0; i--) {
      const { sanitized: s, imageParts: ip } = sanitizeMessagesForEstimation([messages[i]])
      const cost = estimateJSON(s[0]) + ip * IMAGE_TOKEN_ESTIMATE
      if (used + cost > effectiveBudget) break
      used += cost
      startIndex = i
    }
    startIndex = Math.min(startIndex, Math.max(0, messages.length - 2))
    if (startIndex === 0) return messages
    log.info("trimming compaction input", {
      originalMessages: messages.length,
      keptMessages: messages.length - startIndex,
      omittedMessages: startIndex,
      estimatedTokens: estimated,
      budget,
    })
    const marker: ModelMessage = {
      role: "system",
      content:
        `[Earlier conversation (${startIndex} messages) was omitted to fit the summarization model's context window. ` +
        `Focus on summarizing the recent messages below.]`,
    }
    return [marker, ...messages.slice(startIndex)]
  }

  /**
   * Build a deterministic summary from raw messages when LLM compaction fails.
   * Not as good as an LLM summary, but establishes a compaction boundary and
   * preserves enough context for the agent to continue working.
   */
  function buildMechanicalSummary(messages: MessageV2.WithParts[], sessionID: string): string {
    const sections: string[] = []

    const recentUsers = messages
      .filter((m) => m.info.role === "user" && !m.parts.some((p) => MessageV2.isSystemPart(p) && p.type === "text"))
      .slice(-3)
      .map((m) => {
        const text = m.parts
          .filter((p): p is MessageV2.TextPart => p.type === "text")
          .map((p) => p.text)
          .join(" ")
          .trim()
        return text.slice(0, 300)
      })
      .filter(Boolean)
    if (recentUsers.length) {
      sections.push("### Recent user requests\n" + recentUsers.map((t) => `- ${t}`).join("\n"))
    }

    const files = new Set<string>()
    for (const msg of messages) {
      for (const part of msg.parts) {
        if (part.type === "patch") {
          for (const file of part.files) {
            // Filter out temporary/internal files — they add noise to recovery UI
            const base = file.split("/").pop() ?? file
            if (base.startsWith(".tmp-") || base.startsWith("._")) continue
            files.add(file)
          }
        }
      }
    }
    if (files.size) {
      sections.push(
        "### Files involved\n" +
          [...files]
            .slice(0, 30)
            .map((f) => `- ${f}`)
            .join("\n"),
      )
    }

    const tools = new Set<string>()
    for (const msg of messages) {
      for (const part of msg.parts) {
        if (part.type === "tool") tools.add(part.tool)
      }
    }
    if (tools.size) {
      sections.push("### Tools used\n" + [...tools].join(", "))
    }

    sections.push(
      "### Note\n" +
        "This is an automatically generated summary because LLM-based compaction could not complete. " +
        `Use \`session_read\` with session ID \`${sessionID}\` to browse the full conversation history.`,
    )

    return "## Conversation Summary (Automatic Fallback)\n\n" + sections.join("\n\n")
  }

  /** Overwrite the compaction assistant message with a mechanical summary. */
  async function writeMechanicalSummary(
    msg: MessageV2.Assistant,
    input: { messages: MessageV2.WithParts[]; sessionID: string },
  ) {
    const summary = buildMechanicalSummary(input.messages, input.sessionID)
    await Session.updatePart({
      id: Identifier.ascending("part"),
      messageID: msg.id,
      sessionID: input.sessionID,
      type: "text",
      text: summary,
      origin: "system",
      time: { start: Date.now(), end: Date.now() },
    })
    msg.error = undefined
    msg.finish = "stop"
    if (!msg.time.completed) msg.time.completed = Date.now()
    await Session.updateMessage(msg)
    await Session.updatePart({
      id: Identifier.ascending("part"),
      messageID: msg.id,
      sessionID: input.sessionID,
      type: "compaction_recovery",
      summary,
      mechanical: true,
      validated: false,
    })
    log.info("wrote mechanical fallback summary", { sessionID: input.sessionID })
  }

  // goes backwards through parts until there are 40_000 tokens worth of tool
  // calls. then erases output of previous tool calls. idea is to throw away old
  // tool calls that are no longer relevant.

  /** Pure scan that returns the completed tool parts eligible for pruning. */
  export function selectPartsToPrune(msgs: MessageV2.WithParts[], modelID?: string): MessageV2.ToolPart[] {
    let total = 0
    let pruned = 0
    const toPrune: MessageV2.ToolPart[] = []
    const estimateTokens = modelID
      ? (text: string) => Token.estimateModelSync(modelID, text)
      : (text: string) => Token.estimate(text)

    const protectBoundary = Turn.countRecentTurns(msgs, 2)

    loop: for (let msgIndex = protectBoundary - 1; msgIndex >= 0; msgIndex--) {
      const msg = msgs[msgIndex]
      if (msg.info.role === "assistant" && msg.info.summary) break loop
      for (let partIndex = msg.parts.length - 1; partIndex >= 0; partIndex--) {
        const part = msg.parts[partIndex]
        if (part.type === "tool")
          if (part.state.status === "completed") {
            if (PRUNE_PROTECTED_TOOLS.includes(part.tool)) continue

            if (part.state.time.compacted) continue
            const estimate = estimateTokens(part.state.output)
            total += estimate
            if (total > PRUNE_PROTECT) {
              pruned += estimate
              toPrune.push(part)
            }
          }
      }
    }
    return pruned > PRUNE_MINIMUM ? toPrune : []
  }

  export async function prune(input: { sessionID: string; modelID?: string }) {
    const config = await Config.current()
    if (config.compaction?.prune === false) return
    log.info("pruning")
    const msgs = await Session.messages({ sessionID: input.sessionID })

    const toPrune = selectPartsToPrune(msgs, input.modelID)

    if (toPrune.length > 0) {
      const completed = toPrune.filter(
        (part): part is MessageV2.ToolPart & { state: { status: "completed"; time: { compacted?: number } } } =>
          part.state.status === "completed",
      )
      await Promise.all(
        completed.map((part) => {
          part.state.time.compacted = Date.now()
          part.state.output = ""
          return Session.updatePart(part)
        }),
      )
      log.info("pruned", { count: completed.length })
    }
  }

  const ANCHOR_OPEN = "<anchor>"
  const ANCHOR_CLOSE = "</anchor>"

  type Anchor = {
    text: string
    sourceMessageID?: string
  }

  function realUserText(msg: MessageV2.WithParts): string | undefined {
    const textParts = msg.parts.filter((p): p is MessageV2.TextPart => p.type === "text" && !MessageV2.isSystemPart(p))
    if (textParts.length === 0) return undefined
    const text = textParts
      .map((p) => p.text)
      .join("\n")
      .trim()
    return text || undefined
  }

  function formatAnchor(text: string): string {
    return [ANCHOR_OPEN, "This is the most recent request before compaction.", "", text, ANCHOR_CLOSE].join("\n")
  }

  /**
   * Preserve the active task's request across compaction (issue #281 §7).
   * The compaction parent is the task root R, so this is an O(1) lookup by id:
   * take R's user-authored text, falling back to its summary title. No backward
   * scan, no carried-anchor metadata — the root is a persisted message reachable
   * by rootID even after it leaves the context window.
   */
  export function resolveAnchor(messages: MessageV2.WithParts[], parentID: string): Anchor | undefined {
    const root = messages.find((m) => m.info.id === parentID && m.info.role === "user")
    if (!root) return undefined
    const text = realUserText(root) ?? (root.info as MessageV2.User).summary?.title?.trim()
    return text ? { text, sourceMessageID: root.info.id } : undefined
  }

  export function buildAnchor(messages: MessageV2.WithParts[], parentID: string): string | undefined {
    const anchor = resolveAnchor(messages, parentID)
    return anchor ? formatAnchor(anchor.text) : undefined
  }

  export async function process(input: {
    parentID: string
    requestPartID: string
    messages: MessageV2.WithParts[]
    sessionID: string
    abort: AbortSignal
    auto: boolean
  }) {
    const userMessage = input.messages.findLast((m) => m.info.id === input.parentID)!.info as MessageV2.User
    const agent = await Agent.get("compaction")
    const agentModel = await Agent.getAvailableModel(agent)
    const model = agentModel
      ? await Provider.getModel(agentModel.providerID, agentModel.modelID)
      : await Provider.getModel(userMessage.model.providerID, userMessage.model.modelID)

    const session = await SessionManager.requireSession(input.sessionID)
    const directory = (session.scope as Scope).directory
    const modelMessages = MessageV2.toModelMessage(input.messages)

    const msg = (await Session.updateMessage({
      id: Identifier.ascending("message"),
      role: "assistant",
      parentID: input.parentID,
      rootID: input.parentID,
      visible: true,
      sessionID: input.sessionID,
      mode: "compaction",
      agent: "compaction",
      summary: true,
      path: {
        cwd: directory,
        root: directory,
      },
      cost: 0,
      tokens: {
        output: 0,
        input: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      modelID: model.id,
      providerID: model.providerID,
      time: {
        created: Date.now(),
      },
      metadata: {
        compactionRequestPartID: input.requestPartID,
      },
    })) as MessageV2.Assistant
    const processor = SessionProcessor.create({
      assistantMessage: msg,
      sessionID: input.sessionID,
      model,
      abort: input.abort,
    })
    const compacting = await Plugin.trigger(
      "experimental.session.compacting",
      { sessionID: input.sessionID },
      { context: [], prompt: undefined },
    )
    const defaultPrompt = [
      "Write the compaction continuation summary now.",
      "Strictly follow the compaction system prompt and its required Markdown section headers.",
      "Only summarize the prior conversation for a future session; do not continue the user's task or answer pending requests.",
      "Do not call tools. Do not emit tool-call-shaped text, DSML/XML tool blocks, JSON-RPC requests, shell transcripts, patches, file writes, or structured tool arguments.",
      "Preserve exact observed facts, including user requests, decisions, constraints, file paths, commands already run, results already observed, completed work, current state, and pending work.",
      "If something is unknown or was not observed, say it is unknown. Do not infer or fabricate.",
      "Output only the Markdown continuation summary.",
    ].join("\n")
    const promptText = compacting.prompt ?? [defaultPrompt, ...compacting.context].join("\n\n")

    // Trim the conversation history so it fits within the compaction model's
    // context window, reserving space for the prompt and output.
    const contextLimit = model.limit?.context ?? 0
    const promptCost = (await Token.estimateModel(model.id, promptText)) + 200
    const messageBudget = contextLimit > 0 ? contextLimit - promptCost : Infinity
    const safeMessages = isFinite(messageBudget)
      ? await trimMessagesForContext(modelMessages, messageBudget, model.id)
      : modelMessages

    const result = await processor.process({
      user: userMessage,
      agent,
      abort: input.abort,
      sessionID: input.sessionID,
      tools: {},
      system: [],
      messages: [
        ...safeMessages,
        {
          role: "user" as const,
          content: [
            {
              type: "text" as const,
              text: promptText,
            },
          ],
        },
      ],
      model,
    })

    // If the LLM call failed due to context limits (e.g. bad token estimation
    // or model-reported limits don't match reality), fall back to a
    // deterministic mechanical summary rather than letting compaction fail.
    let compactionOk = true
    if (processor.message.error) {
      if (isContextExceeded(processor.message.error)) {
        log.warn("compaction LLM context exceeded, using mechanical fallback", {
          sessionID: input.sessionID,
        })
        await writeMechanicalSummary(msg, input)
      } else {
        compactionOk = false
      }
    }

    if (!compactionOk) return "stop"

    // Ensure the compaction assistant message is marked as finished even if the
    // processor didn't emit a finish-step event (e.g. stream was interrupted).
    // Without this, filterCompacted can't identify the compaction boundary and
    // the loop may incorrectly break on the next user message.
    if (!msg.finish) {
      msg.finish = "stop"
    }
    if (!msg.time.completed) {
      msg.time.completed = Date.now()
    }
    await Session.updateMessage(msg)

    // Emit the full compaction text for the frontend.
    const msgParts = await MessageV2.parts({ sessionID: input.sessionID, messageID: msg.id })
    const textParts = msgParts.filter((p): p is MessageV2.TextPart => p.type === "text")
    const allText = textParts.map((p) => p.text).join("\n")

    await Session.updatePart({
      id: Identifier.ascending("part"),
      messageID: msg.id,
      sessionID: input.sessionID,
      type: "compaction_recovery",
      summary: allText,
      mechanical: false,
      validated: true,
    })

    if (input.auto) {
      const anchor = resolveAnchor(input.messages, input.parentID)
      const continueMsg = await Session.updateMessage({
        id: Identifier.ascending("message"),
        role: "user",
        sessionID: input.sessionID,
        time: {
          created: Date.now(),
        },
        agent: userMessage.agent,
        model: userMessage.model,
        origin: { type: "compaction", detail: "auto_continue" },
        isRoot: false,
        rootID: input.parentID,
        visible: false,
        summary: { title: "Compaction complete", diffs: [] },
      })
      const now = Date.now()
      await Session.updatePart({
        id: Identifier.ascending("part"),
        messageID: continueMsg.id,
        sessionID: input.sessionID,
        type: "text",
        synthetic: true,
        origin: "system",
        text: "Continue if you have next steps",
        time: { start: now, end: now },
      })
      if (anchor) {
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: continueMsg.id,
          sessionID: input.sessionID,
          type: "text",
          synthetic: true,
          origin: "system",
          text: formatAnchor(anchor.text),
          time: { start: now, end: now },
        })
      }
    }
    Bus.publish(Event.Compacted, { sessionID: input.sessionID })
    return input.auto ? "continue" : "stop"
  }

  LoopJob.register({
    type: "compaction",
    phase: "pre",
    blocking: true,
    signals: ["compact"],
    collect() {
      return []
    },
    async execute(ctx) {
      const history = ctx.compactionHistory ?? completedCompactionHistory(ctx.messages, ctx.lastUser.id)
      const part = pendingCompactionRequestFromHistory(history, ctx.lastUserParts)
      if (!part) return "pass"
      const result = await process({
        messages: ctx.messages,
        parentID: ctx.lastUser.id,
        requestPartID: part.id,
        abort: ctx.abort,
        sessionID: ctx.sessionID,
        auto: part.auto,
      })
      return result
    },
  })

  LoopJob.register({
    type: "prune",
    phase: "pre",
    blocking: false,
    collect(ctx) {
      if (ctx.step <= 1) return []
      return [{ type: "prune" }]
    },
    async execute(ctx) {
      await prune({ sessionID: ctx.sessionID, modelID: ctx.modelID })
      return "pass"
    },
  })
}
