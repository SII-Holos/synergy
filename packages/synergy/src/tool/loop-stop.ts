import z from "zod"
import { Tool } from "./tool"
import { Session } from "../session"
import { Identifier } from "../id/id"
import DESCRIPTION from "./loop-stop.txt"

const parameters = z.object({
  summary: z.string().optional().describe("Optional summary of what was completed."),
})

export const LoopStopTool = Tool.define("loop_stop", {
  description: DESCRIPTION,
  parameters,
  async execute(params, ctx) {
    const session = await Session.get(ctx.sessionID)
    if (!session.lightLoop?.active) {
      throw new Error("No active light loop on this session")
    }

    await Session.update(ctx.sessionID, (draft) => {
      draft.lightLoop = undefined
    })

    const text = `Light loop stopped.${params.summary ? ` Summary: ${params.summary}` : ""}`

    await Session.updatePart({
      id: Identifier.ascending("part"),
      messageID: ctx.messageID,
      sessionID: ctx.sessionID,
      type: "text",
      text,
      synthetic: true,
      time: { start: Date.now(), end: Date.now() },
    })

    return {
      title: "Light loop stopped",
      output: text,
      metadata: { loopStopped: true },
    }
  },
})
