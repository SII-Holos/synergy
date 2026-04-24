import z from "zod"
import { Tool } from "./tool"
import { Agenda } from "../agenda"
import { Instance } from "../scope/instance"
import DESCRIPTION from "./agenda-delete.txt"

const parameters = z.object({
  id: z.string().describe("Agenda item ID to delete"),
})

export const AgendaDeleteTool = Tool.define("agenda_delete", {
  description: DESCRIPTION,
  parameters,
  async execute(params: z.infer<typeof parameters>) {
    await Agenda.remove(params.id, Instance.scope.id)

    return {
      title: "Deleted",
      output: `Agenda item ${params.id} deleted.`,
      metadata: { id: params.id } as Record<string, any>,
    }
  },
})
