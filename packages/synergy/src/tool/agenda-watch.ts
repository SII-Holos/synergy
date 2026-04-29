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
    const firesAt = new Date(Date.now() + delayMs).toISOString()

    return {
      title: `Watch: ${params.title}`,
      output: [
        `Watch set — you'll be woken up in THIS session.`,
        "",
        `ID: ${item.id}`,
        `Fires in: ${params.delay} (${firesAt})`,
        "",
        `When it fires, you receive the prompt as a message and continue with full conversation history.`,
        `To cancel: agenda_cancel(id="${item.id}")`,
      ].join("\n"),
      metadata: { id: item.id, status: item.status, delay: params.delay } as Record<string, any>,
    }
  },
})
