import { GitHealth } from "../project/git-health"
import { LoopJob } from "./loop-job"
import { Session } from "."
import { Identifier } from "../id/id"
import { MessageV2 } from "./message-v2"
import { SessionCompaction } from "./compaction"
import { Log } from "@/util/log"
import { ScopeContext } from "../scope/context"
import { SearchGuard, getFailureAnalyzers, type ToolFailureAnalyzer } from "@/tool/search-guard"

const log = Log.create({ service: "session.loop-signals" })

// ─── shared helpers ────────────────────────────────────────────────

type AssistantMsg = MessageV2.WithParts & { info: MessageV2.Assistant }

function recentAssistants(ctx: LoopJob.Context, n: number): AssistantMsg[] {
  return ctx.messages.filter((m): m is AssistantMsg => m.info.role === "assistant").slice(-n)
}

function lastAssistant(ctx: LoopJob.Context): AssistantMsg | undefined {
  return recentAssistants(ctx, 1).at(0)
}

function recentToolRecords(ctx: LoopJob.Context, tools: Set<string>): SearchGuard.SearchRecord[] {
  return recentAssistants(ctx, 8).flatMap((msg) =>
    msg.parts.flatMap((part) => {
      if (part.type !== "tool") return []
      if (!tools.has(part.tool)) return []
      const record = SearchGuard.buildRecord(part)
      return record ? [record] : []
    }),
  )
}

/** Check if the current context contains already-injected markers for an analyzer. */
/** Check if a specific marker text has already been injected into the current context. */
function hasInjectedMarker(ctx: LoopJob.Context, marker: string): boolean {
  return ctx.lastUserParts.some((part) => part.type === "text" && part.synthetic && part.text.includes(marker))
}

/** Find the first analyzer that matches the current agent context and has failures. */
function detectToolFailurePattern(
  ctx: LoopJob.Context,
): { analyzer: ToolFailureAnalyzer; pattern: SearchGuard.FailurePattern } | null {
  const analyzers = getFailureAnalyzers()
  for (const analyzer of analyzers.values()) {
    if (analyzer.agentFilter && !analyzer.agentFilter.includes(ctx.lastUser.agent)) {
      const hasAssistantMatch = recentAssistants(ctx, 8).some((msg) => analyzer.agentFilter!.includes(msg.info.agent))
      if (!hasAssistantMatch) continue
    }

    const records = recentToolRecords(ctx, analyzer.tools)
    const failures = SearchGuard.trailingFailures(records)

    // Check early stop first (higher threshold), then reflection.
    // Each marker is checked independently so reflection → early stop escalation works.
    if (failures.length >= analyzer.earlyStopThreshold && !hasInjectedMarker(ctx, analyzer.earlyStopMarker)) {
      const pattern = analyzer.detect(failures)
      if (pattern && pattern.type === "early_stop") return { analyzer, pattern }
    }
    if (failures.length >= analyzer.reflectionThreshold && !hasInjectedMarker(ctx, analyzer.reflectionMarker)) {
      const pattern = analyzer.detect(failures)
      if (pattern) return { analyzer, pattern }
    }
  }
  return null
}

// ─── compact signal ────────────────────────────────────────────────

LoopJob.defineSignal({
  type: "compact",
  detect(ctx) {
    return SessionCompaction.hasPendingCompaction(ctx.lastUserParts, ctx.messages, ctx.lastUser.id)
  },
})

// ─── error loop: same tool + same error class, all failed ──────────

const ERROR_LOOP_THRESHOLD = 10

