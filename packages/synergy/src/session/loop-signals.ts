import { LoopJob } from "./loop-job"
import { Config } from "@/config/config"
import { Provider } from "../provider/provider"
import { LLM } from "./llm"
import { Session } from "."
import { Identifier } from "../id/id"
import { MessageV2 } from "./message-v2"
import { Log } from "@/util/log"

const log = Log.create({ service: "session.loop-signals" })

LoopJob.defineSignal({
  type: "compact",
  detect(ctx) {
    return ctx.lastUserParts.some((p) => p.type === "compaction")
  },
})

LoopJob.defineSignal({
  type: "overflow",
  async detect(ctx) {
    if (ctx.lastUserParts.some((p) => p.type === "compaction")) return false
    const source = ctx.lastAssistant ?? ctx.lastFinished
    if (!source) return false
    if (source.summary === true) return false
    const config = await Config.get()
    if (config.compaction?.auto === false) return false
    const model = await Provider.getModel(ctx.lastUser.model.providerID, ctx.lastUser.model.modelID)
    const context = model.limit.context
    if (context === 0) return false
    const tokens = source.tokens
    const count = tokens.input + tokens.cache.read + tokens.output
    const output = Math.min(model.limit.output, LLM.OUTPUT_TOKEN_MAX) || LLM.OUTPUT_TOKEN_MAX
    const usable = context - output
    if (count <= usable) return false

    const part = {
      id: Identifier.ascending("part"),
      messageID: ctx.lastUser.id,
      sessionID: ctx.sessionID,
      type: "compaction" as const,
      auto: true,
    }
    await Session.updatePart(part)
    ctx.lastUserParts.push(part)
    return true
  },
})

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
