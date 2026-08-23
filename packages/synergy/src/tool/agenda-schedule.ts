import { formatLocalDateTime } from "@/util/time-format"
import z from "zod"
import { Tool } from "./tool"
import { Agenda, AgendaTypes } from "../agenda"
import { AgendaDedup } from "../agenda/dedup"
import { SessionManager } from "../session/manager"
import { ScopeContext } from "../scope/context"
import DESCRIPTION from "./agenda-schedule.txt"
import { ToolTimeout } from "./timeout"

const parameters = z.object({
  title: z.string().describe("Task title"),
  prompt: z
    .string()
    .describe(
      "Instruction for the agent to execute when triggered. Write as a complete brief — the executing agent has no access to this conversation.",
    ),
  trigger: AgendaTypes.ScheduleTrigger.describe(
    "Schedule trigger. One of: {type:'cron', expr:'0 9 * * *', tz?:'Asia/Shanghai'}, {type:'every', interval:'30m'}, {type:'at', at:1742569200000}, {type:'delay', delay:'2h'}, {type:'session', sessionID:'ses_xxx', event:'turn.end', agent?:'research', finish?:'stop', once?:true}, {type:'github', resource:'pr'|'issue'|'workflow'|'check', repository:'owner/repo', number?:123, interval?:'5m', states?:['merged','failure']}",
  ),
  tags: z.array(z.string()).optional().describe("Tags for organization and filtering"),
  global: z.boolean().optional().describe("If true, visible from all scopes. Default: false (current project only)"),
  wake: z.boolean().optional().describe("If true, wake this session's agent when execution completes. Default: true"),
  silent: z.boolean().optional().describe("If true, suppress result delivery entirely. Default: false"),
  agent: z.string().optional().describe("Agent to use, defaults to configured default"),
  model: z.object({ providerID: z.string(), modelID: z.string() }).optional().describe("Model override"),
  controlProfile: AgendaTypes.ControlProfile.optional().describe(
    "Control profile for sessions created by this agenda item: guarded, autonomous, or full_access",
  ),
  timeout: z.number().optional().describe("Execution timeout in milliseconds"),
  sessionMode: z
    .enum(["ephemeral", "persistent"])
    .optional()
    .describe(
      "Session mode override. Recurring triggers (cron, every) default to 'persistent' (reuse session across fires). Set 'ephemeral' to start a fresh session on every fire — useful for tasks that must not carry history from previous runs, such as daily reports.",
    ),
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

    if (params.trigger.type === "github") {
      // A GitHub trigger can never fire while polling is disabled; reject up
      // front instead of persisting a permanently silent item.
      const { Config } = await import("../config/config")
      const watch = (await Config.globalResolved().catch(() => undefined))?.github?.watch
      if (watch?.enabled === false) {
        return {
          title: "agenda_schedule rejected",
          output: [
            `GitHub triggers are disabled (github.watch.enabled=false in config).`,
            ``,
            `Ask the user to enable them in Settings → GitHub → "Allow GitHub agenda triggers", or set github.watch.enabled=true in 115-github.jsonc.`,
          ].join("\n"),
          metadata: { blocked: true, reason: "github_watch_disabled" } as Record<string, any>,
        }
      }
    }
    const conflicts = await AgendaDedup.findConflicts(
      ScopeContext.current.scope.id,
      params.title,
      triggers,
      params.global,
    )
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
      agent: params.agent,
      model: params.model,
      controlProfile: params.controlProfile,
      sessionMode: params.sessionMode,
      sessionRefs: params.sessionRefs,
      timeout: params.timeout,
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
    if (item.state.nextRunAt) lines.push(`Next run: ${formatLocalDateTime(item.state.nextRunAt)}`)
    if (item.tags?.length) lines.push(`Tags: ${item.tags.join(", ")}`)
    if (item.global) lines.push(`Scope: global`)
    if (item.wake === false) lines.push(`Wake: disabled`)
    if (item.silent) lines.push(`Silent: true`)
    if (item.agent) lines.push(`Agent: ${item.agent}`)
    if (item.model) lines.push(`Model: ${item.model.providerID}/${item.model.modelID}`)
    if (item.controlProfile) lines.push(`Control profile: ${item.controlProfile}`)
    if (item.timeout) lines.push(`Timeout: ${item.timeout}ms`)
    if (item.sessionMode) lines.push(`Session mode: ${item.sessionMode}`)

    lines.push(
      "",
      `Recurring tasks reuse a persistent session across fires by default. Pass sessionMode="ephemeral" to start a fresh session on each fire.`,
      `To pause: agenda_update(id="${item.id}", status="paused")`,
      `To cancel: agenda_cancel(id="${item.id}")`,
      `To view runs: agenda_logs(id="${item.id}")`,
    )

    return {
      title: item.title,
      output: lines.join("\n"),
      metadata: {
        id: item.id,
        status: item.status,
        scheduledTimeoutMs: item.timeout,
        scheduledTimeoutLabel: ToolTimeout.scheduledTimeoutLabel(item.timeout),
      } as Record<string, any>,
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
      return `at ${formatLocalDateTime(t.at)}`
    case "delay":
      return `delay ${t.delay}`
    case "session": {
      const event = t.event === "turn.start" ? "turn start" : "turn end"
      const filters = [t.agent && ` agent=${t.agent}`, t.finish && ` finish=${t.finish}`].filter(Boolean).join("")
      return `session "${t.sessionID}" on ${event}${filters}${t.once === false ? " (recurring)" : ""}`
    }
    case "github": {
      const target = t.number !== undefined ? ` #${t.number}` : ""
      const states = t.states?.length ? ` states=${t.states.join("|")}` : ""
      return `github ${t.resource} ${t.repository}${target}${t.interval ? ` every ${t.interval}` : ""}${states}`
    }
  }
}
