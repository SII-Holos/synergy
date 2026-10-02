import { agendaAgentItem } from "./agent-item"
import { GithubWatchPreflight } from "./github-watch-preflight"
import z from "zod"
import { Tool } from "@ericsanchezok/synergy-harness/tool/tool"
import { Agenda, AgendaTypes } from ".."
import { AgendaDedup } from "../dedup"
import { SessionManager } from "@ericsanchezok/synergy-harness/session/manager"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import DESCRIPTION from "./agenda-schedule.txt"
import { ToolTimeout } from "@ericsanchezok/synergy-harness/tool/timeout"

const parameters = z.object({
  agendaTitle: z.string().describe("Task title"),
  agendaDescription: z
    .string()
    .optional()
    .describe("Description of the scheduled item; omit when its title is sufficient"),
  executionInstructions: z
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
  timeoutSeconds: z.number().optional().describe("Execution timeout in seconds; omit to use the default"),
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

export const AgendaScheduleTool = Tool.define(
  "agenda_schedule",
  {
    description: DESCRIPTION,
    parameters,
    async execute(params: z.infer<typeof parameters>, ctx) {
      const session = await SessionManager.getSession(ctx.sessionID).catch(() => undefined)
      const triggers = [params.trigger as AgendaTypes.Trigger]

      if (params.trigger.type === "github") {
        // A GitHub trigger without a credential never fires; reject at creation
        // with concrete connection steps instead of persisting a silent item.
        const rejected = await GithubWatchPreflight.check("agenda_schedule")
        if (rejected) return rejected
      }
      const conflicts = await AgendaDedup.findConflicts(
        ScopeContext.current.scope.id,
        params.agendaTitle,
        triggers,
        params.global,
        session?.workspaceID ?? null,
      )
      if (conflicts.length > 0) {
        return {
          title: "agenda_schedule",
          output: AgendaDedup.formatConflictMessage(conflicts, "agenda_schedule"),
          metadata: { conflictCount: conflicts.length, action: "conflict_found" } as Record<string, any>,
        }
      }

      const item = await Agenda.create({
        title: params.agendaTitle,
        description: params.agendaDescription,
        prompt: params.executionInstructions,
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
        timeout: params.timeoutSeconds === undefined ? undefined : params.timeoutSeconds * 1_000,
        createdBy: "agent",
        sessionID: ctx.sessionID,
        endpoint: session?.endpoint,
      })

      return {
        title: item.title,
        output: JSON.stringify(agendaAgentItem(item), null, 2),
        metadata: {
          id: item.id,
          status: item.status,
          scheduledTimeoutMs: item.timeout,
          scheduledTimeoutLabel: ToolTimeout.scheduledTimeoutLabel(item.timeout),
        } as Record<string, any>,
      }
    },
  },
  { activityKind: "object" },
)
