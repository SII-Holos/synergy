import { formatLocalDateTime } from "@/util/time-format"
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
  triggers: z.array(AgendaTypes.Trigger).optional().describe("New triggers (replaces existing, recomputes nextRunAt)"),
  prompt: z.string().optional().describe("New execution prompt"),
  wake: z.boolean().optional().describe("Whether to wake the origin session on completion"),
  silent: z.boolean().optional().describe("Whether to suppress result delivery"),
  agent: z.string().optional().describe("Agent to use, defaults to configured default"),
  model: z.object({ providerID: z.string(), modelID: z.string() }).optional().describe("Model override"),
  timeout: z.number().optional().describe("Execution timeout in milliseconds"),
  sessionMode: z
    .enum(["ephemeral", "persistent"])
    .optional()
    .describe("Session mode override. Set 'ephemeral' to create a fresh session on every fire."),
  sessionRefs: z
    .array(
      z.object({
        sessionID: z.string().describe("Session ID to reference"),
        hint: z.string().optional().describe("What to focus on in this session"),
      }),
    )
    .optional()
    .describe("Sessions whose content is relevant context for execution"),
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
    if (params.agent !== undefined) patch.agent = params.agent
    if (params.model !== undefined) patch.model = params.model
    if (params.timeout !== undefined) patch.timeout = params.timeout
    if (params.sessionMode !== undefined) patch.sessionMode = params.sessionMode
    if (params.sessionRefs !== undefined) patch.sessionRefs = params.sessionRefs

    const item = await Agenda.update(params.id, patch, Instance.scope.id)

    const lines = ["Agenda item updated.", `ID: ${item.id}`, `Title: ${item.title}`, `Status: ${item.status}`]
    if (item.state.nextRunAt) lines.push(`Next run: ${formatLocalDateTime(item.state.nextRunAt)}`)
    if (item.sessionMode) lines.push(`Session mode: ${item.sessionMode}`)
    if (item.agent) lines.push(`Agent: ${item.agent}`)
    if (item.model) lines.push(`Model: ${item.model.providerID}/${item.model.modelID}`)
    if (item.timeout) lines.push(`Timeout: ${item.timeout}ms`)

    return {
      title: item.title,
      output: lines.join("\n"),
      metadata: { id: item.id, status: item.status } as Record<string, any>,
    }
  },
})
