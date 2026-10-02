import { agendaAgentItem } from "./agent-item"
import { GithubWatchPreflight } from "./github-watch-preflight"
import { z } from "zod"
import { Tool } from "@ericsanchezok/synergy-harness/tool/tool"
import { Agenda, AgendaStore, AgendaTypes } from ".."
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import DESCRIPTION from "./agenda-update.txt"
import { ToolTimeout } from "@ericsanchezok/synergy-harness/tool/timeout"

const parameters = z.object({
  agendaItemId: z.string().describe("Agenda item ID to update"),
  agendaTitle: z.string().optional().describe("Replace the agenda item’s title; omit to keep it unchanged."),
  agendaDescription: z
    .string()
    .optional()
    .describe("Replace the agenda item’s description; omit to keep it unchanged."),
  status: AgendaTypes.ItemStatus.optional().describe("New status: pending, active, paused, done, cancelled"),
  tags: z.array(z.string()).optional().describe("New tags (replaces existing)"),
  triggers: z.array(AgendaTypes.Trigger).optional().describe("New triggers (replaces existing, recomputes nextRunAt)"),
  executionInstructions: z
    .string()
    .optional()
    .describe("Replace the instructions executed when this item fires; omit to keep them unchanged."),
  wake: z.boolean().optional().describe("Whether to wake the origin session on completion"),
  silent: z.boolean().optional().describe("Whether to suppress result delivery"),
  agent: z.string().optional().describe("Agent to use, defaults to configured default"),
  model: z.object({ providerID: z.string(), modelID: z.string() }).optional().describe("Model override"),
  controlProfile: AgendaTypes.ControlProfile.optional().describe(
    "Control profile for sessions created by this agenda item: guarded, autonomous, or full_access",
  ),
  timeoutSeconds: z.number().optional().describe("Execution timeout in seconds; omit to use the default"),
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

export const AgendaUpdateTool = Tool.define(
  "agenda_update",
  {
    description: DESCRIPTION,
    parameters,
    async execute(params: z.infer<typeof parameters>) {
      const triggers =
        params.triggers ??
        (params.status === "active"
          ? (await AgendaStore.findInScope(ScopeContext.current.scope.id, params.agendaItemId)).item.triggers
          : undefined)
      if (triggers?.some((t) => t.type === "github")) {
        const rejected = await GithubWatchPreflight.check("agenda_update")
        if (rejected) return rejected
      }
      const patch: AgendaTypes.PatchInput = {}

      if (params.agendaTitle !== undefined) patch.title = params.agendaTitle
      if (params.agendaDescription !== undefined) patch.description = params.agendaDescription
      if (params.status !== undefined) patch.status = params.status
      if (params.tags !== undefined) patch.tags = params.tags
      if (params.triggers !== undefined) patch.triggers = params.triggers
      if (params.executionInstructions !== undefined) patch.prompt = params.executionInstructions
      if (params.wake !== undefined) patch.wake = params.wake
      if (params.silent !== undefined) patch.silent = params.silent
      if (params.agent !== undefined) patch.agent = params.agent
      if (params.model !== undefined) patch.model = params.model
      if (params.controlProfile !== undefined) patch.controlProfile = params.controlProfile
      if (params.timeoutSeconds !== undefined) patch.timeout = params.timeoutSeconds * 1_000
      if (params.sessionMode !== undefined) patch.sessionMode = params.sessionMode
      if (params.sessionRefs !== undefined) patch.sessionRefs = params.sessionRefs

      const item = await Agenda.update(params.agendaItemId, patch, ScopeContext.current.scope.id)

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
