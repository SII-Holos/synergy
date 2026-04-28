import z from "zod"
import { Tool } from "./tool"
import { Agenda, AgendaTypes } from "../agenda"
import { AgendaDedup } from "../agenda/dedup"
import { SessionManager } from "../session/manager"
import { Instance } from "../scope/instance"
import DESCRIPTION from "./agenda-schedule.txt"

const parameters = z.object({
  title: z.string().describe("Task title"),
  prompt: z
    .string()
    .describe(
      "Instruction for the agent to execute when triggered. Write as a complete brief — the executing agent has no access to this conversation.",
    ),
  trigger: AgendaTypes.ScheduleTrigger.describe(
    "Schedule trigger. One of: {type:'cron', expr:'0 9 * * *', tz?:'Asia/Shanghai'}, {type:'every', interval:'30m'}, {type:'at', at:1742569200000}, {type:'delay', delay:'2h'}",
  ),
  tags: z.array(z.string()).optional().describe("Tags for organization and filtering"),
  global: z.boolean().optional().describe("If true, visible from all scopes. Default: false (current project only)"),
  wake: z.boolean().optional().describe("If true, wake this session's agent when execution completes. Default: true"),
  silent: z.boolean().optional().describe("If true, suppress result delivery entirely. Default: false"),
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

export const AgendaScheduleTool = Tool.define("agenda_schedule", {
  description: DESCRIPTION,
  parameters,
  async execute(params: z.infer<typeof parameters>, ctx) {
    const session = await SessionManager.getSession(ctx.sessionID).catch(() => undefined)
    const triggers = [params.trigger as AgendaTypes.Trigger]

    const conflicts = await AgendaDedup.findConflicts(Instance.scope.id, params.title, triggers, params.global)
    if (conflicts.length > 0) {
      return {
        title: "agenda_schedule",
        output: AgendaDedup.formatConflictMessage(conflicts, "agenda_schedule"),
        metadata: { conflictCount: conflicts.length, action: "conflict_found" } as Record<string, any>,
      }
    }

    const item = await Agenda.create({
      title: params.title,
      prompt: params.prompt,
      triggers,
      tags: params.tags,
      global: params.global,
      wake: params.wake,
      silent: params.silent,
      sessionRefs: params.sessionRefs,
      createdBy: "agent",
      sessionID: ctx.sessionID,
      endpoint: session?.endpoint,
    })

    const lines = [
      "Scheduled task created.",
      "",
      `ID: ${item.id}`,
      `Title: ${item.title}`,
      `Schedule: ${formatTrigger(params.trigger)}`,
    ]
    if (item.state.nextRunAt) lines.push(`Next run: ${new Date(item.state.nextRunAt).toISOString()}`)
    if (item.tags?.length) lines.push(`Tags: ${item.tags.join(", ")}`)
    if (item.global) lines.push(`Scope: global`)
    if (item.wake === false) lines.push(`Wake: disabled`)
    if (item.silent) lines.push(`Silent: true`)

    lines.push(
      "",
      `Each run executes in a fresh session. Results are delivered back here.`,
      `To pause: agenda_update(id="${item.id}", status="paused")`,
      `To cancel: agenda_cancel(id="${item.id}")`,
      `To view runs: agenda_logs(id="${item.id}")`,
    )

    return {
      title: item.title,
      output: lines.join("\n"),
      metadata: { id: item.id, status: item.status } as Record<string, any>,
    }
  },
})

function formatTrigger(t: AgendaTypes.ScheduleTrigger): string {
  switch (t.type) {
    case "cron":
      return `cron "${t.expr}"${t.tz ? ` (${t.tz})` : ""}`
    case "every":
      return `every ${t.interval}`
    case "at":
      return `at ${new Date(t.at).toISOString()}`
    case "delay":
      return `delay ${t.delay}`
  }
}
