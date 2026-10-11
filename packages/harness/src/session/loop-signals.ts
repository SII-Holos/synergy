import { SessionProjectHealth } from "./project-health"
import { LoopJob } from "./loop-job"
import { MessageV2 } from "./message-v2"
import { SessionCompaction } from "./compaction"
import { ScopeContext } from "../scope/context"

function lastAssistant(ctx: LoopJob.Context) {
  return ctx.messages.findLast((message) => message.info.role === "assistant")
}

export function registerLoopSignals() {
  LoopJob.defineSignal({
    type: "compact",
    detect(ctx) {
      return SessionCompaction.hasPendingCompaction(ctx.lastUserParts, ctx.messages, ctx.lastUser.id)
    },
  })
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
    key(input) {
      return input.directory
    },
    async execute(input, _signal) {
      SessionProjectHealth.invalidateGitHealth(input.directory)
      return "pass"
    },
  })
}
