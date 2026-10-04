import { agendaAgentItem } from "./agent-item"
import z from "zod"
import { Tool } from "@ericsanchezok/synergy-harness/tool/tool"
import { Agenda } from ".."
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import DESCRIPTION from "./agenda-cancel.txt"

const parameters = z.object({
  agendaItemId: z.string().describe("Agenda item ID to cancel"),
})

export const AgendaCancelTool = Tool.define(
  "agenda_cancel",
  {
    description: DESCRIPTION,
    parameters,
    async execute(params: z.infer<typeof parameters>) {
      const item = await Agenda.cancel(params.agendaItemId)

      return {
        title: "Cancelled",
        output: JSON.stringify(agendaAgentItem(item), null, 2),
        metadata: { id: item.id, status: "cancelled" } as Record<string, any>,
      }
    },
  },
  { activityKind: "object" },
)
