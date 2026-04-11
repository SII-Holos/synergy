import z from "zod"
import { Tool } from "./tool"
import { Agenda, AgendaStore, AgendaTypes } from "../agenda"
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
  delivery: z.enum(["auto", "silent", "home", "session"]).optional().describe("New delivery target"),
  deliverySessionID: z.string().optional().describe("Required when delivery is 'session'"),
})

function buildDelivery(delivery?: string, deliverySessionID?: string): AgendaTypes.Delivery | undefined {
  if (!delivery) return undefined
  switch (delivery) {
    case "auto":
      return { target: "auto" }
    case "silent":
      return { target: "silent" }
    case "home":
      return { target: "home" }
    case "session":
      if (!deliverySessionID) throw new Error("deliverySessionID is required when delivery is 'session'")
      return { target: "session", sessionID: deliverySessionID }
    default:
      return undefined
  }
}

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

    if (params.prompt !== undefined) {
      const { item: existing } = await AgendaStore.find(params.id)
      patch.task = { ...existing.task, prompt: params.prompt }
    }

    const deliveryObj = buildDelivery(params.delivery, params.deliverySessionID)
    if (deliveryObj) patch.delivery = deliveryObj

    const item = await Agenda.update(params.id, patch)

    const lines = ["Agenda item updated.", `ID: ${item.id}`, `Title: ${item.title}`, `Status: ${item.status}`]
    if (item.state.nextRunAt) lines.push(`Next run: ${new Date(item.state.nextRunAt).toISOString()}`)

    return {
      title: item.title,
      output: lines.join("\n"),
      metadata: { id: item.id, status: item.status } as Record<string, any>,
    }
  },
})
