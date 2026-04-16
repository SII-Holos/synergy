import z from "zod"
import { Tool } from "./tool"
import { Agenda, AgendaTypes } from "../agenda"
import { Instance } from "../scope/instance"
import { Scope } from "../scope"
import { SessionManager } from "../session/manager"
import DESCRIPTION from "./agenda-create.txt"

const parameters = z.object({
  title: z.string().describe("Title for the agenda item"),
  description: z.string().optional().describe("Longer description of the agenda item"),
  tags: z.array(z.string()).optional().describe("Tags for organization and filtering"),
  triggers: z
    .array(AgendaTypes.Trigger)
    .optional()
    .describe(
      "Activation conditions. Examples: {type:'cron',expr:'0 9 * * *',tz:'Asia/Shanghai'}, {type:'every',interval:'30m'}, {type:'at',at:1742569200000}, {type:'delay',delay:'2h'}, {type:'watch',watch:{kind:'poll',command:'git status',interval:'5m',trigger:'change'}}, {type:'webhook'}",
    ),
  prompt: z.string().optional().describe("Instruction for the agent to execute when triggered"),
  workScopeID: z.string().optional().describe("Scope ID to execute in (takes priority over workDirectory)"),
  workDirectory: z.string().optional().describe("Directory path to resolve execution scope from (fallback)"),
  sessionRefs: z
    .array(
      z.object({
        sessionID: z.string().describe("Session ID to reference"),
        hint: z.string().optional().describe("What to focus on in this session"),
      }),
    )
    .optional()
    .describe("Sessions whose content is relevant context for execution"),
  delivery: z
    .enum(["auto", "silent", "home", "session"])
    .optional()
    .describe("Where to deliver results. Default: 'auto'"),
  deliverySessionID: z.string().optional().describe("Required when delivery is 'session'"),
  sessionMode: z
    .enum(["ephemeral", "persistent"])
    .optional()
    .describe("'ephemeral' (default): new session per trigger. 'persistent': reuse same session across triggers."),
  contextMode: z
    .enum(["full", "signal", "none"])
    .optional()
    .describe("'full' (default): complete agenda context. 'signal': only signal payload. 'none': only task prompt."),
})

async function resolveWorkScope(workScopeID?: string, workDirectory?: string): Promise<Scope | undefined> {
  if (workScopeID) {
    if (workScopeID === "global") return Scope.global()
    const scopes = await Scope.list()
    const match = scopes.find((s) => s.id === workScopeID)
    if (!match) throw new Error(`Scope not found: ${workScopeID}`)
    return match
  }
  if (workDirectory) {
    const { scope } = await Scope.fromDirectory(workDirectory)
    return scope
  }
  return undefined
}

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

export const AgendaCreateTool = Tool.define("agenda_create", {
  description: DESCRIPTION,
  parameters,
  async execute(params: z.infer<typeof parameters>, ctx) {
    const workScope = await resolveWorkScope(params.workScopeID, params.workDirectory)

    const task: AgendaTypes.Task | undefined = params.prompt
      ? {
          prompt: params.prompt,
          workScope,
          sessionRefs: params.sessionRefs,
          sessionMode: params.sessionMode,
          contextMode: params.contextMode,
        }
      : undefined

    const session = await SessionManager.getSession(ctx.sessionID).catch(() => undefined)

    const item = await Agenda.create({
      title: params.title,
      description: params.description,
      tags: params.tags,
      triggers: params.triggers,
      task,
      delivery: buildDelivery(params.delivery, params.deliverySessionID),
      createdBy: "agent",
      sessionID: ctx.sessionID,
      endpoint: session?.endpoint,
    })

    const lines = ["Agenda item created.", `ID: ${item.id}`, `Title: ${item.title}`, `Status: ${item.status}`]
    if (item.tags?.length) lines.push(`Tags: ${item.tags.join(", ")}`)
    if (item.triggers.length) lines.push(`Triggers: ${item.triggers.length} configured`)
    if (item.state.nextRunAt) lines.push(`Next run: ${new Date(item.state.nextRunAt).toISOString()}`)
    if (item.delivery) lines.push(`Delivery: ${item.delivery.target}`)
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
