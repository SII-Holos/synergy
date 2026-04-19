import z from "zod"
import { Tool } from "./tool"
import { Agenda, AgendaTypes } from "../agenda"
import { Instance } from "../scope/instance"
import DESCRIPTION from "./agenda-update.txt"

const parameters = z.object({
  id: z.string().describe("Agenda item ID to update"),
  title: z.string().optional().describe("New title"),
  description: z.string().optional().describe("New description"),
  status: AgendaTypes.ItemStatus.optional().describe("New status: pending, active, paused, done, cancelled"),
  tags: z.array(z.string()).optional().describe("New tags (replaces existing)"),
  triggers: z
    .array(AgendaTypes.Trigger)
    .optional()
    .describe("New triggers (replaces existing). Recalculates next run time."),
  prompt: z.string().optional().describe("New execution prompt"),
  wake: z.boolean().optional().describe("Whether to wake the origin session on completion"),
  silent: z.boolean().optional().describe("Whether to suppress result delivery"),
})

export const AgendaUpdateTool = Tool.define("agenda_update", {
  description: DESCRIPTION,
  parameters,
  async execute(params: z.infer<typeof parameters>) {
    const patch: AgendaTypes.PatchInput = {}

    if (params.title !== undefined) patch.title = params.title
    if (params.description !== undefined) patch.description = params.description
    if (params.status !== undefined) patch.status = params.status
    if (params.tags !== undefined) patch.tags = params.tags
    if (params.triggers !== undefined) patch.triggers = params.triggers
    if (params.prompt !== undefined) patch.prompt = params.prompt
    if (params.wake !== undefined) patch.wake = params.wake
    if (params.silent !== undefined) patch.silent = params.silent

    const item = await Agenda.update(params.id, patch, Instance.scope.id)

    const lines = ["Agenda item updated.", `ID: ${item.id}`, `Title: ${item.title}`, `Status: ${item.status}`]
    if (item.state.nextRunAt) lines.push(`Next run: ${new Date(item.state.nextRunAt).toISOString()}`)

    return {
      title: item.title,
      output: lines.join("\n"),
      metadata: { id: item.id, status: item.status } as Record<string, any>,
    }
  },
})
