import { Log } from "@ericsanchezok/synergy-harness/util/log"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionProgress } from "@ericsanchezok/synergy-harness/session/progress"
import { LoopJob } from "@ericsanchezok/synergy-harness/session/loop-job"

const log = Log.create({ service: "channel.loop-jobs" })

/**
 * Tool whose completed part carries a reaction-only terminal intent. Kept as a
 * literal instead of importing the tool module: the job must stay cheap to
 * load and free of any config or provider side effects.
 */
const REACTION_ONLY_TOOL = "channel_reaction_only"

/**
 * Close a turn the moment it records a reaction-only intent. The tool's
 * contract is "call once, then the turn is over", and the delivery paths
 * (foreground handler and outbound bridge) resolve that terminal assistant's
 * persisted tool part. Closing it avoids an unnecessary model round; a later
 * steer or continuation can still produce its own terminal delivery.
 *
 * The job terminalizes the intent-bearing assistant instead of just breaking
 * the loop: rewriting `finish` to "stop" (the same terminalization compaction
 * performs) leaves the root with a normal terminal assistant, so result
 * selection, completion notices, and repair scans behave exactly as if the
 * model had stopped on its own. The next loop iteration then exits on its own
 * through `needsModelCall`, and returning "pass" keeps other post jobs running.
 * The job fires only while that assistant is still non-terminal; a turn that
 * already ends with stop finishes untouched.
 */
export function registerReactionOnlyJobs() {
  LoopJob.register({
    type: "channel_reaction_only_turn_close",
    phase: "post",
    blocking: true,
    collect(ctx) {
      if (ctx.abort.aborted) return []
      const assistant = ctx.lastAssistant
      if (!assistant || SessionProgress.isTerminalAssistant(assistant)) return []
      const parts = ctx.messages.findLast((message) => message.info.id === assistant.id)?.parts ?? []
      const recorded = parts.some(
        (part) => part.type === "tool" && part.tool === REACTION_ONLY_TOOL && part.state.status === "completed",
      )
      if (!recorded) return []
      // A sibling tool call still in flight must finish first: terminalizing
      // here would leave that result with no model round to consume it. Its
      // completion re-runs this job, which closes the turn then.
      const siblingInFlight = parts.some(
        (part) =>
          part.type === "tool" &&
          part.tool !== REACTION_ONLY_TOOL &&
          part.state.status !== "completed" &&
          part.state.status !== "error",
      )
      return siblingInFlight ? [] : [{ type: "channel_reaction_only_turn_close" }]
    },
    async execute(ctx) {
      const assistant = ctx.lastAssistant
      if (!assistant || ctx.abort.aborted || assistant.error || SessionProgress.isTerminalAssistant(assistant))
        return "pass"
      assistant.finish = "stop"
      await Session.updateMessage(assistant)
      log.info("reaction-only intent recorded; turn closed without another model round", {
        sessionID: ctx.sessionID,
        messageID: assistant.id,
      })
      return "pass"
    },
  })
}
