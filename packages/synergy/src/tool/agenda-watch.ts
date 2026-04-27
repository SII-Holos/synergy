import z from "zod"
import { Tool } from "./tool"
import { Agenda, AgendaTypes } from "../agenda"
import { AgendaDedup } from "../agenda/dedup"
import { SessionManager } from "../session/manager"
import { AgendaStore } from "../agenda/store"
import { Instance } from "../scope/instance"
import DESCRIPTION from "./agenda-watch.txt"

const parameters = z.object({
  title: z.string().describe("Short name for this watch, e.g. 'Monitor exp_007'. Shows in agenda_list."),
  check: z
    .object({
      tool: z
        .string()
        .describe(
          "Synergy tool to call for each check. Must be a tool available in the current environment. Most common: 'bash' to run a shell command and check its output. Other examples: 'inspire_jobs', 'inspire_metrics'. The tool is called with `args` and its output is compared against the trigger condition.",
        ),
      args: z
        .record(z.string(), z.unknown())
        .optional()
        .describe(
          "Arguments passed to the tool on each check. Example: {command: 'curl -s https://api.example.com/status'} for bash, {job_id: 'job-xxx'} for inspire_jobs.",
        ),
      interval: z
        .string()
        .optional()
        .describe(
          "How often to check. Default: '5m'. Examples: '1m', '5m', '15m', '30m', '1h'. Shorter intervals detect changes faster but use more resources. For experiments that take hours, '15m' is usually fine.",
        ),
    })
    .describe("What to check and how often. The tool is called mechanically — no agent involved, zero token cost."),
  trigger: z
    .enum(["change", "match"])
    .optional()
    .describe(
      "When to fire. Default: 'change' — fires when the tool output differs from the previous check. Use 'match' with the `match` parameter if you need to wait for a specific pattern (e.g. 'completed|failed'). 'change' is usually best because you don't need to know the exact output format.",
    ),
  match: z
    .string()
    .optional()
    .describe(
      "Regex pattern to match against tool output. Only used when trigger='match'. Example: 'completed|failed|stopped'. The watch fires when the output matches this pattern. If you're unsure what the output looks like, use trigger='change' instead.",
    ),
  timeout: z
    .string()
    .optional()
    .describe(
      "Maximum time to keep watching. Default: '24h'. After this, the watch fires with a timeout notification so you can decide what to do. Examples: '2h', '12h', '24h', '48h'.",
    ),
  max_checks: z
    .number()
    .optional()
    .describe(
      "Maximum number of checks before timeout. Default: 100. At 15m intervals, 100 checks = 25 hours. The watch fires with a timeout notification when this limit is reached.",
    ),
})

export const AgendaWatchTool = Tool.define("agenda_watch", {
  description: DESCRIPTION,
  parameters,
  async execute(params: z.infer<typeof parameters>, ctx) {
    const session = await SessionManager.getSession(ctx.sessionID).catch(() => undefined)
    const interval = params.check.interval ?? "5m"
    const triggerMode = params.trigger ?? "change"
    const maxChecks = params.max_checks ?? 100

    const watchTrigger: AgendaTypes.Trigger = {
      type: "watch",
      watch: {
        kind: "tool",
        tool: params.check.tool,
        args: params.check.args,
        interval,
        trigger: triggerMode,
        ...(triggerMode === "match" && params.match ? { match: params.match } : {}),
      },
    }

    const conflicts = await AgendaDedup.findConflicts(Instance.scope.id, params.title, [watchTrigger])

    if (conflicts.length > 0) {
      return {
        title: "agenda_watch",
        output: AgendaDedup.formatConflictMessage(conflicts, "agenda_watch"),
        metadata: { conflictCount: conflicts.length, action: "conflict_found" } as Record<string, any>,
      }
    }

    const item = await Agenda.create({
      title: params.title,
      prompt: `Watch fired for: ${params.title}`,
      triggers: [watchTrigger],
      wake: true,
      silent: false,
      autoDone: true,
      createdBy: "agent",
      sessionID: ctx.sessionID,
      endpoint: session?.endpoint,
    })

    const intervalMs = AgendaStore.parseDuration(interval)
    const maxTimeStr = params.timeout ?? "24h"
    const maxTimeMs = AgendaStore.parseDuration(maxTimeStr)
    const estimatedChecks = Math.min(maxChecks, Math.ceil(maxTimeMs / intervalMs))

    const lines = [
      `Watch created — you will be woken up in THIS session when it fires.`,
      "",
      `ID: ${item.id}`,
      `Checking: ${params.check.tool} every ${interval}`,
      `Trigger: ${triggerMode === "change" ? "when output changes from previous check" : `when output matches /${params.match}/`}`,
      `Safety limits: ${maxChecks} checks or ${maxTimeStr} (whichever comes first)`,
      `Estimated checks before timeout: ~${estimatedChecks}`,
      "",
      `What happens next:`,
      `- The system checks ${params.check.tool} every ${interval} (no agent, no tokens)`,
      `- When the condition is met → you get woken up here with the result`,
      `- The watch auto-completes — no cleanup needed`,
      `- If it times out → you still get woken up with a timeout notification`,
      "",
      `To cancel before it fires: agenda_cancel(id="${item.id}")`,
      `To see status: agenda_list()`,
    ]

    return {
      title: `Watching: ${params.title}`,
      output: lines.join("\n"),
      metadata: {
        id: item.id,
        tool: params.check.tool,
        interval,
        trigger: triggerMode,
        maxChecks,
        timeout: maxTimeStr,
      } as Record<string, any>,
    }
  },
})
