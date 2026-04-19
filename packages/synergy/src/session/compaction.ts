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

  /** Detect whether a processor error was caused by exceeding the model's context window. */
  export function isContextExceeded(error: unknown): boolean {
    if (!error || typeof error !== "object") return false
    const obj = error as { name?: string; data?: { message?: string; statusCode?: number; responseBody?: string } }
    if (obj.name !== "APIError") return false
    // Check the primary error message and the raw response body, since
    // ProviderTransform.error() may rewrite the message and drop keywords.
    const texts = [obj.data?.message ?? "", obj.data?.responseBody ?? ""].map((s) => s.toLowerCase())
    return texts.some(
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

  /**
   * Trim a ModelMessage array so the compaction LLM's input stays within its
   * context window. Keeps the most recent messages (highest signal for
   * summarization) and inserts a marker for omitted history.
   */
  function trimMessagesForContext(messages: ModelMessage[], budget: number): ModelMessage[] {
    const estimated = Token.estimateJSON(messages)
    if (estimated <= budget) return messages

    // If budget is zero or negative (output + prompt alone exceeds context),
    // keep only the last 2 messages so the compaction model has *something*
    // to summarize. The mechanical fallback will catch the failure if even
    // this is too large.
    const effectiveBudget = Math.max(budget, 0)

    let used = 0
    let startIndex = messages.length
    for (let i = messages.length - 1; i >= 0; i--) {
      const cost = Token.estimateJSON(messages[i])
      if (used + cost > effectiveBudget) break
      used += cost
      startIndex = i
    }
    // Always include at least the last two messages for minimal context
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
      .filter(
        (m) => m.info.role === "user" && !m.parts.some((p) => p.type === "text" && "synthetic" in p && p.synthetic),
      )
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
          for (const file of part.files) files.add(file)
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
      time: { start: Date.now(), end: Date.now() },
    })
    msg.error = undefined
    msg.finish = "stop"
    if (!msg.time.completed) msg.time.completed = Date.now()
    await Session.updateMessage(msg)
    log.info("wrote mechanical fallback summary", { sessionID: input.sessionID })
  }

  // goes backwards through parts until there are 40_000 tokens worth of tool
  // calls. then erases output of previous tool calls. idea is to throw away old
  // tool calls that are no longer relevant.

  /** Pure scan that returns the completed tool parts eligible for pruning. */
  export function selectPartsToPrune(msgs: MessageV2.WithParts[]): MessageV2.ToolPart[] {
    let total = 0
    let pruned = 0
    const toPrune: MessageV2.ToolPart[] = []

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
            const estimate = Token.estimate(part.state.output)
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

  export async function prune(input: { sessionID: string }) {
    const config = await Config.get()
    if (config.compaction?.prune === false) return
    log.info("pruning")
    const msgs = await Session.messages({ sessionID: input.sessionID })

    const toPrune = selectPartsToPrune(msgs)

    if (toPrune.length > 0) {
      for (const part of toPrune) {
        if (part.state.status === "completed") {
          part.state.time.compacted = Date.now()
          await Session.updatePart(part)
        }
      }
      log.info("pruned", { count: toPrune.length })
    }
  }

  export async function process(input: {
    parentID: string
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
    const defaultPrompt =
      "Provide a detailed prompt for continuing our conversation above. Focus on information that would be helpful for continuing the conversation, including what we did, what we're doing, which files we're working on, and what we're going to do next considering new session will not have access to our conversation."
    const promptText = compacting.prompt ?? [defaultPrompt, ...compacting.context].join("\n\n")

    // Trim the conversation history so it fits within the compaction model's
    // context window, reserving space for the prompt and output.
    const contextLimit = model.limit?.context ?? 0
    const outputReserve = ModelLimit.outputReserve(model.limit, LLM.OUTPUT_TOKEN_MAX)
    const promptCost = (await Token.estimateModel(model.id, promptText)) + 200
    const messageBudget = contextLimit > 0 ? contextLimit - outputReserve - promptCost : Infinity
    const safeMessages = isFinite(messageBudget) ? trimMessagesForContext(modelMessages, messageBudget) : modelMessages

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

    if (input.auto) {
      const continueMsg = await Session.updateMessage({
        id: Identifier.ascending("message"),
        role: "user",
        sessionID: input.sessionID,
        time: {
          created: Date.now(),
        },
        agent: userMessage.agent,
        model: userMessage.model,
        summary: { title: "Compaction complete", diffs: [] },
      })
      await Session.updatePart({
        id: Identifier.ascending("part"),
        messageID: continueMsg.id,
        sessionID: input.sessionID,
        type: "text",
        synthetic: true,
        text: "Continue if you have next steps",
        time: {
          start: Date.now(),
          end: Date.now(),
        },
      })
    }
    Bus.publish(Event.Compacted, { sessionID: input.sessionID })
    return input.auto ? "continue" : "stop"
  }

  LoopJob.register({
    type: "compaction",
    phase: "pre",
    blocking: true,
    signals: ["overflow", "compact"],
    collect() {
      return []
    },
    async execute(ctx) {
      const part = ctx.lastUserParts.find((p): p is MessageV2.CompactionPart => p.type === "compaction")!
      const result = await process({
        messages: ctx.messages,
        parentID: ctx.lastUser.id,
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
      await prune({ sessionID: ctx.sessionID })
      return "pass"
    },
  })
}
