import { formatLocalDateTime } from "@/util/time-format"
import z from "zod"
import { Tool } from "./tool"
import { Agenda } from "../agenda"
import { AgendaDedup } from "../agenda/dedup"
import { AgendaStore } from "../agenda/store"
import { SessionManager } from "../session/manager"
import { Instance } from "../scope/instance"
import DESCRIPTION from "./agenda-watch.txt"

const parameters = z.object({
  title: z.string().describe("Short name, e.g. 'Check pipeline health'"),
  prompt: z
    .string()
    .describe(
      "Instruction you'll receive when woken up. Write it for yourself — you'll see it with full conversation history.",
    ),
  delay: z.string().describe("How long to wait before waking you, e.g. '30m', '2h', '1d'"),
  global: z.boolean().optional().describe("If true, visible from all scopes. Default: false (current project only)"),
})

export const AgendaWatchTool = Tool.define("agenda_watch", {
  description: DESCRIPTION,
  parameters,
  async execute(params: z.infer<typeof parameters>, ctx) {
    // Reject if there are running subagent tasks for this session.
    // Subagents auto-notify on completion — an agenda_watch is never needed for them.
    const { Cortex } = await import("../cortex")
    const runningSubagents = Cortex.getVisibleTasks(ctx.sessionID).filter((t) => t.status === "running")

    if (runningSubagents.length > 0) {
      const taskList = runningSubagents.map((t) => `  - ${t.id}: ${t.description} (agent: ${t.agent})`).join("\n")

      return {
        title: "agenda_watch rejected",
        output: [
          `You cannot set an \`agenda_watch\` while subagents are still running.`,
          ``,
          `Running subagents (${runningSubagents.length}):`,
          taskList,
          ``,
          `These subagents **auto-notify you on completion** — you will be woken up automatically when they finish.`,
          `There is NO reason to poll or watch them. No watch is needed.`,
          ``,
          `Instead: use \`task_output(task_id="...", mode="progress")\` to check live progress, or continue with other work that does not depend on these results.`,
        ].join("\n"),
        metadata: {
          blocked: true,
          reason: "running_subagents",
          runningSubagentCount: runningSubagents.length,
          runningSubagentIds: runningSubagents.map((t) => t.id),
        } as Record<string, any>,
      }
    }

    const session = await SessionManager.getSession(ctx.sessionID).catch(() => undefined)
    const trigger = { type: "delay" as const, delay: params.delay }

    const conflicts = await AgendaDedup.findConflicts(Instance.scope.id, params.title, [trigger], params.global)
    if (conflicts.length > 0) {
      return {
        title: "agenda_watch",
        output: AgendaDedup.formatConflictMessage(conflicts, "agenda_watch"),
        metadata: { conflictCount: conflicts.length, action: "conflict_found" } as Record<string, any>,
      }
    }

    const item = await Agenda.create({
      title: params.title,
      prompt: params.prompt,
      triggers: [trigger],
      global: params.global,
      wake: true,
      silent: false,
      autoDone: true,
      createdBy: "agent",
      sessionID: ctx.sessionID,
      endpoint: session?.endpoint,
    })

    const delayMs = AgendaStore.parseDuration(params.delay)
    const firesAt = formatLocalDateTime(Date.now() + delayMs)

    return {
      title: `Watch: ${params.title}`,
      output: [
        `Watch set — you'll be woken up in THIS session.`,
        ``,
        `ID: ${item.id}`,
        `Fires in: ${params.delay} (${firesAt})`,
        ``,
        `When it fires, you receive the prompt as a message and continue with full conversation history.`,
        `To cancel: agenda_cancel(id="${item.id}")`,
      ].join("\n"),
      metadata: { id: item.id, status: item.status, delay: params.delay } as Record<string, any>,
    }
  },
})
