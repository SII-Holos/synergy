import z from "zod"
import { Tool } from "./tool"
import { Agenda } from "../agenda"
import DESCRIPTION from "./agenda-trigger.txt"

const parameters = z.object({
  id: z.string().describe("Agenda item ID to trigger"),
})

export const AgendaTriggerTool = Tool.define("agenda_trigger", {
  description: DESCRIPTION,
  parameters,
  async execute(params: z.infer<typeof parameters>) {
    const result = await Agenda.trigger(params.id)

    const lines = ["Agenda item triggered."]
    if (result.sessionID) lines.push(`Session: ${result.sessionID}`)

    return {
      title: "Triggered",
      output: lines.join("\n"),
      metadata: { id: params.id, sessionID: result.sessionID } as Record<string, any>,
    }
  },
})
