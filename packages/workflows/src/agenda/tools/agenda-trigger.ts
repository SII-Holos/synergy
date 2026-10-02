import z from "zod"
import { Tool } from "@ericsanchezok/synergy-harness/tool/tool"
import { Agenda } from ".."
import DESCRIPTION from "./agenda-trigger.txt"

const parameters = z.object({
  agendaItemId: z.string().describe("Agenda item ID to trigger"),
})

export const AgendaTriggerTool = Tool.define(
  "agenda_trigger",
  {
    description: DESCRIPTION,
    parameters,
    async execute(params: z.infer<typeof parameters>) {
      const result = await Agenda.trigger(params.agendaItemId)

      return {
        title: "Triggered",
        output: JSON.stringify({ agendaItemId: params.agendaItemId, executionSessionId: result.sessionID }, null, 2),
        metadata: { id: params.agendaItemId, sessionID: result.sessionID } as Record<string, any>,
      }
    },
  },
  { activityKind: "object" },
)
