import z from "zod"
import { Tool } from "./tool"
import { Agenda } from "../agenda"
import { Instance } from "../scope/instance"
import DESCRIPTION from "./agenda-cancel.txt"

const parameters = z.object({
  id: z.string().describe("Agenda item ID to cancel"),
})

export const AgendaCancelTool = Tool.define("agenda_cancel", {
  description: DESCRIPTION,
  parameters,
  async execute(params: z.infer<typeof parameters>) {
    const item = await Agenda.cancel(params.id)

    return {
      title: "Cancelled",
      output: `Agenda item cancelled.\nID: ${item.id}\nTitle: ${item.title}\nStatus: cancelled\n\nThe item will no longer fire. Execution history is preserved — use agenda_logs(id="${item.id}") to review.`,
      metadata: { id: item.id, status: "cancelled" } as Record<string, any>,
    }
  },
})