LoopJob.defineSignal({
  type: "error_loop",
  detect(ctx) {
    if (ctx.step < ERROR_LOOP_THRESHOLD) return false

    const recent = recentAssistants(ctx, ERROR_LOOP_THRESHOLD)
    if (recent.length < ERROR_LOOP_THRESHOLD) return false

    const errorSignatures: string[] = []
    for (const msg of recent) {
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
    const msg = lastAssistant(ctx)

    const errorParts = msg?.parts.filter(
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

// ─── repeat loop: same tool + same params, all successful ──────────

const REPEAT_LOOP_THRESHOLD = 3

function toolCallKey(part: MessageV2.ToolPart): string {
  return `${part.tool}::${JSON.stringify(part.state.input)}`
}

LoopJob.defineSignal({
  type: "repeat_loop",
  detect(ctx) {
    const recent = recentAssistants(ctx, REPEAT_LOOP_THRESHOLD)
    if (recent.length < REPEAT_LOOP_THRESHOLD) return false

    const sigs: string[] = []
    for (const msg of recent) {
      const successfulParts = msg.parts.filter(
        (p): p is MessageV2.ToolPart => p.type === "tool" && p.state.status === "completed",
      )
      if (successfulParts.length === 0) return false
      sigs.push(successfulParts.map(toolCallKey).sort().join("|"))
    }

    const allSame = sigs.every((s) => s === sigs[0])
    if (allSame) {
      log.warn("repeat loop detected", {
        sessionID: ctx.sessionID,
        step: ctx.step,
        signature: sigs[0],
      })
    }
    return allSame
  },
})

LoopJob.register({
  type: "repeat_loop_injector",
  phase: "pre",
  blocking: true,
  signals: ["repeat_loop"],
  collect() {
    return []
  },
  async execute(ctx) {
    const msg = lastAssistant(ctx)

    const toolParts = msg?.parts.filter(
      (p): p is MessageV2.ToolPart => p.type === "tool" && p.state.status === "completed",
    )
    if (!toolParts?.length) return "pass"

    const toolSummary = toolParts
      .map((p) => {
        const args = JSON.stringify(p.state.input).slice(0, 120)
        return `  - ${p.tool}(${args})`
      })
      .join("\n")

    const warning = [
      `[Tool repeat loop detected] The same tool has been called successfully with the same arguments ${REPEAT_LOOP_THRESHOLD} times in a row. This may indicate an infinite loop.`,
      `Before continuing, verify that the tool is making progress. If stuck, try a different approach or report the situation to the user.`,
      `Last successful calls:`,
      toolSummary,
    ].join("\n")

    await Session.updatePart({
      id: Identifier.ascending("part"),
      messageID: ctx.lastUser.id,
      sessionID: ctx.sessionID,
      type: "text",
      text: warning,
      time: { start: Date.now(), end: Date.now() },
      synthetic: true,
    })

    return "pass"
  },
})

// ─── tool failure pattern: category-specific escalations ───────────
//
// Generic signal that delegates failure pattern detection to registered
// ToolFailureAnalyzers. Each analyzer owns its category's thresholds,
// markers, agent filter, and intervention text.
//
// Current analyzers (auto-registered in search-guard.ts):
//   - search: scholar agent search/fetch failures → reflection → early stop

LoopJob.defineSignal({
  type: "tool_failure_pattern",
  detect(ctx) {
    return detectToolFailurePattern(ctx) !== null
  },
})

LoopJob.register({
  type: "tool_failure_pattern_injector",
  phase: "pre",
  blocking: true,
  signals: ["tool_failure_pattern"],
  collect() {
    return []
  },
  async execute(ctx) {
    const result = detectToolFailurePattern(ctx)
    if (!result) return "pass"

    const { analyzer, pattern } = result
    const text = analyzer.buildIntervention(pattern)

    // Inject as a synthetic part on the current user message.
    // Uses the same mechanism as error_loop_breaker and repeat_loop_injector
    // (Session.updatePart) so the marker is immediately visible to both
    // hasInjectedMarker on the next detect cycle and the frontend renderer.
    const part = (await Session.updatePart({
      id: Identifier.ascending("part"),
      messageID: ctx.lastUser.id,
      sessionID: ctx.sessionID,
      type: "text",
      text,
      synthetic: true,
      time: { start: Date.now(), end: Date.now() },
    })) as MessageV2.Part

    ctx.lastUserParts.push(part)
    const userMessage = ctx.messages.find((msg) => msg.info.id === ctx.lastUser.id)
    if (userMessage && userMessage.parts !== ctx.lastUserParts) userMessage.parts.push(part)

    return "pass"
  },
})

// ─── git health cache invalidation ─────────────────────────────────

LoopJob.register({
  type: "git_health_cache_invalidator",
  phase: "post",
  blocking: false,
  collect(ctx) {
    const assistant = lastAssistant(ctx)
    if (!assistant) return []
    const ranBash = assistant.parts.some(
      (p): p is MessageV2.ToolPart => p.type === "tool" && p.tool === "bash" && p.state.status !== "pending",
    )
    return ranBash ? [{ type: "git_health_cache_invalidator" }] : []
  },
  capture(ctx) {
    return {
      type: "git_health_cache_invalidator",
      sessionID: ctx.sessionID,
      directory: ScopeContext.current.directory,
    }
  },
  async execute(input) {
    GitHealth.invalidate(input.directory)
    return "pass"
  },
})
