import { LoopJob } from "./loop-job"
import { LLM } from "./llm"
import { Session } from "."
import { Identifier } from "../id/id"
import { MessageV2 } from "./message-v2"
import { Log } from "@/util/log"
import { Token } from "@/util/token"

const log = Log.create({ service: "session.loop-signals" })

LoopJob.defineSignal({
  type: "compact",
  detect(ctx) {
    return ctx.lastUserParts.some((p) => p.type === "compaction")
  },
})

LoopJob.defineSignal({
  type: "overflow",
  detect(ctx) {
    if (ctx.lastUserParts.some((p) => p.type === "compaction")) return false
    if (ctx.compactionAutoDisabled) return false
    const limits = ctx.modelLimits
    if (!limits || limits.context === 0) return false

    const output = Math.min(limits.output, LLM.OUTPUT_TOKEN_MAX) || LLM.OUTPUT_TOKEN_MAX
    const usable = limits.context - output

    // Check 1: previous turn's actual token usage is near or exceeds the limit.
    // Skipped when the last assistant is a compaction summary (just compacted).
    // Uses a 95% threshold to trigger preemptively — a single tool output can
    // push input tokens a few thousand higher between signal detection and the
    // next LLM call, so waiting until we're actually over is too late.
    const source = ctx.lastAssistant ?? ctx.lastFinished
    let lastActualInput = 0
    if (source && source.summary !== true) {
      const tokens = source.tokens
      lastActualInput = tokens.input + tokens.cache.read
      const count = lastActualInput + tokens.output
      if (count > usable * 0.95) return injectCompaction(ctx)
    }

    // Check 2: estimate current conversation size to catch growth that
    // the previous turn's usage doesn't reflect (new user messages,
    // tool outputs, system prompt expansion, etc.).
    // This runs independently of whether the last turn was a compaction
    // summary, because new content may have accumulated since.
    //
    // The raw estimate only counts message content visible in the
    // conversation history. It does NOT include the system prompt, tool
    // schema definitions, memory/engram injections, or model-specific
    // formatting overhead — which can add 30-60K+ tokens. To compensate,
    // we calibrate against the last assistant's actual provider-reported
    // input token count: the gap between actual and estimated is the
    // invisible overhead, and we carry it forward.
    const estimated = estimateConversationTokens(ctx.messages, ctx.modelID)
    const overhead = lastActualInput > estimated ? lastActualInput - estimated : 0
    const calibrated = estimated + overhead
    if (calibrated > usable * 0.85) {
      log.info("overflow check 2 triggered", {
        sessionID: ctx.sessionID,
        estimated,
        overhead,
        calibrated,
        threshold: Math.round(usable * 0.85),
        usable,
      })
      return injectCompaction(ctx)
    }

    return false
  },
})

function injectCompaction(ctx: LoopJob.Context): true {
  const part = {
    id: Identifier.ascending("part"),
    messageID: ctx.lastUser.id,
    sessionID: ctx.sessionID,
    type: "compaction" as const,
    auto: true,
  }
  Session.updatePart(part).catch(() => {})
  ctx.lastUserParts.push(part)
  return true
}

function estimateConversationTokens(messages: MessageV2.WithParts[], modelID?: string): number {
  const est = (text: string) => (modelID ? Token.estimateModelSync(modelID, text) : Token.estimate(text))
  let total = 0
  for (const msg of messages) {
    total += 4
    for (const part of msg.parts) {
      switch (part.type) {
        case "text":
          total += est(part.text)
          break
        case "tool":
          if (part.state.status === "completed") {
            total += Token.estimateJSON(part.state.input)
            total += part.state.time.compacted ? 10 : est(part.state.output)
          } else if (part.state.status === "error") {
            total += Token.estimateJSON(part.state.input)
            total += est(part.state.error)
          }
          break
        case "reasoning":
          total += est(part.text)
          break
        case "file":
          total += 300
          break
      }
    }
  }
  return total
}

const ERROR_LOOP_THRESHOLD = 3

LoopJob.defineSignal({
  type: "error_loop",
  detect(ctx) {
    if (ctx.step < ERROR_LOOP_THRESHOLD) return false

    const recentAssistants = ctx.messages
      .filter((m): m is MessageV2.WithParts & { info: MessageV2.Assistant } => m.info.role === "assistant")
      .slice(-ERROR_LOOP_THRESHOLD)

    if (recentAssistants.length < ERROR_LOOP_THRESHOLD) return false

    const errorSignatures: string[] = []
    for (const msg of recentAssistants) {
      const errorParts = msg.parts.filter(
        (p): p is MessageV2.ToolPart => p.type === "tool" && p.state.status === "error",
      )
      if (errorParts.length === 0) return false

      const sig = errorParts
        .map((p) => {
          const errorText = p.state.status === "error" ? p.state.error : ""
          return `${p.tool}:${extractErrorName(errorText)}`
        })
        .sort()
        .join("|")
      errorSignatures.push(sig)
    }

    const allSame = errorSignatures.every((sig) => sig === errorSignatures[0])
    if (allSame) {
      log.warn("error loop detected", {
        sessionID: ctx.sessionID,
        step: ctx.step,
        signature: errorSignatures[0],
      })
    }
    return allSame
  },
})

function extractErrorName(error: string): string {
  const colonIndex = error.indexOf(":")
  if (colonIndex > 0 && colonIndex < 60) {
    const candidate = error.slice(0, colonIndex).trim()
    if (/^[A-Z]\w*Error$/.test(candidate)) return candidate
  }
  return "UnknownError"
}

LoopJob.register({
  type: "error_loop_breaker",
  phase: "pre",
  blocking: true,
  signals: ["error_loop"],
  collect() {
    return []
  },
  async execute(ctx) {
    const lastAssistant = ctx.messages
      .filter((m): m is MessageV2.WithParts & { info: MessageV2.Assistant } => m.info.role === "assistant")
      .at(-1)

    const errorParts = lastAssistant?.parts.filter(
      (p): p is MessageV2.ToolPart => p.type === "tool" && p.state.status === "error",
    )

    const errorSummary = errorParts?.length
      ? errorParts
          .map((p) => {
            const errorText = p.state.status === "error" ? p.state.error : ""
            return `${p.tool}: ${errorText.slice(0, 200)}`
          })
          .join("; ")
      : "unknown error"

    await Session.updatePart({
      id: Identifier.ascending("part"),
      messageID: ctx.lastUser.id,
      sessionID: ctx.sessionID,
      type: "text",
      text: `[Tool error loop detected] The same tool has failed ${ERROR_LOOP_THRESHOLD} times in a row with the same error class. Stopping to avoid wasting further resources. Last error: ${errorSummary}`,
      time: { start: Date.now(), end: Date.now() },
      synthetic: true,
    })

    return "stop"
  },
})
