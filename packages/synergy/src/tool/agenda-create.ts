import z from "zod"
import { Tool } from "./tool"
import { Agenda, AgendaTypes } from "../agenda"
import { SessionManager } from "../session/manager"
import DESCRIPTION from "./agenda-create.txt"

const parameters = z.object({
  title: z.string().describe("Title for the agenda item"),
  prompt: z.string().describe("Instruction for the agent to execute when triggered"),
  triggers: z
    .array(AgendaTypes.Trigger)
    .optional()
    .describe(
      "Activation conditions. Examples: {type:'cron',expr:'0 9 * * *',tz:'Asia/Shanghai'}, {type:'every',interval:'30m'}, {type:'at',at:1742569200000}, {type:'delay',delay:'2h'}, {type:'watch',watch:{kind:'poll',command:'git status',interval:'5m',trigger:'change'}}, {type:'watch',watch:{kind:'tool',tool:'bash',args:{command:'curl -s https://api.example.com/health'},interval:'5m',trigger:'change'}}, {type:'watch',watch:{kind:'tool',tool:'inspire_jobs',args:{status:'running'},interval:'5m',trigger:'change'}}, {type:'webhook'}",
    ),
  description: z.string().optional().describe("Longer description of the agenda item"),
  tags: z.array(z.string()).optional().describe("Tags for organization and filtering"),
  global: z
    .boolean()
    .optional()
    .describe("If true, item is visible from all scopes. Default: false (scoped to current project)"),
  silent: z.boolean().optional().describe("If true, suppress result delivery. Default: false"),
  wake: z.boolean().optional().describe("If true, wake the origin session's agent on completion. Default: true"),
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

export const AgendaCreateTool = Tool.define("agenda_create", {
  description: DESCRIPTION,
  parameters,
  async execute(params: z.infer<typeof parameters>, ctx) {
    const session = await SessionManager.getSession(ctx.sessionID).catch(() => undefined)

    const item = await Agenda.create({
      title: params.title,
      prompt: params.prompt,
      description: params.description,
      tags: params.tags,
      triggers: params.triggers,
      global: params.global,
      wake: params.wake,
      silent: params.silent,
      sessionRefs: params.sessionRefs,
      createdBy: "agent",
      sessionID: ctx.sessionID,
      endpoint: session?.endpoint,
    })

    const lines = ["Agenda item created.", `ID: ${item.id}`, `Title: ${item.title}`, `Status: ${item.status}`]
    if (item.tags?.length) lines.push(`Tags: ${item.tags.join(", ")}`)
    if (item.triggers.length) lines.push(`Triggers: ${item.triggers.length} configured`)
    if (item.state.nextRunAt) lines.push(`Next run: ${new Date(item.state.nextRunAt).toISOString()}`)
    if (item.global) lines.push(`Scope: global`)
    if (item.wake === false) lines.push(`Wake: disabled`)
    if (item.silent) lines.push(`Silent: true`)
    for (const trigger of item.triggers) {
      if (trigger.type === "webhook" && trigger.token) {
        lines.push(`Webhook URL: POST /agenda/webhook/${trigger.token}`)
      }
    }

    return {
      title: item.title,
      output: lines.join("\n"),
      metadata: { id: item.id, status: item.status } as Record<string, any>,
    }
  },
})
